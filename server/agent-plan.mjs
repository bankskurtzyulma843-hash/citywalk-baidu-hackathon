import { randomUUID } from 'node:crypto';
import { AppError, resultMeta, routeHash } from './geo.mjs';

/**
 * Agent Plan transport contract verified from Baidu's official references:
 * https://github.com/baidu-maps/bmap-agent-plugin/blob/main/baidu-map/skills/baidu-ai-map/references/agent-plan-api.md
 * https://github.com/baidu-maps/map-skills/blob/main/skills/baidu-ai-map/SKILL.md
 * Published map visualization/answer-type additions:
 * https://clawhub.ai/api/v1/skills/baidu-ai-map/file?path=SKILL.md
 *
 * These references specify requests, GCJ02 coordinates, and clarification
 * behavior, but do not publish a response JSON/road geometry schema. The place
 * mappings below were verified against successful provider responses captured
 * by the root task in .data/agentplan-place-live.json and
 * .data/agentplan-direction-no-location.json (no credentials). Unknown
 * response shapes are rejected explicitly rather than read heuristically.
 * No sample results or straight-line paths are returned from this adapter.
 */
const BASE_URL = 'https://api.map.baidu.com';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Build only Baidu's documented MapRender URL; never trust an upstream URL. */
export function agentPlanMapUrl(resourceKey) {
  if (typeof resourceKey !== 'string' || !resourceKey.trim() ||
      resourceKey.length > 1024 || /[\u0000-\u001f\u007f]/.test(resourceKey)) return null;
  const url = new URL('https://lbs.baidu.com/mapstatic/agentui_resource.html');
  url.searchParams.set('resource_key', resourceKey);
  return url.href;
}

function requiredText(value, label, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new AppError('INVALID_ARGUMENT', `${label}不能为空，且最多 ${max} 字。`);
  }
  // Preserve the entire original request, including every qualifier.
  return value;
}

function gcjLocation(value, code = 'INVALID_ARGUMENT', message = '请提供可信来源的 GCJ02 经纬度。') {
  if (!value || typeof value !== 'object' || value.coordSystem !== 'GCJ02' ||
      !Number.isFinite(value.lng) || !Number.isFinite(value.lat) ||
      value.lng < -180 || value.lng > 180 || value.lat < -90 || value.lat > 90) {
    throw new AppError(code, message);
  }
  return { lng: value.lng, lat: value.lat, coordSystem: 'GCJ02' };
}

function coordinatePair(value) {
  return `${value.lat.toFixed(6)},${value.lng.toFixed(6)}`;
}

function selectedStops(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 5) {
    throw new AppError('INVALID_ARGUMENT', '请选择 2 至 5 个真实 Agent Plan 地点。');
  }
  const seen = new Set();
  return value.map(p => {
    if (!p || p.source !== 'agentplan' || typeof p.placeId !== 'string' ||
        !p.placeId || seen.has(p.placeId) || typeof p.providerPlaceId !== 'string' ||
        !p.providerPlaceId || /[,:;]/.test(p.providerPlaceId)) {
      throw new AppError('INVALID_ARGUMENT', '请使用 Agent Plan 检索得到的不同地点，不能混用示例或其他坐标系。');
    }
    const name = requiredText(p.name, '地点名称', 200);
    const location = gcjLocation(p.location);
    seen.add(p.placeId);
    return { placeId: p.placeId, providerPlaceId: p.providerPlaceId, name,
      address: typeof p.address === 'string' ? p.address : '',
      city: typeof p.city === 'string' ? p.city : '', source: 'agentplan', location };
  });
}

function unresolvedResponse(kind) {
  return new AppError('AGENTPLAN_RESPONSE_UNSUPPORTED',
    kind === 'place'
      ? 'Agent Plan 返回结构尚未核验，暂不能把响应转换为可选地点。'
      : 'Agent Plan 路线与道路坐标结构尚未核验，暂不能显示真实步行路径。', 502);
}

function providerSuccess(payload, kind) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      typeof payload.status !== 'number' || !Number.isFinite(payload.status)) throw unresolvedResponse(kind);
  if (payload.status !== 0) {
    // Agent Plan business error codes are not published in the verified source.
    // Preserve explicit failure without guessing a success or forwarding text.
    throw new AppError('PROVIDER_UNAVAILABLE', 'Agent Plan 未能返回有效结果，请检查授权、额度或请求内容。', 502);
  }
}

/** Exact place shape verified against the real authenticated provider response. */
export function normalizeAgentPlanPlaceResponse(payload, city) {
  providerSuccess(payload, 'place');
  if (payload.response_type !== 'place' || payload.result_type !== 'poi_type' || !Array.isArray(payload.results)) {
    throw unresolvedResponse('place');
  }
  const places = [];
  const seen = new Set();
  let skipped = 0;
  for (const item of payload.results) {
    if (!item || typeof item.uid !== 'string' || !item.uid.trim() ||
        typeof item.name !== 'string' || !item.name.trim() ||
        typeof item.location?.lng !== 'number' || typeof item.location?.lat !== 'number' ||
        !Number.isFinite(item.location.lng) || !Number.isFinite(item.location.lat) ||
        item.location.lng < -180 || item.location.lng > 180 || item.location.lat < -90 || item.location.lat > 90) {
      skipped++;
      continue;
    }
    if (seen.has(item.uid)) continue;
    seen.add(item.uid);
    // Only core public place fields enter the application. Do not forward
    // reviews, image URLs, raw provider objects or unrelated response content.
    places.push({ placeId: `agentplan-${item.uid}`, providerPlaceId: item.uid,
      name: item.name, address: typeof item.address === 'string' ? item.address : '',
      city: typeof item.city === 'string' && item.city.trim() ? item.city : city,
      location: { lng: item.location.lng, lat: item.location.lat, coordSystem: 'GCJ02' }, source: 'agentplan' });
  }
  if (payload.results.length && !places.length) throw unresolvedResponse('place');
  const mapUrl = agentPlanMapUrl(payload.resource_key);
  return { data: { places, coordSystem: 'GCJ02', ...(mapUrl ? { mapUrl } : {}) },
    meta: resultMeta('baidu', 'agentplan', skipped ? ['部分地点缺少可用坐标或 UID，未显示在清单中。'] : []) };
}

function numericCoordinate(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return NaN;
}

function providerPoint(value) {
  const lng = numericCoordinate(value?.lng), lat = numericCoordinate(value?.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
    throw unresolvedResponse('direction');
  }
  return { lng, lat, coordSystem: 'GCJ02' };
}

function separationM(a, b) {
  const radians = degrees => degrees * Math.PI / 180;
  const latDifference = radians(b.lat - a.lat), lngDifference = radians(b.lng - a.lng);
  const h = Math.sin(latDifference / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(lngDifference / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Verified direction shape: result.navigation_data.type=walk,
 * walk_routes[0].distance (meters)/duration (seconds), steps[].path lng,lat.
 * stepOriginLocation/stepDestinationLocation are intentionally unused: the
 * authenticated response contained unrelated coordinates in those fields.
 */
export function normalizeAgentPlanDirectionResponse(payload, start, end) {
  providerSuccess(payload, 'direction');
  if (payload.response_type !== 'direction' || !payload.result || typeof payload.result !== 'object') {
    throw unresolvedResponse('direction');
  }
  const answerType = payload.result.answer_type;
  if (['gptmodel_poi_clarify', 'gptmodel_onway_search_clarify'].includes(answerType)) {
    throw new AppError('AGENTPLAN_CLARIFICATION_REQUIRED', '百度返回了需要确认的地点候选，请重新搜索并选中具体地点后再规划。', 409);
  }
  if (answerType !== 'gptmodel_navigate') throw unresolvedResponse('direction');
  const navigation = payload.result.navigation_data;
  if (!navigation || navigation.type !== 'walk' || !Array.isArray(navigation.walk_routes) || !navigation.walk_routes.length) {
    throw unresolvedResponse('direction');
  }
  const origin = providerPoint(navigation.origin), destination = providerPoint(navigation.destination);
  // Check the service chose the explicit selected endpoints; road entrances
  // can differ from POI markers, while a different city/landmark is rejected.
  if (typeof navigation.origin.name !== 'string' || typeof navigation.destination.name !== 'string' ||
      navigation.origin.name.trim() !== start.name.trim() || navigation.destination.name.trim() !== end.name.trim() ||
      separationM(origin, start.location) > 1000 || separationM(destination, end.location) > 1000) {
    throw new AppError('AGENTPLAN_ENDPOINT_MISMATCH', '百度返回的路线起终点与所选地点不一致，请选择更具体的地点后重试。', 409);
  }
  const route = navigation.walk_routes[0];
  if (!route || !Number.isFinite(route.distance) || route.distance < 0 || !Number.isFinite(route.duration) || route.duration < 0) {
    throw unresolvedResponse('direction');
  }
  const mapUrl = agentPlanMapUrl(payload.resource_key);
  const path = [];
  let missingGeometry = !Array.isArray(route.steps) || !route.steps.length;
  for (const step of Array.isArray(route.steps) ? route.steps : []) {
    if (!step || typeof step.path !== 'string' || !step.path.trim()) { missingGeometry = true; continue; }
    for (const pair of step.path.split(';')) {
      const coordinates = pair.split(',');
      if (coordinates.length !== 2) throw unresolvedResponse('direction');
      const point = providerPoint({ lng: coordinates[0], lat: coordinates[1] });
      const previous = path.at(-1);
      if (!previous || previous.lng !== point.lng || previous.lat !== point.lat) path.push(point);
    }
  }
  if (!missingGeometry && path.length >= 2) {
    if (separationM(path[0], origin) > 1000 || separationM(path.at(-1), destination) > 1000) {
      throw new AppError('AGENTPLAN_GEOMETRY_MISMATCH', '道路路径与路线起终点位置不一致，已停止展示，请重试。', 502);
    }
  } else {
    // A missing or incomplete geometry may use the provider's actual hosted
    // map, but never a straight line or a partial road portrayed as complete.
    if (!mapUrl) throw new AppError('AGENTPLAN_GEOMETRY_UNAVAILABLE', '百度返回了步行时间，但缺少完整道路路径和可查看的官方地图。', 502);
    path.length = 0;
    missingGeometry = true;
  }
  return { fromId: start.placeId, toId: end.placeId, distanceM: route.distance,
    durationSec: route.duration, coordSystem: 'GCJ02', path,
    geometryUnavailable: missingGeometry, ...(mapUrl ? { mapUrl } : {}) };
}

/**
 * authToken is supplied by the server; this module never reads credential files
 * or exposes the token in URLs, public metadata, or error messages.
 * Methods return the GeoService {data, meta} envelope. Normalized Place.source
 * and adapterMode are `agentplan`, with
 * location/route/segment coordinates explicitly tagged `GCJ02`.
 */
export function createAgentPlanAdapter(options = {}) {
  const { authToken, fetchImpl = globalThis.fetch, timeoutMs = 12000 } = options;

  function requireCredential() {
    if (typeof authToken !== 'string' || !authToken.trim()) {
      throw new AppError('CAPABILITY_UNAVAILABLE', 'Agent Plan 尚未配置服务端授权凭证。', 503);
    }
  }

  async function request(kind, params) {
    requireCredential();
    const url = new URL(`/agent_plan/v1/${kind}`, BASE_URL);
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(name, value);
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${authToken}`, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new AppError('PROVIDER_TIMEOUT', 'Agent Plan 请求超时，请重试。', 504, true);
      }
      throw new AppError('PROVIDER_UNAVAILABLE', '无法连接 Agent Plan，请稍后重试。', 502, true);
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError('PROVIDER_AUTH_FAILED', 'Agent Plan 服务端凭证或权限配置无效。', 503);
    }
    if (response.status === 429) {
      throw new AppError('PROVIDER_QUOTA_EXCEEDED', 'Agent Plan 额度或调用频率受限，请稍后再试。', 503, true);
    }
    if (!response.ok) {
      // Do not forward raw upstream responses: they may include sensitive data.
      throw new AppError('PROVIDER_UNAVAILABLE', 'Agent Plan 未能完成此次请求。', 502, response.status >= 500);
    }
    let body;
    try {
      body = await response.text();
    } catch {
      throw new AppError('PROVIDER_UNAVAILABLE', 'Agent Plan 响应读取失败，请稍后重试。', 502, true);
    }
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
      throw new AppError('AGENTPLAN_RESPONSE_UNSUPPORTED', 'Agent Plan 返回内容过大，暂不能展示。', 502);
    }
    try {
      const payload = JSON.parse(body);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('shape');
      return payload;
    } catch {
      throw new AppError('AGENTPLAN_RESPONSE_UNSUPPORTED', 'Agent Plan 未返回可核验的 JSON 对象。', 502);
    }
  }

  return {
    async search({ keyword, city = '北京', center, sort = 'relevance' } = {}) {
      requireCredential();
      const userRawRequest = requiredText(keyword, '完整地点需求');
      const region = requiredText(city, '城市或区域', 100);
      if (!['distance', 'relevance'].includes(sort)) throw new AppError('INVALID_ARGUMENT', '检索排序方式无效。');
      if (sort === 'distance' && !center) {
        throw new AppError('LOCATION_REQUIRED', '按距离检索需要先提供可信的检索中心点。');
      }
      if (!center && /我附近|我的附近|我周围|我的位置|当前位置|离我最近|^\s*(?:附近|周边)/.test(userRawRequest)) {
        throw new AppError('LOCATION_REQUIRED', '请先提供具体地点或可信位置，再搜索附近地点。');
      }
      const payload = await request('place', { user_raw_request: userRawRequest, region, sort,
        center: center ? coordinatePair(gcjLocation(center)) : undefined });
      return normalizeAgentPlanPlaceResponse(payload, region);
    },

    async route({ orderedStops, location } = {}) {
      requireCredential();
      const stops = selectedStops(orderedStops);
      // The official docs call location the current user position. A real
      // authorized call verified that explicit named endpoints + refer_pois
      // can succeed without it. Omit a missing location; never fabricate it
      // or silently replace it with the first itinerary stop.
      const context = location === undefined ? undefined : gcjLocation(location, 'INVALID_ARGUMENT',
        '提供的位置必须是可信来源的 GCJ02 当前坐标。');
      const segments = [];
      for (let i = 1; i < stops.length; i++) {
        const start = stops[i - 1], end = stops[i];
        if (/[;:]/.test(start.name) || /[;:]/.test(end.name) || start.name === end.name) {
          throw new AppError('INVALID_ARGUMENT', '这两个地点名称无法精确消歧，请选择具有不同完整名称的地点。');
        }
        const userRawRequest = `请规划从${start.city}${start.name}到${end.city}${end.name}的步行路线，只使用步行。`;
        const payload = await request('direction', { user_raw_request: userRawRequest,
          location: context ? coordinatePair(context) : undefined,
          refer_pois: `${start.name}:${start.providerPlaceId},${coordinatePair(start.location)};${end.name}:${end.providerPlaceId},${coordinatePair(end.location)}` });
        segments.push(normalizeAgentPlanDirectionResponse(payload, start, end));
      }
      const mapUrls = segments.filter(segment => segment.mapUrl).map(segment => segment.mapUrl);
      const geometryUnavailable = segments.some(segment => segment.geometryUnavailable);
      return { data: { routeResultId: randomUUID(), inputHash: routeHash(stops, 'agentplan'), orderedStops: stops,
        coordSystem: 'GCJ02', segments, distanceM: segments.reduce((sum, segment) => sum + segment.distanceM, 0),
        walkingDurationSec: segments.reduce((sum, segment) => sum + segment.durationSec, 0), geometryUnavailable,
        ...(mapUrls.length ? { mapUrl: mapUrls[0], mapUrls } : {}) },
        meta: resultMeta('baidu', 'agentplan', geometryUnavailable
          ? ['部分路段未返回完整道路坐标；时间为真实步行结果，请逐段打开对应的百度官方地图查看道路。']
          : []) };
    },
  };
}
