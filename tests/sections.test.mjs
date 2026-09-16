import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNavigation } from '../src/affine-media/sections.mjs';
import { createAffineMediaTools, PILOT_DOCUMENT_ID } from '../src/affine-media/media.mjs';
import { Doc, Map as YMap, Text as YText, encodeStateAsUpdate } from '../src/affine-media/vendor/yjs.mjs';

const node = (id, flavour, more = {}) => ({ id, flavour, children: [], elementChildren: [], text: '', title: '',
  bold: false, headingLevel: null, rect: null, rotation: 0, ...more });
const image = id => ({ block_id: id, source_id: 'fixture-key-' + id, caption: '', xywh: null });
const has = (i, id, basis) => i.sections.some(s => s.section_id === id && (!basis || s.basis === basis));

test('page headings own ordered image ranges; blank headings do not erase sections or leak across notes', () => {
  const nodes = [node('note', 'affine:note', { children: ['visual', 'fog', 'a', 'blank', 'b', 'prep', 'c'] }),
    node('visual', 'affine:paragraph', { text: 'VISUAL / РЕФЕРЕНСЫ', headingLevel: 1 }),
    node('fog', 'affine:paragraph', { text: 'Образы в поле в тумане', headingLevel: 6 }),
    node('blank', 'affine:paragraph', { headingLevel: 1 }),
    node('prep', 'affine:paragraph', { text: 'ПОДГОТОВКА', headingLevel: 1 }),
    node('other-note', 'affine:note', { children: ['d'] }),
    ...['a', 'b', 'c', 'd'].map(id => node(id, 'affine:image'))];
  const images = ['a', 'b', 'c', 'd'].map(image);
  const result = buildNavigation(nodes, images);
  assert.equal(result.sections.length, 3);
  for (const i of images.slice(0, 2)) {
    assert.ok(has(i, 'heading:visual', 'document_heading')); assert.ok(has(i, 'heading:fog'));
  }
  assert.ok(has(images[2], 'heading:prep')); assert.ok(!has(images[2], 'heading:visual'));
  assert.deepEqual(images[3].sections, []);
});

test('explicit frame relationships include images nested inside notes and nested frames', () => {
  const nodes = [node('frame', 'affine:frame', { elementChildren: ['inner'] }),
    node('inner', 'affine:frame', { title: 'Красный', elementChildren: ['note'] }),
    node('note', 'affine:note', { children: ['heading', 'a'] }),
    node('heading', 'affine:paragraph', { text: 'КРАСНЫЙ', headingLevel: 3 }), node('a', 'affine:image')];
  const images = [image('a')], result = buildNavigation(nodes, images);
  assert.ok(has(images[0], 'frame:frame', 'frame_membership'));
  assert.ok(has(images[0], 'frame:inner', 'frame_membership'));
  assert.equal(result.sections.find(s => s.section_id === 'frame:frame').title_basis, 'single_heading_in_frame');
});

test('frame containment is marked geometric; overlapping frames stay explicit and rotation is respected', () => {
  const nodes = [node('frame1', 'affine:frame', { title: 'A', rect: [0, 0, 100, 100] }),
    node('frame2', 'affine:frame', { title: 'B', rect: [0, 0, 100, 100] }),
    node('a', 'affine:image', { rect: [20, 20, 30, 30] }),
    node('b', 'affine:image', { rect: [0, 0, 100, 100], rotation: 45 })];
  const images = [image('a'), image('b')];
  buildNavigation(nodes, images);
  assert.equal(images[0].sections.length, 2);
  assert.ok(images[0].sections.every(s => s.basis === 'frame_geometry'));
  assert.deepEqual(images[1].sections, []);
});

test('isolated bold labels produce proximity candidates, never automatic section membership', () => {
  const nodes = [node('label', 'affine:edgeless-text', { rect: [0, 0, 300, 60], children: ['heading'] }),
    node('heading', 'affine:paragraph', { text: 'FASHION', bold: true }),
    node('a', 'affine:image', { rect: [20, 150, 100, 100] })];
  const images = [image('a')], result = buildNavigation(nodes, images);
  assert.deepEqual(images[0].sections, []);
  assert.equal(images[0].section_candidates[0].basis, 'nearby_label_only');
  assert.equal(result.sections[0].structural_image_count, 0);
  assert.equal(result.sections[0].candidate_image_count, 1);
  assert.equal(result.unassigned_images, 1);
});

test('duplicate titles remain separate by ID; invalid rectangles do not create fake locations', () => {
  const nodes = [node('n1', 'affine:note', { rect: null, children: ['h1'] }),
    node('n2', 'affine:note', { rect: null, children: ['h2'] }),
    node('h1', 'affine:paragraph', { text: 'FASHION', headingLevel: 6 }),
    node('h2', 'affine:paragraph', { text: 'FASHION', headingLevel: 6 }),
    node('a', 'affine:image')];
  const images = [image('a')], result = buildNavigation(nodes, images);
  assert.equal(new Set(result.sections.map(s => s.section_id)).size, 2);
  assert.deepEqual(images[0].section_candidates, []);
  assert.equal(images[0].canvas_bounds, null);
});

test('database titles identify tables; only descendant image blocks belong to them', () => {
  const nodes = [node('note', 'affine:note', { children: ['db', 'outside'] }),
    node('db', 'affine:database', { title: 'Формируем вкус', children: ['row'] }),
    node('row', 'affine:paragraph', { text: 'Референс', children: ['inside'] }),
    node('empty-db', 'affine:database', { title: 'ВИЗУАЛЬНЫЕ ИДЕИ' }),
    node('inside', 'affine:image'), node('outside', 'affine:image')];
  const images = [image('inside'), image('outside')], result = buildNavigation(nodes, images);
  assert.ok(has(images[0], 'table:db', 'table_membership'));
  assert.deepEqual(images[1].sections, []);
  const table = result.sections.find(s => s.section_id === 'table:db');
  assert.equal(table.title, 'Формируем вкус');
  assert.equal(table.title_basis, 'database_title');
  assert.equal(table.structural_image_count, 1);
  assert.equal(result.sections.find(s => s.section_id === 'table:empty-db').structural_image_count, 0);
});

function snapshot({ isolated = false, removed = false } = {}) {
  const doc = new Doc(), blocks = doc.getMap('blocks');
  const temporary = new Doc(), YArray = temporary.getArray('type-probe').constructor; temporary.destroy();
  const add = (id, flavour, props = {}, children = []) => {
    const b = new YMap(); blocks.set(id, b); b.set('sys:flavour', flavour);
    const array = new YArray(); array.push(children); b.set('sys:children', array);
    for (const [k, v] of Object.entries(props)) b.set('prop:' + k, v);
    return b;
  };
  add('note', isolated ? 'affine:edgeless-text' : 'affine:note', { xywh: '[0,0,400,80]' }, isolated ? ['heading'] : ['heading', 'a']);
  if (!removed) add('heading', 'affine:paragraph', { type: 'h2', text: new YText('FASHION') });
  add('a', 'affine:image', { sourceId: 'asset-a', xywh: '[20,100,100,100]' });
  const result = encodeStateAsUpdate(doc); doc.destroy(); return result;
}

function moduleWith(options) {
  const calls = [];
  const module = createAffineMediaTools({ authorize: async () => ({ cookie: 'session=synthetic' }),
    fetchImpl: async (url, request) => {
      calls.push(url); assert.ok(url.includes('/docs/'), 'no asset download expected');
      return new Response(snapshot(options), { headers: { 'Content-Type': 'application/octet-stream' } });
    } });
  return { module, calls };
}

test('Yjs arrays and text decode into searchable sections and an exact section filter', async () => {
  const { module, calls } = moduleWith({});
  const result = await module.callTool('affine_list_sections', { doc_id: PILOT_DOCUMENT_ID, query: 'fashion' });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.sections[0].structural_image_count, 1);
  const list = await module.callTool('affine_list_images', { doc_id: PILOT_DOCUMENT_ID, section_id: 'heading:heading' });
  assert.equal(list.structuredContent.images[0].filter_match, 'linked');
  assert.equal(list.structuredContent.images[0].sections[0].basis, 'document_heading');
  assert.equal(calls.length, 2);
});

test('proximity candidates require explicit inclusion, and deleted sections stop before asset access', async () => {
  const { module } = moduleWith({ isolated: true });
  const args = { doc_id: PILOT_DOCUMENT_ID, section_id: 'heading:heading' };
  assert.equal((await module.callTool('affine_list_images', args)).structuredContent.matched_images, 0);
  const result = await module.callTool('affine_list_images', { ...args, include_candidates: true });
  assert.equal(result.structuredContent.images[0].filter_match, 'candidate_only');
  const removed = moduleWith({ removed: true });
  assert.equal((await removed.module.callTool('affine_list_images', args)).structuredContent.error, 'SECTION_NOT_FOUND');
  assert.equal(removed.calls.length, 1);
});

test('section input boundaries fail before network access', async () => {
  const { module, calls } = moduleWith({});
  for (const [name, args] of [
    ['affine_list_sections', { doc_id: PILOT_DOCUMENT_ID, limit: 101 }],
    ['affine_list_sections', { doc_id: PILOT_DOCUMENT_ID, query: 42 }],
    ['affine_list_images', { doc_id: PILOT_DOCUMENT_ID, include_candidates: true }],
    ['affine_list_images', { doc_id: PILOT_DOCUMENT_ID, section_id: '' }],
    ['affine_list_images', { doc_id: PILOT_DOCUMENT_ID, workspace_id: 'different-workspace' }],
  ]) assert.equal((await module.callTool(name, args)).isError, true);
  assert.equal(calls.length, 0);
});
