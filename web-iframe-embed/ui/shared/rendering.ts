import type { RenderConfig, StreamType } from './types';

const VIDEO_EXTENSION_RE = /\.(mp4|webm|ogg|mov)(?:$|[?#])/i;
const HLS_RE = /(?:\.m3u8(?:$|[?#])|[/?=&_-]m3u8(?:[/?=&_-]|$))/i;

function normalizeInputUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function inferStreamType(url: URL): StreamType | null {
  const haystack = `${url.pathname}${url.search}`;
  if (HLS_RE.test(haystack)) {
    return 'hls';
  }
  if (VIDEO_EXTENSION_RE.test(haystack)) {
    return 'file';
  }
  return null;
}

export function createRenderConfig(rawUrl: string): RenderConfig {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { mode: 'empty' };
  }

  const url = normalizeInputUrl(trimmed);
  if (!url) {
    return { mode: 'invalid', src: trimmed };
  }

  const streamType = inferStreamType(url);
  if (streamType) {
    return {
      mode: 'video',
      src: url.toString(),
      streamType,
      autoplay: true,
      muted: true,
      controls: true,
      playsInline: true,
    };
  }

  return {
    mode: 'iframe',
    src: url.toString(),
  };
}
