/**
 * frame-history-viewer 服务端逻辑单元测试
 *
 * 覆盖：日期校验（防目录穿越）、limit/cursor 归一化、JSONL 分页读取、
 * EOF 感知的 hasMore、损坏行跳过、日期列表扫描、数据目录解析。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  assertValidDate,
  clampLimit,
  toNonNegativeCursor,
  listDates,
  loadRecords,
  getDataDir,
} from '../index.js';

let tempDir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  previousDataDir = process.env.TX5DR_DATA_DIR;
  tempDir = mkdtempSync(join(tmpdir(), 'fhv-test-'));
  mkdirSync(join(tempDir, 'frames-logs'), { recursive: true });
  process.env.TX5DR_DATA_DIR = tempDir;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  if (previousDataDir === undefined) {
    delete process.env.TX5DR_DATA_DIR;
  } else {
    process.env.TX5DR_DATA_DIR = previousDataDir;
  }
});

function writeLog(dateStr: string, lines: string[]): void {
  const filePath = join(tempDir, 'frames-logs', `frames-${dateStr}.jsonl`);
  writeFileSync(filePath, lines.length ? lines.join('\n') + '\n' : '', 'utf8');
}

function record(slotId: string): string {
  return JSON.stringify({
    storedAt: 1,
    operation: 'created',
    version: '1.0.0',
    slotPack: {
      slotId,
      startMs: 0,
      endMs: 15000,
      frames: [{ message: `CQ ${slotId}`, snr: -10, freq: 7074000, dt: 0.5 }],
      stats: {},
      decodeHistory: [],
    },
  });
}

describe('assertValidDate', () => {
  it('接受合法 YYYY-MM-DD 格式', () => {
    expect(() => assertValidDate('2025-01-02')).not.toThrow();
    expect(() => assertValidDate('2024-12-31')).not.toThrow();
    // 格式级校验：与 listDates 的文件名正则一致，不校验日历合法性
    expect(() => assertValidDate('2025-13-40')).not.toThrow();
  });

  it('拒绝目录穿越与非法格式', () => {
    for (const bad of [
      '',
      '2025-1-2',
      '2025/01/02',
      '2025-01-02/../x',
      '../2025-01-02',
      '2025-01-02.jsonl',
      'frames-2025-01-02',
      '..',
      '2025-01-02\n',
    ]) {
      expect(() => assertValidDate(bad)).toThrow();
    }
  });
});

describe('clampLimit', () => {
  it('未传时返回 undefined（不限）', () => {
    expect(clampLimit(undefined)).toBeUndefined();
    expect(clampLimit(null)).toBeUndefined();
  });

  it('将 limit 收敛到 [1, 2000]', () => {
    expect(clampLimit(100)).toBe(100);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit(1e9)).toBe(2000);
    expect(clampLimit(1.7)).toBe(1);
  });

  it('非法 limit 归 2000', () => {
    expect(clampLimit('abc')).toBe(2000);
    expect(clampLimit(Number.NaN)).toBe(2000);
  });
});

describe('toNonNegativeCursor', () => {
  it('归一化为非负整数', () => {
    expect(toNonNegativeCursor(undefined)).toBe(0);
    expect(toNonNegativeCursor(5)).toBe(5);
    expect(toNonNegativeCursor(-3)).toBe(0);
    expect(toNonNegativeCursor(3.9)).toBe(3);
  });

  it('非法游标归 0', () => {
    expect(toNonNegativeCursor('x')).toBe(0);
    expect(toNonNegativeCursor(Number.NaN)).toBe(0);
    expect(toNonNegativeCursor(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('getDataDir', () => {
  it('TX5DR_DATA_DIR 环境变量优先', () => {
    process.env.TX5DR_DATA_DIR = '/custom/data/dir';
    expect(getDataDir()).toBe('/custom/data/dir');
  });
});

describe('listDates', () => {
  it('扫描并排序 frames-*.jsonl 文件名', async () => {
    writeLog('2025-12-31', [record('a')]);
    writeLog('2025-01-01', [record('b')]);
    writeLog('2025-06-15', [record('c')]);
    writeFileSync(join(tempDir, 'frames-logs', 'not-a-log.txt'), 'x', 'utf8');
    expect(await listDates()).toEqual(['2025-01-01', '2025-06-15', '2025-12-31']);
  });

  it('frames-logs 目录不存在时返回空数组', async () => {
    rmSync(join(tempDir, 'frames-logs'), { recursive: true, force: true });
    expect(await listDates()).toEqual([]);
  });
});

describe('loadRecords', () => {
  it('文件不存在时返回空结果且无更多数据', async () => {
    const result = await loadRecords('2025-01-01');
    expect(result).toEqual({ records: [], cursor: 0, hasMore: false });
  });

  it('无 limit 时读取全部有效行，跳过损坏行与空行', async () => {
    writeLog('2025-01-01', [
      record('a'),
      'not-json{',
      '',
      record('b'),
      '{ broken',
    ]);
    const result = await loadRecords('2025-01-01');
    expect(result.records.map((r) => r.slotPack.slotId)).toEqual(['a', 'b']);
    expect(result.hasMore).toBe(false);
  });

  it('limit 分页：提前截断时 hasMore=true，继续取下一页直至 EOF', async () => {
    writeLog('2025-01-01', [
      record('a'), record('b'), record('c'), record('d'), record('e'),
    ]);

    const page1 = await loadRecords('2025-01-01', { limit: 2 });
    expect(page1.records.map((r) => r.slotPack.slotId)).toEqual(['a', 'b']);
    expect(page1.hasMore).toBe(true);

    const page2 = await loadRecords('2025-01-01', { limit: 2, cursor: page1.cursor });
    expect(page2.records.map((r) => r.slotPack.slotId)).toEqual(['c', 'd']);
    expect(page2.hasMore).toBe(true);

    const page3 = await loadRecords('2025-01-01', { limit: 2, cursor: page2.cursor });
    expect(page3.records.map((r) => r.slotPack.slotId)).toEqual(['e']);
    expect(page3.hasMore).toBe(false);
  });

  it('恰好读完 limit 条且文件已到末尾时 hasMore=false（EOF 边界）', async () => {
    writeLog('2025-01-01', [record('a'), record('b')]);
    const result = await loadRecords('2025-01-01', { limit: 2 });
    expect(result.records).toHaveLength(2);
    expect(result.hasMore).toBe(false);
  });

  it('cursor 跳过已读行，游标越界时返回空', async () => {
    writeLog('2025-01-01', [record('a'), record('b'), record('c')]);
    const skipped = await loadRecords('2025-01-01', { cursor: 2 });
    expect(skipped.records.map((r) => r.slotPack.slotId)).toEqual(['c']);

    const beyond = await loadRecords('2025-01-01', { cursor: 99 });
    expect(beyond.records).toEqual([]);
    expect(beyond.hasMore).toBe(false);
  });

  it('损坏行计入行号游标，不影响后续分页', async () => {
    writeLog('2025-01-01', [record('a'), 'broken', record('b')]);
    const page1 = await loadRecords('2025-01-01', { limit: 1 });
    expect(page1.records.map((r) => r.slotPack.slotId)).toEqual(['a']);
    expect(page1.hasMore).toBe(true);
    const page2 = await loadRecords('2025-01-01', { limit: 1, cursor: page1.cursor });
    expect(page2.records.map((r) => r.slotPack.slotId)).toEqual(['b']);
    expect(page2.hasMore).toBe(false);
  });

  it('非法日期直接抛错（防穿越）', async () => {
    await expect(loadRecords('../etc/passwd')).rejects.toThrow();
  });
});
