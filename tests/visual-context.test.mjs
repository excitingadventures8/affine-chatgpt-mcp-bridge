import test from 'node:test';
import assert from 'node:assert/strict';
import { Doc, Map as YMap, Text as YText, encodeStateAsUpdate } from '../src/affine-media/vendor/yjs.mjs';
import { createAffineMediaTools, PILOT_DOCUMENT_ID } from '../src/affine-media/media.mjs';

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5VQAAAAASUVORK5CYII='), c => c.charCodeAt(0));

function fixture(title = 'Правила композиции + примеры') {
  const doc = new Doc(), blocks = doc.getMap('blocks');
  const put = (id, flavour, children = [], props = {}) => {
    const block = new YMap(); blocks.set(id, block);
    block.set('sys:flavour', flavour); block.set('sys:children', children);
    for (const [key, value] of Object.entries(props)) block.set('prop:' + key, value);
  };
  if (title !== null) put('page', 'affine:page', ['note', 'surface'], { title: new YText(title) });
  put('note', 'affine:note', ['label'], { xywh: '[0,0,100,100]' });
  put('label', 'affine:paragraph', [], { type: 'h1', text: new YText('Ритм') });
  put('surface', 'affine:surface', ['group', 'linked', 'unassigned']);
  put('group', 'surface:group', [], {
    title: new YText('FASHION'), childElementIds: { linked: true }
  });
  put('linked', 'affine:image', [], { sourceId: 'linked-image', xywh: '[5000,0,100,100]' });
  put('unassigned', 'affine:image', [], { sourceId: 'free-image', xywh: '[200,0,100,100]' });
  const bytes = encodeStateAsUpdate(doc); doc.destroy(); return bytes;
}

function setup(title) {
  let bytes = fixture(title);
  const requests = [];
  const module = createAffineMediaTools({
    authorize: async () => ({ cookie: 'session=synthetic' }),
    fetchImpl: async url => {
      requests.push(url);
      const isImage = url.includes('/blobs/');
      return new Response(isImage ? PNG : bytes, {
        headers: { 'Content-Type': isImage ? 'image/png' : 'application/octet-stream' }
      });
    }
  });
  return {
    requests, rename: title => { bytes = fixture(title); },
    call: async (name, args = {}) => {
      const result = await module.callTool(name, { doc_id: PILOT_DOCUMENT_ID, ...args });
      assert.equal(result.isError, undefined);
      return result;
    }
  };
}

test('all context tools identify the current document; image bytes retain named membership', async () => {
  const { call, requests } = setup();
  const context = { doc_id: PILOT_DOCUMENT_ID, title: 'Правила композиции + примеры',
    title_basis: 'affine_page_title', title_is_truncated: false };
  for (const [name, args] of [
    ['affine_read_structure', { kind: 'nodes', limit: 1 }],
    ['affine_list_sections', {}], ['affine_list_images', { limit: 1 }],
    ['affine_read_image', { block_id: 'linked' }]
  ]) {
    const result = await call(name, args);
    assert.deepEqual(result.structuredContent.document_context, context);
    assert.deepEqual(JSON.parse(result.content[0].text).document_context, context);
    if (name === 'affine_read_image') {
      assert.deepEqual(result.structuredContent.sections, [{ section_id: 'group:group',
        basis: 'group_membership', title: 'FASHION', kind: 'group', title_basis: 'group_title' }]);
      const image = result.content.find(item => item.type === 'image');
      assert.deepEqual(Uint8Array.from(atob(image.data), c => c.charCodeAt(0)), PNG);
    }
  }
  assert.equal(requests.length, 5, 'context must not fetch more documents or remote services');
});

test('document-wide reading preserves meaning-bearing context without inventing a category', async () => {
  const { call } = setup();
  const empty = (await call('affine_list_images', { section_id: 'heading:label' })).structuredContent;
  assert.equal(empty.matched_images, 0);
  const first = (await call('affine_list_images', { limit: 1 })).structuredContent;
  assert.equal(first.images[0].sections[0].title, 'FASHION');
  const next = (await call('affine_list_images', { offset: first.next_offset, limit: 1 })).structuredContent;
  const free = next.images[0];
  assert.equal(free.block_id, 'unassigned');
  assert.equal(free.section_membership, 'unassigned');
  assert.deepEqual(free.sections, []);
  assert.equal(next.document_context.title, 'Правила композиции + примеры');
  assert.deepEqual(free.section_candidates, [{ section_id: 'heading:label',
    basis: 'nearby_label_only', distance: 150, title: 'Ритм', kind: 'heading', title_basis: 'heading_text' }]);
  const candidates = (await call('affine_list_images', {
    section_id: 'heading:label', include_candidates: true
  })).structuredContent;
  assert.equal(candidates.images[0].filter_match, 'candidate_only');
  const read = (await call('affine_read_image', { block_id: 'unassigned' })).structuredContent;
  assert.deepEqual(read.sections, []);
  assert.deepEqual(read.section_candidates, free.section_candidates);
});

test('document titles stay current and declare missing or shortened values', async () => {
  const { call, rename } = setup();
  rename('Сценарии и монтаж');
  assert.equal((await call('affine_list_images')).structuredContent.document_context.title, 'Сценарии и монтаж');
  rename(null);
  assert.deepEqual((await call('affine_list_images')).structuredContent.document_context,
    { doc_id: PILOT_DOCUMENT_ID, title: null, title_basis: 'unavailable', title_is_truncated: false });
  rename(' ');
  assert.equal((await call('affine_list_sections')).structuredContent.document_context.title, null);
  rename('я'.repeat(501));
  const context = (await call('affine_read_image', { block_id: 'linked' })).structuredContent.document_context;
  assert.equal(context.title.length, 500);
  assert.equal(context.title_is_truncated, true);
  rename('я'.repeat(500));
  assert.equal((await call('affine_read_structure', { kind: 'groups' })).structuredContent.document_context.title_is_truncated, false);
});
