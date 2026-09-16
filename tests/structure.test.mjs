import test from 'node:test';
import assert from 'node:assert/strict';
import { Doc, Map as YMap, Text as YText, encodeStateAsUpdate } from '../src/affine-media/vendor/yjs.mjs';
import { createAffineMediaTools, PILOT_DOCUMENT_ID } from '../src/affine-media/media.mjs';

const typeDoc = new Doc();
const YArray = typeDoc.getArray('probe').constructor;
typeDoc.destroy();

function fixture({ ambiguous = false, deleted = false, grouped = true } = {}) {
  const doc = new Doc(), blocks = doc.getMap('blocks');
  function block(id, flavour, children = [], props = {}) {
    const b = new YMap(); blocks.set(id, b); b.set('sys:flavour', flavour);
    const a = new YArray(); b.set('sys:children', a); a.push(children);
    for (const [k,v] of Object.entries(props)) b.set('prop:' + k, v);
    return b;
  }
  const rich = new YText();
  block('note', 'affine:edgeless-text', ['fashion'], { xywh: '[0,0,200,50]' });
  block('fashion', 'affine:paragraph', [], { type: 'h2', text: rich });
  rich.insert(0, 'FASHION', { link: 'https://app.affine.pro/workspace/00000000-0000-4000-8000-000000000000/target-doc' });
  block('long-text', 'affine:paragraph', [], { text: new YText('x'.repeat(2100) + ' https://example.com/late-link') });
  block('a', 'affine:image', [], { sourceId: 'asset-a', xywh: '[20,100,50,50]' });
  block('outside', 'affine:image', [], { sourceId: 'asset-out', xywh: '[10000,10000,50,50]' });
  block('distant', 'affine:image', [], { sourceId: 'asset-distant', xywh: '[20000,20000,50,50]' });
  const elements = new YMap(), box = new YMap();
  block('surface', 'affine:surface', [], { elements: box });
  box.set('type', '$blocksuite:internal:native$'); box.set('value', elements);
  function element(id, props) {
    const e = new YMap(); elements.set(id, e);
    for (const [k,v] of Object.entries(props)) e.set(k,v);
    return e;
  }
  if (grouped) {
    const outer = new YMap(), inner = new YMap();
    element('outer', { type: 'group', title: new YText('VISUAL'), children: outer });
    outer.set('inner', true);
    element('inner', { type: 'group', title: new YText('FASHION'), children: inner });
    inner.set('note', true); inner.set('a', !deleted); inner.set('outside', false);
    if (ambiguous) {
      block('note2', 'affine:note', ['other']); block('other', 'affine:paragraph', [], { type: 'h2', text: new YText('OTHER') });
      inner.set('note2', true);
    }
  }
  element('line', { type: 'connector', source: { id: 'note', position: [1, .5] },
    target: { id: 'a', position: [0, .5] }, text: new YText('связано'), frontEndpointStyle: 'Arrow', rearEndpointStyle: 'None' });
  element('free-line', { type: 'connector', source: { position: [0, 0] }, target: { id: 'missing', position: [1, 1] } });
  for (const [id,tagName] of [['table1','Режиссура'],['table2','Цвет']]) {
    block(id, 'affine:database', [id+'-row'], { title: new YText(id),
      columns: [ { id:'tag',type:'multi-select',name:'Область',data:{options:[{id:'same-id',value:tagName,color:'red'}]}},
        {id:'url',type:'link',name:'Источник',data:{}}, {id:'notes',type:'rich-text',name:'Связь',data:{}} ],
      cells: { [id+'-row']: { tag: {columnId:'tag',value:['same-id','unresolved-id']},
        url:{columnId:'url',value:'https://t.me/tnhrs'},
        notes:{columnId:'notes',value:{delta:[{insert:'Документ',attributes:{reference:{pageId:'linked-from-cell'}}}]}} } },
      views: [{id:'view1',name:'Активные',mode:'table',filter:{type:'select',value:'same-id'}}] });
    block(id+'-row', 'affine:paragraph', [], {text:new YText('Материал')});
  }
  const bytes = encodeStateAsUpdate(doc); doc.destroy(); return bytes;
}
function setup(options = {}) {
  const state = { options, requests: [], authorizations: 0 };
  const tools = createAffineMediaTools({ authorize:async()=>{ state.authorizations++; return {cookie:'session=synthetic'}; },
    fetchImpl:async url=>{ state.requests.push(url); return new Response(fixture(state.options),{headers:{'Content-Type':'application/octet-stream'}}); } });
  return {state, call: async(name,args={})=>tools.callTool(name,{doc_id:PILOT_DOCUMENT_ID,...args})};
}

test('boxed surface groups resolve exact members, nested groups and the existing heading ID', async()=>{
  const {call}=setup();
  const result=await call('affine_list_images',{section_id:'heading:fashion'});
  assert.equal(result.isError,undefined);
  assert.deepEqual(result.structuredContent.images.map(i=>i.block_id),['a']);
  const bases=result.structuredContent.images[0].sections.map(s=>[s.section_id,s.basis]);
  assert.ok(bases.some(([id,basis])=>id==='group:inner'&&basis==='group_membership'));
  assert.ok(bases.some(([id])=>id==='group:outer'));
  assert.ok(bases.some(([id,basis])=>id==='heading:fashion'&&basis==='group_label_membership'));
  assert.deepEqual(result.structuredContent.images[0].section_candidates,[]);
  const structure=await call('affine_read_structure',{kind:'groups',limit:1});
  assert.equal(structure.structuredContent.total,2); assert.equal(structure.structuredContent.next_offset,1);
  assert.equal(structure.structuredContent.counts.connections,2);
});

test('multiple labels do not claim the same group as a unique heading section',async()=>{
  const {call}=setup({ambiguous:true});
  assert.equal((await call('affine_list_images',{section_id:'heading:fashion'})).structuredContent.matched_images,0);
  assert.equal((await call('affine_list_images',{section_id:'group:inner'})).structuredContent.matched_images,1);
});

test('group changes are read fresh and distant labels are not proximity matches',async()=>{
  const {state,call}=setup();
  assert.equal((await call('affine_list_images',{section_id:'group:inner'})).structuredContent.matched_images,1);
  state.options.deleted=true;
  assert.equal((await call('affine_list_images',{section_id:'group:inner'})).structuredContent.matched_images,0);
  const list=await call('affine_list_images');
  assert.deepEqual(list.structuredContent.images.find(i=>i.block_id==='distant').section_candidates,[]);
  assert.equal(state.authorizations,3);
});

test('connector endpoints retain attachment IDs and unbound or missing endpoints stay unresolved',async()=>{
  const {call}=setup();
  const r=(await call('affine_read_structure',{kind:'connections'})).structuredContent;
  const line=r.items.find(i=>i.id==='line'), free=r.items.find(i=>i.id==='free-line');
  assert.equal(line.source.id,'note'); assert.equal(line.target.id,'a');
  assert.equal(line.source.resolved,true); assert.equal(line.label,'связано');
  assert.equal(free.source.id,null); assert.equal(free.source.resolved,false);
  assert.equal(free.target.id,'missing'); assert.equal(free.target.resolved,false);
});

test('select tag IDs resolve only within their table column; unknown IDs remain explicit',async()=>{
  const {call,state}=setup();
  const r=(await call('affine_read_structure',{kind:'tags'})).structuredContent;
  assert.equal(r.total,4);
  assert.equal(r.items.find(i=>i.table_id==='table1'&&i.id==='same-id').label,'Режиссура');
  assert.equal(r.items.find(i=>i.table_id==='table2'&&i.id==='same-id').label,'Цвет');
  assert.equal(r.items.find(i=>i.id==='unresolved-id').resolved,false);
  const rows=(await call('affine_read_structure',{kind:'table_rows',table_id:'table1'})).structuredContent;
  assert.equal(rows.items[0].cells[1].value,'https://t.me/tnhrs');
  assert.ok(state.requests.every(url=>url.includes('/docs/')),'external URLs must never be fetched');
  const tables=(await call('affine_read_structure',{kind:'tables'})).structuredContent;
  assert.equal(tables.items[0].views[0].filter.value,'same-id');
});

test('references keep source locations and fetching structure does not fetch linked documents',async()=>{
  const {state,call}=setup();
  const r=(await call('affine_read_structure',{kind:'references'})).structuredContent;
  assert.ok(r.items.some(i=>i.target_doc_id==='target-doc'&&i.source_id==='fashion'));
  assert.ok(r.items.some(i=>i.table_id==='table1'&&i.column_id==='url'));
  assert.ok(r.items.some(i=>i.table_id==='table1'&&i.row_id==='table1-row'&&i.column_id==='notes'&&i.target_doc_id==='linked-from-cell'));
  assert.ok(r.items.some(i=>i.source_id==='long-text'&&i.url==='https://example.com/late-link'));
  assert.equal(state.requests.length,1); assert.equal(r.coverage.external_content_fetched,false);
  assert.equal(r.coverage.workspace_document_tags,'not_in_this_document_snapshot');
});

test('structure argument errors stop before authorization or network',async()=>{
  const {call,state}=setup();
  for(const args of [{kind:'anything'},{kind:'table_rows'},{kind:'tags',table_id:'table1'},
    {kind:'tags',limit:101},{kind:'tags',cookie:'stolen'}]) assert.equal((await call('affine_read_structure',args)).isError,true);
  assert.equal(state.requests.length,0); assert.equal(state.authorizations,0);
});
