/**
 * Frame History Viewer — 服务端插件入口
 *
 * 本插件是一个 utility + global 实例的工具插件，在 RadioControl 工具栏添加一个
 * iframe 按钮入口（"帧历史查看器"），通过 Bridge SDK 通信，从 JSONL 帧日志文件中
 * 读取历史解码数据供前端浏览。
 *
 * 数据来源：<dataDir>/frames-logs/frames-YYYY-MM-DD.jsonl
 * 通信方式：iframe → tx5dr.invoke() → ctx.ui.registerPageHandler()
 */

import type { PluginContext, PluginDefinition, SlotPack } from '@tx5dr/plugin-api';
import { readdir, stat } from 'fs/promises';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';
import { homedir } from 'os';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };

const PLUGIN_NAME = 'frame-history-viewer';
const PAGE_ID = 'viewer';
const PANEL_GROUP_ID = 'viewer-entry';

function buildPanelDescriptor(openInModal: boolean) {
  return [{
    id: 'history-viewer-button',
    title: 'historyViewerTitle',
    component: 'iframe' as const,
    pageId: PAGE_ID,
    slot: 'radio-control-toolbar' as const,
    icon: 'clock-rotate-left',
    openMode: (openInModal ? 'modal' : 'popover') as 'modal' | 'popover',
    uiSize: 'lg' as const,
    params: { openMode: openInModal ? 'modal' : 'popover' },
  }];
}

/**
 * 与服务端 SlotPackPersistence.ts 中定义的 SlotPackStorageRecord 等效。
 * 此处重新定义是为了在独立插件项目中不依赖 @tx5dr/contracts，直接按 JSONL
 * 的存储格式反序列化。
 *
 * slotPack.startMs / slotPack.endMs 均为毫秒级 UTC 时间戳；
 * operation 标记该记录是"新建"还是"更新"（后者表示同一时隙的增量更新）。
 */
interface SlotPackStorageRecord {
  storedAt: number;
  operation: 'updated' | 'created';
  slotPack: SlotPack;
  mode?: string;
  version: string;
}

/**
 * 获取 TX-5DR 数据根目录。
 * 解析顺序与宿主 tx5drPaths.getDataDir()（packages/server/src/utils/app-paths.ts）保持一致：
 *   1. TX5DR_DATA_DIR 环境变量（Docker / Linux server 包 / Electron 桌面均会注入）
 *   2. Windows: %LOCALAPPDATA%\TX-5DR
 *   3. macOS:   ~/Library/Application Support/TX-5DR
 *   4. Linux:   $XDG_DATA_HOME/TX-5DR，否则 ~/.local/share/TX-5DR
 * 不做 /app/data、/var/lib/tx5dr 等目录的存在性探测，避免无环境变量时
 * 命中宿主并未实际使用的目录（例如桌面版与 server 包并存时读到错误数据）。
 */
export function getDataDir(): string {
  const env = process.env.TX5DR_DATA_DIR;
  if (env) return env;

  const APP_DIR_NAME = 'TX-5DR';
  switch (process.platform) {
    case 'win32':
      return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), APP_DIR_NAME);
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', APP_DIR_NAME);
    default:
      return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), APP_DIR_NAME);
  }
}

/** frames-logs 子目录路径 */
function getFramesLogDir(): string {
  return join(getDataDir(), 'frames-logs');
}

/**
 * 扫描 frames-logs 目录，列出所有 JSONL 日志文件对应的日期。
 * 文件名格式：frames-YYYY-MM-DD.jsonl
 * 返回按字典序排序的日期字符串数组，最新日期在最后。
 */
export async function listDates(): Promise<string[]> {
  const dir = getFramesLogDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const dates: string[] = [];
  for (const name of entries.sort()) {
    const match = name.match(/^frames-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (match) dates.push(match[1]);
  }
  return dates;
}

/**
 * 读取指定日期的 JSONL 日志文件，支持游标分页。
 *
 * 使用流式读取（createReadStream + readline）避免大文件一次性加载到内存。
 * 遇到格式损坏的行自动跳过，不影响其他有效行的读取。
 *
 * @param dateStr       - 日期字符串 "YYYY-MM-DD"
 * @param options       - 可选参数对象
 * @param options.limit - 最大返回记录数（默认 Infinity，向后兼容）
 * @param options.cursor- 起始行号游标（默认 0）
 * @returns 记录数组 + 下一游标 + hasMore 标记
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 单次 loadRecords 允许返回的最大记录数，防止客户端传超大 limit 一次性读入整个文件 */
const MAX_RECORDS_PER_PAGE = 2000;

/** 将客户端传入的 limit 归一化为 [1, MAX_RECORDS_PER_PAGE]；未传时返回 undefined（不限） */
export function clampLimit(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : MAX_RECORDS_PER_PAGE;
  return Math.min(Math.max(1, n), MAX_RECORDS_PER_PAGE);
}

/** 将游标归一化为非负整数；非法值归 0 */
export function toNonNegativeCursor(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * 校验日期字符串，防止目录穿越。
 *
 * dateStr 直接拼进文件路径（index.ts 由 iframe invoke 透传，宿主仅做 session
 * 校验后原样交给插件 handler），若含 `../` 等片段可逃逸 frames-logs 目录。
 * 与 listDates() 的 `frames-YYYY-MM-DD.jsonl` 正则保持一致。
 */
export function assertValidDate(dateStr: string): void {
  if (!DATE_RE.test(dateStr)) {
    throw new Error(`Invalid date: ${dateStr}`);
  }
}

/**
 * 读取指定日期的 JSONL 日志文件，支持游标分页。
 *
 * 使用流式读取（createReadStream + readline）避免大文件一次性加载到内存。
 * 遇到格式损坏的行自动跳过，不影响其他有效行的读取。
 *
 * @param dateStr       - 日期字符串 "YYYY-MM-DD"
 * @param options       - 可选参数对象
 * @param options.limit - 最大返回记录数（默认 Infinity，向后兼容）
 * @param options.cursor- 起始行号游标（默认 0）
 * @returns 记录数组 + 下一游标 + hasMore 标记
 */
export async function loadRecords(
  dateStr: string,
  options?: { limit?: number; cursor?: number }
): Promise<{ records: SlotPackStorageRecord[]; cursor: number; hasMore: boolean }> {
  assertValidDate(dateStr);
  const filePath = join(getFramesLogDir(), `frames-${dateStr}.jsonl`);
  try {
    const s = await stat(filePath);
    if (!s.isFile()) return { records: [], cursor: 0, hasMore: false };
  } catch {
    return { records: [], cursor: 0, hasMore: false };
  }
  const records: SlotPackStorageRecord[] = [];
  const limit = clampLimit(options?.limit) ?? Infinity;
  const cursor = toNonNegativeCursor(options?.cursor);
  let lineIdx = 0;
  let truncated = false;

  try {
    const stream = createReadStream(filePath, 'utf-8');
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      const iterator = rl[Symbol.asyncIterator]();
      while (true) {
        const { done, value: line } = await iterator.next();
        if (done) break; // 读到 EOF
        if (lineIdx++ < cursor) continue;
        if (!line) continue;
        try {
          records.push(JSON.parse(line) as SlotPackStorageRecord);
          if (limit !== Infinity && records.length >= limit) {
            // 已满页：预取下一行确认是否还有更多，避免"恰好整页读到文件末尾"误报 hasMore
            const next = await iterator.next();
            truncated = !next.done;
            break;
          }
        } catch {
          // 跳过格式损坏的行
        }
      }
    } finally {
      rl.close();
    }
  } catch {
    return { records: [], cursor: 0, hasMore: false };
  }

  return {
    records,
    cursor: lineIdx,
    // 仅当满页且文件仍有余行时才报告 hasMore（truncated 由预取结果决定）
    hasMore: truncated,
  };
}

const plugin: PluginDefinition = {
  name: PLUGIN_NAME,
  version: '1.0.0',
  type: 'utility',
  instanceScope: 'global',         // 全局单例：不需要按操作员分别实例化
  description: 'pluginDescription',

  // 面板改为动态注册（由设置 openInModal 控制 openMode），
  // 不在静态 panels 中声明，避免出现双按钮
  panels: [],

  settings: {
    openInModal: {
      type: 'boolean',
      default: false,
      label: 'openInModal',
      description: 'openInModalDescription',
      scope: 'global',
    },
  },

  ui: {
    dir: 'ui',
    pages: [{
      id: PAGE_ID,
      title: 'historyViewerTitle',
      entry: 'viewer.html',
      accessScope: 'operator',         // 操作员即可访问（与 radio-control-toolbar 入口定位一致）
      resourceBinding: 'none',         // 不绑定特定操作员/呼号
    }],
  },

  onLoad(ctx: PluginContext) {
    ctx.log.debug('Plugin loaded');

    // 根据当前配置动态创建工具栏面板
    const openInModal = ctx.config.openInModal === true;
    ctx.ui.setPanelContributions(PANEL_GROUP_ID, buildPanelDescriptor(openInModal));

    ctx.ui.registerPageHandler({
      async onMessage(_pageId: string, action: string, data: unknown) {
        switch (action) {
          case 'listDates':
            return { dates: await listDates() };
          case 'loadRecords': {
            const { date, limit, cursor } = data as {
              date: string; limit?: number; cursor?: number;
            };
            const result = await loadRecords(date, { limit, cursor });
            return { date, ...result };
          }
          case 'getLocaleStrings': {
            const { locale } = data as { locale: string };
            return locale === 'zh' ? zhLocale : enLocale;
          }
          default:
            throw new Error(`Unknown action: ${action}`);
        }
      },
    });
  },

  onUnload(ctx: PluginContext) {
    ctx.ui.clearPanelContributions(PANEL_GROUP_ID);
    ctx.log.debug('Plugin unloaded');
  },

  hooks: {
    onConfigChange(changes: Record<string, unknown>, ctx: PluginContext) {
      if ('openInModal' in changes) {
        const openInModal = changes.openInModal === true;
        ctx.ui.setPanelContributions(PANEL_GROUP_ID, buildPanelDescriptor(openInModal));
      }
    },
  },
};

export default plugin;
