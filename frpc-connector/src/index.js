import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, chmod, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PLUGIN_ID = 'bd8ftc-frpc-connector';
const SERVICE_NAME = 'websdr.bd8ftc.de FRP穿透服务';
const VERSION = '1.0.0';
const FRPC_VERSION = '0.68.1';
const SUPPORT_EMAIL = 'bd8ftc@bd8ftc.de';
const API = 'http://websdr.bd8ftc.de/?callsign=';

function resolvePluginRoot() {
  if (existsSync(path.join(__dirname, 'bin'))) {
    return __dirname;
  }

  const sourceProjectRoot = path.dirname(__dirname);
  if (existsSync(path.join(sourceProjectRoot, 'bin'))) {
    return sourceProjectRoot;
  }

  return __dirname;
}

const PLUGIN_ROOT = resolvePluginRoot();
const TOML = path.join(PLUGIN_ROOT, 'frpc.toml');
const PID_FILE = path.join(PLUGIN_ROOT, 'frpc.pid');
const LOG_FILE = path.join(PLUGIN_ROOT, 'frpc.log');
const WINDOWS_SCRIPT = path.join(PLUGIN_ROOT, 'run-frpc.bat');
const UNIX_SCRIPT = path.join(PLUGIN_ROOT, 'run-frpc.sh');
let internalConfigUpdate = false;
let lifecycleQueue = Promise.resolve();

const PLATFORM_TARGETS = {
  'win32-amd64': { platformLabel: 'Windows amd64', dir: 'windows-amd64', executableName: 'frpc.exe', scriptName: 'run-frpc.bat', isWindows: true },
  'darwin-amd64': { platformLabel: 'macOS amd64', dir: 'darwin-amd64', executableName: 'frpc', scriptName: 'run-frpc.sh', isWindows: false },
  'darwin-arm64': { platformLabel: 'macOS arm64', dir: 'darwin-arm64', executableName: 'frpc', scriptName: 'run-frpc.sh', isWindows: false },
  'linux-amd64': { platformLabel: 'Linux amd64', dir: 'linux-amd64', executableName: 'frpc', scriptName: 'run-frpc.sh', isWindows: false },
  'linux-arm64': { platformLabel: 'Linux arm64', dir: 'linux-arm64', executableName: 'frpc', scriptName: 'run-frpc.sh', isWindows: false },
};

function log(ctx, msg) {
  ctx.log.info(String(msg));
}

function warn(ctx, msg) {
  ctx.log.warn(String(msg));
}

function formatError(err) {
  if (err instanceof Error) {
    return `${err.message}${err.stack ? `\n${err.stack}` : ''}`;
  }
  return String(err);
}

function error(ctx, msg, err) {
  ctx.log.error(`${msg}: ${formatError(err)}`);
}

function queueLifecycle(label, ctx, operation) {
  const run = lifecycleQueue
    .catch(() => undefined)
    .then(async () => {
      log(ctx, `生命周期任务开始：${label}`);
      const result = await operation();
      log(ctx, `生命周期任务完成：${label}`);
      return result;
    });
  lifecycleQueue = run.catch(() => undefined);
  return run;
}

function normalizeCallsign(value) {
  return String(value || '').trim().toUpperCase();
}

function createRegistrationError(callsign) {
  return new Error(
    `呼号 ${callsign} 尚未开通 ${SERVICE_NAME}。请先手动发送邮件到 ${SUPPORT_EMAIL} 申请开通，邮件中包含你的呼号；审核通过后再保存配置或点击“启动/重启”。`,
  );
}

async function describePath(filePath) {
  try {
    const s = await stat(filePath);
    return `${filePath} exists=true mode=${(s.mode & 0o777).toString(8)} size=${s.size}`;
  } catch (err) {
    return `${filePath} exists=false error=${err instanceof Error ? err.message : String(err)}`;
  }
}

function normalizeArch(arch) {
  if (arch === 'x64') return 'amd64';
  if (arch === 'arm64') return 'arm64';
  return undefined;
}

export function resolvePlatformTarget(platform = process.platform, arch = process.arch) {
  const normalizedArch = normalizeArch(arch);
  const key = normalizedArch ? `${platform}-${normalizedArch}` : undefined;
  const target = key ? PLATFORM_TARGETS[key] : undefined;
  if (!target) {
    throw new Error(`当前平台暂不支持 ${SERVICE_NAME}：${platform}/${arch}`);
  }

  return {
    ...target,
    key,
    executablePath: path.join(PLUGIN_ROOT, 'bin', target.dir, target.executableName),
    scriptPath: target.isWindows ? WINDOWS_SCRIPT : UNIX_SCRIPT,
  };
}

function toWindowsRelativePath(filePath) {
  return path.relative(PLUGIN_ROOT, filePath).split(path.sep).join('\\');
}

function toPosixRelativePath(filePath) {
  return `./${path.relative(PLUGIN_ROOT, filePath).split(path.sep).join('/')}`;
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadConfig(ctx) {
  const call = normalizeCallsign(ctx.config.callsign);

  log(ctx, `配置检查：hasCallsign=${call.length > 0}, autoStart=${String(ctx.config.autoStart)}, restartInterval=${String(ctx.config.restartInterval)}`);

  if (!call) {
    throw new Error('未设置 websdr.bd8ftc.de 登记呼号');
  }
  if (!ctx.fetch) {
    throw new Error('缺少 network 权限');
  }

  const url = API + encodeURIComponent(call);

  log(ctx, `下载配置: ${url}`);

  const res = await ctx.fetch(url);
  if (!res.ok) {
    if (res.status === 404) {
      throw createRegistrationError(call);
    }
    throw new Error(`下载配置失败：HTTP ${res.status}`);
  }

  const text = await res.text();

  if (!text.trim()) throw new Error('配置为空');

  if (/Callsign not found/i.test(text)) {
    throw createRegistrationError(call);
  }

  await writeFile(TOML, text, 'utf8');

  const s = await stat(TOML);
  if (s.size === 0) throw new Error('写入失败');

  log(ctx, `配置下载成功 (${s.size} bytes)`);
}

export function buildWindowsScript(target, restartSeconds) {
  const frpc = toWindowsRelativePath(target.executablePath);
  return [
    '@echo off',
    'chcp 65001 >nul',
    'title TX-5DR websdr.bd8ftc.de FRP Tunnel',
    `cd /d "${PLUGIN_ROOT}"`,
    'echo TX-5DR websdr.bd8ftc.de FRP Tunnel',
    `echo frpc version: ${FRPC_VERSION}`,
    'echo Warning: frpc may be blocked by Windows Security or antivirus.',
    'echo This connects to websdr.bd8ftc.de FRP tunnel service',
    'echo Visit websdr.bd8ftc.de and enter your callsign after FRPC is running.',
    'echo.',
    ':loop',
    'echo ===== FRPC START %date% %time% =====',
    `"${frpc}" -c frpc.toml`,
    'echo.',
    'echo ===== FRPC EXIT %date% %time% ERRORLEVEL=%errorlevel% =====',
    `echo Restart after ${restartSeconds} seconds...`,
    `timeout /t ${restartSeconds} >nul`,
    'goto loop',
    '',
  ].join('\r\n');
}

export function buildUnixScript(target, restartSeconds) {
  const frpc = toPosixRelativePath(target.executablePath);
  return [
    '#!/bin/sh',
    'cd "$(dirname "$0")" || exit 1',
    `FRPC="${frpc}"`,
    'CONFIG="./frpc.toml"',
    'LOG="./frpc.log"',
    `INTERVAL="${restartSeconds}"`,
    'chmod +x "$FRPC"',
    `echo "===== ${SERVICE_NAME} launcher start $(date) =====" >> "$LOG"`,
    `echo "frpc version: ${FRPC_VERSION}" >> "$LOG"`,
    'echo "FRPC running. Visit websdr.bd8ftc.de and enter your callsign to access the service." >> "$LOG"',
    'while true; do',
    '  echo "===== FRPC START $(date) =====" >> "$LOG"',
    '  "$FRPC" -c "$CONFIG" >> "$LOG" 2>&1',
    '  status=$?',
    '  echo "===== FRPC EXIT $(date) STATUS=$status =====" >> "$LOG"',
    '  echo "Restart after $INTERVAL seconds..." >> "$LOG"',
    '  sleep "$INTERVAL"',
    'done',
    '',
  ].join('\n');
}

async function writeLauncherScript(ctx, target) {
  const restartSeconds = Math.max(1, Number(ctx.config.restartInterval || 10)) * 60;

  log(ctx, `准备生成启动脚本：script=${target.scriptPath}, restartSeconds=${restartSeconds}`);

  if (target.isWindows) {
    await writeFile(target.scriptPath, buildWindowsScript(target, restartSeconds), 'utf8');
    log(ctx, `已生成 run-frpc.bat：${await describePath(target.scriptPath)}`);
    return;
  }

  await writeFile(target.scriptPath, buildUnixScript(target, restartSeconds), 'utf8');
  try {
    await chmod(target.executablePath, 0o755);
    await chmod(target.scriptPath, 0o755);
  } catch (err) {
    throw new Error(`无法设置 frpc 或 run-frpc.sh 执行权限，请检查插件目录权限或重新安装插件：${err instanceof Error ? err.message : String(err)}`);
  }
  log(ctx, `已生成 run-frpc.sh 并设置执行权限：${await describePath(target.scriptPath)}`);
  log(ctx, `frpc 权限检查：${await describePath(target.executablePath)}`);
}

async function readPidForLog(ctx) {
  try {
    const raw = await readFile(PID_FILE, 'utf8');
    const pid = Number(raw.trim());
    log(ctx, `读取 PID 文件：path=${PID_FILE}, raw=${JSON.stringify(raw.trim())}, parsed=${Number.isInteger(pid) ? pid : 'invalid'}`);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    log(ctx, `未找到 PID 文件：${PID_FILE}`);
    return undefined;
  }
}

async function removePidFile() {
  try {
    await unlink(PID_FILE);
  } catch {
    // ignore missing pid file
  }
}

function taskkill(args) {
  return new Promise((resolve) => {
    const child = spawn('taskkill.exe', args, {
      windowsHide: true,
      stdio: 'ignore',
    });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

async function stopWindowsProcess(pid, ctx) {
  if (pid) {
    log(ctx, `尝试按 PID 停止 Windows FRPC：pid=${pid}`);
    const stoppedByPid = await taskkill(['/f', '/t', '/pid', String(pid)]);
    if (stoppedByPid) {
      log(ctx, `已停止 FRPC 进程树 PID=${pid}`);
      return;
    }
    warn(ctx, `按 PID 停止 FRPC 失败，尝试按进程名清理：PID=${pid}`);
  }

  await taskkill(['/f', '/im', 'frpc.exe']);
  log(ctx, '已尝试停止 FRPC');
}

function killUnix(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

async function stopUnixProcess(pid, ctx) {
  if (!pid) return;

  log(ctx, `尝试停止 Unix FRPC 进程组：pid=${pid}`);
  if (!killUnix(pid, 'SIGTERM')) {
    warn(ctx, `SIGTERM 未找到可停止的 FRPC 进程：pid=${pid}`);
    return;
  }

  await sleep(1000);
  killUnix(pid, 'SIGKILL');
  log(ctx, `已停止 FRPC 后台进程组 PID=${pid}`);
}

async function stopFrpc(ctx) {
  const target = resolvePlatformTarget();
  log(ctx, `停止流程：platform=${process.platform}, arch=${process.arch}, target=${target.key}, pidFile=${PID_FILE}`);
  const pid = await readPidForLog(ctx);

  if (target.isWindows) {
    await stopWindowsProcess(pid, ctx);
  } else {
    await stopUnixProcess(pid, ctx);
  }

  await removePidFile();
}

async function updateEnabledState(ctx, enabled) {
  internalConfigUpdate = true;
  try {
    await ctx.updateConfig({ enabled });
  } finally {
    internalConfigUpdate = false;
  }
}

async function startLauncher(ctx, target) {
  const command = target.isWindows ? 'cmd.exe' : '/bin/sh';
  const args = target.isWindows
    ? ['/d', '/k', `call "${target.scriptPath}"`]
    : [target.scriptPath];

  log(ctx, `启动脚本命令：command=${command}, args=${JSON.stringify(args)}, cwd=${PLUGIN_ROOT}, detached=true`);

  const child = spawn(command, args, {
    cwd: PLUGIN_ROOT,
    windowsHide: false,
    shell: false,
    detached: true,
    stdio: 'ignore',
  });

  child.unref();

  child.on('error', (err) => {
    error(ctx, 'FRPC 启动脚本进程错误', err);
  });

  child.on('exit', (code, signal) => {
    log(ctx, `FRPC 启动脚本进程退出：pid=${child.pid ?? 'unknown'}, code=${String(code)}, signal=${String(signal)}`);
  });

  if (!child.pid) {
    throw new Error('启动 FRPC 脚本失败：无法获取进程 PID');
  }

  await writeFile(PID_FILE, `${child.pid}\n`, 'utf8');
  log(ctx, `启动成功：${target.platformLabel}，PID=${child.pid}`);
}

async function startFrpc(ctx) {
  const target = resolvePlatformTarget();

  log(ctx, `启动诊断：moduleDir=${__dirname}`);
  log(ctx, `启动诊断：pluginRoot=${PLUGIN_ROOT}`);
  log(ctx, `启动诊断：platform=${process.platform}, arch=${process.arch}, target=${target.key}, label=${target.platformLabel}`);
  log(ctx, `启动诊断：frpc=${await describePath(target.executablePath)}`);
  log(ctx, `启动诊断：toml=${TOML}, script=${target.scriptPath}, log=${LOG_FILE}, pid=${PID_FILE}`);

  if (!(await exists(target.executablePath))) {
    throw new Error(`找不到当前平台的 frpc 二进制：${target.executablePath}`);
  }

  await downloadConfig(ctx);
  await writeLauncherScript(ctx, target);
  await stopFrpc(ctx);

  log(ctx, `启动 ${SERVICE_NAME}（${target.platformLabel}）`);
  await startLauncher(ctx, target);
  log(ctx, 'FRPC 启动后，请访问 websdr.bd8ftc.de 并输入你的呼号来访问服务。');
  await updateEnabledState(ctx, true);
}

async function reconcileDesiredState(ctx, reason) {
  const call = normalizeCallsign(ctx.config.callsign);
  const autoStart = ctx.config.autoStart === true;
  const enabled = ctx.config.enabled === true;

  log(ctx, `状态协调：reason=${reason}, hasCallsign=${call.length > 0}, autoStart=${autoStart}, enabled=${enabled}`);

  if (!call) {
    if (enabled) {
      log(ctx, '登记呼号为空，停止当前 frpc 并清除启用状态');
      await stopFrpc(ctx);
      await updateEnabledState(ctx, false);
      return;
    }

    log(ctx, '等待配置：请填写 websdr.bd8ftc.de 登记呼号。未填写时不会启动 frpc。');
    return;
  }

  if (autoStart || enabled) {
    log(ctx, `${reason} 后需要运行 frpc，执行启动/重启`);
    await startFrpc(ctx);
    return;
  }

  log(ctx, `${reason} 已保存；自动启动关闭且当前未启用，保持停止状态。需要运行时请点击“启动/重启”。`);
}

export default {
  name: PLUGIN_ID,
  version: VERSION,
  minPluginApiVersion: '1.0.0',
  type: 'utility',
  instanceScope: 'global',
  description: '接入 websdr.bd8ftc.de FRP穿透服务，按登记呼号下载专属 frpc 配置，并启动本机 frpc 客户端。',
  permissions: ['network'],

  settings: {
    notice: {
      type: 'info',
      default: '',
      label: `使用流程：先向 ${SUPPORT_EMAIL} 发送邮件申请开通，邮件中包含你的呼号；审核通过后填写 websdr.bd8ftc.de 登记呼号并保存。FRPC 启动后，访问 websdr.bd8ftc.de 并输入呼号来访问。`,
      scope: 'global',
    },
    callsign: {
      type: 'string',
      default: '',
      label: 'websdr.bd8ftc.de 登记呼号',
      scope: 'global',
    },
    autoStart: {
      type: 'boolean',
      default: true,
      label: '保存配置后自动启动/重启',
      scope: 'global',
    },
    restartInterval: {
      type: 'number',
      default: 10,
      label: '异常退出重启间隔(分钟)',
      min: 1,
      max: 1440,
      scope: 'global',
    },
    enabled: {
      type: 'boolean',
      default: false,
      label: 'FRPC 运行状态（内部）',
      hidden: true,
      scope: 'global',
    },
  },

  quickActions: [
    { id: 'start', label: '启动/重启' },
    { id: 'stop', label: '停止' },
  ],

  async onLoad(ctx) {
    log(ctx, `${SERVICE_NAME} 插件已加载`);
    log(ctx, `提示：本插件会连接 ${SERVICE_NAME}，并启动本机 frpc ${FRPC_VERSION} 客户端`);

    if (ctx.config.autoStart || ctx.config.enabled) {
      await queueLifecycle('插件加载状态协调', ctx, () => reconcileDesiredState(ctx, '插件加载')).catch((e) => {
        error(ctx, '插件加载状态协调失败', e);
      });
      return;
    }

    log(ctx, '插件已就绪：自动启动关闭。填写登记呼号后可点击“启动/重启”。');
  },

  async onUnload(ctx) {
    try {
      await stopFrpc(ctx);
    } catch (e) {
      error(ctx, '停止失败', e);
    }
  },

  hooks: {
    async onUserAction(id, payload, ctx) {
      log(ctx, `收到用户动作：id=${id}, payload=${JSON.stringify(payload ?? null)}`);
      if (id === 'start') {
        await queueLifecycle('用户启动/重启', ctx, () => startFrpc(ctx)).catch((e) => {
          error(ctx, '启动失败', e);
        });
      }

      if (id === 'stop') {
        await queueLifecycle('用户停止', ctx, async () => {
          await stopFrpc(ctx);
          await updateEnabledState(ctx, false);
        }).catch((e) => {
          error(ctx, '停止失败', e);
        });
      }
    },

    async onConfigChange(changes, ctx) {
      log(ctx, `配置更新：${JSON.stringify(changes)}`);
      if (internalConfigUpdate) {
        log(ctx, '跳过内部状态更新触发的重启');
        return;
      }

      await queueLifecycle('配置保存状态协调', ctx, () => reconcileDesiredState(ctx, '配置保存')).catch((e) => {
        error(ctx, '配置保存状态协调失败', e);
      });
    },
  },
};
