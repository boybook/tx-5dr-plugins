import { describe, expect, it, vi } from 'vitest';
import { createMockContext } from '@tx5dr/plugin-api/testing';
import plugin, { internals } from '../index.js';
import type { FetchLike } from '../transport.js';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createMockFetch(responses?: ((call: FetchCall) => Response | Promise<Response>)[]): {
  fetchFn: FetchLike;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const call = { url, init: init ?? {} };
    calls.push(call);
    const responder = responses?.[calls.length - 1];
    return responder ? responder(call) : new Response('{"ok":true}', { status: 200, statusText: 'OK' });
  };
  return { fetchFn, calls };
}

function makeContext(config: Record<string, unknown>, fetchFn: FetchLike) {
  const ctx = createMockContext<['network']>({
    permissions: ['network'],
    operatorId: 'op-1',
    config,
  });
  Object.assign(ctx, { fetch: fetchFn });
  return ctx;
}

const baseConfig = {
  enabled: true,
  targets: [
    {
      name: 'Primary',
      webhookUrl: 'https://example.com/hook-a',
      method: 'POST',
      headers: [],
      events: ['decode', 'qso', 'slot', 'freq'],
      enabled: true,
    },
    {
      name: 'Alt',
      webhookUrl: 'https://example.com/hook-b?channel=test',
      method: 'GET',
      headers: [],
      events: ['decode', 'qso', 'slot', 'freq'],
      enabled: true,
    },
  ],
  batchWindowSec: 5,
  maxBatchSize: 20,
  retryCount: 2,
};

describe('webhook-push integration', () => {
  it('onLoad restarts timers without errors', () => {
    const { fetchFn } = createMockFetch();
    const ctx = makeContext(baseConfig, fetchFn);
    expect(() => plugin.onLoad(ctx)).not.toThrow();
  });

  it('queues decoded messages and flushes them to every enabled target', async () => {
    const { fetchFn, calls } = createMockFetch();
    const ctx = makeContext(baseConfig, fetchFn);
    plugin.onLoad(ctx);

    const messages = [
      { snr: -10, dt: 0.1, df: 0.2, rawMessage: 'CQ K1ABC FN42', message: { type: 'cq', senderCallsign: 'K1ABC' } },
      { snr: -12, dt: 0.2, df: 0.3, rawMessage: 'K1ABC K2XYZ -12', message: { type: 'call', senderCallsign: 'K1ABC' } },
    ];
    plugin.hooks?.onDecode?.(messages as never, ctx);

    await internals.flush(ctx);

    expect(calls).toHaveLength(2);
    const [first, second] = calls;

    expect(first.url).toBe('https://example.com/hook-a');
    expect(first.init.method).toBe('POST');
    expect(first.init.headers).toMatchObject({ 'content-type': 'application/json' });
    const jsonBody = JSON.parse(String(first.init.body));
    expect(jsonBody.schemaVersion).toBe(1);
    expect(jsonBody.operatorId).toBe('op-1');
    expect(jsonBody.events).toHaveLength(1);
    expect(jsonBody.events[0].type).toBe('decode');
    expect(jsonBody.events[0].data.messages).toHaveLength(2);

    expect(second.init.method).toBe('GET');
    expect(second.init.body).toBeUndefined();
    const url = new URL(second.url);
    expect(url.origin + url.pathname).toBe('https://example.com/hook-b');
    expect(url.searchParams.get('channel')).toBe('test');
    const getPayload = JSON.parse(url.searchParams.get('payload') ?? '{}');
    expect(getPayload.events[0].type).toBe('decode');
    expect(getPayload.events[0].data.messages).toHaveLength(2);
  });

  it('filters events per target and honors the enabled master switch', async () => {
    const { fetchFn, calls } = createMockFetch();
    const ctx = makeContext({
      ...baseConfig,
      targets: [
        { ...baseConfig.targets[0], events: ['qso'] },
        { ...baseConfig.targets[1], events: ['decode'] },
      ],
    }, fetchFn);
    const ctxOff = makeContext({ ...baseConfig, enabled: false }, fetchFn);

    const messages = [{ rawMessage: 'CQ K1ABC' }];
    plugin.hooks?.onDecode?.(messages as never, ctx);
    plugin.hooks?.onDecode?.(messages as never, ctxOff);
    plugin.hooks?.onSlotStart?.({} as never, messages as never, ctx);
    plugin.hooks?.onQSOStart?.({ targetCallsign: 'K1ABC', grid: 'FN42' } as never, ctx);
    plugin.hooks?.onQSOStart?.({ targetCallsign: 'K1ABC', grid: 'FN42' } as never, ctxOff);

    await internals.flush(ctx);
    await internals.flush(ctxOff);

    // Target A (qso only) receives only the qso event; target B (decode only)
    // receives only the decode event; the disabled ctx sends nothing.
    expect(calls).toHaveLength(2);
    const bodyA = JSON.parse(String(calls[0].init.body));
    expect(bodyA.events).toHaveLength(1);
    expect(bodyA.events[0].type).toBe('qso.start');
    const payloadB = JSON.parse(new URL(calls[1].url).searchParams.get('payload') ?? '{}');
    expect(payloadB.events).toHaveLength(1);
    expect(payloadB.events[0].type).toBe('decode');
  });

  it('retries failed deliveries up to retryCount', async () => {
    let okAttempts = 0;
    const { fetchFn, calls } = createMockFetch([
      () => new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
      () => {
        okAttempts += 1;
        return new Response('{"ok":true}', { status: 200, statusText: 'OK' });
      },
    ]);
    const singleTargetConfig = {
      ...baseConfig,
      targets: [{
        name: 'Primary',
        webhookUrl: 'https://example.com/hook-a',
        method: 'POST',
        events: ['decode', 'qso', 'slot', 'freq'],
        enabled: true,
      }],
      retryCount: 1,
    };
    const ctx = makeContext(singleTargetConfig, fetchFn);
    plugin.onLoad(ctx);

    plugin.hooks?.onDecode?.([{ rawMessage: 'CQ K1ABC' }] as never, ctx);
    await internals.flush(ctx);

    expect(calls).toHaveLength(2);
    expect(okAttempts).toBe(1);
  });

  it('drops a batch for a target that exhausts retries', async () => {
    const { fetchFn, calls } = createMockFetch([
      () => new Response('nope', { status: 500, statusText: 'Server Error' }),
      () => new Response('nope', { status: 500, statusText: 'Server Error' }),
      () => new Response('nope', { status: 500, statusText: 'Server Error' }),
      () => new Response('nope', { status: 500, statusText: 'Server Error' }),
    ]);
    const ctx = makeContext({ ...baseConfig, retryCount: 1 }, fetchFn);
    plugin.onLoad(ctx);

    plugin.hooks?.onDecode?.([{ rawMessage: 'CQ K1ABC' }] as never, ctx);
    await internals.flush(ctx);

    // Two targets, both fail on both attempts with retryCount 1 → 4 calls total.
    expect(calls).toHaveLength(4);
  });

  it('sends a test event when a row action fires and returns a structured result', async () => {
    const { fetchFn, calls } = createMockFetch();
    const ctx = makeContext(baseConfig, fetchFn);
    plugin.onLoad(ctx);

    const result = await plugin.hooks?.onUserAction?.('test:0', undefined, ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://example.com/hook-a');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.events[0].type).toBe('test');
    expect(body.events[0].data.message).toBe('Webhook test event');
    // 结构化结果随 onUserAction 返回值回传，供设置页按钮展示成败
    expect(result).toMatchObject({ ok: true, messageKey: 'testOk', params: { target: 'Primary', status: '200' } });
  });

  it('reports a failed test action with the failure reason', async () => {
    const { fetchFn } = createMockFetch([
      () => new Response('nope', { status: 502, statusText: 'Bad Gateway' }),
      () => new Response('nope', { status: 502, statusText: 'Bad Gateway' }),
      () => new Response('nope', { status: 502, statusText: 'Bad Gateway' }),
    ]);
    const ctx = makeContext({ ...baseConfig, retryCount: 2 }, fetchFn);
    plugin.onLoad(ctx);

    const result = await plugin.hooks?.onUserAction?.('test:0', undefined, ctx);

    expect(result).toMatchObject({ ok: false, messageKey: 'testFail' });
    expect((result as { params?: Record<string, unknown> }).params?.target).toBe('Primary');
  });

  it('blocks test actions while the master switch is off (no external requests)', async () => {
    const { fetchFn, calls } = createMockFetch();
    const ctx = makeContext({ ...baseConfig, enabled: false }, fetchFn);
    plugin.onLoad(ctx);

    const row = await plugin.hooks?.onUserAction?.('test:0', undefined, ctx);
    expect(row).toMatchObject({ ok: false, messageKey: 'testDisabled' });

    const all = await plugin.hooks?.onUserAction?.('sendTestAll', undefined, ctx);
    expect(all).toMatchObject({ ok: false, messageKey: 'testDisabled' });

    expect(calls).toHaveLength(0);
  });

  it('clamps config numbers to the schema ranges at runtime', () => {
    const { fetchFn } = createMockFetch();
    const ctx = makeContext({ ...baseConfig, batchWindowSec: 99999, maxBatchSize: 0, retryCount: -5 }, fetchFn);
    const setSpy = vi.spyOn(ctx.timers, 'set');

    plugin.onLoad(ctx);

    // 99999 → 60s 上限
    expect(setSpy).toHaveBeenCalledWith('flush', 60000);
  });

  it('deduplicates repeated test actions within the window', async () => {
    const { fetchFn, calls } = createMockFetch();
    const ctx = makeContext(baseConfig, fetchFn);
    plugin.onLoad(ctx);

    await plugin.hooks?.onUserAction?.('test:0', undefined, ctx);
    await plugin.hooks?.onUserAction?.('test:0', undefined, ctx);

    expect(calls).toHaveLength(1);
  });

  it('declares all settings as operator-scoped', () => {
    const settings = plugin.settings as unknown as Record<string, { scope?: string }>;
    for (const key of ['enabled', 'targets', 'batchWindowSec', 'maxBatchSize', 'retryCount']) {
      expect(settings[key]?.scope).toBe('operator');
    }
  });

  it('deduplicates test actions per operator instance', async () => {
    const { fetchFn: fetchA, calls: callsA } = createMockFetch();
    const ctxA = makeContext(baseConfig, fetchA);
    const { fetchFn: fetchB, calls: callsB } = createMockFetch();
    const ctxB = makeContext(baseConfig, fetchB);
    plugin.onLoad(ctxA);
    plugin.onLoad(ctxB);

    await plugin.hooks?.onUserAction?.('test:0', undefined, ctxA);
    await plugin.hooks?.onUserAction?.('test:0', undefined, ctxB);
    await plugin.hooks?.onUserAction?.('test:0', undefined, ctxA);

    // Each operator instance sends its own test; a repeated click within the
    // window is still collapsed per instance.
    expect(callsA).toHaveLength(1);
    expect(callsB).toHaveLength(1);
  });

  it('flushes a batch to several targets in parallel', async () => {
    const { fetchFn, calls } = createMockFetch([
      () => new Response('{"ok":true}', { status: 200 }),
      () => new Response('{"ok":true}', { status: 200 }),
      () => new Response('{"ok":true}', { status: 200 }),
    ]);
    const ctx = makeContext({
      ...baseConfig,
      targets: [
        { ...baseConfig.targets[0], webhookUrl: 'https://example.com/hook-a' },
        { ...baseConfig.targets[1], webhookUrl: 'https://example.com/hook-b?channel=test' },
        { ...baseConfig.targets[0], name: 'Third', webhookUrl: 'https://example.com/hook-c' },
      ],
    }, fetchFn);
    plugin.onLoad(ctx);

    plugin.hooks?.onDecode?.([{ rawMessage: 'CQ K1ABC' }] as never, ctx);
    await internals.flush(ctx);

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      const payload = call.init.body !== undefined
        ? String(call.init.body)
        : new URL(call.url).searchParams.get('payload') ?? '';
      expect(payload).toContain('"type":"decode"');
    }
  });

  it('limits normal delivery to the first five configured targets', async () => {
    const { fetchFn, calls } = createMockFetch();
    const targets = Array.from({ length: 6 }, (_, index) => ({
      ...baseConfig.targets[0],
      name: `Target ${index + 1}`,
      webhookUrl: `https://example.com/hook-${index + 1}`,
    }));
    const ctx = makeContext({ ...baseConfig, targets }, fetchFn);
    plugin.onLoad(ctx);

    plugin.hooks?.onDecode?.([{ rawMessage: 'CQ K1ABC' }] as never, ctx);
    await internals.flush(ctx);

    expect(calls).toHaveLength(5);
    expect(calls.map((call) => call.url)).toEqual([
      'https://example.com/hook-1',
      'https://example.com/hook-2',
      'https://example.com/hook-3',
      'https://example.com/hook-4',
      'https://example.com/hook-5',
    ]);
  });

  it('limits test-all delivery to the first five configured targets', async () => {
    const { fetchFn, calls } = createMockFetch();
    const targets = Array.from({ length: 6 }, (_, index) => ({
      ...baseConfig.targets[0],
      name: `Target ${index + 1}`,
      webhookUrl: `https://example.com/hook-${index + 1}`,
    }));
    const ctx = makeContext({ ...baseConfig, targets }, fetchFn);
    plugin.onLoad(ctx);

    const result = await plugin.hooks?.onUserAction?.('sendTestAll', undefined, ctx);

    expect(calls).toHaveLength(5);
    expect(result).toMatchObject({ ok: true, messageKey: 'testAllOk', params: { count: '5' } });
  });

  it('rejects row test actions beyond the configured target limit', async () => {
    const { fetchFn, calls } = createMockFetch();
    const targets = Array.from({ length: 6 }, (_, index) => ({
      ...baseConfig.targets[0],
      name: `Target ${index + 1}`,
      webhookUrl: `https://example.com/hook-${index + 1}`,
    }));
    const ctx = makeContext({ ...baseConfig, targets }, fetchFn);
    plugin.onLoad(ctx);

    const result = await plugin.hooks?.onUserAction?.('test:5', undefined, ctx);

    expect(result).toMatchObject({ ok: false, messageKey: 'testNotFound', params: { index: '6' } });
    expect(calls).toHaveLength(0);
  });

  it('automatically disables a target after its eleventh consecutive delivery failure', async () => {
    const { fetchFn, calls } = createMockFetch(
      Array.from({ length: 11 }, () => () => new Response('nope', { status: 500, statusText: 'Server Error' })),
    );
    const ctx = makeContext({
      ...baseConfig,
      retryCount: 0,
      targets: [{ ...baseConfig.targets[0], targetId: 'target-primary' }],
    }, fetchFn);
    const updateConfigSpy = vi.spyOn(ctx, 'updateConfig');
    plugin.onLoad(ctx);

    for (let index = 0; index < 10; index += 1) {
      plugin.hooks?.onDecode?.([{ rawMessage: `CQ K1ABC ${index}` }] as never, ctx);
      await internals.flush(ctx);
    }
    expect((ctx.config.targets as Array<{ enabled?: boolean }>)[0].enabled).not.toBe(false);

    plugin.hooks?.onDecode?.([{ rawMessage: 'CQ K1ABC final' }] as never, ctx);
    await internals.flush(ctx);

    expect(calls).toHaveLength(11);
    expect(updateConfigSpy).toHaveBeenLastCalledWith({
      targets: [expect.objectContaining({ enabled: false })],
    });
  });

  it('counts a retried delivery once and clears failures after a success', async () => {
    const responses = [
      ...Array.from({ length: 20 }, () => () => new Response('nope', { status: 500, statusText: 'Server Error' })),
      () => new Response('{"ok":true}', { status: 200 }),
      ...Array.from({ length: 10 }, () => () => new Response('nope', { status: 500, statusText: 'Server Error' })),
    ];
    const { fetchFn } = createMockFetch(responses);
    const ctx = makeContext({
      ...baseConfig,
      retryCount: 1,
      targets: [{ ...baseConfig.targets[0], targetId: 'target-primary' }],
    }, fetchFn);
    plugin.onLoad(ctx);

    for (let index = 0; index < 10; index += 1) {
      plugin.hooks?.onDecode?.([{ rawMessage: `CQ K1ABC failed ${index}` }] as never, ctx);
      await internals.flush(ctx);
    }
    expect((ctx.config.targets as Array<{ enabled?: boolean }>)[0].enabled).not.toBe(false);

    plugin.hooks?.onDecode?.([{ rawMessage: 'CQ K1ABC recovered' }] as never, ctx);
    await internals.flush(ctx);

    for (let index = 0; index < 5; index += 1) {
      plugin.hooks?.onDecode?.([{ rawMessage: `CQ K1ABC failed again ${index}` }] as never, ctx);
      await internals.flush(ctx);
    }
    expect((ctx.config.targets as Array<{ enabled?: boolean }>)[0].enabled).not.toBe(false);
  });

  it('skips GET targets whose payload would exceed the URL size limit', async () => {
    const { fetchFn, calls } = createMockFetch();
    const ctx = makeContext(baseConfig, fetchFn);
    plugin.onLoad(ctx);

    const hugeMessage = `CQ K1ABC ${'X'.repeat(5000)}`;
    plugin.hooks?.onDecode?.([{ rawMessage: hugeMessage }] as never, ctx);
    plugin.hooks?.onDecode?.([{ rawMessage: hugeMessage }] as never, ctx);
    await internals.flush(ctx);

    // The POST target still delivers; the GET target is skipped with an error.
    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe('POST');
    const logCalls = (ctx.log as unknown as { _calls: Array<{ level: string; message: string }> })._calls;
    expect(logCalls.some((entry) => entry.level === 'error' && entry.message.includes('GET payload exceeds'))).toBe(true);
  });

  it('attaches per-target custom headers only to that target', async () => {
    const { fetchFn, calls } = createMockFetch([
      () => new Response('{"ok":true}', { status: 200 }),
      () => new Response('{"ok":true}', { status: 200 }),
    ]);
    const ctx = makeContext({
      ...baseConfig,
      targets: [
        { ...baseConfig.targets[0], headers: ['Authorization: Bearer placeholder-token-abc'] },
        baseConfig.targets[1],
      ],
    }, fetchFn);
    plugin.onLoad(ctx);

    plugin.hooks?.onDecode?.([{ rawMessage: 'CQ K1ABC' }] as never, ctx);
    await internals.flush(ctx);

    expect(calls).toHaveLength(2);
    expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer placeholder-token-abc' });
    expect(calls[1].init.headers).not.toHaveProperty('Authorization');
  });

  it('resolves custom header casing over rendered defaults per target', async () => {
    const { fetchFn, calls } = createMockFetch([
      () => new Response('{"ok":true}', { status: 200 }),
      () => new Response('{"ok":true}', { status: 200 }),
    ]);
    const ctx = makeContext({
      ...baseConfig,
      targets: [
        { ...baseConfig.targets[0], headers: ['Content-Type: text/plain'] },
        baseConfig.targets[1],
      ],
    }, fetchFn);
    plugin.onLoad(ctx);

    plugin.hooks?.onDecode?.([{ rawMessage: 'CQ K1ABC' }] as never, ctx);
    await internals.flush(ctx);

    const headers = calls[0].init.headers as Record<string, string>;
    const contentTypeKeys = Object.keys(headers).filter((key) => key.toLowerCase() === 'content-type');
    expect(contentTypeKeys).toHaveLength(1);
    expect(headers[contentTypeKeys[0]]).toBe('text/plain');
  });

  it('respects maxBatchSize by leaving the rest queued', async () => {
    const { fetchFn, calls } = createMockFetch([
      () => new Response('{"ok":true}', { status: 200 }),
      () => new Response('{"ok":true}', { status: 200 }),
      () => new Response('{"ok":true}', { status: 200 }),
      () => new Response('{"ok":true}', { status: 200 }),
    ]);
    const ctx = makeContext({ ...baseConfig, maxBatchSize: 1 }, fetchFn);
    plugin.onLoad(ctx);

    plugin.hooks?.onDecode?.([{ rawMessage: 'CQ K1ABC' }] as never, ctx);
    plugin.hooks?.onFrequencyChange?.({ frequency: 7_074_000, band: '40m' } as never, ctx);
    await internals.flush(ctx);

    expect(calls).toHaveLength(2); // both targets got exactly 1 event
    const postBody = JSON.parse(String(calls[0].init.body));
    expect(postBody.events).toHaveLength(1);
    const getPayload = JSON.parse(new URL(calls[1].url).searchParams.get('payload') ?? '{}');
    expect(getPayload.events).toHaveLength(1);

    // The second event is still queued and delivered on the next flush.
    await internals.flush(ctx);
    expect(calls).toHaveLength(4);
    const secondPostBody = JSON.parse(String(calls[2].init.body));
    expect(secondPostBody.events).toHaveLength(1);
    expect(secondPostBody.events[0].type).toBe('freq');
  });
});