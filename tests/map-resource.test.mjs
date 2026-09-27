import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectMapResource } from '../server/map-resource.mjs';

const key = 'a'.repeat(32);
const secondKey = 'b'.repeat(32);
const poi = { uid: 'poi-test', name: '测试地点', location: { lng: 116.417, lat: 39.947 } };
// Structural fixtures exercise formats supported by the official hosted page.
// They are test data, not a claim of a new live resource retrieval.
const placePayload = { status: 0, response_type: 'place', results: [poi] };
const navigation = {
  answer_type: 'gptmodel_navigate', navigation_data: {
    type: 'walk', origin: { lng: '116.417', lat: '39.947' }, destination: { lng: '116.413', lat: '39.948' },
    walk_routes: [{ distance: 654, duration: 727 }],
  },
};
const responseFor = payload => async () => new Response(JSON.stringify(payload));

test('only validated keys reach the fixed resource endpoint without credentials or redirects', async () => {
  let captured;
  const result = await inspectMapResource(`${key},${secondKey}`, { fetchImpl: async (url, init) => {
    captured = { url: new URL(url), init }; return new Response(JSON.stringify({ status: 0, results: [placePayload, placePayload] }));
  } });
  assert.deepEqual(result, { available: true, reason: 'available' });
  assert.equal(captured.url.origin, 'https://api.map.baidu.com');
  assert.equal(captured.url.pathname, '/agent_plan/v1/resource');
  assert.deepEqual([...captured.url.searchParams.keys()], ['resource_key']);
  assert.equal(captured.url.searchParams.get('resource_key'), `${key},${secondKey}`);
  assert.deepEqual(captured.init.headers, { Accept: 'application/json' });
  assert.equal(captured.init.method, 'GET');
  assert.equal(captured.init.redirect, 'error');
  assert.equal(captured.init.cache, 'no-store');
  assert.ok(captured.init.signal instanceof AbortSignal);
  assert.deepEqual(await inspectMapResource([key], { fetchImpl: responseFor(placePayload) }), result);
});

test('rejects URLs, query injection, invalid key counts and malformed keys before fetching', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('must not run'); };
  for (const invalid of [undefined, null, '', [], [key, key, key, key, key, key], 32,
    'https://example.com/', key + '&ak=secret', key + ',', ' ' + key, 'g'.repeat(32), [key, null]]) {
    await assert.rejects(inspectMapResource(invalid, { fetchImpl }), error => error.code === 'INVALID_ARGUMENT');
  }
  assert.equal(calls, 0);
  assert.equal((await inspectMapResource([key, key, key, key, key], { fetchImpl: responseFor(placePayload) })).available, true);
});

test('HTTP 200/status 0 with empty results is expired, including the observed cache-miss shape', async () => {
  assert.deepEqual(await inspectMapResource(key, { fetchImpl: responseFor({ status: 0, message: '缓存未命中: test-only', results: [] }) }), { available: false, reason: 'expired' });
  assert.deepEqual(await inspectMapResource(key, { fetchImpl: responseFor({ ...placePayload, results: [] }) }), { available: false, reason: 'expired' });
});

test('combined map resources require every distinct key while duplicate keys and original single payloads remain valid', async () => {
  const partial = { status: 0, results: [{ response_type: 'direction', result: navigation }] };
  assert.deepEqual(await inspectMapResource([key, secondKey], { fetchImpl: responseFor(partial) }), { available: false, reason: 'expired' });
  assert.deepEqual(await inspectMapResource([key, secondKey], { fetchImpl: responseFor(placePayload) }), { available: false, reason: 'expired' });
  assert.deepEqual(await inspectMapResource([key, secondKey], { fetchImpl: responseFor({ status: 0, results: [partial.results[0], partial.results[0]] }) }), { available: true, reason: 'available' });
  let requestedKey;
  assert.deepEqual(await inspectMapResource([key, key], { fetchImpl: async url => {
    requestedKey = new URL(url).searchParams.get('resource_key');
    return new Response(JSON.stringify(partial));
  } }), { available: true, reason: 'available' });
  assert.equal(requestedKey, key);
  assert.deepEqual(await inspectMapResource(key, { fetchImpl: responseFor(placePayload) }), { available: true, reason: 'available' });
});

test('recognizes supported place and walking data while rejecting unknown or malformed success', async () => {
  for (const payload of [placePayload, { status: 0, response_type: 'direction', result: navigation },
    { status: 0, results: [placePayload, { response_type: 'direction', result: navigation }] },
    { status: 0, results: [navigation] }, { status: 0, results: [poi] }]) {
    assert.deepEqual(await inspectMapResource(key, { fetchImpl: responseFor(payload) }), { available: true, reason: 'available' });
  }
  for (const payload of [null, [], { status: 0 }, { status: '0', results: [poi] }, { status: 0, results: [{}] },
    { ...placePayload, results: [{ ...poi, location: { lng: 400, lat: 39 } }] },
    { status: 0, results: [placePayload, null] },
    { status: 0, response_type: 'direction', result: { ...navigation, answer_type: 'gptmodel_poi_clarify' } },
    { status: 0, response_type: 'unknown', results: [poi] }]) {
    assert.deepEqual(await inspectMapResource(key, { fetchImpl: responseFor(payload) }), { available: false, reason: 'unsupported' });
  }
});

test('HTTP/business errors, invalid bodies and network failures never expose upstream details', async () => {
  assert.deepEqual(await inspectMapResource(key, { fetchImpl: async () => new Response('sensitive-provider-detail', { status: 503 }) }), { available: false, reason: 'unavailable' });
  assert.deepEqual(await inspectMapResource(key, { fetchImpl: responseFor({ status: 1, message: 'sensitive-provider-detail' }) }), { available: false, reason: 'unavailable' });
  assert.deepEqual(await inspectMapResource(key, { fetchImpl: async () => new Response('<html>not JSON</html>') }), { available: false, reason: 'unsupported' });
  assert.deepEqual(await inspectMapResource(key, { fetchImpl: async () => { throw new Error('sensitive-provider-detail'); } }), { available: false, reason: 'unreachable' });
  assert.deepEqual(await inspectMapResource(key, { fetchImpl: async () => new Response('{}', { headers: { 'content-length': String(3 * 1024 * 1024) } }) }), { available: false, reason: 'unsupported' });
});

test('ten-second timeout also bounds a fetch implementation that ignores abort', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const pending = inspectMapResource(key, { fetchImpl: async (_url, init) => {
    signal = init.signal; return await new Promise(() => {});
  } });
  context.mock.timers.tick(9_999);
  assert.equal(signal.aborted, false);
  context.mock.timers.tick(1);
  assert.deepEqual(await pending, { available: false, reason: 'timeout' });
  assert.equal(signal.aborted, true);
});

test('ten-second timeout includes reading a hanging response body', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = inspectMapResource(key, { fetchImpl: async () => ({
    ok: true, headers: new Headers(), text: () => new Promise(() => {}),
  }) });
  await Promise.resolve();
  context.mock.timers.tick(10_000);
  assert.deepEqual(await pending, { available: false, reason: 'timeout' });
});
