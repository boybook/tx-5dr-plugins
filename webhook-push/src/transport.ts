/**
 * HTTP transport for the webhook-push plugin.
 *
 * All requests go through the host-provided `ctx.fetch` (network permission).
 * Client-side proxying is intentionally not supported.
 */

import type { RenderedRequest } from './queue.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpResult {
  ok: boolean;
  status: number;
  statusText: string;
  bodyPreview: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** 响应体读取上限：端点异常时限制内存占用（预览只取前 200 字符）。 */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * 有限读取响应体：最多消费 MAX_BODY_BYTES 字节，超出即取消流并截断，
 * 避免恶意/异常端点让插件进程（与宿主同进程）内存膨胀。
 */
export async function readBodyLimited(response: Response): Promise<string> {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  let overflow = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        overflow = true;
        break;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    try {
      await reader.cancel();
    } catch {
      // already cancelled/closed
    }
    reader.releaseLock();
  }
  const text = chunks.join('');
  return overflow ? `${text.slice(0, MAX_BODY_BYTES)}… (truncated)` : text;
}

function httpResultFromStatus(status: number, statusText: string, body: string): HttpResult {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    bodyPreview: body.slice(0, 200),
  };
}

async function fetchRequest(
  fetchFn: FetchLike,
  request: RenderedRequest,
  timeoutMs: number,
): Promise<HttpResult> {
  let response: Response;
  try {
    response = await fetchFn(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' ? undefined : request.body,
      signal: AbortSignal.timeout(timeoutMs),
      // 不跟随重定向：3xx 视为投递失败（可重试），避免端点被劫持后把
      // webhook 数据与自定义头转发到内网/回环等第二跳地址。
      redirect: 'manual',
    });
  } catch (error) {
    throw new Error(`webhook request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await readBodyLimited(response);
  const status = response.status;
  if (status === 0) {
    // opaqueredirect：manual 模式下服务器返回 3xx
    return httpResultFromStatus(0, 'redirected (redirects are not allowed)', text);
  }
  return httpResultFromStatus(status, response.statusText, text);
}

/**
 * Sends a rendered request to a target using the host-provided fetch.
 */
export function sendRequest(
  options: { fetchFn: FetchLike; timeoutMs?: number },
  request: RenderedRequest,
): Promise<HttpResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return fetchRequest(options.fetchFn, request, timeoutMs);
}