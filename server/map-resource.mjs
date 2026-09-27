import { AppError } from './geo.mjs';

const RESOURCE_ENDPOINT = 'https://api.map.baidu.com/agent_plan/v1/resource';
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function resourceKeys(value) {
  const keys = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 5 ||
      keys.some(key => typeof key !== 'string' || !/^[a-f0-9]{32}$/i.test(key))) {
    throw new AppError('INVALID_ARGUMENT', '请提供 1 至 5 个有效的地图资源标识。');
  }
  return [...new Set(keys)];
}

function coordinate(location) {
  if (!location || typeof location !== 'object') return false;
  const lng = typeof location.lng === 'string' && location.lng.trim() ? Number(location.lng) : location.lng;
  const lat = typeof location.lat === 'string' && location.lat.trim() ? Number(location.lat) : location.lat;
  return Number.isFinite(lng) && Number.isFinite(lat) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90;
}

function place(poi) {
  return Boolean(poi && typeof poi.uid === 'string' && poi.uid &&
    typeof poi.name === 'string' && poi.name && coordinate(poi.location));
}

function direction(result) {
  const nav = result?.navigation_data;
  return Boolean(result?.answer_type === 'gptmodel_navigate' && nav?.type === 'walk' &&
    coordinate(nav.origin) && coordinate(nav.destination) &&
    Array.isArray(nav.walk_routes) && nav.walk_routes.length && nav.walk_routes.every(route =>
      Number.isFinite(route?.distance) && route.distance >= 0 &&
      Number.isFinite(route?.duration) && route.duration >= 0));
}

// The hosted page accepts the original place/direction payload, and a results
// list containing those payloads or navigation_data records. This confirms
// usable resource data only: it cannot prove cross-origin map tiles rendered.
function renderable(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (payload.response_type === 'place') return Array.isArray(payload.results) && payload.results.length > 0 && payload.results.every(place);
  if (payload.response_type === 'direction') return direction(payload.result);
  if (payload.response_type !== undefined) return false;
  return direction(payload) || place(payload);
}

function availability(payload, requestedKeyCount) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.status !== 'number') {
    return { available: false, reason: 'unsupported' };
  }
  if (payload.status !== 0) return { available: false, reason: 'unavailable' };
  if (Array.isArray(payload.results) && payload.results.length === 0) return { available: false, reason: 'expired' };
  // A combined request must include a wrapper entry for every distinct key.
  // Otherwise the official viewer can show only surviving route segments and
  // silently omit the expired ones. Original unwrapped payloads remain valid
  // for a single resource request.
  if (requestedKeyCount > 1 && (payload.response_type !== undefined ||
      (Array.isArray(payload.results) && payload.results.length < requestedKeyCount))) {
    return { available: false, reason: 'expired' };
  }
  const valid = renderable(payload) || (payload.response_type === undefined &&
    Array.isArray(payload.results) && payload.results.length > 0 && payload.results.every(renderable));
  return { available: Boolean(valid), reason: valid ? 'available' : 'unsupported' };
}

/** Inspect existing resource data without SK, AK, or a new place/route request.
 * reason: available | expired | unsupported | unavailable | unreachable | timeout.
 * Invalid keys throw INVALID_ARGUMENT before any network request.
 */
export async function inspectMapResource(resourceKey, { fetchImpl = globalThis.fetch } = {}) {
  const keys = resourceKeys(resourceKey);
  const url = new URL(RESOURCE_ENDPOINT);
  url.searchParams.set('resource_key', keys.join(','));
  const controller = new AbortController();
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ available: false, reason: 'timeout' });
    }, TIMEOUT_MS);
  });
  const request = (async () => {
    try {
      const response = await fetchImpl(url.href, {
        method: 'GET', headers: { Accept: 'application/json' },
        redirect: 'error', cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok) return { available: false, reason: 'unavailable' };
      const length = Number(response.headers?.get('content-length'));
      if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) return { available: false, reason: 'unsupported' };
      const body = await response.text();
      if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) return { available: false, reason: 'unsupported' };
      let payload;
      try { payload = JSON.parse(body); }
      catch { return { available: false, reason: 'unsupported' }; }
      return availability(payload, keys.length);
    } catch {
      return { available: false, reason: controller.signal.aborted ? 'timeout' : 'unreachable' };
    }
  })();
  try { return await Promise.race([request, timeout]); }
  finally { clearTimeout(timer); }
}
