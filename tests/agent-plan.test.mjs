import test from 'node:test';
import assert from 'node:assert/strict';
import { agentPlanMapUrl, createAgentPlanAdapter, normalizeAgentPlanPlaceResponse, normalizeAgentPlanDirectionResponse } from '../server/agent-plan.mjs';

const token = 'test-only-token';
const location = { lng: 116.42, lat: 39.94, coordSystem: 'GCJ02' };
// Input fixtures describe normalized selected POIs; they are not asserted to
// represent a real Agent Plan response schema.
const stops = [
  { placeId: 'agentplan-a', providerPlaceId: 'uid-a', name: '地点甲', address: '甲地址', city: '北京', source: 'agentplan', location },
  { placeId: 'agentplan-b', providerPlaceId: 'uid-b', name: '地点乙', address: '乙地址', city: '北京', source: 'agentplan', location: { ...location, lng: 116.43 } },
];
const unsupported = error => error.code === 'AGENTPLAN_RESPONSE_UNSUPPORTED';

// Exact successful shape and public POI fields recorded from the authorized
// provider call in .data/agentplan-place-live.json. Reviews and image objects
// are omitted; the resource key is replaced with a test-only value.
const recordedPlaceResponse = {
  status: 0, message: 'ok', response_type: 'place', result_type: 'poi_type', query_type: 'general', resource_key: 'recorded-place-resource',
  results: [
    { uid: '92bc1f0a948a5c38a0acc418', name: '雍和宫', address: '北京市东城区雍和宫大街28号', city: '北京市', location: { lat: 39.94716503763865, lng: 116.41729518615993 } },
    { uid: 'f23002aec5fe00e0c61e51f8', name: '五道营胡同', address: '安定门街道五道营胡同49号', city: '北京市', location: { lat: 39.948485793669654, lng: 116.41292288740297 } },
  ],
};
// Shape, units, path strings, and endpoint fields copied from the successful
// no-location response .data/agentplan-direction-no-location.json. The
// resource key is substituted. Unused instruction text/log IDs are omitted.
const recordedDirectionResponse = {
  status: 0, message: 'ok', response_type: 'direction', resource_key: 'recorded-direction-resource',
  result: { answer_type: 'gptmodel_navigate', navigation_data: {
    type: 'walk',
    origin: { lat: '39.947147', lng: '116.417572', name: '雍和宫' },
    destination: { lat: '39.948471', lng: '116.413099', name: '五道营胡同' },
    walk_routes: [{ distance: 654, duration: 727, steps: [
      { distance: 347, duration: 386, name: '雍和宫大街',
        path: '116.416706,39.945282;116.416697,39.945337;116.416697,39.945386;116.416697,39.945524;116.416688,39.946063;116.416669,39.946768;116.416660,39.946941;116.416660,39.947065;116.416651,39.947279;116.416633,39.947548;116.416588,39.947734;116.416534,39.947893;116.416534,39.947948;116.416516,39.948245;116.416507,39.948397',
        stepOriginLocation: { lat: 33.91823763599, lng: 104.57116022909 }, stepDestinationLocation: { lat: 33.920573501872, lng: 104.57101809017 } },
      { distance: 307, duration: 341, name: '五道营胡同',
        path: '116.416507,39.948397;116.416364,39.948395;116.415738,39.948400;116.415479,39.948397;116.415443,39.948396;116.414942,39.948403;116.413753,39.948409;116.412921,39.948420',
        stepOriginLocation: { lat: 33.920573501872, lng: 104.57101809017 }, stepDestinationLocation: { lat: 33.920560781437, lng: 104.56780216344 } },
    ] }],
  } },
};
const recordedStops = normalizeAgentPlanPlaceResponse(recordedPlaceResponse, '北京市').data.places;

test('recorded real place response maps exact provider IDs and GCJ02 coordinates without returning raw details', async () => {
  const adapter = createAgentPlanAdapter({ authToken: token, fetchImpl: async () => new Response(JSON.stringify(recordedPlaceResponse)) });
  const result = await adapter.search({ keyword: '北京雍和宫和五道营胡同', city: '北京市' });
  assert.equal(result.meta.provider, 'baidu');
  assert.equal(result.meta.adapterMode, 'agentplan');
  assert.equal(result.data.places.length, 2);
  assert.deepEqual(result.data.places[0], {
    placeId: 'agentplan-92bc1f0a948a5c38a0acc418', providerPlaceId: '92bc1f0a948a5c38a0acc418', name: '雍和宫',
    address: '北京市东城区雍和宫大街28号', city: '北京市', source: 'agentplan',
    location: { lng: 116.41729518615993, lat: 39.94716503763865, coordSystem: 'GCJ02' },
  });
  assert.equal(new URL(result.data.mapUrl).searchParams.get('resource_key'), 'recorded-place-resource');
  assert.ok(!JSON.stringify(result).includes(token));
  assert.ok(!('results' in result.data));
});

test('place mapping handles a verified empty POI list and rejects malformed success variants or business failure', () => {
  assert.deepEqual(normalizeAgentPlanPlaceResponse({ ...recordedPlaceResponse, results: [] }, '北京').data.places, []);
  const mixed = normalizeAgentPlanPlaceResponse({ ...recordedPlaceResponse, results: [...recordedPlaceResponse.results, { uid: 'missing-location', name: '无坐标' }] }, '北京');
  assert.equal(mixed.data.places.length, 2);
  assert.equal(mixed.meta.warnings.length, 1);
  assert.throws(() => normalizeAgentPlanPlaceResponse({ ...recordedPlaceResponse, results: [{ uid: 'invalid', name: '错误', location: { lng: '116.42', lat: 39.94 } }] }), unsupported);
  assert.throws(() => normalizeAgentPlanPlaceResponse({ ...recordedPlaceResponse, result_type: 'unverified-type' }), unsupported);
  assert.throws(() => normalizeAgentPlanPlaceResponse({ ...recordedPlaceResponse, status: 1, message: token }), e => e.code === 'PROVIDER_UNAVAILABLE' && !e.message.includes(token));
});

test('Agent Plan GET preserves complete place request, sends Bearer only in header, and fails closed on unknown schema', async () => {
  let seen;
  const adapter = createAgentPlanAdapter({ authToken: token, fetchImpl: async (url, init) => {
    seen = { url: new URL(url), init }; return new Response(JSON.stringify({ unverified: true }));
  } });
  const keyword = '帮我找北京评分最高、可带宠物、3公里内的咖啡馆';
  await assert.rejects(adapter.search({ keyword, city: '北京市', center: location, sort: 'distance' }), unsupported);
  assert.equal(seen.url.origin, 'https://api.map.baidu.com');
  assert.equal(seen.url.pathname, '/agent_plan/v1/place');
  assert.equal(seen.url.searchParams.get('user_raw_request'), keyword);
  assert.equal(seen.url.searchParams.get('region'), '北京市');
  assert.equal(seen.url.searchParams.get('center'), '39.940000,116.420000');
  assert.equal(seen.url.searchParams.get('sort'), 'distance');
  assert.equal(seen.init.method, 'GET');
  assert.equal(seen.init.headers.Authorization, `Bearer ${token}`);
  assert.equal(seen.init.redirect, 'error');
  assert.ok(!seen.url.href.includes(token));
  assert.ok(!seen.url.searchParams.has('ak'));
});

test('Agent Plan requires credential and trustworthy GCJ02 centers without issuing an upstream request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('should not execute'); };
  await assert.rejects(createAgentPlanAdapter({ fetchImpl }).search({ keyword: '咖啡', city: '北京' }), e => e.code === 'CAPABILITY_UNAVAILABLE');
  const adapter = createAgentPlanAdapter({ authToken: token, fetchImpl });
  await assert.rejects(adapter.search({ keyword: '咖啡', sort: 'distance' }), e => e.code === 'LOCATION_REQUIRED');
  await assert.rejects(adapter.search({ keyword: '我附近的咖啡馆' }), e => e.code === 'LOCATION_REQUIRED');
  await assert.rejects(adapter.search({ keyword: '咖啡', center: { ...location, coordSystem: 'BD09LL' } }), e => e.code === 'INVALID_ARGUMENT');
  await assert.rejects(adapter.search({ keyword: 'x'.repeat(1001) }), e => e.code === 'INVALID_ARGUMENT');
  assert.equal(calls, 0);
});

test('direction request uses exact selected-POI names, genuine supplied GCJ02 location, and walking semantics', async () => {
  let seen;
  const adapter = createAgentPlanAdapter({ authToken: token, fetchImpl: async (url, init) => {
    seen = { url: new URL(url), init }; return new Response(JSON.stringify({ unverifiedRoute: true }));
  } });
  await assert.rejects(adapter.route({ orderedStops: stops, location }), unsupported);
  assert.equal(seen.url.pathname, '/agent_plan/v1/direction');
  assert.equal(seen.url.searchParams.get('location'), '39.940000,116.420000');
  assert.match(seen.url.searchParams.get('user_raw_request'), /步行/);
  assert.match(seen.url.searchParams.get('user_raw_request'), /地点甲/);
  assert.match(seen.url.searchParams.get('user_raw_request'), /地点乙/);
  assert.equal(seen.url.searchParams.get('refer_pois'), '地点甲:uid-a,39.940000,116.420000;地点乙:uid-b,39.940000,116.430000');
  assert.ok(!seen.url.searchParams.has('mode'));
  assert.equal(seen.init.headers.Authorization, `Bearer ${token}`);
});

test('route refuses invalid supplied location, mixed demo data and mislabeled Baidu coordinates before calling upstream', async () => {
  let calls = 0;
  const adapter = createAgentPlanAdapter({ authToken: token, fetchImpl: async () => { calls++; throw new Error('should not execute'); } });
  await assert.rejects(adapter.route({ orderedStops: stops, location: { ...location, coordSystem: 'BD09LL' } }), e => e.code === 'INVALID_ARGUMENT');
  await assert.rejects(adapter.route({ orderedStops: [stops[0], { ...stops[1], source: 'demo' }], location }), e => e.code === 'INVALID_ARGUMENT');
  await assert.rejects(adapter.route({ orderedStops: [stops[0], { ...stops[1], location: { ...location, coordSystem: 'BD09LL' } }], location }), e => e.code === 'INVALID_ARGUMENT');
  assert.equal(calls, 0);
});

test('recorded real direction maps walking distance/time and complete GCJ02 road geometry without fabricating current location', async () => {
  let requested;
  const adapter = createAgentPlanAdapter({ authToken: token, fetchImpl: async url => {
    requested = new URL(url); return new Response(JSON.stringify(recordedDirectionResponse));
  } });
  const response = await adapter.route({ orderedStops: recordedStops });
  assert.equal(requested.pathname, '/agent_plan/v1/direction');
  assert.ok(!requested.searchParams.has('location'));
  assert.match(requested.searchParams.get('refer_pois'), /^雍和宫:92bc1f0a948a5c38a0acc418,/);
  assert.match(requested.searchParams.get('refer_pois'), /;五道营胡同:f23002aec5fe00e0c61e51f8,/);
  assert.equal(response.meta.provider, 'baidu');
  assert.equal(response.meta.adapterMode, 'agentplan');
  assert.equal(response.data.distanceM, 654);
  assert.equal(response.data.walkingDurationSec, 727);
  assert.equal(response.data.coordSystem, 'GCJ02');
  assert.equal(response.data.segments.length, 1);
  assert.equal(response.data.segments[0].path.length, 22);
  assert.deepEqual(response.data.segments[0].path[0], { lng: 116.416706, lat: 39.945282, coordSystem: 'GCJ02' });
  assert.deepEqual(response.data.segments[0].path.at(-1), { lng: 116.412921, lat: 39.94842, coordSystem: 'GCJ02' });
  assert.ok(response.data.segments[0].path.every(p => p.lng > 116 && p.lat > 39));
  assert.equal(response.data.geometryUnavailable, false);
  assert.equal(response.data.segments[0].mapUrl, response.data.mapUrl);
  assert.deepEqual(response.data.mapUrls, [response.data.mapUrl]);
  assert.match(response.data.inputHash, /^[a-f0-9]{64}$/);
  assert.equal(typeof response.data.routeResultId, 'string');
});

test('verified walking stats with missing geometry keep the actual hosted map; missing resource cannot become a fake road', () => {
  const noGeometry = structuredClone(recordedDirectionResponse);
  delete noGeometry.result.navigation_data.walk_routes[0].steps;
  const segment = normalizeAgentPlanDirectionResponse(noGeometry, ...recordedStops);
  assert.equal(segment.geometryUnavailable, true);
  assert.deepEqual(segment.path, []);
  assert.equal(segment.distanceM, 654);
  assert.equal(segment.durationSec, 727);
  assert.equal(new URL(segment.mapUrl).hostname, 'lbs.baidu.com');
  delete noGeometry.resource_key;
  assert.throws(() => normalizeAgentPlanDirectionResponse(noGeometry, ...recordedStops), e => e.code === 'AGENTPLAN_GEOMETRY_UNAVAILABLE');
  const partial = structuredClone(recordedDirectionResponse);
  delete partial.result.navigation_data.walk_routes[0].steps[1].path;
  const incomplete = normalizeAgentPlanDirectionResponse(partial, ...recordedStops);
  assert.equal(incomplete.geometryUnavailable, true);
  assert.deepEqual(incomplete.path, []);
});

test('direction rejects malformed geometry, wrong endpoint/city, nonwalking routes, unknown stats and clarification answers', () => {
  for (const badPath of ['bad', '116.4,', '116.4,91;116.5,39.9']) {
    const malformed = structuredClone(recordedDirectionResponse);
    malformed.result.navigation_data.walk_routes[0].steps[0].path = badPath;
    assert.throws(() => normalizeAgentPlanDirectionResponse(malformed, ...recordedStops), unsupported);
  }
  const foreignPath = structuredClone(recordedDirectionResponse);
  foreignPath.result.navigation_data.walk_routes[0].steps = [{ path: '104.57,33.92;104.58,33.93' }];
  assert.throws(() => normalizeAgentPlanDirectionResponse(foreignPath, ...recordedStops), e => e.code === 'AGENTPLAN_GEOMETRY_MISMATCH');
  const wrongEndpoint = structuredClone(recordedDirectionResponse);
  wrongEndpoint.result.navigation_data.origin.name = '未选中的地点';
  assert.throws(() => normalizeAgentPlanDirectionResponse(wrongEndpoint, ...recordedStops), e => e.code === 'AGENTPLAN_ENDPOINT_MISMATCH');
  const nonwalking = structuredClone(recordedDirectionResponse);
  nonwalking.result.navigation_data.type = 'drive';
  assert.throws(() => normalizeAgentPlanDirectionResponse(nonwalking, ...recordedStops), unsupported);
  const unknownStats = structuredClone(recordedDirectionResponse);
  delete unknownStats.result.navigation_data.walk_routes[0].duration;
  assert.throws(() => normalizeAgentPlanDirectionResponse(unknownStats, ...recordedStops), unsupported);
  for (const answerType of ['gptmodel_poi_clarify', 'gptmodel_onway_search_clarify']) {
    assert.throws(() => normalizeAgentPlanDirectionResponse({ ...recordedDirectionResponse, result: { answer_type: answerType } }, ...recordedStops), e => e.code === 'AGENTPLAN_CLARIFICATION_REQUIRED');
  }
});

test('upstream auth, quota and network errors are sanitized and never fabricate output', async () => {
  for (const [status, code] of [[401, 'PROVIDER_AUTH_FAILED'], [403, 'PROVIDER_AUTH_FAILED'], [429, 'PROVIDER_QUOTA_EXCEEDED'], [500, 'PROVIDER_UNAVAILABLE']]) {
    const adapter = createAgentPlanAdapter({ authToken: token, fetchImpl: async () => new Response(`sensitive ${token}`, { status }) });
    await assert.rejects(adapter.search({ keyword: '咖啡', city: '北京' }), e => e.code === code && !e.message.includes(token));
  }
  const adapter = createAgentPlanAdapter({ authToken: token, fetchImpl: async () => { throw new Error(`fetch failed ${token}`); } });
  await assert.rejects(adapter.search({ keyword: '咖啡' }), e => e.code === 'PROVIDER_UNAVAILABLE' && !e.message.includes(token));
});

test('text, JSON primitives, unknown success structures, and oversized output are explicit limitations', async () => {
  for (const body of ['not JSON', 'null', '[]', '"text"', '{"status":0,"message":"unverified contract"}', JSON.stringify({ text: 'x'.repeat(2 * 1024 * 1024) })]) {
    const adapter = createAgentPlanAdapter({ authToken: token, fetchImpl: async () => new Response(body) });
    await assert.rejects(adapter.search({ keyword: '咖啡' }), unsupported);
  }
});

test('official visualization URL accepts only a resource key and cannot redirect to an upstream-supplied host', () => {
  const url = new URL(agentPlanMapUrl('actual-key&next=https://outside.example'));
  assert.equal(url.origin, 'https://lbs.baidu.com');
  assert.equal(url.pathname, '/mapstatic/agentui_resource.html');
  assert.equal(url.searchParams.get('resource_key'), 'actual-key&next=https://outside.example');
  assert.equal(url.searchParams.size, 1);
  assert.equal(agentPlanMapUrl(null), null);
  assert.equal(agentPlanMapUrl(''), null);
  assert.equal(agentPlanMapUrl('bad\nkey'), null);
});
