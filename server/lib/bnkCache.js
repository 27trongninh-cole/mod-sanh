'use strict';

const supabaseStore = require('./supabaseStore');

const CONFIG_TTL_MS = 30 * 1000; // re-check Supabase tối đa mỗi 30s
const MAX_BNK_BYTES = 100 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30 * 1000;

let cachedConfig = null;   // { bnkUrl, updatedAt, updatedBy, fetchedAt }
let cachedBnkBuffer = null;
let cachedBnkUrl = null;

async function fetchBuffer(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(url, { signal: controller.signal });
  } catch (e) {
    throw new Error(`Không tải được file từ URL (${e.message})`);
  } finally {
    clearTimeout(timeout);
  }
  if (!resp.ok) throw new Error(`Không tải được file từ URL (HTTP ${resp.status})`);

  const contentLength = resp.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_BNK_BYTES) {
    throw new Error('File vượt quá giới hạn 100MB');
  }
  const arrayBuf = await resp.arrayBuffer();
  const buf = Buffer.from(arrayBuf);
  if (buf.length > MAX_BNK_BYTES) throw new Error('File vượt quá giới hạn 100MB');
  if (buf.length === 0) throw new Error('File tải về rỗng (0 byte)');
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
}

module.exports = { getActive, invalidate, fetchBuffer };
