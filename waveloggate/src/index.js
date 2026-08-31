let lastFreq = null;
let lastMode = null;
let debugLogged = false;

// 获取 WaveLog/ADIF 兼容的模式字符串
function getWaveLogMode(radioModeObj) {
    if (!radioModeObj) return 'SSB';

    const { mode, submode, radioMode } = radioModeObj;

    // 1. 优先检查 submode (通常包含最具体的模式信息)
    if (submode) {
        const s = submode.toUpperCase();
        // 常见数字模式直接返回
        const digitalModes = ['FT8', 'FT4', 'JS8', 'SSTV', 'RTTY', 'PSK31', 'JT65', 'JT9', 'WSPR'];
        if (digitalModes.some(m => s.includes(m))) {
            return digitalModes.find(m => s.includes(m));
        }
        // 如果是 DATA-U / DATA-L，通常表示通用数据模式
        if (s === 'DATA-U' || s === 'DATA-L') {
            return 'DATA';
        }
        // 如果是 USB / LSB / FM / AM，直接返回
        if (['USB', 'LSB', 'FM', 'AM', 'CW'].includes(s)) {
            return s;
        }
    }

    // 2. 检查 mode (主模式)
    if (mode) {
        const m = mode.toUpperCase();
        if (['FT8', 'FT4', 'SSTV', 'RTTY', 'CW', 'FM', 'AM'].includes(m)) {
            return m;
        }
        // 如果 mode 是 DATA，但 submode 没提供具体信息
        if (m === 'DATA') return 'DATA';
        if (m === 'SSB') return 'SSB'; // 默认 SSB
    }

    // 3. 检查 radioMode (电台原始模式)
    if (radioMode) {
        const r = radioMode.toUpperCase();
        if (r.startsWith('CW')) return 'CW';
        if (r.startsWith('DATA')) return 'DATA';
        if (['USB', 'LSB', 'FM', 'AM'].includes(r)) return r;
    }

    return 'SSB';
}

function getBand(freqHz) {
    const freqMHz = freqHz / 1000000;
    if (freqMHz >= 1.8 && freqMHz < 2) return '160m';
    if (freqMHz >= 3.5 && freqMHz < 4) return '80m';
    if (freqMHz >= 5 && freqMHz < 5.5) return '60m';
    if (freqMHz >= 7 && freqMHz < 7.3) return '40m';
    if (freqMHz >= 10 && freqMHz < 10.15) return '30m';
    if (freqMHz >= 14 && freqMHz < 14.35) return '20m';
    if (freqMHz >= 18 && freqMHz < 18.17) return '17m';
    if (freqMHz >= 21 && freqMHz < 21.45) return '15m';
    if (freqMHz >= 24 && freqMHz < 24.99) return '12m';
    if (freqMHz >= 28 && freqMHz < 29.7) return '10m';
    if (freqMHz >= 50 && freqMHz < 54) return '6m';
    if (freqMHz >= 144 && freqMHz < 148) return '2m';
    return 'UNKNOWN';
}

async function pollRadio(ctx) {
    try {
        if (!ctx.radio?.isConnected) {
            ctx.log.debug('电台未连接');
            return;
        }

        // 首次调试：打印新的 mode 对象结构
        if (!debugLogged) {
            debugLogged = true;
            ctx.log.info('=== 调试信息 (API v1.7.11+) ===', {
                frequency: ctx.radio?.frequency,
                band: ctx.radio?.band,
                modeObject: ctx.radio?.mode, // 新 API 对象
                operatorCallsign: ctx.operator?.callsign,
                apiUrl: ctx.config.apiUrl,
            });
        }

        const freq = ctx.radio.frequency;
        
        // 使用新 API 获取模式
        const radioModeObj = ctx.radio?.mode;
        const waveLogMode = getWaveLogMode(radioModeObj);

        if (!freq || freq === 0) {
            ctx.log.debug('频率为 0，跳过');
            return;
        }

        // 检查频率或模式是否变化
        if (freq === lastFreq && waveLogMode === lastMode) return;

        lastFreq = freq;
        lastMode = waveLogMode;

        ctx.log.info('频率/模式变化', { 
            freq, 
            mode: waveLogMode, 
            band: getBand(freq),
            engineMode: radioModeObj?.engineMode 
        });

        // 确保 API URL 正确
        let apiUrl = String(ctx.config.apiUrl).trim();
        if (!apiUrl.includes('/api/radio')) {
            apiUrl = apiUrl.replace(/\/+$/, '') + '/index.php/api/radio';
        }

        const res = await ctx.fetch(apiUrl, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                key: ctx.config.apiKey,
                radio: ctx.config.radioName,
                frequency: freq,
                mode: waveLogMode,
                timestamp: new Date().toISOString().replace('T', ' ').substring(0, 16)
            })
        });

        const body = await res.text().catch(() => '');
        
        if (body.includes('<!doctype html>') || body.includes('<html')) {
            ctx.log.error('API 认证失败', { 
                status: res.status,
                apiUrl,
                hint: '请检查 API Key 是否正确'
            });
            return;
        }
        
        try {
            const json = JSON.parse(body);
            if (json.status === 'ok' || json.status === 'success') {
                ctx.log.info('同步成功', { freq, mode: waveLogMode });
            } else {
                ctx.log.error('API 返回错误', { status: json.status, body: body.substring(0, 200) });
            }
        } catch {
            ctx.log.error('API 响应解析失败', { status: res.status, body: body.substring(0, 200) });
        }
    } catch (e) {
        ctx.log.error('轮询出错', { message: e.message });
    }
}

export default {
    name: 'tx5dr-waveloggate',
    version: '2.1.0',
    minPluginApiVersion: '1.7.11',
    type: 'utility',
    description: 'pluginDescription',
    instanceScope: 'operator',
    permissions: ['network', 'radio:read'],
    settings: {
        apiUrl: {
            type: 'string',
            label: 'apiUrlLabel',
            description: 'apiUrlDescription',
            default: 'https://wavelog.karats.com.cn/index.php/api/radio'
        },
        apiKey: {
            type: 'string',
            label: 'apiKeyLabel',
            description: 'apiKeyDescription',
            default: ''
        },
        radioName: {
            type: 'string',
            label: 'radioNameLabel',
            description: 'radioNameDescription',
            default: 'TX-5DR'
        },
        pollInterval: {
            type: 'number',
            label: 'pollIntervalLabel',
            description: 'pollIntervalDescription',
            default: 2000
        }
    },

    onLoad(ctx) {
        debugLogged = false;
        ctx.timers.set('pollRadio', ctx.config.pollInterval || 2000);
    },

    onUnload(ctx) {
        ctx.timers.clearAll();
    },

    hooks: {
        onTimer(timerId, ctx) {
            if (timerId === 'pollRadio') pollRadio(ctx);
        },
        onConfigChange(changes, ctx) {
            if (changes.pollInterval) {
                ctx.timers.clear('pollRadio');
                ctx.timers.set('pollRadio', changes.pollInterval);
            }
        }
    }
};
