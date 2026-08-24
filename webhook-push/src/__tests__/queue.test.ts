import { describe, expect, it } from 'vitest';
import {
  filterEvent,
  formatSummary,
  formatTime,
  isValidWebhookUrl,
  normalizeMethod,
  parseHeaderLines,
  parseTargetRow,
  redactUrlDisplay,
  renderRequest,
  takeBatch,
  type QueuedEvent,
} from '../queue.js';

const baseEvent = (overrides?: Partial<QueuedEvent>): QueuedEvent => ({
  type: 'decode',
  timestamp: new Date('2026-08-22T12:00:00Z').getTime(),
  data: {},
  ...overrides,
});

describe('isValidWebhookUrl', () => {
  it('accepts absolute http(s) urls', () => {
    expect(isValidWebhookUrl('https://example.com/webhook')).toBe(true);
    expect(isValidWebhookUrl('http://localhost:8080/hook')).toBe(true);
  });

  it('rejects urls with embedded credentials (userinfo)', () => {
    expect(isValidWebhookUrl('https://user:pass@example.com/hook')).toBe(false);
    expect(isValidWebhookUrl('http://user@example.com/hook')).toBe(false);
    expect(isValidWebhookUrl('https://example.com/hook')).toBe(true);
  });

  it('rejects non-http, relative and empty values', () => {
    expect(isValidWebhookUrl('ftp://example.com/x')).toBe(false);
    expect(isValidWebhookUrl('/relative/path')).toBe(false);
    expect(isValidWebhookUrl('example.com/webhook')).toBe(false);
    expect(isValidWebhookUrl('')).toBe(false);
    expect(isValidWebhookUrl(undefined)).toBe(false);
    expect(isValidWebhookUrl(null)).toBe(false);
  });
});

describe('normalizeMethod', () => {
  it('accepts GET/POST and falls back to POST', () => {
    expect(normalizeMethod('POST')).toBe('POST');
    expect(normalizeMethod('get')).toBe('GET');
    expect(normalizeMethod('PUT')).toBe('POST');
    expect(normalizeMethod('')).toBe('POST');
    expect(normalizeMethod(undefined)).toBe('POST');
  });
});

describe('parseHeaderLines', () => {
  it('parses Name: value lines', () => {
    expect(parseHeaderLines(['Authorization: Bearer abc', 'X-Custom:  value  ']))
      .toEqual({ Authorization: 'Bearer abc', 'X-Custom': 'value' });
  });

  it('skips malformed, invalid or unsafe lines', () => {
    expect(parseHeaderLines([
      'no-colon-here',
      ': missing-name',
      'Bad Name: spaced name is not a valid token',
      'Inject: ok\r\nX-Evil: 1',
      '',
      42 as unknown as string,
    ])).toEqual({});
  });
});

describe('parseTargetRow', () => {
  it('parses a full row', () => {
    const target = parseTargetRow({
      name: 'Primary',
      webhookUrl: 'https://example.com/hook',
      method: 'GET',
      headers: ['Authorization: Bearer abc', 'Bad Line'],
      events: ['decode', 'qso'],
      enabled: false,
    }, 0);
    expect(target).toMatchObject({
      name: 'Primary',
      webhookUrl: 'https://example.com/hook',
      method: 'GET',
      headers: { Authorization: 'Bearer abc' },
      events: ['decode', 'qso'],
      enabled: false,
    });
  });

  it('fills defaults, sanitizes unknowns and falls back to a generated name', () => {
    const target = parseTargetRow({ webhookUrl: 'https://example.com/hook' }, 2);
    expect(target.name).toBe('target-3');
    expect(target.method).toBe('POST');
    expect(target.headers).toEqual({});
    expect(target.events).toEqual([]);
    expect(target.enabled).toBe(true);
  });

  it('handles non-object rows', () => {
    expect(parseTargetRow(null, 0).webhookUrl).toBe('');
    expect(parseTargetRow('x', 0).webhookUrl).toBe('');
  });
});

describe('filterEvent', () => {
  it('matches exact selections and qso sub-events', () => {
    expect(filterEvent(['decode'], 'decode')).toBe(true);
    expect(filterEvent(['decode'], 'qso.complete')).toBe(false);
    expect(filterEvent(['qso'], 'qso.start')).toBe(true);
    expect(filterEvent(['qso'], 'qso.complete')).toBe(true);
    expect(filterEvent(['qso'], 'qso.fail')).toBe(true);
    expect(filterEvent(['freq'], 'qso.fail')).toBe(false);
    expect(filterEvent([], 'decode')).toBe(false);
  });
});

describe('takeBatch', () => {
  it('splits the queue and leaves the rest', () => {
    const events = [baseEvent({ type: 'a' }), baseEvent({ type: 'b' }), baseEvent({ type: 'c' })];
    const { batch, rest } = takeBatch(events, 2);
    expect(batch.map((e) => e.type)).toEqual(['a', 'b']);
    expect(rest.map((e) => e.type)).toEqual(['c']);
  });

  it('handles empty queues and invalid limits', () => {
    expect(takeBatch([], 5).batch).toEqual([]);
    expect(takeBatch([baseEvent()], 0).batch.length).toBe(1);
    expect(takeBatch([baseEvent()], -3).batch.length).toBe(1);
  });
});

describe('formatSummary', () => {
  it('renders decode lines with raw message text', () => {
    const summary = formatSummary([
      baseEvent({
        type: 'decode',
        data: {
          frequency: 7_074_000,
          band: '40m',
          messages: [
            { rawMessage: 'CQ K1ABC FN42' },
            { rawMessage: 'K1ABC K2XYZ -12' },
          ],
        },
      }),
    ]);
    expect(summary).toMatch(/^\[\d\d:\d\d:\d\d\] decode ×2 \(7\.074MHz 40m\): CQ K1ABC FN42 \| K1ABC K2XYZ -12$/);
  });

  it('renders a truncated long decode line', () => {
    const long = 'X'.repeat(500);
    const summary = formatSummary([
      baseEvent({ type: 'decode', data: { messages: [{ rawMessage: long }] } }),
    ]);
    expect(summary.length).toBeLessThan(250);
  });

  it('renders decode without messages as ×0', () => {
    const summary = formatSummary([baseEvent({ type: 'decode', data: {} })]);
    expect(summary).toContain('decode ×0');
  });

  it('renders qso lifecycle lines', () => {
    const events = [
      baseEvent({ type: 'qso.start', data: { targetCallsign: 'K1ABC', grid: 'FN42' } }),
      baseEvent({
        type: 'qso.complete',
        data: { record: { callsign: 'K1ABC', mode: 'FT8', frequency: 7_074_000 } },
      }),
      baseEvent({ type: 'qso.fail', data: { targetCallsign: 'K2XYZ', reason: 'timeout' } }),
    ];
    const summary = formatSummary(events);
    expect(summary).toContain('qso.start: K1ABC (FN42)');
    expect(summary).toContain('qso.complete: K1ABC (FT8, 7.074MHz)');
    expect(summary).toContain('qso.fail: K2XYZ (timeout)');
  });

  it('renders freq, slot and custom test lines', () => {
    const summary = formatSummary([
      baseEvent({ type: 'freq', data: { frequency: 14_074_000, band: '20m' } }),
      baseEvent({ type: 'slot', data: { messageCount: 5 } }),
      baseEvent({ type: 'test', data: { message: 'Webhook test event' } }),
    ]);
    expect(summary).toContain('freq: 14.074MHz 20m');
    expect(summary).toContain('slot: 5 messages');
    expect(summary).toContain('test: Webhook test event');
  });
});

describe('formatTime', () => {
  it('formats local time as HH:mm:ss', () => {
    expect(formatTime(new Date('2026-08-22T12:00:00Z').getTime())).toMatch(/^\d\d:\d\d:\d\d$/);
  });
});

const renderCtx = {
  plugin: 'webhook-push',
  pluginVersion: '0.1.0',
  operatorId: 'op-1',
  sentAt: '2026-08-22T12:00:00.000Z',
  summary: 'summary text',
};

describe('renderRequest', () => {
  const events = [baseEvent({ type: 'decode', data: { a: 1 } })];
  const target = { name: 't', webhookUrl: 'https://example.com/hook', method: 'POST' as const, enabled: true };

  it('renders the json payload for POST requests', () => {
    const request = renderRequest(target, events, renderCtx);
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://example.com/hook');
    expect(request.headers['content-type']).toBe('application/json');
    const body = JSON.parse(request.body ?? '{}');
    expect(body.schemaVersion).toBe(1);
    expect(body.plugin).toBe('webhook-push');
    expect(body.operatorId).toBe('op-1');
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ type: 'decode', data: { a: 1 } });
  });

  it('encodes the json payload into a query parameter for GET requests', () => {
    const request = renderRequest({ ...target, method: 'GET' }, events, renderCtx);
    expect(request.method).toBe('GET');
    expect(request.body).toBeUndefined();

    const url = new URL(request.url);
    expect(url.origin + url.pathname).toBe('https://example.com/hook');
    const payload = JSON.parse(url.searchParams.get('payload') ?? '{}');
    expect(payload.schemaVersion).toBe(1);
    expect(payload.events[0]).toMatchObject({ type: 'decode', data: { a: 1 } });
  });

  it('merges the payload query parameter into webhook urls that already have a query', () => {
    const request = renderRequest(
      { ...target, method: 'GET', webhookUrl: 'https://example.com/hook?channel=test' },
      events,
      renderCtx,
    );
    const url = new URL(request.url);
    expect(url.searchParams.get('channel')).toBe('test');
    expect(url.searchParams.has('payload')).toBe(true);
  });
});

describe('redactUrlDisplay', () => {
  it('strips userinfo, query and fragment for log/UI display', () => {
    expect(redactUrlDisplay('https://user:pass@example.com/hook?token=secret#frag'))
      .toBe('https://example.com/hook');
    expect(redactUrlDisplay('http://example.com:8080/x?y=1')).toBe('http://example.com:8080/x');
    expect(redactUrlDisplay('not a url')).toBe('<invalid url>');
  });
});

describe('parseTargetRow hardening', () => {
  it('sanitizes target names used in logs (control chars stripped, capped)', () => {
    const row = parseTargetRow(
      { name: 'bad\nname\r\nwith controls', webhookUrl: 'https://example.com/h', events: [], headers: [] },
      0,
    );
    expect(row.name).toBe('bad name with controls');

    const longRow = parseTargetRow({ name: 'x'.repeat(100), webhookUrl: 'https://example.com/h' }, 0);
    expect(longRow.name?.length).toBe(64);
  });
});