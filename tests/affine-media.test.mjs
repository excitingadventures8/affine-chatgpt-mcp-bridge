import test from 'node:test';
import assert from 'node:assert/strict';
import { Doc, Map as YMap, Text as YText, encodeStateAsUpdate } from '../src/affine-media/vendor/yjs.mjs';
import { createAffineMediaTools, PILOT_DOCUMENT_ID } from '../src/affine-media/media.mjs';

const COOKIE = 'session=synthetic-test-credential';
const URL = 'https://usercontent.affine.pro/image?signature=synthetic-private-grant';
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5VQAAAAASUVORK5CYII='), c => c.charCodeAt(0));
const context = Object.freeze({ authenticatedPrincipal: 'test-owner' });

function fixture() {
  const doc = new Doc(), blocks = doc.getMap('blocks');
  function add(id, flavour, key, caption = '') {
    const b = new YMap(); blocks.set(id, b); b.set('sys:flavour', flavour);
    b.set('prop:sourceId', key); b.set('prop:caption', new YText(caption));
    b.set('prop:xywh', '[10,20,100,200]');
    return b;
  }
  add('a-image', 'affine:image', 'image/key+one=', 'test caption');
  add('b-image', 'affine:image', 'key-two');
  add('c-external', 'affine:image', 'https://example.org/not-a-blob.png');
  add('d-attachment', 'affine:attachment', 'attachment-key');
  add('deleted', 'affine:image', 'deleted-key'); blocks.delete('deleted');
  const frame = add('frame-one', 'affine:frame', ''); frame.set('prop:title', new YText('Frame title'));
  const bytes = encodeStateAsUpdate(doc); doc.destroy(); return bytes;
}

function response(body, type, status = 200, more = {}) {
  return new Response(body, { status, headers: { 'Content-Type': type, ...more } });
}
function setup(queue, authorize = async (ctx, docId) => {
  assert.equal(ctx, context); assert.equal(docId, PILOT_DOCUMENT_ID); return { cookie: COOKIE };
}) {
  const calls = [];
  const module = createAffineMediaTools({ authorize,
    fetchImpl: async (url, options) => {
      calls.push({ url, options }); assert.ok(queue.length, 'unexpected network request');
      const next = queue.shift(); if (next instanceof Error) throw next; return next;
    } });
  return { module, calls };
}

test('lists only live image references, paginates and keeps canvas metadata', async () => {
  const { module, calls } = setup([response(fixture(), 'application/octet-stream')]);
  const result = await module.callTool('affine_list_images', { doc_id: PILOT_DOCUMENT_ID, limit: 1 }, context);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.image_blocks, 3);
  assert.equal(result.structuredContent.readable_image_blocks, 2);
  assert.equal(result.structuredContent.images[0].block_id, 'a-image');
  assert.equal(result.structuredContent.images[0].caption, 'test caption');
  assert.equal(result.structuredContent.frames[0].title, 'Frame title');
  assert.equal(result.structuredContent.next_offset, 1);
  assert.equal(result.structuredContent.images[0].source_id, undefined);
  assert.equal(calls.length, 1);
});

test('returns real image content through memory, never Cookie to storage or signed URL in result', async () => {
  const { module, calls } = setup([response(fixture(), 'application/octet-stream'),
    response(JSON.stringify({ url: URL }), 'application/json'), response(PNG, 'image/png')]);
  const result = await module.callTool('affine_read_image', { doc_id: PILOT_DOCUMENT_ID, block_id: 'a-image' }, context);
  assert.equal(result.isError, undefined);
  const content = result.content.find(item => item.type === 'image');
  assert.equal(content.mimeType, 'image/png');
  assert.deepEqual(Uint8Array.from(atob(content.data), c => c.charCodeAt(0)), PNG);
  assert.equal(calls.length, 3);
  assert.ok(calls[1].url.endsWith('/blobs/image%2Fkey%2Bone%3D?redirect=manual'));
  assert.equal(calls[0].options.headers.get('Cookie'), COOKIE);
  assert.equal(calls[1].options.headers.get('Cookie'), COOKIE);
  assert.equal(calls[2].options.headers.has('Cookie'), false);
  assert.equal(calls[2].options.headers.has('Authorization'), false);
  assert.ok(calls.every(c => c.options.method === 'GET' && c.options.redirect === 'manual' && c.options.credentials === 'omit'));
  assert.ok(!JSON.stringify(result).includes(COOKIE));
  assert.ok(!JSON.stringify(result).includes('synthetic-private-grant'));
});

test('supports a direct AFFiNE image response and an explicit storage redirect', async () => {
  for (const delegate of [false, true]) {
    const queue = [response(fixture(), 'application/octet-stream')];
    if (delegate) queue.push(response(null, 'text/plain', 302, { Location: URL }));
    queue.push(response(PNG, 'image/png'));
    const { module, calls } = setup(queue);
    const result = await module.callTool('affine_read_image', { doc_id: PILOT_DOCUMENT_ID, block_id: 'a-image' }, context);
    assert.equal(result.isError, undefined);
    assert.equal(calls.length, delegate ? 3 : 2);
  }
});

test('rejects unauthorized callers, off-scope documents, credential arguments and invalid pagination before networking', async () => {
  assert.throws(() => createAffineMediaTools(), /authorization/);
  const { module, calls } = setup([], async () => null);
  for (const [name, args, code] of [
    ['affine_list_images', { doc_id: PILOT_DOCUMENT_ID }, 'AUTHORIZATION_REQUIRED'],
    ['affine_list_images', { doc_id: 'another-document' }, 'DOCUMENT_NOT_ALLOWED'],
    ['affine_list_images', { doc_id: PILOT_DOCUMENT_ID, cookie: COOKIE }, 'INVALID_ARGUMENTS'],
    ['affine_list_images', { doc_id: PILOT_DOCUMENT_ID, limit: 400 }, 'INVALID_ARGUMENTS'],
    ['affine_read_image', { doc_id: PILOT_DOCUMENT_ID, block_id: '' }, 'INVALID_ARGUMENTS'],
    ['unknown', { doc_id: PILOT_DOCUMENT_ID }, 'UNKNOWN_TOOL'],
  ]) {
    const r = await module.callTool(name, args, context);
    assert.equal(r.structuredContent.error, code);
  }
  assert.equal(calls.length, 0);
  const invalid = setup([], async () => ({ cookie: 'aff_mcp_v1.not-a-session=value' }));
  const r = await invalid.module.callTool('affine_list_images', { doc_id: PILOT_DOCUMENT_ID }, context);
  assert.equal(r.structuredContent.error, 'SESSION_REQUIRED');
});

test('fresh document authorization happens on every read; deleted/missing references are never fetched', async () => {
  const { module, calls } = setup([response(fixture(), 'application/octet-stream')]);
  const r = await module.callTool('affine_read_image', { doc_id: PILOT_DOCUMENT_ID, block_id: 'deleted' }, context);
  assert.equal(r.structuredContent.error, 'IMAGE_BLOCK_NOT_FOUND'); assert.equal(calls.length, 1);
});

test('stops on HTTP failures and keeps response bodies and secrets out of errors', async () => {
  for (const code of [401, 403, 404, 426, 429]) {
    const { module, calls } = setup([response('secret-server-body', 'text/plain', code)]);
    const r = await module.callTool('affine_list_images', { doc_id: PILOT_DOCUMENT_ID }, context);
    assert.equal(r.isError, true); assert.equal(r.structuredContent.http_status, code);
    assert.equal(r.structuredContent.stage, 'document_download'); assert.equal(calls.length, 1);
    assert.ok(!JSON.stringify(r).includes('secret-server-body'));
  }
});

test('rejects storage origins outside the verified domain and never follows a second redirect', async () => {
  for (const url of ['https://other.example/image', 'https://usercontent.affine.pro.evil.example/image',
    'http://usercontent.affine.pro/image', 'https://secret@usercontent.affine.pro/image',
    'https://usercontent.affine.pro:444/image', 'https://127.0.0.1/image']) {
    const { module, calls } = setup([response(fixture(), 'application/octet-stream'), response(JSON.stringify({ url }), 'application/json')]);
    const r = await module.callTool('affine_read_image', { doc_id: PILOT_DOCUMENT_ID, block_id: 'a-image' }, context);
    assert.equal(r.structuredContent.error, 'STORAGE_URL_REJECTED'); assert.equal(calls.length, 2);
    assert.ok(!JSON.stringify(r).includes(url));
  }
  const { module, calls } = setup([response(fixture(), 'application/octet-stream'),
    response(JSON.stringify({ url: URL }), 'application/json'), response(null, 'text/plain', 302, { Location: 'https://other.example/image' })]);
  const r = await module.callTool('affine_read_image', { doc_id: PILOT_DOCUMENT_ID, block_id: 'a-image' }, context);
  assert.equal(r.structuredContent.error, 'REDIRECT_REJECTED'); assert.equal(calls.length, 3);
});

test('rejects login HTML, invalid Yjs, excessive declared bytes and wrong image bytes', async () => {
  for (const [reply, code] of [
    [response('<html>login</html>', 'text/html'), 'DOCUMENT_TYPE_UNEXPECTED'],
    [response('not Yjs', 'application/octet-stream'), 'DOCUMENT_FORMAT_UNSUPPORTED'],
    [response('x', 'application/octet-stream', 200, { 'Content-Length': '999999999' }), 'RESPONSE_TOO_LARGE'],
  ]) {
    const { module } = setup([reply]);
    const r = await module.callTool('affine_list_images', { doc_id: PILOT_DOCUMENT_ID }, context);
    assert.equal(r.structuredContent.error, code);
  }
  const { module } = setup([response(fixture(), 'application/octet-stream'), response('wrong bytes', 'image/png')]);
  const r = await module.callTool('affine_read_image', { doc_id: PILOT_DOCUMENT_ID, block_id: 'a-image' }, context);
  assert.equal(r.structuredContent.error, 'IMAGE_FORMAT_UNSUPPORTED');
});
