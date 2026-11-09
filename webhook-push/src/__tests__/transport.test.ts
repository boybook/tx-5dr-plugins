import { describe, expect, it } from 'vitest';
import { readBodyLimited, sendRequest, type FetchLike } from '../transport.js';
import type { RenderedRequest } from '../queue.js';

describe('sendRequest (direct, no proxy)', () => {
  const request: RenderedRequest = {
    method: 'POST',
    url: 'https://example.com/hook',
    headers: { 'content-type': 'application/json' },
    body: '{"a":1}',
  };

  it('delegates to the provided fetch function and normalizes the result', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, init: init ?? {} });
      return new Response('ok body', { status: 200, statusText: 'OK' });
    };

    const result = await sendRequest({ fetchFn }, request);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://example.com/hook');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe('{"a":1}');
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    // 不跟随重定向（防端点被劫持后把数据转发到第二跳地址）
    expect(calls[0].init.redirect).toBe('manual');
    expect(result).toMatchObject({ ok: true, status: 200, statusText: 'OK' });
    expect(result.bodyPreview).toBe('ok body');
  });

  it('treats an opaque redirect (3xx with redirect:manual) as a failure', async () => {
    const fetchFn: FetchLike = async () => ({ status: 0, statusText: '', body: null } as unknown as Response);
    const result = await sendRequest({ fetchFn }, request);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.statusText).toBe('redirected (redirects are not allowed)');
  });

  it('limits response body reads to protect host memory', async () => {
    const big = new Response('x'.repeat(300 * 1024), { status: 200 });
    const text = await readBodyLimited(big);
    expect(text.length).toBeLessThanOrEqual(256 * 1024 + 32);
    expect(text.endsWith('… (truncated)')).toBe(true);

    const small = new Response('hello', { status: 200 });
    expect(await readBodyLimited(small)).toBe('hello');
  });

  it('reports non-2xx responses as failures', async () => {
    const fetchFn: FetchLike = async () => new Response('rate limited', { status: 429, statusText: 'Too Many Requests' });
    const result = await sendRequest({ fetchFn }, request);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
    expect(result.bodyPreview).toBe('rate limited');
  });

  it('wraps fetch errors into descriptive errors', async () => {
    const fetchFn: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(sendRequest({ fetchFn }, request))
      .rejects.toThrow(/webhook request failed: ECONNREFUSED/);
  });
});