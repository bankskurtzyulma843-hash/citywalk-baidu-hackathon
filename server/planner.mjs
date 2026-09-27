import { AppError, routeHash } from './geo.mjs';

const cities = ['北京', '上海', '天津', '重庆', '广州', '深圳', '杭州', '成都', '南京', '武汉', '西安', '苏州', '长沙', '青岛', '厦门', '济南', '郑州', '宁波', '无锡', '福州', '昆明', '大理', '丽江', '珠海', '佛山', '合肥', '南昌', '沈阳', '哈尔滨', '长春', '海口', '三亚', '贵阳', '南宁', '桂林', '泉州', '洛阳', '开封', '扬州', '绍兴'];
const numberPattern = '[零〇一二两三四五六七八九十百半\\d.]+';
const invalid = message => new AppError('INVALID_ARGUMENT', message);
function numberValue(value) {
  if (value === '半') return 0.5;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0, digit = 0;
  for (const char of value) {
    if (char in digits) digit = digits[char];
    else if (char === '十' || char === '百') { total += (digit || 1) * (char === '十' ? 10 : 100); digit = 0; }
    else return NaN;
  }
  return total + digit;
}
function duration(match) {
  if (!match) return null;
  const amount = numberValue(match[1]);
  return Math.round((amount + (match[2] ? 0.5 : 0)) * (/小时|钟头/.test(match[3]) ? 60 : 1) + (match[4] ? 30 : 0));
}
const durationPattern = `${numberPattern}`;
// Intentionally small, auditable grammar; all unparsed preferences still reach
// Agent Plan verbatim. These are planning defaults, not inferred facts.
export function parsePlanningRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.request !== 'string') throw invalid('请用一句话描述想去的城市、地点和时间。');
  const request = input.request;
  if (!request.trim() || request.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(request)) throw invalid('行程需求应为 1 至 1000 字的完整句子。');
  if (input.mode !== undefined && input.mode !== 'agentplan') throw invalid('一句话规划需要使用百度 Agent Plan 真实数据模式。');
  if (input.city !== undefined && (typeof input.city !== 'string' || !input.city.trim() || input.city.length > 50 || /[\u0000-\u001f]/.test(input.city))) throw invalid('城市提示无效。');
  if (/我(?:的)?附近|我(?:的)?周围|我的位置|当前位置|离我最近|我这(?:里|边)/.test(request)) throw new AppError('LOCATION_REQUIRED', '请写明附近的地标，例如“北京雍和宫附近”，当前没有你的真实位置。');
  const mentionedCities = cities.filter(city => new RegExp(`${city}(?!路|街|大道|小面|石)`).test(request));
  if (mentionedCities.length > 1) throw invalid('一次 CityWalk 请只规划一个城市。');
  const city = mentionedCities[0] || input.city?.trim() || '北京';
  const warnings = [];
  if (!mentionedCities.length && !input.city) warnings.push('没有识别到城市，暂按北京规划；可在需求中写明城市。');
  const countMatch = request.match(new RegExp(`(${numberPattern})\\s*(?:个\\s*)?(?:站(?:点)?|地点|地方|景点|去处|处)(?!\\s*(?:小时|分钟))`));
  const requestedStops = countMatch ? numberValue(countMatch[1]) : 3;
  if (!Number.isInteger(requestedStops) || requestedStops < 2 || requestedStops > 5) throw invalid('一次行程支持 2 至 5 站，请调整站数。');
  const stayPattern = new RegExp(`(?:每(?:一)?(?:个)?(?:站(?:点)?|地点|地方|景点)|各(?:站|地点))\\s*(?:建议)?(?:停留|待|玩|逛)?\\s*(${durationPattern})(?:个)?(半)?\\s*(小时|钟头|分钟|分)(半)?`);
  const stayMatch = request.match(stayPattern);
  const stayMin = duration(stayMatch) ?? 20;
  if (!Number.isInteger(stayMin) || stayMin < 0 || stayMin > 240) throw invalid('每站停留支持 0 至 240 分钟。');
  const budgetText = stayMatch ? request.replace(stayMatch[0], '') : request;
  const budgetMatch = budgetText.match(new RegExp(`(${durationPattern})(?:个)?(半)?\\s*(小时|钟头|分钟|分)(半)?`));
  const budgetMin = duration(budgetMatch) ?? 180;
  if (!Number.isInteger(budgetMin) || budgetMin < 1 || budgetMin > 1440) throw invalid('总时间预算支持 1 至 1440 分钟。');
  if (!budgetMatch) warnings.push('未识别到总时间预算，暂用 180 分钟；可以修改。');
  return { request, city, requestedStops, countExplicit: Boolean(countMatch), budgetMin, stayMin, stayExplicit: Boolean(stayMatch), warnings,
    nearby: /附近|周边/.test(request), preserveOrder: /依次|按(?:这个|此)?顺序|先[\s\S]*再|最后/.test(request) };
}

function distance(a, b) {
  const rad = Math.PI / 180, lat = (b.location.lat - a.location.lat) * rad, lng = (b.location.lng - a.location.lng) * rad;
  const h = Math.sin(lat / 2) ** 2 + Math.cos(a.location.lat * rad) * Math.cos(b.location.lat * rad) * Math.sin(lng / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
function aliases(place) {
  const name = place.name.replace(/[（(][^）)]*[）)]/g, '').trim();
  const values = [name];
  // Avoid treating an entrance or a photo spot as its parent landmark.
  if (!/-|打卡点|入口|出口|昭泰门|集贤门/.test(name)) {
    const base = name.replace(/(?:博物馆|胡同|步行街|街区|景区|公园|古镇|广场|牌坊)$/, '');
    values.push(base);
    if (/博物馆$/.test(name)) values.push(...base.split('和'));
  }
  return [...new Set(values)].filter(value => value.length >= 2);
}
function namedPlaces(places, request) {
  const matches = places.flatMap((place, rank) => aliases(place).flatMap(alias => {
    const index = request.indexOf(alias);
    return index < 0 ? [] : [{ place, rank, index, end: index + alias.length, length: alias.length, exact: alias === place.name }];
  }));
  // Prefer an explicitly written full name, then the longest matched phrase;
  // provider relevance breaks ties. A single phrase never selects a parent
  // landmark and all of its entrances at once.
  matches.sort((a, b) => Number(b.exact) - Number(a.exact) || b.length - a.length || a.rank - b.rank);
  const chosen = [];
  for (const match of matches) {
    if (chosen.some(other => other.place.placeId === match.place.placeId || (match.index < other.end && other.index < match.end))) continue;
    chosen.push(match);
  }
  return chosen.sort((a, b) => a.index - b.index).map(match => match.place);
}
function validCandidates(result, city, minimum = 2) {
  if (result?.meta?.provider !== 'baidu' || result.meta.adapterMode !== 'agentplan' || !Array.isArray(result.data?.places)) {
    throw new AppError('PLANNING_SOURCE_INVALID', '规划检索没有返回真实 Agent Plan 地点。', 502);
  }
  const seen = new Set();
  const places = result.data.places.filter(place => {
    const loc = place?.location;
    if (!place || typeof place.placeId !== 'string' || !place.placeId || seen.has(place.placeId) || typeof place.providerPlaceId !== 'string' || !place.providerPlaceId ||
      typeof place.name !== 'string' || !place.name || place.source !== 'agentplan' || loc?.coordSystem !== 'GCJ02' ||
      !Number.isFinite(loc.lng) || !Number.isFinite(loc.lat) || Math.abs(loc.lng) > 180 || Math.abs(loc.lat) > 90 ||
      (place.city && place.city.replace(/市$/, '') !== city.replace(/市$/, ''))) return false;
    seen.add(place.placeId); return true;
  });
  if (places.length < minimum) throw new AppError('NOT_ENOUGH_PLACES', '百度没有返回足够的同城真实地点，请补充一个明确地标或调整需求。', 422);
  return places;
}
function nearbyLandmark(request, city) {
  const match = request.match(/([^，,。！？!?；;：:\n\r]{2,40}?)(?:附近|周边)/);
  if (!match) return null;
  let landmark = match[1].trim();
  const cityIndex = landmark.indexOf(city.replace(/市$/, ''));
  if (cityIndex >= 0) landmark = landmark.slice(cityIndex + city.replace(/市$/, '').length).replace(/^市/, '');
  landmark = landmark.replace(/^(?:(?:请)?帮我(?:安排|规划|找|设计)?|(?:我)?想(?:要)?(?:去|在)?|(?:我)?要(?:去|在)?|(?:计划|希望)(?:去|在)?|(?:周末|今天|明天|这周六|这周日|周六|周日)?(?:去|在|从))\s*/, '').replace(/的$/, '').trim();
  if (landmark.length < 2 || landmark.length > 30 || /^(?:城市|这里|那里|附近|周边|我家|家里|公司|学校|酒店|当前位置|我的位置)$/.test(landmark)) return null;
  return landmark;
}
function orderPlaces(selected, named, preserveOrder) {
  if (preserveOrder && named.length > 1) return [...named, ...selected.filter(p => !named.some(n => n.placeId === p.placeId))];
  // At most five stops: enumerate the small set with the first landmark fixed.
  // This optimizes straight-line ordering only; provider walking routes remain
  // authoritative and may have a different optimum.
  let best = selected, score = Infinity;
  function visit(prefix, remaining, cost) {
    if (!remaining.length) { if (cost < score) { best = prefix; score = cost; } return; }
    for (const place of remaining) visit([...prefix, place], remaining.filter(p => p !== place), cost + distance(prefix.at(-1), place));
  }
  visit([selected[0]], selected.slice(1), 0); return best;
}
export async function planItinerary(input, geo) {
  const parsed = parsePlanningRequest(input);
  const search = await geo.search({ keyword: parsed.request, city: parsed.city, mode: 'agentplan' });
  const places = validCandidates(search, parsed.city, 0);
  const warnings = [...(search.meta.warnings || []), ...parsed.warnings];
  let named = namedPlaces(places, parsed.request);
  let anchorMapUrl;
  const nearbyAnchor = parsed.nearby ? nearbyLandmark(parsed.request, parsed.city) : null;
  let anchorMatched = nearbyAnchor && namedPlaces(places, nearbyAnchor).length > 0;
  if (parsed.nearby && !anchorMatched) {
    const landmark = nearbyAnchor;
    if (landmark) {
      // One supplemental lookup for a landmark explicitly written by the user.
      // It is a planning anchor, never a guessed current user position.
      const anchorResult = await geo.search({ keyword: `${parsed.city}${landmark}`, city: parsed.city, mode: 'agentplan' });
      const anchors = validCandidates(anchorResult, parsed.city, 1);
      const anchor = namedPlaces(anchors, landmark)[0];
      if (anchor) {
        if (!places.some(place => place.placeId === anchor.placeId)) places.push(anchor);
        named = namedPlaces(places, parsed.request);
        anchorMatched = true;
        anchorMapUrl = anchorResult.data.mapUrl;
        warnings.push(...(anchorResult.meta.warnings || []), `已补查你写明的“${landmark}”作为真实地标起点，它不代表你的当前位置。`);
      }
    }
  }
  if (parsed.nearby && !anchorMatched) throw new AppError('LOCATION_REQUIRED', '附近规划需要明确地标，百度返回的地点中未找到你指定的参照地标。', 422);
  if (places.length < 2) throw new AppError('NOT_ENOUGH_PLACES', '百度没有返回足够的同城真实地点，请补充一个明确地标或调整需求。', 422);
  if (named.length > parsed.requestedStops) throw invalid(`需求中匹配到 ${named.length} 个地标，超过 ${parsed.requestedStops} 站；请减少地标或增加站数。`);
  const selected = named.length ? [...named] : [places[0]];
  while (selected.length < parsed.requestedStops) {
    const choices = places.filter(place => !selected.some(p => p.placeId === place.placeId)).map(place => ({ place,
      nearest: Math.min(...selected.map(p => distance(p, place))) })).filter(candidate => candidate.nearest >= 150 && candidate.nearest <= 2500);
    choices.sort((a, b) => a.nearest - b.nearest || places.indexOf(a.place) - places.indexOf(b.place));
    if (!choices.length) break;
    selected.push(choices[0].place);
  }
  if (selected.length < parsed.requestedStops) {
    if (selected.length < 2 || parsed.countExplicit) throw new AppError('NOT_ENOUGH_PLACES', `未找到 ${parsed.requestedStops} 个可步行连接的独立地点，请减少站数或写明更多地标。`, 422);
    warnings.push(`没有足够的相邻独立地点，默认 3 站已缩减为 ${selected.length} 站。`);
  }
  const ordered = orderPlaces(selected, named, parsed.preserveOrder);
  if (ordered.slice(1).some((place, index) => distance(ordered[index], place) > 2500)) throw new AppError('PLACES_TOO_FAR', '选中的地标间距过大，不适合这份步行行程，请选择同一片区的地点。', 422);
  // Never substitute a selected landmark for the user's current location.
  const result = await geo.route({ orderedStops: ordered, mode: 'agentplan' });
  const route = result?.data;
  if (result?.meta?.provider !== 'baidu' || result.meta.adapterMode !== 'agentplan' || route?.coordSystem !== 'GCJ02' ||
    route.inputHash !== routeHash(ordered, 'agentplan') || !route.routeResultId || !Array.isArray(route.orderedStops) ||
    route.orderedStops.length !== ordered.length || route.orderedStops.some((p, i) => p.placeId !== ordered[i].placeId) ||
    !Array.isArray(route.segments) || route.segments.length !== ordered.length - 1 || !Number.isFinite(route.walkingDurationSec) || route.walkingDurationSec < 0 || !Number.isFinite(route.distanceM) || route.distanceM < 0) {
    throw new AppError('PLANNING_SOURCE_INVALID', '百度步行路线没有返回与所选地点一致的完整结果。', 502);
  }
  let stayMin = parsed.stayMin;
  if (!parsed.stayExplicit) {
    stayMin = Math.max(0, Math.min(stayMin, Math.floor((parsed.budgetMin * 60 - route.walkingDurationSec) / (ordered.length * 60))));
    if (stayMin !== parsed.stayMin) warnings.push(`为了贴近时间预算，每站建议停留调整为 ${stayMin} 分钟；你可以继续修改。`);
  }
  const orderedStops = route.orderedStops.map(place => ({ ...place, stayMin }));
  const totalDurationSec = route.walkingDurationSec + stayMin * orderedStops.length * 60;
  const budgetExceededMin = Math.max(0, Math.ceil((totalDurationSec - parsed.budgetMin * 60) / 60));
  if (budgetExceededMin) warnings.push(`真实步行加停留预计超出预算 ${budgetExceededMin} 分钟，请减少地点、停留或增加预算。`);
  warnings.push('地点来自百度真实检索；偏好、营业时间、评分和可进入状态尚未逐项核实，停留时间仅为可编辑建议。');
  const selectionExplanation = `${named.length ? `优先保留需求中匹配到的 ${named.length} 个地标，` : '以百度返回的首个地点为起点，'}从同一片区补足独立地点，${parsed.preserveOrder && named.length > 1 ? '保留你写明的地标先后顺序' : '按地点直线距离安排顺序'}；各段距离和时间使用百度真实步行结果。`;
  return { data: { ...route, orderedStops, city: parsed.city, title: `${parsed.city.replace(/市$/, '')} · ${orderedStops[0].name} CityWalk`.slice(0, 60),
    budgetMin: parsed.budgetMin, totalDurationSec, suggestedStays: orderedStops.map(p => ({ placeId: p.placeId, stayMin: p.stayMin })),
    places, ...(search.data.mapUrl ? { searchMapUrl: search.data.mapUrl } : {}), ...(anchorMapUrl ? { anchorMapUrl } : {}),
    planning: { requestedStops: parsed.requestedStops, selectedStops: orderedStops.length, selectionMethod: 'named-landmarks-and-nearby-distance', selectionExplanation, constraintsVerified: false, budgetExceededMin } },
    meta: { ...result.meta, warnings: [...new Set([...(result.meta.warnings || []), ...warnings])] } };
}
