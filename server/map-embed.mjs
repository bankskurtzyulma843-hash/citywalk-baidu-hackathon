import { AppError } from './geo.mjs';

const OFFICIAL_DOCUMENT_URL = 'https://lbs.baidu.com/mapstatic/agentui_resource.html';
const TIMEOUT_MS = 10_000;
const MAX_HTML_BYTES = 128 * 1024;

function validKeys(value) {
  const keys = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 5 ||
      keys.some(key => typeof key !== 'string' || !/^[a-f0-9]{32}$/i.test(key))) {
    throw new AppError('INVALID_ARGUMENT', '请提供 1 至 5 个有效的地图资源标识。');
  }
  return keys;
}

function invalidDocument() {
  return new AppError('MAP_DOCUMENT_INVALID', '百度官方地图页面未返回有效文档。', 502, true);
}

async function limitedDocument(response) {
  if (!/^text\/html(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '')) throw invalidDocument();
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_HTML_BYTES) throw invalidDocument();
  if (!response.body || typeof response.body.getReader !== 'function') throw invalidDocument();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HTML_BYTES) {
        reader.cancel().catch(() => {});
        throw invalidDocument();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  // Return the complete original document; do not extract, rewrite, or reuse
  // any script/SDK credentials. The caller must isolate it in a sandboxed
  // iframe without allow-same-origin, and retain Baidu attribution/link.
  const html = Buffer.concat(chunks, size).toString('utf8');
  if (!/<html(?:\s|>)/i.test(html) || !/<\/html\s*>/i.test(html)) throw invalidDocument();
  return html;
}

/** Fetch only the complete official map resource document, never other URLs.
 * No SK/AK/cookies are supplied. The document is not persisted or modified.
 */
export async function fetchOfficialMapDocument(resourceKey, { fetchImpl = globalThis.fetch } = {}) {
  const url = new URL(OFFICIAL_DOCUMENT_URL);
  url.searchParams.set('resource_key', validKeys(resourceKey).join(','));
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AppError('MAP_DOCUMENT_TIMEOUT', '百度官方地图页面加载超时。', 504, true));
    }, TIMEOUT_MS);
  });
  const request = (async () => {
    try {
      const response = await fetchImpl(url.href, {
        method: 'GET', headers: { Accept: 'text/html' },
        redirect: 'error', cache: 'no-store', credentials: 'omit', signal: controller.signal,
      });
      if (!response.ok) throw new AppError('MAP_DOCUMENT_UNAVAILABLE', '暂时无法加载百度官方地图页面。', 502, true);
      return await limitedDocument(response);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (controller.signal.aborted) throw new AppError('MAP_DOCUMENT_TIMEOUT', '百度官方地图页面加载超时。', 504, true);
      throw new AppError('MAP_DOCUMENT_UNAVAILABLE', '暂时无法连接百度官方地图页面。', 502, true);
    }
  })();
  try { return await Promise.race([request, timeout]); }
  finally { clearTimeout(timer); }
}
