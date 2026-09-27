import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchOfficialMapDocument } from '../server/map-embed.mjs';

const key = 'a'.repeat(32);
const secondKey = 'B'.repeat(32);
// This test-only HTML deliberately contains unchanged script/text markers;
// it is not a copy of Baidu's document or any real SDK credential.
const html = '<!doctype html><html><head><title>官方地图测试</title><script src="https://example.test/sdk.js?ak=test-only"></script></head><body><script>const request = "resource_key";</script></body></html>';
const documentResponse = (body = html, options = {}) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' }, ...options });

test('fetches only the fixed official document with validated keys and returns it unchanged', async () => {
  let captured;
  const result = await fetchOfficialMapDocument(`${key},${secondKey}`, { fetchImpl: async (url, init) => {
    captured = { url: new URL(url), init }; return documentResponse();
  } });
  assert.equal(result, html);
  assert.equal(captured.url.origin, 'https://lbs.baidu.com');
  assert.equal(captured.url.pathname, '/mapstatic/agentui_resource.html');
  assert.deepEqual([...captured.url.searchParams.keys()], ['resource_key']);
  assert.equal(captured.url.searchParams.get('resource_key'), `${key},${secondKey}`);
  assert.deepEqual(captured.init.headers, { Accept: 'text/html' });
  assert.equal(captured.init.method, 'GET');
  assert.equal(captured.init.redirect, 'error');
  assert.equal(captured.init.credentials, 'omit');
  assert.equal(captured.init.cache, 'no-store');
  assert.ok(captured.init.signal instanceof AbortSignal);
  assert.equal(await fetchOfficialMapDocument([key], { fetchImpl: async () => documentResponse() }), html);
});

test('rejects injected URLs, optional query parameters and invalid key counts before a network request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return documentResponse(); };
  for (const invalid of [undefined, null, '', [], [key, key, key, key, key, key],
    'https://lbs.baidu.com/mapstatic/agentui_resource.html', key + '&api_base=https://example.test',
    key + ',', ' ' + key, 'g'.repeat(32), [key, null]]) {
    await assert.rejects(fetchOfficialMapDocument(invalid, { fetchImpl }), error => error.code === 'INVALID_ARGUMENT');
  }
  assert.equal(calls, 0);
  assert.equal(await fetchOfficialMapDocument([key, key, key, key, key], { fetchImpl }), html);
});

test('rejects non-HTML, incomplete HTML, oversized declared and streamed documents', async () => {
  const invalid = error => error.code === 'MAP_DOCUMENT_INVALID' && error.status === 502;
  for (const response of [new Response('{}', { headers: { 'content-type': 'application/json' } }),
    documentResponse('<html>unfinished'), documentResponse('not a document'),
    documentResponse(html, { headers: { 'content-type': 'text/html', 'content-length': String(128 * 1024 + 1) } }),
    documentResponse('<html>' + 'x'.repeat(128 * 1024) + '</html>')]) {
    await assert.rejects(fetchOfficialMapDocument(key, { fetchImpl: async () => response }), invalid);
  }
  const boundary = '<html>' + 'x'.repeat(128 * 1024 - '<html></html>'.length) + '</html>';
  assert.equal(Buffer.byteLength(boundary), 128 * 1024);
  assert.equal(await fetchOfficialMapDocument(key, { fetchImpl: async () => documentResponse(boundary) }), boundary);
});

test('HTTP failure, redirects and network errors expose only safe generic errors', async () => {
  for (const fetchImpl of [async () => documentResponse('sensitive-detail', { status: 503 }),
    async () => documentResponse('', { status: 302, headers: { location: 'https://example.test/' } }),
    async () => { throw new Error('sensitive-detail'); }]) {
    await assert.rejects(fetchOfficialMapDocument(key, { fetchImpl }), error =>
      error.code === 'MAP_DOCUMENT_UNAVAILABLE' && error.status === 502 && !error.message.includes('sensitive-detail'));
  }
});

test('ten-second timeout bounds stalled fetch even if it ignores abort', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const pending = fetchOfficialMapDocument(key, { fetchImpl: async (_url, init) => {
    signal = init.signal; return await new Promise(() => {});
  } });
  const assertion = assert.rejects(pending, error => error.code === 'MAP_DOCUMENT_TIMEOUT' && error.status === 504);
  context.mock.timers.tick(9_999);
  assert.equal(signal.aborted, false);
  context.mock.timers.tick(1);
  await assertion;
  assert.equal(signal.aborted, true);
});

test('ten-second timeout also covers a stalled body reader', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = fetchOfficialMapDocument(key, { fetchImpl: async () => documentResponse(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('<html>')); },
  })) });
  const assertion = assert.rejects(pending, error => error.code === 'MAP_DOCUMENT_TIMEOUT');
  await Promise.resolve();
  context.mock.timers.tick(10_000);
  await assertion;
});
