import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parsePlanningRequest, planItinerary } from '../server/planner.mjs';
import { normalizeAgentPlanPlaceResponse, agentPlanMapUrl } from '../server/agent-plan.mjs';
import { routeHash, resultMeta } from '../server/geo.mjs';
import { createApp } from '../server/index.mjs';

// Public POI fields from the authorized place response; no credentials, logs,
// reviews or account data. Direction is mocked below solely to test planning
// orchestration. Exact provider road mapping is covered in agent-plan.test.mjs.
const response = { status: 0, response_type: 'place', result_type: 'poi_type', resource_key: 'test-only-place-resource', results: [
  { uid: '92bc1f0a948a5c38a0acc418', name: '雍和宫', address: '北京市东城区雍和宫大街28号', city: '北京市', location: { lat: 39.94716503763865, lng: 116.41729518615993 } },
  { uid: '41572e00530f08b4b45f1ed2', name: '孔庙和国子监博物馆', address: '北京市东城区安定门内国子监街15号', city: '北京市', location: { lat: 39.94662174845691, lng: 116.41386890123759 } },
  { uid: '16ed8dff03cdd1fef82213c4', name: '国子监牌坊', address: '国子监街', city: '北京市', location: { lat: 39.945437870546996, lng: 116.41269965989675 } },
  { uid: 'f23002aec5fe00e0c61e51f8', name: '五道营胡同', address: '安定门街道五道营胡同49号', city: '北京市', location: { lat: 39.948485793669654, lng: 116.41292288740297 } },
  { uid: 'f4a33da92c9976093010af7b', name: '雍和宫昭泰门', address: '雍和宫', city: '北京市', location: { lat: 39.946909597403, lng: 116.41735920822042 } },
] };
const searchResult = normalizeAgentPlanPlaceResponse(response, '北京');
function mockGeo({ candidates = searchResult, durationSec = 1440, routeMode = 'agentplan' } = {}) {
  const calls = { searches: [], routes: [] };
  return { calls, async search(input) { calls.searches.push(input); return structuredClone(candidates); },
    async route(input) {
      calls.routes.push(input);
      const stops = input.orderedStops;
      const segments = stops.slice(1).map((end, index) => ({ fromId: stops[index].placeId, toId: end.placeId, coordSystem: 'GCJ02',
        distanceM: 600, durationSec: durationSec / (stops.length - 1), path: [], geometryUnavailable: true, mapUrl: agentPlanMapUrl(`test-only-segment-${index}`) }));
      return { data: { routeResultId: randomUUID(), inputHash: routeHash(stops, 'agentplan'), orderedStops: structuredClone(stops), coordSystem: 'GCJ02',
        segments, distanceM: 600 * segments.length, walkingDurationSec: durationSec, geometryUnavailable: true,
        mapUrl: segments[0].mapUrl, mapUrls: segments.map(segment => segment.mapUrl) }, meta: resultMeta('baidu', routeMode, ['测试上游没有几何，保留官方资源地址。']) };
    } };
}

test('small planning grammar parses city, Arabic/Chinese counts, budgets and stays without losing full request', () => {
  const request = '北京雍和宫附近，安排三个地点，两个小时，每站停留二十分钟，想拍照喝咖啡';
  const parsed = parsePlanningRequest({ request, city: '上海' });
  assert.equal(parsed.request, request); assert.equal(parsed.city, '北京');
  assert.equal(parsed.requestedStops, 3); assert.equal(parsed.budgetMin, 120); assert.equal(parsed.stayMin, 20);
  assert.equal(parsed.nearby, true);
  assert.equal(parsePlanningRequest({ request: '北京三站，一个半小时，每站10分钟' }).budgetMin, 90);
  assert.equal(parsePlanningRequest({ request: '北京三站，一小时半' }).budgetMin, 90);
  assert.equal(parsePlanningRequest({ request: '北京两站，半小时' }).budgetMin, 30);
  const defaults = parsePlanningRequest({ request: '逛逛街', city: '杭州' });
  assert.equal(defaults.city, '杭州'); assert.equal(defaults.requestedStops, 3); assert.equal(defaults.budgetMin, 180);
});

test('three named real landmarks produce editable GCJ02 itinerary in the requested explicit order', async () => {
  const geo = mockGeo();
  const request = '北京，先雍和宫，再五道营，最后国子监，安排三站，两个小时，每站20分钟';
  const result = await planItinerary({ request }, geo);
  assert.deepEqual(geo.calls.searches, [{ keyword: request, city: '北京', mode: 'agentplan' }]);
  assert.deepEqual(result.data.orderedStops.map(place => place.name), ['雍和宫', '五道营胡同', '孔庙和国子监博物馆']);
  assert.ok(!('currentLocation' in geo.calls.routes[0]));
  assert.equal(geo.calls.routes[0].mode, 'agentplan');
  assert.equal(result.data.budgetMin, 120); assert.equal(result.data.totalDurationSec, 84 * 60);
  assert.equal(result.data.suggestedStays.length, 3); assert.equal(result.data.places.length, 5);
  assert.equal(result.data.planning.constraintsVerified, false); assert.equal(result.data.planning.selectedStops, 3);
  assert.match(result.data.planning.selectionExplanation, /保留.*先后顺序/);
  assert.equal(result.data.searchMapUrl, searchResult.data.mapUrl);
  assert.deepEqual(result.data.mapUrls, geo.calls.routes[0].orderedStops.slice(1).map((_, i) => agentPlanMapUrl(`test-only-segment-${i}`)));
  assert.equal(result.data.segments.length, 2); assert.ok(result.data.segments.every(segment => segment.path.length === 0 && segment.mapUrl));
  assert.ok(result.meta.warnings.some(warning => /营业时间.*尚未/.test(warning)));
});

test('default selection uses distinct nearby real places and is honest about heuristic ordering and tighter budget', async () => {
  const geo = mockGeo({ durationSec: 1800 });
  const result = await planItinerary({ request: '北京雍和宫附近，想看看胡同，40分钟' }, geo);
  assert.equal(result.data.orderedStops.length, 3);
  assert.ok(!result.data.orderedStops.some(place => place.name === '雍和宫昭泰门'));
  assert.equal(result.data.orderedStops[0].name, '雍和宫');
  assert.equal(result.data.orderedStops[0].stayMin, 3);
  assert.match(result.data.planning.selectionExplanation, /直线距离/);
  assert.ok(result.meta.warnings.some(warning => /建议停留调整/.test(warning)));
});

test('a landmark omitted from nearby search is looked up once as a same-city planning anchor, not current location', async () => {
  const firstResult = structuredClone(searchResult);
  firstResult.data.places = firstResult.data.places.filter(place => !place.name.startsWith('雍和宫'));
  const anchorResult = structuredClone(searchResult);
  anchorResult.data.places = anchorResult.data.places.filter(place => place.name === '雍和宫');
  const geo = mockGeo({ candidates: firstResult });
  geo.search = async input => { geo.calls.searches.push(input); return structuredClone(geo.calls.searches.length === 1 ? firstResult : anchorResult); };
  const request = '北京雍和宫附近，2小时，胡同和咖啡，3站';
  const result = await planItinerary({ request }, geo);
  assert.equal(geo.calls.searches.length, 2);
  assert.equal(geo.calls.searches[0].keyword, request); assert.equal(geo.calls.searches[1].keyword, '北京雍和宫');
  assert.ok(geo.calls.searches.every(call => call.city === '北京' && call.mode === 'agentplan'));
  assert.equal(result.data.orderedStops[0].name, '雍和宫'); assert.equal(result.data.orderedStops.length, 3);
  assert.ok(result.meta.warnings.some(w => /不代表你的当前位置/.test(w)));
  assert.ok(!('currentLocation' in geo.calls.routes[0]));
  const wrongCity = structuredClone(anchorResult); wrongCity.data.places[0].city = '上海市';
  const wrongGeo = mockGeo({ candidates: firstResult });
  wrongGeo.search = async input => { wrongGeo.calls.searches.push(input); return structuredClone(wrongGeo.calls.searches.length === 1 ? firstResult : wrongCity); };
  await assert.rejects(planItinerary({ request }, wrongGeo), error => error.code === 'NOT_ENOUGH_PLACES');
  assert.equal(wrongGeo.calls.searches.length, 2); assert.equal(wrongGeo.calls.routes.length, 0);
});

test('multiline text remains intact and street names do not become a second city', async () => {
  const geo = mockGeo();
  const request = '  北京雍和宫附近\n2小时\t三站，每站20分钟\r\n';
  await planItinerary({ request }, geo);
  assert.equal(geo.calls.searches[0].keyword, request);
  assert.equal(parsePlanningRequest({ request: '上海南京路附近，三站' }).city, '上海');
  assert.throws(() => parsePlanningRequest({ request: '北京\u0000三站' }), error => error.code === 'INVALID_ARGUMENT');
});

test('explicit stays are retained when real walking exceeds the time budget', async () => {
  const result = await planItinerary({ request: '北京雍和宫、五道营，2站，30分钟，每站停留20分钟' }, mockGeo({ durationSec: 1800 }));
  assert.equal(result.data.orderedStops[0].stayMin, 20); assert.equal(result.data.planning.budgetExceededMin, 40);
  assert.ok(result.meta.warnings.some(warning => /超出预算 40/.test(warning)));
});

test('invalid requests and nonexistent current location fail before searching', async () => {
  for (const input of [null, {}, { request: '' }, { request: 'x'.repeat(1001) }, { request: '北京6站' }, { request: '北京1站' },
    { request: '北京两站0分钟' }, { request: '北京两站每站停留300分钟' }, { request: '北京到上海的散步' }, { request: '北京散步', mode: 'demo' }, { request: '我附近走三站' }]) {
    const geo = mockGeo();
    await assert.rejects(planItinerary(input, geo), error => ['INVALID_ARGUMENT', 'LOCATION_REQUIRED'].includes(error.code));
    assert.equal(geo.calls.searches.length, 0); assert.equal(geo.calls.routes.length, 0);
  }
});

test('unclear nearby anchor, insufficient or dispersed POIs and demo fallback cannot become successful plans', async () => {
  await assert.rejects(planItinerary({ request: '北京附近三站' }, mockGeo()), error => error.code === 'LOCATION_REQUIRED');
  const two = { ...searchResult, data: { ...searchResult.data, places: searchResult.data.places.filter(p => ['雍和宫', '五道营胡同'].includes(p.name)) } };
  await assert.rejects(planItinerary({ request: '北京3站' }, mockGeo({ candidates: two })), error => error.code === 'NOT_ENOUGH_PLACES');
  const reduced = await planItinerary({ request: '北京散步' }, mockGeo({ candidates: two }));
  assert.equal(reduced.data.orderedStops.length, 2); assert.ok(reduced.meta.warnings.some(w => /缩减/.test(w)));
  const far = structuredClone(two); far.data.places[1].location.lng += 0.2;
  await assert.rejects(planItinerary({ request: '北京雍和宫、五道营，2站' }, mockGeo({ candidates: far })), error => error.code === 'PLACES_TOO_FAR');
  await assert.rejects(planItinerary({ request: '北京散步' }, mockGeo({ candidates: { ...searchResult, meta: { provider: 'demo', adapterMode: 'fixture' } } })), error => error.code === 'PLANNING_SOURCE_INVALID');
  await assert.rejects(planItinerary({ request: '北京散步' }, mockGeo({ routeMode: 'demo' })), error => error.code === 'PLANNING_SOURCE_INVALID');
});

test('planning endpoint registers the route for immediate immutable sharing and concurrent retry returns one plan', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'citywalk-planner-test-'));
  const geo = mockGeo();
  const app = createApp({ geo, dataDir, mode: 'agentplan', serverAk: '', authToken: '', browserAk: '' });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const post = async (endpoint, body, key) => {
    const res = await fetch(`${base}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const payload = { request: '北京雍和宫、五道营、国子监，3站，2小时' };
  const [first, second] = await Promise.all([post('/api/v1/itineraries/plan', payload, 'same-plan'), post('/api/v1/itineraries/plan', payload, 'same-plan')]);
  assert.equal(first.status, 200); assert.equal(first.body.data.routeResultId, second.body.data.routeResultId);
  assert.equal(geo.calls.searches.length, 1); assert.equal(geo.calls.routes.length, 1);
  const route = first.body.data;
  const share = await post('/api/v1/shares', { routeResultId: route.routeResultId, inputHash: route.inputHash, title: route.title, budgetMin: route.budgetMin, stays: route.suggestedStays });
  assert.equal(share.status, 201);
  const token = share.body.data.shareUrl.split('/').at(-1);
  const snapshot = await (await fetch(`${base}/api/v1/shares/${token}`)).json();
  assert.deepEqual(snapshot.data.segments, route.segments); assert.deepEqual(snapshot.data.mapUrls, route.mapUrls);
  assert.equal(snapshot.data.geometryUnavailable, true); assert.equal(snapshot.data.coordSystem, 'GCJ02');
  assert.deepEqual(snapshot.data.orderedStops, route.orderedStops);
  assert.ok(!JSON.stringify(snapshot).includes('test-only-token'));
});
