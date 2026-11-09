// WaveLog Bridge for TX-5DR
// 基于 BI7ALG/tx5dr-waveloggate-plugin 2.1.0 修改：
//   1. 改为全局单实例，避免多个操作员重复上报、重复占用端口
//   2. 增加心跳：频率/模式不变时也定期上报，防止 WaveLog 判定电台离线
//   3. 增加 WaveLog Bandmap 点击切频回调（本地 HTTP 监听，默认 127.0.0.1:54321）
//   4. API URL 默认留空，未填写时不上报

import http from 'node:http';

const PLUGIN_NAME = 'tx5dr-waveloggate-bridge';
const SERVER_KEY = Symbol.for(`${PLUGIN_NAME}.httpServer`);

// ---------- 运行状态 ----------
let lastFreq = null;
let lastMode = null;
let lastPushAt = 0;
let pushing = false;
let pendingTune = null; // { frequency, mode, receivedAt }
let tuning = false;
let logRef = null; // ctx.log 可在回调外使用

// ---------- FT8 / FT4 标准拨号频率（Hz） ----------
const FT8_DIALS = [1840000, 3573000, 5357000, 7074000, 10136000, 14074000, 18100000,
    21074000, 24915000, 28074000, 50313000, 144174000];
const FT4_DIALS = [3575500, 7047500, 10140000, 14080000, 18104000, 21140000, 24919000,
    28180000, 50318000, 144170000];

// ---------- 模式转换 ----------
function getWaveLogMode(modeObj) {
    if (!modeObj) return 'SSB';
    const { mode, submode, radioMode } = modeObj;

    if (submode) {
        const s = String(submode).toUpperCase();
        const digital = ['FT8', 'FT4', 'JS8', 'SSTV', 'RTTY', 'PSK31', 'JT65', 'JT9', 'WSPR'];
        const hit = digital.find((m) => s.includes(m));
        if (hit) return hit;
        if (s === 'DATA-U' || s === 'DATA-L') return 'DATA';
        if (['USB', 'LSB', 'FM', 'AM', 'CW'].includes(s)) return s;
    }
    if (mode) {
        const m = String(mode).toUpperCase();
        if (['FT8', 'FT4', 'SSTV', 'RTTY', 'CW', 'FM', 'AM', 'SSB', 'DATA'].includes(m)) return m;
    }
    if (radioMode) {
        const r = String(radioMode).toUpperCase();
        if (r.startsWith('CW')) return 'CW';
        if (r.startsWith('DATA')) return 'DATA';
        if (['USB', 'LSB', 'FM', 'AM'].includes(r)) return r;
    }
    return 'SSB';
}

// 统一换算为旧版接口 <WaveLog 根地址>/index.php/api/radio
// 兼容填写：根地址、/index.php、/index.php/api、/api/v2、/api/v2/radio、完整接口地址等
function resolveApiUrl(raw) {
    let url = String(raw ?? '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    if (/\/(index\.php\/)?api\/radio$/i.test(url)) return url;
    const cut = url.search(/\/(index\.php|api)(\/|$)/i);
    const base = cut >= 0 ? url.slice(0, cut) : url;
    return base + '/index.php/api/radio';
}

// 失败退避：避免地址或 Key 错误时每次轮询都请求并刷屏
let failCount = 0;
let nextAttemptAt = 0;
let lastErrorText = '';

function logError(message, details) { logRef?.error(message, details); }
function logDebug(message, details) { logRef?.debug?.(message, details); }

function recordFailure(message, details) {
    failCount += 1;
    const delay = Math.min(300000, 5000 * 2 ** (failCount - 1));
    nextAttemptAt = Date.now() + delay;
    const text = `${message}|${JSON.stringify(details)}`;
    const payload = { ...details, retryInSeconds: Math.round(delay / 1000) };
    if (text !== lastErrorText || failCount <= 1) logError(message, payload);
    else logDebug(message, payload);
    lastErrorText = text;
}

function recordSuccess() {
    failCount = 0;
    nextAttemptAt = 0;
    lastErrorText = '';
}

// ---------- 上报：TX-5DR → WaveLog ----------
// 注意：TX-5DR 对 onTimer 等回调限时 5 秒，超时且 1 秒内未结束会停用插件。
// 因此这里只在回调内读取 ctx 并发起请求，网络等待在回调之外进行，且请求自带超时。
const HTTP_TIMEOUT_MS = 4000;

function pushRadio(ctx) {
    if (pushing) return;
    if (!ctx.radio?.isConnected) return;

    const apiUrl = resolveApiUrl(ctx.config.apiUrl);
    const apiKey = String(ctx.config.apiKey ?? '').trim();
    if (!apiUrl || !apiKey) return;

    const freq = ctx.radio.frequency;
    if (!freq) return;
    const mode = getWaveLogMode(ctx.radio.mode);

    const heartbeatMs = Math.max(0, Number(ctx.config.heartbeatSeconds) || 0) * 1000;
    const changed = freq !== lastFreq || mode !== lastMode;
    const heartbeatDue = heartbeatMs > 0 && Date.now() - lastPushAt >= heartbeatMs;
    if (!changed && !heartbeatDue) return;
    if (Date.now() < nextAttemptAt) return;

    pushing = true;
    let request;
    try {
        request = ctx.fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                key: apiKey,
                radio: ctx.config.radioName || 'TX-5DR',
                frequency: freq,
                mode,
                timestamp: new Date().toISOString().replace('T', ' ').substring(0, 16),
            }),
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
    } catch (e) {
        pushing = false;
        recordFailure('上报 WaveLog 失败', { apiUrl, message: e?.message });
        return;
    }

    // 不在回调内等待结果
    void (async () => {
        try {
            const res = await request;
            const body = await res.text().catch(() => '');
            if (/<!doctype html|<html/i.test(body)) {
                recordFailure('WaveLog 返回网页而非 JSON，请检查 API URL 和 API Key', { status: res.status, apiUrl });
                return;
            }
            let json = null;
            try { json = JSON.parse(body); } catch { /* 下面统一处理 */ }
            if (res.ok && json && (json.status === 'ok' || json.status === 'success')) {
                recordSuccess();
                lastFreq = freq;
                lastMode = mode;
                lastPushAt = Date.now();
                if (changed) logRef?.info('已同步到 WaveLog', { freq, mode });
            } else {
                const hint = res.status === 404
                    ? '接口地址不存在：API URL 请只填 WaveLog 根地址，例如 https://log.example.com'
                    : res.status === 401 || res.status === 403
                        ? 'API Key 无效或权限不足，请使用读写 Key'
                        : undefined;
                recordFailure('WaveLog 返回错误', { status: res.status, apiUrl, hint, body: body.substring(0, 200) });
            }
        } catch (e) {
            const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
            recordFailure(timedOut ? 'WaveLog 响应超时' : '上报 WaveLog 失败', {
                apiUrl,
                message: timedOut ? `超过 ${HTTP_TIMEOUT_MS / 1000} 秒未响应` : e?.message,
            });
        } finally {
            pushing = false;
        }
    })();
}

// ---------- 切频：WaveLog Bandmap → TX-5DR ----------
function snapToDigitalDial(freq, currentMode) {
    const dials = currentMode === 'FT4' ? FT4_DIALS : currentMode === 'FT8' ? FT8_DIALS : null;
    if (!dials) return freq;
    // FT8/FT4 信号位于拨号频率之上 0~3.5 kHz 音频范围内
    const dial = dials.find((d) => freq >= d && freq <= d + 3500);
    return dial ?? freq;
}

function drainTuneQueue(ctx) {
    if (tuning || !pendingTune) return;
    const req = pendingTune;
    pendingTune = null;

    // 超过 10 秒仍未执行的请求直接丢弃，避免延迟后突然切频
    if (Date.now() - req.receivedAt > 10000) return;

    if (!ctx.radio?.isConnected) {
        ctx.log.warn('电台未连接，忽略切频请求', { frequency: req.frequency });
        return;
    }

    const currentMode = getWaveLogMode(ctx.radio.mode);
    const target = ctx.config.snapDigitalDial !== false
        ? snapToDigitalDial(req.frequency, currentMode)
        : req.frequency;

    tuning = true;
    let command;
    try {
        command = ctx.radioCommands.submit({ type: 'set-frequency', frequency: target });
    } catch (e) {
        tuning = false;
        ctx.log.warn('切频未执行', { frequency: target, reason: e?.message });
        return;
    }

    // 不在回调内等待电台执行结果；最长 15 秒后释放占用标记
    const guard = setTimeout(() => { tuning = false; }, 15000);
    Promise.resolve(command).then(() => {
        logRef?.info('已按 WaveLog 切频', { requested: req.frequency, tuned: target, spotMode: req.mode, currentMode });
        lastFreq = null; // 下一次轮询立即回报新频率
    }, (e) => {
        // 发射中、调谐中或人工 PTT 时 TX-5DR 会拒绝，属于预期情况
        logRef?.warn('切频未执行', { frequency: target, reason: e?.message });
    }).finally(() => {
        clearTimeout(guard);
        tuning = false;
    });
}

function corsHeaders(req) {
    return {
        'Access-Control-Allow-Origin': req.headers.origin || '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
    };
}

function handleRequest(req, res) {
    const headers = corsHeaders(req);

    if (req.method === 'OPTIONS') {
        res.writeHead(204, headers);
        res.end();
        return;
    }
    if (req.method !== 'GET') {
        res.writeHead(405, headers);
        res.end();
        return;
    }

    // 期望格式：/<频率Hz>/<模式>，例如 /7010600/cw
    const parts = (req.url || '/').split('?')[0].split('/').filter(Boolean);
    const frequency = Number(parts[0]);
    const mode = parts[1] ? decodeURIComponent(parts[1]).toUpperCase() : '';

    if (!Number.isFinite(frequency) || frequency < 100000 || frequency > 3000000000) {
        res.writeHead(400, { ...headers, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: 'invalid frequency' }));
        return;
    }

    pendingTune = { frequency: Math.round(frequency), mode, receivedAt: Date.now() };
    logRef?.info('收到 WaveLog 切频请求', { frequency, mode });

    res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'queued', frequency, mode }));
}

async function stopServer() {
    const server = globalThis[SERVER_KEY];
    globalThis[SERVER_KEY] = undefined;
    if (!server) return;
    await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
    });
}

async function startServer(ctx) {
    await stopServer();
    if (ctx.config.callbackEnabled === false) return;

    const host = String(ctx.config.callbackHost || '127.0.0.1').trim();
    const port = Number(ctx.config.callbackPort) || 54321;
    const server = http.createServer(handleRequest);
    globalThis[SERVER_KEY] = server;

    server.on('error', (e) => {
        logRef?.error('切频回调端口监听失败', {
            host, port, message: e?.message,
            hint: e?.code === 'EADDRINUSE' ? '端口被占用，请关闭 WaveLogGate 等占用该端口的程序，或修改端口' : undefined,
        });
    });
    server.listen(port, host, () => {
        logRef?.info('切频回调已启动', { url: `http://${host}:${port}` });
    });
}

// ---------- 插件定义 ----------
export default {
    apiVersion: 2,
    name: PLUGIN_NAME,
    version: '3.0.2',
    minPluginApiVersion: '2.5.0',
    type: 'utility',
    instanceScope: 'global',
    description: 'pluginDescription',
    permissions: ['network', 'radio:read', 'radio:control'],
    settings: {
        apiUrl: { type: 'string', scope: 'global', label: 'apiUrlLabel', description: 'apiUrlDescription', default: '' },
        apiKey: { type: 'string', scope: 'global', label: 'apiKeyLabel', description: 'apiKeyDescription', default: '' },
        radioName: { type: 'string', scope: 'global', label: 'radioNameLabel', description: 'radioNameDescription', default: 'TX-5DR' },
        pollInterval: { type: 'number', scope: 'global', label: 'pollIntervalLabel', description: 'pollIntervalDescription', default: 2000, min: 500, max: 60000 },
        heartbeatSeconds: { type: 'number', scope: 'global', label: 'heartbeatLabel', description: 'heartbeatDescription', default: 60, min: 0, max: 3600 },
        callbackEnabled: { type: 'boolean', scope: 'global', label: 'callbackEnabledLabel', description: 'callbackEnabledDescription', default: true },
        callbackHost: { type: 'string', scope: 'global', label: 'callbackHostLabel', description: 'callbackHostDescription', default: '127.0.0.1' },
        callbackPort: { type: 'number', scope: 'global', label: 'callbackPortLabel', description: 'callbackPortDescription', default: 54321, min: 1024, max: 65535 },
        snapDigitalDial: { type: 'boolean', scope: 'global', label: 'snapDigitalDialLabel', description: 'snapDigitalDialDescription', default: true },
    },

    async onLoad(ctx) {
        logRef = ctx.log;
        lastFreq = null;
        lastMode = null;
        lastPushAt = 0;
        pendingTune = null;
        ctx.timers.set('pollRadio', Number(ctx.config.pollInterval) || 2000);
        ctx.timers.set('tuneQueue', 250);
        await startServer(ctx);
    },

    async onUnload(ctx) {
        ctx.timers.clearAll();
        await stopServer();
        logRef = null;
    },

    hooks: {
        onTimer(timerId, ctx) {
            // 同步返回，不等待网络和电台
            if (timerId === 'pollRadio') pushRadio(ctx);
            else if (timerId === 'tuneQueue') drainTuneQueue(ctx);
        },
        async onConfigChange(changes, ctx) {
            if ('pollInterval' in changes) {
                ctx.timers.set('pollRadio', Number(ctx.config.pollInterval) || 2000);
            }
            if ('apiUrl' in changes || 'apiKey' in changes || 'radioName' in changes) {
                lastFreq = null; // 配置变化后立即重新上报
                recordSuccess(); // 清除失败退避
            }
            if ('callbackEnabled' in changes || 'callbackHost' in changes || 'callbackPort' in changes) {
                await startServer(ctx);
            }
        },
    },
};
