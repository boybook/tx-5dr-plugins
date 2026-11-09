/**
 * Pure queue/payload logic for the webhook-push plugin.
 *
 * This module must stay free of any runtime or node-only imports so it can be
 * unit-tested in isolation.
 */

export type TargetMethod = 'GET' | 'POST';

/** Matches RFC 9110 token production used by HTTP header field names. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export interface ParsedTarget {
  /** Internal stable identifier used for delivery health state. */
  targetId?: string;
  name?: string;
  webhookUrl: string;
  method: TargetMethod;
  /** Per-target custom request headers, resolved case-insensitively. */
  headers: Record<string, string>;
  /** Event types this target should receive. */
  events: string[];
  enabled: boolean;
}

export interface QueuedEvent {
  type: string;
  /** epoch milliseconds */
  timestamp: number;
  data: Record<string, unknown>;
}

export interface RenderContext {
  plugin: string;
  pluginVersion: string;
  operatorId: string;
  /** ISO timestamp of the send */
  sentAt: string;
  summary: string;
}

export interface RenderedRequest {
  method: TargetMethod;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

const SUMMARY_LINE_LIMIT = 200;

/** Accepts only absolute http(s) URLs without embedded credentials. */
export function isValidWebhookUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.trim() === '') {
    return false;
  }
  try {
    const parsed = new URL(url.trim());
    if (parsed.username || parsed.password) {
      return false;
    }
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * URL 用于日志/UI 展示的脱敏形态：剥离 userinfo 与查询参数（查询串可能携带
 * token 等凭据），解析失败返回占位符。
 */
export function redactUrlDisplay(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '<invalid url>';
  }
}

/** Unknown or empty method values fall back to POST. */
export function normalizeMethod(value: unknown): TargetMethod {
  const candidate = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return candidate === 'GET' ? 'GET' : 'POST';
}

/**
 * Parses `Name: value` lines into a header map. Lines without a colon are
 * skipped, header names must be valid RFC 9110 tokens and values must not
 * contain line breaks (which would allow header injection).
 */
export function parseHeaderLines(lines: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of lines) {
    if (typeof line !== 'string') {
      continue;
    }
    const separator = line.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!HEADER_NAME_PATTERN.test(name) || /[\r\n]/.test(value)) {
      continue;
    }
    headers[name] = value;
  }
  return headers;
}

/**
 * Parses one raw object[] row of the `targets` setting into a typed target.
 * Missing or malformed fields are replaced with safe defaults; the caller is
 * responsible for filtering targets with an empty/disabled webhookUrl.
 */
export function parseTargetRow(row: unknown, index: number): ParsedTarget {
  const source = row && typeof row === 'object' && !Array.isArray(row)
    ? row as Record<string, unknown>
    : {};
  const name = typeof source.name === 'string' && source.name.trim()
    ? source.name.trim().replace(/[\r\n]+/g, ' ').slice(0, 64)
    : undefined;
  const webhookUrl = typeof source.webhookUrl === 'string' ? source.webhookUrl.trim() : '';
  const rawHeaders = Array.isArray(source.headers)
    ? source.headers.filter((item): item is string => typeof item === 'string')
    : typeof source.headers === 'string'
      ? source.headers.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean)
      : [];
  const events = Array.isArray(source.events)
    ? source.events.filter((item): item is string => typeof item === 'string')
    : typeof source.events === 'string' && source.events.trim()
      ? source.events.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean)
      : [];
  return {
    targetId: typeof source.targetId === 'string' && source.targetId.trim()
      ? source.targetId.trim().slice(0, 128)
      : undefined,
    name: name ?? (index >= 0 ? `target-${index + 1}` : undefined),
    webhookUrl,
    method: normalizeMethod(source.method),
    headers: parseHeaderLines(rawHeaders),
    events,
    enabled: source.enabled !== false,
  };
}

/** qso.* sub-events are matched by the top-level `qso` selection. */
export function filterEvent(selected: readonly string[], type: string): boolean {
  if (!selected || selected.length === 0) {
    return false;
  }
  if (selected.includes(type)) {
    return true;
  }
  if (type.startsWith('qso.')) {
    return selected.includes('qso');
  }
  return false;
}

/** Splits a queue into the first `max` events and the remainder. */
export function takeBatch(
  queue: readonly QueuedEvent[],
  max: number,
): { batch: QueuedEvent[]; rest: QueuedEvent[] } {
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 1;
  return {
    batch: queue.slice(0, limit),
    rest: queue.slice(limit),
  };
}

/** Local-time HH:mm:ss label for a timestamp. */
export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function truncate(text: string, limit: number = SUMMARY_LINE_LIMIT): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, limit - 1)}…`;
}

function readString(data: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function readMessages(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = data.messages;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is Record<string, unknown> =>
    Boolean(item) && typeof item === 'object' && !Array.isArray(item)
  );
}

function formatFrequency(hertz: unknown): string {
  const value = typeof hertz === 'number' && Number.isFinite(hertz) ? hertz : Number(hertz);
  if (!Number.isFinite(value)) {
    return '';
  }
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(3)}MHz` : `${(value / 1_000).toFixed(1)}kHz`;
}

function formatBand(data: Record<string, unknown>): string {
  const band = readString(data, ['band']);
  return band ? ` ${band}` : '';
}

/** One human-readable line per queued event. */
export function formatSummary(events: readonly QueuedEvent[]): string {
  return events.map((event) => {
    const time = formatTime(event.timestamp);
    const data = event.data ?? {};
    const prefix = `[${time}] ${event.type}`;

    switch (event.type) {
      case 'decode': {
        const messages = readMessages(data);
        const count = messages.length > 0 ? messages.length : (readString(data, ['count']) ?? '0');
        const freq = formatFrequency(data.frequency);
        const pieces = messages
          .slice(0, 3)
          .map((message) => readString(message, ['rawMessage', 'text']) ?? '')
          .filter(Boolean);
        const detail = pieces.length > 0 ? `: ${pieces.join(' | ')}` : '';
        return truncate(`${prefix} ×${count}${freq ? ` (${freq}${formatBand(data)})` : ''}${detail}`);
      }
      case 'qso.start': {
        const callsign = readString(data, ['targetCallsign']);
        const grid = readString(data, ['grid']);
        return truncate(`${prefix}: ${callsign ?? '?'}${grid ? ` (${grid})` : ''}`);
      }
      case 'qso.complete': {
        const record = data.record && typeof data.record === 'object' && !Array.isArray(data.record)
          ? data.record as Record<string, unknown>
          : {};
        const callsign = readString(record, ['callsign']);
        const mode = readString(record, ['mode']);
        const freq = formatFrequency(record.frequency);
        const detail = [mode, freq].filter(Boolean).join(', ');
        return truncate(`${prefix}: ${callsign ?? '?'}${detail ? ` (${detail})` : ''}`);
      }
      case 'qso.fail': {
        const callsign = readString(data, ['targetCallsign']);
        const reason = readString(data, ['reason']);
        return truncate(`${prefix}: ${callsign ?? '?'}${reason ? ` (${reason})` : ''}`);
      }
      case 'slot': {
        const count = readString(data, ['messageCount', 'count']);
        return truncate(`${prefix}: ${count ?? '?'} messages`);
      }
      case 'freq': {
        const freq = formatFrequency(data.frequency);
        return truncate(`${prefix}: ${freq || '?'}${formatBand(data)}`);
      }
      default: {
        const message = readString(data, ['message']);
        return truncate(message ? `${prefix}: ${message}` : prefix);
      }
    }
  }).join('\n');
}

/** Builds the request for a single target. POST sends JSON as the body. */
export function renderRequest(
  target: ParsedTarget,
  events: readonly QueuedEvent[],
  ctx: RenderContext,
): RenderedRequest {
  const payload = {
    schemaVersion: 1,
    plugin: ctx.plugin,
    pluginVersion: ctx.pluginVersion,
    operatorId: ctx.operatorId,
    sentAt: ctx.sentAt,
    events: events.map((event) => ({ type: event.type, timestamp: event.timestamp, data: event.data })),
  };

  if (target.method === 'GET') {
    const separator = target.webhookUrl.includes('?') ? '&' : '?';
    return {
      method: 'GET',
      url: `${target.webhookUrl}${separator}payload=${encodeURIComponent(JSON.stringify(payload))}`,
      headers: {},
    };
  }

  return {
    method: 'POST',
    url: target.webhookUrl,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}