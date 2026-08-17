'use strict';

const supabaseStore = require('./supabaseStore');

const CONFIG_TTL_MS = 30 * 1000; // re-check Supabase tối đa mỗi 30s
const MAX_BNK_BYTES = 100 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30 * 1000;

let cachedConfig = null;   // { bnkUrl, updatedAt, updatedBy, fetchedAt }
let cachedBnkBuffer = null;
let cachedBnkUrl = null;

// Cache nhẹ theo URL cho wem/video (preview xong build lại thường tải đúng
// file vừa preview) — giảm số request lặp lại tới nguồn trong thời gian ngắn.
const URL_CACHE_TTL_MS = 5 * 60 * 1000;
const urlBufferCache = new Map(); // url -> { buffer, fetchedAt }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchOnce(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (e) {
    throw new Error(`Không tải được file từ URL (${e.message})`);
  } finally {
    clearTimeout(timeout);
  }
}

// Retry với backoff khi nguồn (Supabase Storage / GitHub raw...) trả 429
// (rate limit) hoặc lỗi 5xx tạm thời. Tối đa 4 lần thử.
async function fetchBuffer(url) {
  const hit = urlBufferCache.get(url);
  if (hit && (Date.now() - hit.fetchedAt) < URL_CACHE_TTL_MS) return hit.buffer;

  const MAX_ATTEMPTS = 4;
  let resp, lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      resp = await fetchOnce(url);
    } catch (e) {
      lastErr = e;
      resp = null;
    }
    if (resp && resp.ok) break;
    if (resp && resp.status !== 429 && !(resp.status >= 500 && resp.status < 600)) {
      // lỗi không tạm thời (404, 403...) — không cần thử lại
      break;
    }
    if (attempt < MAX_ATTEMPTS) {
      const retryAfterHeader = resp && resp.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : null;
      const backoffMs = retryAfterMs || Math.min(1000 * 2 ** (attempt - 1), 8000);
      await sleep(backoffMs);
    }
  }
  if (!resp) throw lastErr || new Error('Không tải được file từ URL');
  if (!resp.ok) throw new Error(`Không tải được file từ URL (HTTP ${resp.status})`);

  const contentLength = resp.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_BNK_BYTES) {
    throw new Error('File vượt quá giới hạn 100MB');
  }
  const arrayBuf = await resp.arrayBuffer();
  const buf = Buffer.from(arrayBuf);
  if (buf.length > MAX_BNK_BYTES) throw new Error('File vượt quá giới hạn 100MB');
  if (buf.length === 0) throw new Error('File tải về rỗng (0 byte)');
  urlBufferCache.set(url, { buffer: buf, fetchedAt: Date.now() });
  return buf;
}

// Returns { bnkBuffer, config }
async function getActive(opts = {}) {
  const now = Date.now();
  const stale = !cachedConfig || (now - cachedConfig.fetchedAt) > CONFIG_TTL_MS;

  if (opts.forceRefresh || stale) {
    const remote = await supabaseStore.getBnkConfig();
    cachedConfig = remote ? { ...remote, fetchedAt: now } : null;
  }

  if (!cachedConfig || !cachedConfig.bnk_url) {
    throw new Error('Chưa cấu hình Music_Login.bnk (vào /admin để set link GitHub)');
  }

  if (opts.forceRefresh || cachedBnkUrl !== cachedConfig.bnk_url || !cachedBnkBuffer) {
    cachedBnkBuffer = await fetchBuffer(cachedConfig.bnk_url);
    cachedBnkUrl = cachedConfig.bnk_url;
  }

  return { bnkBuffer: cachedBnkBuffer, config: cachedConfig };
}

function invalidate() {
  cachedConfig = null;
  cachedBnkBuffer = null;
  cachedBnkUrl = null;
  urlBufferCache.clear();
}

module.exports = { getActive, invalidate, fetchBuffer };
