import type { PluginDefinition, PluginContext } from '@tx5dr/plugin-api';
import {
  filterEvent,
  formatSummary,
  isValidWebhookUrl,
  parseTargetRow,
  redactUrlDisplay,
  renderRequest,
  takeBatch,
  type ParsedTarget,
  type QueuedEvent,
} from './queue.js';
import { sendRequest, type HttpResult } from './transport.js';

/** Keep in sync with the `version` field in package.json. */
const PLUGIN_VERSION = '0.1.0';
const FLUSH_TIMER_ID = 'flush';
const TEST_ALL_ACTION = 'sendTestAll';
const TEST_ACTION_PREFIX = 'test:';
const MAX_QUEUE_LENGTH = 500;
const MAX_WEBHOOK_TARGETS = 5;
const MAX_CONSECUTIVE_DELIVERY_FAILURES = 10;
const DELIVERY_FAILURE_KEY_PREFIX = 'deliveryFailures:';
const DELIVERY_STATUS_KEY = 'deliveryStatus';
const DELIVERY_STATUS_PANEL_ID = 'delivery-status';
const MAX_DELIVERY_STATUS_ENTRIES = 20;
/**
 * Host execution budget for one hook invocation (BROADCAST_HOOK_TIMEOUT_MS is
 * 5s in the host). A flush must complete — including all retries — inside this
 * window, otherwise the guarded ctx.fetch fails fast with an expiration error
 * and the whole batch is dropped. Keeping the deadline under 5s leaves the
 * host time to run its own timeout, so slow endpoints fail with a clear
 * message instead of losing events to the invocation guard.
 */
const FLUSH_BUDGET_MS = 4_500;
/** GET pushes put the payload into the query string; common servers reject URLs beyond ~8KB. */
const MAX_GET_URL_LENGTH = 8_000;
/** Per-operator guard: repeated test actions within the window are collapsed. */
const DEDUP_WINDOW_MS = 10_000;

type WebhookContext = PluginContext;

interface RuntimeState {
  queue: QueuedEvent[];
  flushing: boolean;
  targetIdsReady?: Promise<void>;
  disablingTargetIds: Set<string>;
}

interface DeliveryFailureState {
  consecutive: number;
}

interface DeliveryStatusEntry {
  level: 'error' | 'warning';
  message: string;
  timestamp: string;
}

const states = new WeakMap<WebhookContext, RuntimeState>();

function runtimeState(ctx: WebhookContext): RuntimeState {
  let state = states.get(ctx);
  if (!state) {
    state = { queue: [], flushing: false, disablingTargetIds: new Set() };
    states.set(ctx, state);
  }
  return state;
}

/** 与 settings schema 的 min/max 一致；手改配置文件绕过 schema 时运行时钳位。 */
const CONFIG_LIMITS: Record<string, { min: number; max: number }> = {
  batchWindowSec: { min: 0, max: 60 },
  maxBatchSize: { min: 1, max: 100 },
  retryCount: { min: 0, max: 5 },
};

function getConfigNumber(ctx: WebhookContext, key: string, fallback: number): number {
  const value = ctx.config[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const limits = CONFIG_LIMITS[key];
  return limits ? Math.min(limits.max, Math.max(limits.min, value)) : value;
}

/**
 * Coarse enqueue gate: an event type is only queued when at least one
 * enabled target has selected it; fine-grained filtering happens per target
 * at flush time.
 */
function shouldEnqueue(ctx: WebhookContext, type: string): boolean {
  if (ctx.config.enabled === false) {
    return false;
  }
  return readTargets(ctx).some((target) => filterEvent(target.events, type));
}

function isTargetRow(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRawTargets(ctx: WebhookContext): unknown[] {
  return Array.isArray(ctx.config.targets) ? ctx.config.targets.slice(0, MAX_WEBHOOK_TARGETS) : [];
}

function createTargetId(): string {
  return `target-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

async function ensureTargetIds(ctx: WebhookContext): Promise<void> {
  const state = runtimeState(ctx);
  if (state.targetIdsReady) {
    return state.targetIdsReady;
  }
  state.targetIdsReady = (async () => {
    if (!Array.isArray(ctx.config.targets)) {
      return;
    }
    let changed = false;
    const targets = ctx.config.targets.map((row) => {
      if (!isTargetRow(row) || (typeof row.targetId === 'string' && row.targetId.trim())) {
        return row;
      }
      changed = true;
      return { ...row, targetId: createTargetId() };
    });
    if (!changed) {
      return;
    }
    try {
      await ctx.updateConfig({ targets });
    } catch (error) {
      state.targetIdsReady = undefined;
      ctx.log.error('webhook-push: could not assign stable target IDs', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  return state.targetIdsReady;
}

function readTargets(ctx: WebhookContext): ParsedTarget[] {
  return readRawTargets(ctx)
    .map((row, index) => parseTargetRow(row, index))
    .filter((target) => target.enabled && isValidWebhookUrl(target.webhookUrl));
}

function readTargetByIndex(ctx: WebhookContext, index: number): ParsedTarget | undefined {
  const raw = readRawTargets(ctx);
  if (index < 0 || index >= raw.length) {
    return undefined;
  }
  const target = parseTargetRow(raw[index], index);
  if (!target.enabled || !isValidWebhookUrl(target.webhookUrl)) {
    return undefined;
  }
  return target;
}

function enqueue(ctx: WebhookContext, type: string, data: Record<string, unknown>): void {
  if (ctx.config.enabled === false) {
    return;
  }
  const state = runtimeState(ctx);
  state.queue.push({ type, timestamp: Date.now(), data });
  if (state.queue.length > MAX_QUEUE_LENGTH) {
    state.queue.splice(0, state.queue.length - MAX_QUEUE_LENGTH);
  }
}

/**
 * Merges custom headers over the rendered defaults. Duplicate keys are
 * resolved case-insensitively (e.g. a user-provided `Content-Type` replaces
 * the default `content-type`) so the rendered defaults never leak through.
 */
function mergeHeaders(base: Record<string, string>, custom: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = { ...base };
  for (const [key, value] of Object.entries(custom)) {
    const existingKey = Object.keys(merged).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (existingKey) {
      delete merged[existingKey];
    }
    merged[key] = value;
  }
  return merged;
}

function targetLabel(target: ParsedTarget): string {
  // 日志与 UI 展示一律用脱敏 URL：不回显 userinfo 与查询参数中的潜在凭据
  return target.name ?? redactUrlDisplay(target.webhookUrl);
}

interface DeliveryResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * 测试动作的结果会随 onUserAction 的返回值回传到设置页（主程序通过
 * PLUGIN_USER_ACTION_RESULT 消息转交前端，messageKey 走插件 i18n 命名空间）。
 * 旧版主程序不回传，前端会显示"未收到主机反馈"。
 */
interface ActionResult {
  ok: boolean;
  messageKey?: string;
  params?: Record<string, string>;
  message?: string;
}

function publishDeliveryStatus(ctx: WebhookContext, entry?: DeliveryStatusEntry): void {
  const current = ctx.store.operator.get<DeliveryStatusEntry[]>(DELIVERY_STATUS_KEY, []);
  const entries = entry ? [entry, ...current].slice(0, MAX_DELIVERY_STATUS_ENTRIES) : current;
  if (entry) {
    ctx.store.operator.set(DELIVERY_STATUS_KEY, entries);
  }
  ctx.ui.send(DELIVERY_STATUS_PANEL_ID, entries);
}

async function disableFailedTarget(ctx: WebhookContext, target: ParsedTarget, consecutive: number): Promise<void> {
  if (!target.targetId) {
    return;
  }
  const state = runtimeState(ctx);
  if (state.disablingTargetIds.has(target.targetId)) {
    return;
  }
  state.disablingTargetIds.add(target.targetId);
  try {
    if (!Array.isArray(ctx.config.targets)) {
      return;
    }
    let found = false;
    const targets = ctx.config.targets.map((row) => {
      if (!isTargetRow(row) || row.targetId !== target.targetId || row.enabled === false) {
        return row;
      }
      found = true;
      return { ...row, enabled: false };
    });
    if (!found) {
      return;
    }
    await ctx.updateConfig({ targets });
    const message = `Target ${targetLabel(target)} was automatically disabled after ${consecutive} consecutive delivery failures. Fix it and enable it manually.`;
    publishDeliveryStatus(ctx, { level: 'error', message, timestamp: new Date().toISOString() });
    ctx.log.error('webhook-push: target automatically disabled after consecutive delivery failures', {
      target: targetLabel(target),
      consecutive,
    });
  } catch (error) {
    ctx.log.error('webhook-push: could not automatically disable failed target', {
      target: targetLabel(target),
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    state.disablingTargetIds.delete(target.targetId);
  }
}

async function recordDeliveryResult(ctx: WebhookContext, target: ParsedTarget, result: DeliveryResult): Promise<void> {
  if (!target.targetId) {
    return;
  }
  const key = `${DELIVERY_FAILURE_KEY_PREFIX}${target.targetId}`;
  if (result.ok) {
    ctx.store.operator.delete(key);
    return;
  }
  const previous = ctx.store.operator.get<DeliveryFailureState>(key, { consecutive: 0 });
  const consecutive = previous.consecutive + 1;
  ctx.store.operator.set(key, { consecutive });
  if (consecutive > MAX_CONSECUTIVE_DELIVERY_FAILURES) {
    await disableFailedTarget(ctx, target, consecutive);
  }
}

async function sendBatchToTarget(
  ctx: WebhookContext,
  target: ParsedTarget,
  events: readonly QueuedEvent[],
): Promise<DeliveryResult> {
  const sentAt = new Date().toISOString();
  const renderContext = {
    plugin: 'webhook-push',
    pluginVersion: PLUGIN_VERSION,
    operatorId: ctx.operator.id,
    sentAt,
    summary: formatSummary(events),
  };

  const request = renderRequest(target, events, renderContext);

  if (target.method === 'GET' && request.url.length > MAX_GET_URL_LENGTH) {
    ctx.log.error('webhook-push: GET payload exceeds URL size limit; switch this target to POST or reduce maxBatchSize', {
      target: targetLabel(target),
      urlLength: request.url.length,
    });
    const result = { ok: false, error: 'GET payload exceeds URL size limit' };
    await recordDeliveryResult(ctx, target, result);
    return result;
  }

  const headers = mergeHeaders(request.headers, target.headers);
  const fetchFn = ctx.fetch;
  if (!fetchFn) {
    ctx.log.error('webhook-push: network permission is not available', { target: targetLabel(target) });
    const result = { ok: false, error: 'network permission is not available' };
    await recordDeliveryResult(ctx, target, result);
    return result;
  }
  const retries = getConfigNumber(ctx, 'retryCount', 2);
  const attempts = Math.max(0, Math.floor(retries)) + 1;
  // Each attempt may use the remaining flush budget; the whole send (retries
  // included) must finish before the host revokes this hook invocation.
  const deadline = Date.now() + FLUSH_BUDGET_MS;

  let result: HttpResult | undefined;
  let lastError: string | undefined;
  for (let attempt = 0; attempt < attempts && !result?.ok; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 150) {
      lastError ??= 'send budget exhausted';
      break;
    }
    try {
      result = await sendRequest({ fetchFn, timeoutMs: remaining }, { ...request, headers });
      if (result && !result.ok) {
        lastError = `HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ''}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  if (!result?.ok) {
    ctx.log.error('webhook-push: event delivery failed', {
      target: targetLabel(target),
      error: lastError ?? 'unknown error',
      eventCount: events.length,
    });
    const delivery = { ok: false, error: lastError ?? 'unknown error' };
    await recordDeliveryResult(ctx, target, delivery);
    return delivery;
  }
  const delivery = { ok: true, status: result.status };
  await recordDeliveryResult(ctx, target, delivery);
  return delivery;
}

async function flush(ctx: WebhookContext): Promise<void> {
  const state = runtimeState(ctx);
  if (ctx.config.enabled === false || state.queue.length === 0 || state.flushing) {
    return;
  }
  await ensureTargetIds(ctx);
  const targets = readTargets(ctx);
  if (targets.length === 0) {
    return;
  }
  const maxBatchSize = getConfigNumber(ctx, 'maxBatchSize', 20);
  const { batch, rest } = takeBatch(state.queue, maxBatchSize);
  state.queue.length = 0;
  state.queue.push(...rest);
  state.flushing = true;
  try {
    // Targets run in parallel so a slow endpoint does not eat the host's hook
    // budget (and thereby the retries) of the remaining targets.
    await Promise.all(targets.map(async (target) => {
      const filtered = batch.filter((event) => filterEvent(target.events, event.type));
      if (filtered.length === 0) {
        return;
      }
      await sendBatchToTarget(ctx, target, filtered);
    }));
  } finally {
    state.flushing = false;
  }
}

function restartTimers(ctx: WebhookContext): void {
  const windowSec = getConfigNumber(ctx, 'batchWindowSec', 5);
  const windowMs = windowSec > 0 ? windowSec * 1000 : 100;
  ctx.timers.set(FLUSH_TIMER_ID, windowMs);
}

/**
 * Per-operator dedup: test actions are collapsed within the window so a
 * repeated click (or a re-dispatch to the same instance) does not send twice.
 * Each operator instance keeps its own mark, so operators never suppress each
 * other's tests.
 */
function isDuplicateTestAction(ctx: WebhookContext, key: string): boolean {
  const now = Date.now();
  const last = ctx.store.operator.get<number>(`dedup:${key}`, 0);
  if (now - last < DEDUP_WINDOW_MS) {
    return true;
  }
  ctx.store.operator.set(`dedup:${key}`, now);
  return false;
}

async function sendTestEvent(ctx: WebhookContext, target: ParsedTarget): Promise<DeliveryResult> {
  const queueDepth = runtimeState(ctx).queue.length;
  const events: QueuedEvent[] = [{
    type: 'test',
    timestamp: Date.now(),
    data: {
      frequency: ctx.radio.frequency,
      band: ctx.radio.band,
      queueDepth,
      message: 'Webhook test event',
    },
  }];
  return sendBatchToTarget(ctx, target, events);
}

/**
 * 行内测试按钮（test:index）与 sendTestAll 的动作处理。
 * 返回结构化结果供主程序回传并展示：ok 决定颜色，messageKey 走插件 i18n。
 * 总开关关闭时短路（不发出任何请求）；去重命中返回 testDeduped 文案；
 * 未知动作返回 undefined（前端按"无主机反馈"降级）。
 */
async function handleUserAction(actionId: string, _payload: unknown, ctx: WebhookContext): Promise<ActionResult | undefined> {
  // H2：总开关关闭时测试按钮也必须停止外发，与收集/入队/flush 的门控一致
  if (ctx.config.enabled === false) {
    return { ok: false, messageKey: 'testDisabled' };
  }
  await ensureTargetIds(ctx);
  if (actionId === TEST_ALL_ACTION) {
    if (isDuplicateTestAction(ctx, TEST_ALL_ACTION)) {
      return { ok: true, messageKey: 'testDeduped' };
    }
    const targets = readTargets(ctx);
    let sent = 0;
    let firstError: string | undefined;
    for (const target of targets) {
      const result = await sendTestEvent(ctx, target);
      if (result.ok) {
        sent += 1;
      } else {
        firstError ??= result.error;
      }
    }
    if (sent === targets.length) {
      return { ok: true, messageKey: 'testAllOk', params: { count: String(sent) } };
    }
    return { ok: false, messageKey: 'testAllFail', params: { count: String(sent), error: firstError ?? 'unknown' } };
  }
  if (actionId.startsWith(TEST_ACTION_PREFIX)) {
    const index = Number(actionId.slice(TEST_ACTION_PREFIX.length));
    const target = readTargetByIndex(ctx, index);
    if (!target) {
      ctx.log.error('webhook-push: test target not found or disabled', { index });
      return { ok: false, messageKey: 'testNotFound', params: { index: String(index + 1) } };
    }
    if (isDuplicateTestAction(ctx, actionId)) {
      return { ok: true, messageKey: 'testDeduped' };
    }
    const result = await sendTestEvent(ctx, target);
    return result.ok
      ? { ok: true, messageKey: 'testOk', params: { target: targetLabel(target), status: String(result.status ?? '') } }
      : { ok: false, messageKey: 'testFail', params: { target: targetLabel(target), error: result.error ?? 'unknown' } };
  }
  return undefined;
}

/**
 * Settings use the row-level control types provided by the host's
 * `feat/plugin-settings-controls` branch (object[] radio/multiselect/action/
 * string[]/fullWidth). The host validates descriptors at load time; the cast
 * keeps the published `@tx5dr/plugin-api` types from blocking the extra
 * row fields, and parseTargetRow accepts both string and array forms so
 * saved values from hosts without the controls still parse.
 */
const settings = {
  enabled: {
    type: 'boolean',
    default: true,
    label: 'enabled',
    description: 'enabledDesc',
    scope: 'operator',
  },
  targets: {
    type: 'object[]',
    default: [],
    label: 'targets',
    description: 'targetsDesc',
    scope: 'operator',
    itemFields: [
      { key: 'name', type: 'string', label: 'targetName', description: 'targetNameDesc' },
      { key: 'enabled', type: 'boolean', label: 'targetEnabled', description: 'targetEnabledDesc', default: true },
      {
        key: 'webhookUrl',
        type: 'string',
        label: 'targetWebhookUrl',
        description: 'targetWebhookUrlDesc',
        required: true,
      },
      {
        key: 'method',
        type: 'radio',
        label: 'targetMethod',
        description: 'targetMethodDesc',
        options: [
          { value: 'POST', label: 'POST' },
          { value: 'GET', label: 'GET' },
        ],
        default: 'POST',
        fullWidth: false,
      },
      {
        key: 'headers',
        type: 'string[]',
        label: 'targetHeaders',
        description: 'targetHeadersDesc',
        fullWidth: true,
      },
      {
        key: 'events',
        type: 'multiselect',
        label: 'targetEvents',
        description: 'targetEventsDesc',
        options: [
          { value: 'decode', label: 'eventDecode' },
          { value: 'qso', label: 'eventQSO' },
          { value: 'slot', label: 'eventSlot' },
          { value: 'freq', label: 'eventFreq' },
        ],
        default: ['decode', 'qso'],
        fullWidth: true,
      },
      {
        key: 'test',
        type: 'action',
        label: 'targetTest',
        description: 'targetTestDesc',
        fullWidth: true,
      },
    ],
  },
  batchWindowSec: {
    type: 'number',
    default: 5,
    label: 'batchWindowSec',
    description: 'batchWindowSecDesc',
    scope: 'operator',
    min: 0,
    max: 60,
  },
  maxBatchSize: {
    type: 'number',
    default: 20,
    label: 'maxBatchSize',
    description: 'maxBatchSizeDesc',
    scope: 'operator',
    min: 1,
    max: 100,
  },
  retryCount: {
    type: 'number',
    default: 2,
    label: 'retryCount',
    description: 'retryCountDesc',
    scope: 'operator',
    min: 0,
    max: 5,
  },
} as unknown as PluginDefinition['settings'];

const webhookPushPlugin: PluginDefinition = {
  name: 'webhook-push',
  version: PLUGIN_VERSION,
  type: 'utility',
  instanceScope: 'operator',
  description: 'pluginDescription',
  permissions: ['network'],

  settings,

  quickSettings: [{ settingKey: 'enabled' }],

  quickActions: [
    { id: TEST_ALL_ACTION, label: 'sendTestAll' },
  ],

  panels: [
    { id: DELIVERY_STATUS_PANEL_ID, title: 'deliveryStatusPanel', component: 'log' },
  ],

  onLoad(ctx) {
    restartTimers(ctx);
    publishDeliveryStatus(ctx);
  },

  onUnload(ctx) {
    const state = states.get(ctx);
    if (state && state.queue.length > 0) {
      ctx.log.warn('webhook-push: dropping queued events on unload', { count: state.queue.length });
    }
    states.delete(ctx);
  },

  hooks: {
    onDecode(messages, ctx) {
      if (!shouldEnqueue(ctx, 'decode') || !Array.isArray(messages) || messages.length === 0) {
        return;
      }
      enqueue(ctx, 'decode', {
        messages,
        frequency: ctx.radio.frequency,
        band: ctx.radio.band,
      });
    },

    onSlotStart(slotInfo, messages, ctx) {
      if (!shouldEnqueue(ctx, 'slot')) {
        return;
      }
      enqueue(ctx, 'slot', {
        messageCount: Array.isArray(messages) ? messages.length : 0,
        slotInfo,
        frequency: ctx.radio.frequency,
        band: ctx.radio.band,
      });
    },

    onFrequencyChange(state, ctx) {
      if (!shouldEnqueue(ctx, 'freq')) {
        return;
      }
      enqueue(ctx, 'freq', {
        frequency: state.frequency,
        band: state.band,
      });
    },

    onQSOStart(info, ctx) {
      if (!shouldEnqueue(ctx, 'qso')) {
        return;
      }
      enqueue(ctx, 'qso.start', {
        targetCallsign: info.targetCallsign,
        grid: info.grid,
        frequency: ctx.radio.frequency,
        band: ctx.radio.band,
      });
    },

    onQSOComplete(record, ctx) {
      if (!shouldEnqueue(ctx, 'qso')) {
        return;
      }
      enqueue(ctx, 'qso.complete', {
        record,
        frequency: ctx.radio.frequency,
        band: ctx.radio.band,
      });
    },

    onQSOFail(info, ctx) {
      if (!shouldEnqueue(ctx, 'qso')) {
        return;
      }
      enqueue(ctx, 'qso.fail', {
        targetCallsign: 'targetCallsign' in info ? info.targetCallsign : undefined,
        reason: info.reason,
        frequency: ctx.radio.frequency,
        band: ctx.radio.band,
      });
    },

    onTimer(timerId, ctx) {
      if (timerId === FLUSH_TIMER_ID) {
        // flush 内 renderRequest 的 JSON.stringify 可能因不可序列化数据拒绝，
        // 捕获后仅记日志，避免未处理拒绝泄漏到宿主。
        void flush(ctx).catch((error) => {
          ctx.log.error('webhook-push: flush failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    },

    onUserAction: handleUserAction as unknown as NonNullable<PluginDefinition['hooks']>['onUserAction'],

    onConfigChange(_changes, ctx) {
      restartTimers(ctx);
    },
  },
};

export default webhookPushPlugin;

/** Internal surface used by integration tests; not part of the plugin API. */
export const internals = { flush, enqueue };