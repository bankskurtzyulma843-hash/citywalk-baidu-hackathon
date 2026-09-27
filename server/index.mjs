import http from 'node:http';
import path from 'node:path';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AppError, createGeoService } from './geo.mjs';
import { inspectMapResource } from './map-resource.mjs';
import { fetchOfficialMapDocument } from './map-embed.mjs';
import { planItinerary } from './planner.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const publicRoot = path.join(root, 'public');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
function send(res, status, body, requestId) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Request-Id': requestId });
  res.end(JSON.stringify(body));
}
async function jsonBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 64 * 1024) throw new AppError('INVALID_ARGUMENT', '请求内容过大。', 413);
  }
  try { return body ? JSON.parse(body) : {}; }
  catch { throw new AppError('INVALID_ARGUMENT', '请求格式无效。'); }
}
export function createApp(options = {}) {
  const mode = options.mode || process.env.CITYWALK_MODE || 'demo';
  const browserAk = options.browserAk ?? process.env.BAIDU_BROWSER_AK ?? '';
  const serverAk = options.serverAk ?? process.env.BAIDU_SERVER_AK ?? '';
  const authToken = options.authToken ?? process.env.BAIDU_MAP_AUTH_TOKEN ?? '';
  const dataDir = options.dataDir || path.join(root, '.data', 'shares');
  const geo = options.geo || createGeoService({ serverAk, authToken });
  const routes = new Map();
  const idempotent = new Map();
  const inFlight = new Map();
  const limits = new Map();
  const routeTtlMs = options.routeTtlMs ?? 30 * 60 * 1000;
  const shareTtlMs = options.shareTtlMs ?? 7 * 24 * 60 * 60 * 1000;
  let cliStatusPromise, cliStatusAt = 0;
  async function cliStatus() {
    if (!cliStatusPromise || Date.now() - cliStatusAt > 10000) {
      cliStatusAt = Date.now();
      cliStatusPromise = import('./baidu-cli.mjs').then(m => m.getCliStatus()).catch(() => ({ installed: false, version: null, available: false, reason: 'CLI 适配器尚未安装。' }));
    }
    return cliStatusPromise;
  }
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    let activeFlight = null;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new AppError('FORBIDDEN', '此请求来源不被允许。', 403);
        const client = req.socket.remoteAddress || 'local';
        const now = Date.now();
        for (const [key, value] of routes) if (now > value.expiresAt) routes.delete(key);
        for (const [key, value] of idempotent) if (now > value.expiresAt) idempotent.delete(key);
        for (const [key, value] of limits) if (now > value.resetAt) limits.delete(key);
        const limit = limits.get(client) || { count: 0, resetAt: now + 60000 };
        if (++limit.count > 120) throw new AppError('LIMIT_EXCEEDED', '操作过于频繁，请稍后再试。', 429, true);
        limits.set(client, limit);
        let body;
        const success = (value, status = 200) => send(res, status, { requestId, ...value }, requestId);
        if (req.method === 'GET' && url.pathname === '/api/config') {
          success({ mode, browserAk, cliStatus: await cliStatus(), limits: { maxStops: 5 }, capabilities: { demo: true, baidu: Boolean(serverAk), agentplan: Boolean(authToken), baiduMap: Boolean(browserAk) } }); return;
        }
        if (req.method === 'GET' && url.pathname === '/api/health') {
          success({ data: { status: 'ok' } }); return;
        }
        if (req.method === 'GET' && url.pathname === '/api/v1/maps/resource-status') {
          success({ data: await inspectMapResource(url.searchParams.get('resource_key')) }); return;
        }
        if (req.method === 'GET' && url.pathname === '/api/v1/maps/embed') {
          const html = await fetchOfficialMapDocument(url.searchParams.get('resource_key'));
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': 'sandbox allow-scripts allow-same-origin allow-popups',
          });
          res.end(html); return;
        }
        if (req.method === 'GET' && /^\/api\/v1\/shares\/[a-f0-9]{32}$/.test(url.pathname)) {
          const token = url.pathname.split('/').at(-1);
          let record;
          try { record = JSON.parse(await readFile(path.join(dataDir, `${token}.json`), 'utf8')); }
          catch { throw new AppError('SHARE_NOT_FOUND', '这份行程不存在或链接已失效。', 404); }
          if (Date.now() >= Date.parse(record.data.expiresAt)) throw new AppError('SHARE_EXPIRED', '这份行程的分享链接已到期。', 410);
          success(record); return;
        }
        if (req.method !== 'POST') throw new AppError('NOT_FOUND', '此接口不存在。', 404);
        body = await jsonBody(req);
        const keyHeader = req.headers['idempotency-key'];
        if (keyHeader && (typeof keyHeader !== 'string' || keyHeader.length > 150)) throw new AppError('INVALID_ARGUMENT', '幂等键无效。');
        const key = keyHeader ? `${client}:${url.pathname}:${keyHeader}` : null;
        const fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex');
        if (key && idempotent.has(key)) {
          const cached = idempotent.get(key);
          if (fingerprint !== cached.fingerprint) throw new AppError('IDEMPOTENCY_CONFLICT', '相同操作标识不能用于不同内容。', 409);
          success(cached.result, cached.status); return;
        }
        if (key && inFlight.has(key)) {
          const pending = inFlight.get(key);
          if (pending.fingerprint !== fingerprint) throw new AppError('IDEMPOTENCY_CONFLICT', '相同操作标识不能用于不同内容。', 409);
          const completed = await pending.promise;
          success(completed.result, completed.status); return;
        }
        if (key) {
          let resolve, reject;
          const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
          promise.catch(() => {});
          activeFlight = { key, resolve, reject };
          inFlight.set(key, { fingerprint, promise });
        }
        let result, status = 200;
        if (url.pathname === '/api/v1/geo/places/search') {
          result = await geo.search({ ...body, mode: body.mode || mode });
        } else if (url.pathname === '/api/v1/itineraries/plan') {
          if (routes.size >= 1000) throw new AppError('LIMIT_EXCEEDED', '演示服务繁忙，请稍后再试。', 503, true);
          result = await planItinerary(body, geo);
          routes.set(result.data.routeResultId, { result: structuredClone(result), expiresAt: Date.now() + routeTtlMs });
        } else if (url.pathname === '/api/v1/geo/routes/walking') {
          if (routes.size >= 1000) throw new AppError('LIMIT_EXCEEDED', '演示服务繁忙，请稍后再试。', 503, true);
          result = await geo.route({ ...body, mode: body.mode || mode });
          routes.set(result.data.routeResultId, { result: structuredClone(result), expiresAt: Date.now() + routeTtlMs });
        } else if (url.pathname === '/api/v1/shares') {
          const stored = routes.get(body.routeResultId);
          if (!stored || Date.now() > stored.expiresAt) throw new AppError('RESULT_EXPIRED', '路线结果已过期，请重新生成路线后分享。', 409);
          const route = stored.result.data;
          if (body.inputHash !== route.inputHash) throw new AppError('VERSION_CONFLICT', '地点顺序已变化，请重新算路。', 409);
          if (!Number.isInteger(body.budgetMin) || body.budgetMin < 1 || body.budgetMin > 1440) throw new AppError('INVALID_ARGUMENT', '总时间预算应为 1 至 1440 分钟。');
          if (!Array.isArray(body.stays) || body.stays.length !== route.orderedStops.length) throw new AppError('INVALID_ARGUMENT', '请为每个地点设置停留时间。');
          const seen = new Set();
          for (const stop of body.stays) {
            if (!stop || typeof stop !== 'object' || seen.has(stop.placeId) || !route.orderedStops.some(p => p.placeId === stop.placeId) || !Number.isInteger(stop.stayMin) || stop.stayMin < 0 || stop.stayMin > 240) {
              throw new AppError('INVALID_ARGUMENT', '停留时间应为 0 至 240 的整数分钟，且地点不能重复。');
            }
            seen.add(stop.placeId);
          }
          const orderedStops = route.orderedStops.map(p => ({ ...p, stayMin: body.stays.find(s => s.placeId === p.placeId).stayMin }));
          const totalDurationSec = route.walkingDurationSec + orderedStops.reduce((n, p) => n + p.stayMin * 60, 0);
          const token = randomBytes(16).toString('hex');
          const expiresAt = new Date(Date.now() + shareTtlMs).toISOString();
          const snapshot = { data: { title: typeof body.title === 'string' ? body.title.trim().slice(0, 60) || '一起走 CityWalk' : '一起走 CityWalk',
            city: orderedStops[0].city || '北京', orderedStops, segments: route.segments, distanceM: route.distanceM,
            walkingDurationSec: route.walkingDurationSec, totalDurationSec, budgetMin: body.budgetMin,
            ...(route.mapUrl ? { mapUrl: route.mapUrl } : {}),
            ...(route.mapUrls ? { mapUrls: route.mapUrls } : {}),
            ...(route.coordSystem ? { coordSystem: route.coordSystem } : {}),
            ...(route.geometryUnavailable === true ? { geometryUnavailable: true } : {}),
            createdAt: new Date().toISOString(), expiresAt }, meta: stored.result.meta };
          await mkdir(dataDir, { recursive: true });
          const temporary = path.join(dataDir, `${token}.tmp`);
          await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
          await rename(temporary, path.join(dataDir, `${token}.json`));
          result = { data: { shareUrl: `/s/${token}`, expiresAt } }; status = 201;
        } else throw new AppError('NOT_FOUND', '此接口不存在。', 404);
        if (key) idempotent.set(key, { result, fingerprint, status, expiresAt: Date.now() + routeTtlMs });
        if (activeFlight) { activeFlight.resolve({ result, status }); inFlight.delete(activeFlight.key); }
        success(result, status); return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new AppError('NOT_FOUND', '页面不存在。', 404);
      const pathname = url.pathname === '/' || /^\/s\/[a-f0-9]{32}$/.test(url.pathname) ? '/index.html' : decodeURIComponent(url.pathname);
      const filename = path.resolve(publicRoot, `.${pathname}`);
      if (!filename.startsWith(`${publicRoot}${path.sep}`)) throw new AppError('NOT_FOUND', '页面不存在。', 404);
      let data;
      try { data = await readFile(filename); } catch { throw new AppError('NOT_FOUND', '页面不存在。', 404); }
      res.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (activeFlight) { activeFlight.reject(error); inFlight.delete(activeFlight.key); }
      const known = error instanceof AppError || error.code === 'CAPABILITY_UNAVAILABLE';
      const code = known ? error.code : 'INTERNAL_ERROR';
      const message = known ? error.message : '服务暂时无法完成操作，请重试。';
      send(res, error.status || (known ? 503 : 500), { requestId, error: { code, message, retryable: Boolean(error.retryable) } }, requestId);
    }
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 4173);
  createApp().listen(port, host, () => console.log(`CityWalk Demo: http://${host}:${port} (${process.env.CITYWALK_MODE || 'demo'})`));
}
