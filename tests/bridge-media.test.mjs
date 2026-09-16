import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeMedia, OWNER_LOGIN } from '../src/affine-media/bridge.mjs';
import { PILOT_DOCUMENT_ID } from '../src/affine-media/media.mjs';
import { Doc, Map as YMap, encodeStateAsUpdate } from '../src/affine-media/vendor/yjs.mjs';

const COOKIE = 'session=synthetic-owner-session';
const ok = () => ({ content: [{ type: 'text', text: 'FASHION / Эстетики' }] });
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5VQAAAAASUVORK5CYII='), c => c.charCodeAt(0));
function docResponse() {
  const doc = new Doc(), block = new YMap();
  doc.getMap('blocks').set('test-image', block);
  block.set('sys:flavour', 'affine:image');
  block.set('prop:sourceId', 'test-asset');
  const bytes = encodeStateAsUpdate(doc); doc.destroy();
  return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } });
}
function setup() {
  const state = { login: OWNER_LOGIN, cookie: COOKIE, result: ok(), native: [], http: [], queue: [] };
  const media = createBridgeMedia({
    getLogin: () => state.login,
    getCookie: () => state.cookie,
    callAffineTool: async (name, args) => {
      state.native.push({ name, args });
      if (state.result instanceof Error) throw state.result;
      return state.result;
    },
    fetchImpl: async (url, options) => {
      state.http.push({ url, options });
      assert.ok(state.queue.length, 'unexpected REST call');
      return state.queue.shift();
    },
  });
  return { media, state };
}
const list = media => media.callTool('affine_list_images', { doc_id: PILOT_DOCUMENT_ID });

test('missing, foreign or changed OAuth identity never gets native or REST access', async () => {
  const { media, state } = setup();
  for (const login of [undefined, '', 'someone-else', { login: OWNER_LOGIN }]) {
    state.login = login;
    assert.equal((await list(media)).structuredContent.error, 'AUTHORIZATION_REQUIRED');
  }
  assert.equal(state.native.length, 0); assert.equal(state.http.length, 0);
  state.login = OWNER_LOGIN; state.queue.push(docResponse());
  assert.equal((await list(media)).isError, undefined);
  state.login = 'someone-else';
  assert.equal((await list(media)).isError, true);
  assert.equal(state.native.length, 1); assert.equal(state.http.length, 1);
});

test('absent Worker session returns actionable SESSION_REQUIRED without networking', async () => {
  const { media, state } = setup(); state.cookie = undefined;
  const result = await list(media);
  assert.equal(result.structuredContent.error, 'SESSION_REQUIRED');
  assert.equal(state.native.length, 0); assert.equal(state.http.length, 0);
});

test('native MCP denial, revocation, malformed result or exception cannot be replaced by a REST Cookie', async () => {
  const { media, state } = setup();
  for (const result of [undefined, {}, { content: [], isError: 'true' }, { content: [], error: 'denied' },
    { ...ok(), isError: true }, new Error('AFFiNE 403 secret=synthetic-error-body')]) {
    state.result = result;
    const output = await list(media);
    assert.equal(output.structuredContent.error, result instanceof Error ? 'AUTHORIZATION_CHECK_FAILED' : 'AUTHORIZATION_REQUIRED');
    assert.ok(!JSON.stringify(output).includes('synthetic-error-body'));
  }
  assert.equal(state.http.length, 0);
});

test('every media read rechecks native document scope and returns actual MCP image content', async () => {
  const { media, state } = setup();
  state.queue.push(docResponse());
  const listed = await list(media);
  assert.equal(listed.structuredContent.images[0].block_id, 'test-image');
  state.queue.push(docResponse(), Response.json({ url: 'https://usercontent.affine.pro/test.png?sig=synthetic' }),
    new Response(png, { headers: { 'Content-Type': 'image/png' } }));
  const output = await media.callTool('affine_read_image', { doc_id: PILOT_DOCUMENT_ID, block_id: 'test-image' });
  assert.equal(output.isError, undefined);
  assert.deepEqual(Buffer.from(output.content[1].data, 'base64'), Buffer.from(png));
  assert.deepEqual(state.native, [
    { name: 'read_document', args: { docId: PILOT_DOCUMENT_ID } },
    { name: 'read_document', args: { docId: PILOT_DOCUMENT_ID } },
  ]);
  assert.equal(state.http.at(-1).options.headers.get('Cookie'), null);
  assert.equal(state.http.at(-1).options.headers.get('Authorization'), null);
  assert.ok(!JSON.stringify(output).includes('synthetic'));
  state.result = { ...ok(), isError: true };
  assert.equal((await list(media)).isError, true);
  assert.equal(state.http.length, 4);
});

test('invalid doc IDs and attempts to pass a Cookie or principal in tool arguments are rejected', async () => {
  const { media, state } = setup();
  for (const args of [{ doc_id: '../another-workspace/doc' },
    { doc_id: PILOT_DOCUMENT_ID, cookie: COOKIE },
    { doc_id: PILOT_DOCUMENT_ID, login: OWNER_LOGIN }]) {
    assert.equal((await media.callTool('affine_list_images', args)).isError, true);
  }
  assert.equal(state.native.length, 0); assert.equal(state.http.length, 0);
});

test('upstream timeout, rate limit, denial and outage remain distinct without REST fallback', async () => {
  const { media, state } = setup();
  for (const [error, code] of [
    [new DOMException('secret timeout body', 'TimeoutError'), 'UPSTREAM_TIMEOUT'],
    [Object.assign(new Error('secret server body'), { upstreamStatus: 429 }), 'UPSTREAM_RATE_LIMITED'],
    [Object.assign(new Error('secret server body'), { upstreamStatus: 503 }), 'UPSTREAM_UNAVAILABLE'],
    [Object.assign(new Error('secret server body'), { upstreamStatus: 403 }), 'ACCESS_DENIED'],
    [Object.assign(new Error('secret server body'), { upstreamCode: 'NETWORK_ERROR' }), 'UPSTREAM_NETWORK_ERROR'],
  ]) {
    state.result = error;
    const result = await media.callTool('affine_read_structure', { doc_id: PILOT_DOCUMENT_ID, kind: 'tags' });
    assert.equal(result.structuredContent.error, code);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
  assert.equal(state.http.length, 0);
});

test('all authorized workspace docs are supported, including image-only canvases with successful empty text', async () => {
  const { media, state } = setup();
  for (const native of [{ content: [] }, { content: [{ type: 'text', text: '' }], isError: false }]) {
    state.result = native; state.queue.push(docResponse());
    const output = await media.callTool('affine_list_images', { doc_id: 'new-visual-document' });
    assert.equal(output.isError, undefined);
    assert.equal(output.structuredContent.images.length, 1);
    assert.equal(state.native.at(-1).args.docId, 'new-visual-document');
    assert.ok(state.http.at(-1).url.endsWith('/docs/new-visual-document'));
  }
  state.result = { content: [], isError: true };
  const count = state.http.length;
  assert.equal((await media.callTool('affine_list_images', { doc_id: 'revoked-document' })).structuredContent.error, 'AUTHORIZATION_REQUIRED');
  assert.equal(state.http.length, count);
});
