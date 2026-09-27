import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.mjs';
import { createGeoService, samplePlaces } from '../server/geo.mjs';

async function setup(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'citywalk-test-'));
  const app = createApp({ dataDir, ...options });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  return { app, base, dataDir, async call(route, body, key) {
    const res = await fetch(`${base}${route}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  } };
}
const routeBody = { orderedStops: samplePlaces.slice(0, 3), mode: 'demo' };
function shareBody(route, mins = 20) {
  return { routeResultId: route.routeResultId, inputHash: route.inputHash, title: '周末散步', budgetMin: 180,
    stays: route.orderedStops.map(p => ({ placeId: p.placeId, stayMin: mins })) };
}
test('interactive sample search, real API interface, fixed share snapshots and readonly access', async t => {
  const { call } = await setup(t);
  const search = await call('/api/v1/geo/places/search', { keyword: '示例', city: '北京', mode: 'demo' });
  assert.equal(search.json.meta.provider, 'demo'); assert.equal(search.json.data.places.length, 5);
  const route = await call('/api/v1/geo/routes/walking', routeBody);
  assert.equal(route.status, 200); assert.equal(route.json.data.segments.length, 2);
  const share = await call('/api/v1/shares', shareBody(route.json.data));
  assert.equal(share.status, 201);
  const token = share.json.data.shareUrl.split('/').at(-1);
  const before = await call(`/api/v1/shares/${token}`);
  assert.equal(before.json.meta.provider, 'demo');
  assert.equal(before.json.data.totalDurationSec, route.json.data.walkingDurationSec + 60 * 60);
  await call('/api/v1/shares', shareBody(route.json.data, 40));
  const after = await call(`/api/v1/shares/${token}`);
  assert.deepEqual(after.json.data, before.json.data);
  assert.equal((await call(`/api/v1/shares/${token}`, { title: 'overwrite' })).status, 404);
});
test('duplicate stops, stale input and invalid stay values cannot create a shared itinerary', async t => {
  const { call } = await setup(t);
  assert.equal((await call('/api/v1/geo/routes/walking', { mode: 'demo', orderedStops: [samplePlaces[0], samplePlaces[0]] })).status, 400);
  const route = (await call('/api/v1/geo/routes/walking', routeBody)).json.data;
  const stale = await call('/api/v1/shares', { ...shareBody(route), inputHash: 'old' });
  assert.equal(stale.status, 409); assert.equal(stale.json.error.code, 'VERSION_CONFLICT');
  const invalid = shareBody(route); invalid.stays[0].stayMin = -1;
  assert.equal((await call('/api/v1/shares', invalid)).status, 400);
  const malformed = shareBody(route); malformed.stays[0] = null;
  assert.equal((await call('/api/v1/shares', malformed)).status, 400);
});
test('concurrent retries use the same share URL; changed payload with same key is rejected', async t => {
  const { call } = await setup(t);
  const route = (await call('/api/v1/geo/routes/walking', routeBody)).json.data;
  const [one, two] = await Promise.all([call('/api/v1/shares', shareBody(route), 'same-share'), call('/api/v1/shares', shareBody(route), 'same-share')]);
  assert.equal(one.json.data.shareUrl, two.json.data.shareUrl);
  assert.equal((await call('/api/v1/shares', { ...shareBody(route), title: 'different' }, 'same-share')).status, 409);
});
test('expired route cannot be shared, and missing Baidu key does not silently return sample data', async t => {
  const { call } = await setup(t, { routeTtlMs: 1, serverAk: '' });
  const route = (await call('/api/v1/geo/routes/walking', routeBody)).json.data;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await call('/api/v1/shares', shareBody(route))).json.error.code, 'RESULT_EXPIRED');
  const live = await call('/api/v1/geo/places/search', { keyword: '咖啡', city: '北京', mode: 'baidu' });
  assert.equal(live.json.error.code, 'CAPABILITY_UNAVAILABLE'); assert.equal(live.json.data, undefined);
});
test('Web API adapter maps POI IDs, coordinate order and road geometry (mocked upstream)', async () => {
  const seen = [];
  const geo = createGeoService({ serverAk: 'test-only-secret', fetchImpl: async url => {
    seen.push(new URL(url));
    if (url.pathname === '/place/v2/search') return new Response(JSON.stringify({ status: 0, results: [
      { uid: 'poi-a', name: 'A', address: '甲', city: '北京', location: { lng: 116.42, lat: 39.94 } },
      { uid: 'poi-b', name: 'B', address: '乙', city: '北京', location: { lng: 116.43, lat: 39.95 } },
    ] }));
    return new Response(JSON.stringify({ status: 0, result: { routes: [{ distance: 1800, duration: 1400, steps: [{ path: '116.42,39.94;116.425,39.945;116.43,39.95' }] }] } }));
  } });
  const search = await geo.search({ keyword: 'test', city: '北京', mode: 'baidu' });
  const route = await geo.route({ orderedStops: search.data.places, mode: 'baidu' });
  assert.equal(route.meta.provider, 'baidu'); assert.equal(route.data.segments[0].path.length, 3);
  assert.equal(seen[1].searchParams.get('origin'), '39.94,116.42');
  assert.equal(seen[1].searchParams.get('destination_uid'), 'poi-b');
  assert.equal(route.data.distanceM, 1800);
});
test('upstream failure is explicit and never fabricates a valid route (mocked upstream)', async () => {
  const geo = createGeoService({ serverAk: 'test-key', fetchImpl: async () => new Response(JSON.stringify({ status: 7 })) });
  const stops = samplePlaces.slice(0, 2).map((p, i) => ({ ...p, source: 'baidu', providerPlaceId: `poi${i}` }));
  await assert.rejects(geo.route({ orderedStops: stops, mode: 'baidu' }), e => e.code === 'NO_ROUTE' && /第 1 段/.test(e.message));
});
test('server config exposes browser key only; cross-origin writes and private paths are rejected', async t => {
  const { call, base } = await setup(t, { serverAk: 'server-secret-must-not-leak', authToken: 'agent-token-must-not-leak', browserAk: 'browser-key' });
  const config = await call('/api/config');
  assert.equal(config.json.browserAk, 'browser-key'); assert.ok(!JSON.stringify(config.json).includes('server-secret'));
  assert.equal(config.json.capabilities.agentplan, true); assert.ok(!JSON.stringify(config.json).includes('agent-token'));
  const other = await fetch(`${base}/api/v1/geo/places/search`, { method: 'POST', headers: { Origin: 'https://outside.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(other.status, 403);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
});
