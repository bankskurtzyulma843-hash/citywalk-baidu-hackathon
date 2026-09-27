import { createHash, randomUUID } from 'node:crypto';

export class AppError extends Error {
  constructor(code, message, status = 400, retryable = false) {
    super(message); Object.assign(this, { code, status, retryable });
  }
}
const samplePoints = [
  ['sample-yonghe', '雍和宫街口', '北京 · 东城区雍和宫大街（示例点位）', 116.4242, 39.9479],
  ['sample-wudaoying', '五道营小巷', '北京 · 东城区五道营胡同（示例点位）', 116.4206, 39.9497],
  ['sample-coffee', '胡同咖啡小站', '虚构咖啡站，仅用于交互演示', 116.4187, 39.9488],
  ['sample-guozijian', '国子监街', '北京 · 东城区国子监街（示例点位）', 116.4168, 39.9461],
  ['sample-park', '街角口袋公园', '虚构休憩点，仅用于交互演示', 116.4119, 39.9434],
];
export const samplePlaces = samplePoints.map(([placeId, name, address, lng, lat]) => ({
  placeId, providerPlaceId: null, name, address, city: '北京',
  location: { lng, lat, coordSystem: 'BD09LL' }, source: 'demo',
}));
const textValue = (value, max = 100) => typeof value === 'string' ? value.trim().slice(0, max) : '';
export function validateStops(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 5) {
    throw new AppError('INVALID_ARGUMENT', '请选择 2 至 5 个不同地点，再生成步行路线。');
  }
  const seen = new Set();
  return value.map(p => {
    const placeId = textValue(p?.placeId);
    const lng = p?.location?.lng, lat = p?.location?.lat;
    if (!placeId || seen.has(placeId) || typeof lng !== 'number' || typeof lat !== 'number' ||
        !Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90 ||
        p.location.coordSystem !== 'BD09LL') {
      throw new AppError('INVALID_ARGUMENT', '地点重复或坐标无效，请重新选择地点。');
    }
    seen.add(placeId);
    return { placeId, providerPlaceId: textValue(p.providerPlaceId) || null,
      name: textValue(p.name) || '未命名地点', address: textValue(p.address, 300),
      city: textValue(p.city, 50), source: textValue(p.source), location: { lng, lat, coordSystem: 'BD09LL' } };
  });
}
export function routeHash(stops, mode) {
  return createHash('sha256').update(JSON.stringify({ mode, stops: stops.map(p => [p.placeId, p.providerPlaceId, p.location.lng, p.location.lat]) })).digest('hex');
}
export function resultMeta(provider, adapterMode, warnings = []) {
  return { provider, adapterMode, fetchedAt: new Date().toISOString(), warnings };
}
function sampleRoute(stops) {
  const segments = stops.slice(1).map((end, i) => {
    const start = stops[i];
    const dx = (end.location.lng - start.location.lng) * 85300;
    const dy = (end.location.lat - start.location.lat) * 111000;
    const distanceM = Math.max(100, Math.round(Math.hypot(dx, dy) * 1.22));
    return { fromId: start.placeId, toId: end.placeId, distanceM,
      durationSec: Math.round(distanceM / 1.12),
      path: [{ lng: start.location.lng, lat: start.location.lat },
        { lng: end.location.lng, lat: start.location.lat },
        { lng: end.location.lng, lat: end.location.lat }] };
  });
  return { segments, distanceM: segments.reduce((n, s) => n + s.distanceM, 0),
    walkingDurationSec: segments.reduce((n, s) => n + s.durationSec, 0),
    meta: resultMeta('demo', 'fixture', ['演示点位与路径用于体验流程，不是百度检索或真实步行道路。']) };
}
function vendorError(data) {
  const code = Number(data.status);
  if (code === 0) return;
  if ([4, 302, 401, 402].includes(code)) throw new AppError('PROVIDER_QUOTA_EXCEEDED', '百度服务额度或调用频率受限，请稍后再试。', 503);
  if ([5, 101, 102, 200, 201, 202, 203, 210, 211, 220, 240].includes(code)) throw new AppError('PROVIDER_AUTH_FAILED', '百度服务凭证或授权配置尚未就绪。', 503);
  if (code === 7) throw new AppError('NO_ROUTE', '这两个地点暂时没有可用的步行路线，请调整地点。', 422);
  throw new AppError('PROVIDER_UNAVAILABLE', '百度地图服务暂时未返回可用结果。', 502, true);
}
async function vendorGet(path, params, options) {
  const url = new URL(path, options.baseUrl || 'https://api.map.baidu.com');
  for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
  url.searchParams.set('ak', options.serverAk);
  try {
    const response = await (options.fetchImpl || fetch)(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new AppError('PROVIDER_UNAVAILABLE', '百度地图服务暂时不可用。', 502, true);
    const data = await response.json(); vendorError(data); return data;
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new AppError('PROVIDER_TIMEOUT', '百度地图请求超时，请重试。', 504, true);
    throw new AppError('PROVIDER_UNAVAILABLE', '无法连接百度地图服务，请检查网络后重试。', 502, true);
  }
}
export function createGeoService(options = {}) {
  let agentPlanPromise;
  function agentPlan() {
    return agentPlanPromise ||= import('./agent-plan.mjs').then(({ createAgentPlanAdapter }) => createAgentPlanAdapter({
      authToken: options.authToken, fetchImpl: options.fetchImpl,
    }));
  }
  function assertMode(mode) {
    if (!['demo', 'baidu', 'cli', 'agentplan'].includes(mode)) throw new AppError('INVALID_ARGUMENT', '请选择有效的数据模式。');
    if (mode === 'baidu' && !options.serverAk) throw new AppError('CAPABILITY_UNAVAILABLE', '真实检索和步行算路需要先配置服务端 AK。', 503);
    if (mode === 'agentplan' && !options.authToken) throw new AppError('CAPABILITY_UNAVAILABLE', 'Agent Plan 需要先完成百度账号授权并获取 SK。', 503);
  }
  return {
    async search({ keyword, city = '北京', mode = 'demo' }) {
      assertMode(mode);
      if (mode === 'agentplan') return (await agentPlan()).search({ keyword, city });
      keyword = textValue(keyword); city = textValue(city, 50);
      if (!keyword || !city) throw new AppError('INVALID_ARGUMENT', '请输入地点关键词并选择城市。');
      if (mode === 'demo') {
        const places = city.replace(/市$/, '') === '北京' ? samplePlaces.filter(p => keyword === '示例' || `${p.name}${p.address}`.includes(keyword)) : [];
        return { data: { places }, meta: resultMeta('demo', 'fixture', ['当前为演示数据，仅提供北京示例点位。']) };
      }
      if (mode === 'cli') {
        const { searchWithCli } = await import('./baidu-cli.mjs');
        const result = await searchWithCli({ keyword, city });
        return { data: { places: result.places }, meta: result.meta || resultMeta('baidu', 'cli') };
      }
      const result = await vendorGet('/place/v2/search', { query: keyword, region: city, city_limit: true, output: 'json', scope: 1, page_size: 10 }, options);
      const places = (result.results || []).filter(p => p.uid && Number.isFinite(p.location?.lng) && Number.isFinite(p.location?.lat)).map(p => ({
        placeId: `baidu-${p.uid}`, providerPlaceId: p.uid, name: p.name, address: p.address || '', city: p.city || city,
        location: { lng: p.location.lng, lat: p.location.lat, coordSystem: 'BD09LL' }, source: 'baidu',
      }));
      return { data: { places }, meta: resultMeta('baidu', 'webapi') };
    },
    async route({ orderedStops, currentLocation, mode = 'demo' }) {
      assertMode(mode);
      if (mode === 'agentplan') return (await agentPlan()).route({ orderedStops, location: currentLocation });
      const stops = validateStops(orderedStops);
      let result;
      if (mode === 'demo') {
        if (stops.some(p => !samplePlaces.some(s => s.placeId === p.placeId && s.location.lng === p.location.lng && s.location.lat === p.location.lat))) {
          throw new AppError('INVALID_ARGUMENT', '演示模式只接受已提供的示例地点。');
        }
        result = sampleRoute(stops);
      } else if (mode === 'cli') {
        const { routeWithCli } = await import('./baidu-cli.mjs'); result = await routeWithCli({ orderedStops: stops });
      } else {
        if (stops.some(p => p.source !== 'baidu' || !p.providerPlaceId)) throw new AppError('INVALID_ARGUMENT', '请使用真实百度检索结果生成路线。');
        const tasks = stops.slice(1).map(async (end, i) => {
          const start = stops[i];
          const result = await vendorGet('/directionlite/v1/walking', {
            origin: `${start.location.lat},${start.location.lng}`, destination: `${end.location.lat},${end.location.lng}`,
            origin_uid: start.providerPlaceId, destination_uid: end.providerPlaceId,
            coord_type: 'bd09ll', ret_coordtype: 'bd09ll', steps_info: 1,
          }, options);
          const route = result.result?.routes?.[0];
          const path = (route?.steps || []).flatMap(s => String(s.path || '').split(';').filter(Boolean).map(pair => {
            const [lng, lat] = pair.split(',').map(Number); return { lng, lat };
          }));
          if (!route || !Number.isFinite(route.distance) || !Number.isFinite(route.duration) || path.length < 2 || path.some(p => !Number.isFinite(p.lng) || !Number.isFinite(p.lat))) {
            throw new AppError('NO_ROUTE', '百度服务未返回完整的步行道路，请换点或重试。', 422);
          }
          return { fromId: start.placeId, toId: end.placeId, distanceM: route.distance, durationSec: route.duration, path };
        });
        const results = await Promise.allSettled(tasks);
        const failure = results.findIndex(r => r.status === 'rejected');
        if (failure >= 0) {
          const error = results[failure].reason;
          error.message = `第 ${failure + 1} 段路线未完成：${error.message}`;
          throw error;
        }
        const segments = results.map(r => r.value);
        result = { segments, distanceM: segments.reduce((n, s) => n + s.distanceM, 0),
          walkingDurationSec: segments.reduce((n, s) => n + s.durationSec, 0), meta: resultMeta('baidu', 'webapi') };
      }
      return { data: { routeResultId: randomUUID(), inputHash: routeHash(stops, mode), orderedStops: stops,
        segments: result.segments, distanceM: result.distanceM, walkingDurationSec: result.walkingDurationSec },
        meta: result.meta || resultMeta('baidu', mode) };
    },
  };
}
