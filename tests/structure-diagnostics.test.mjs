import test from 'node:test';
import assert from 'node:assert/strict';
import { Doc, Map as YMap, Text as YText, encodeStateAsUpdate } from '../src/affine-media/vendor/yjs.mjs';
import { createAffineMediaTools, PILOT_DOCUMENT_ID } from '../src/affine-media/media.mjs';

function snapshot({ secondHeading = false, missingChild = false, removeTarget = false,
  removeOption = false, heading = 'ЛИЧНЫЕ ДЕЛА' } = {}) {
  const doc = new Doc(), blocks = doc.getMap('blocks');
  const put = (id, flavour, children = [], props = {}) => {
    const b = new YMap(); blocks.set(id,b);
    b.set('sys:flavour',flavour); b.set('sys:children',children);
    for (const [key,value] of Object.entries(props)) b.set('prop:'+key,value);
    return b;
  };
  put('note','affine:note',['heading','body',...(missingChild?['absent-child']:[])]);
  put('heading','affine:paragraph',[],{type:'h1',text:new YText(heading)});
  put('body','affine:paragraph',[],{type:secondHeading?'h2':'text',text:new YText('Описание раздела')});
  put('target','affine:note',['target-heading']);
  put('target-heading','affine:paragraph',[],{type:'h2',text:new YText('ФИНАНСЫ')});
  const elements = new YMap(); put('surface','affine:surface',[],{elements});
  const line = new YMap(); elements.set('line',line);
  line.set('type','connector'); line.set('source',{id:'note',position:[1,.5]});
  line.set('target',{id:'target',position:[0,.5]});
  const free = new YMap(); elements.set('free',free);
  free.set('type','connector'); free.set('source',{position:[0,0]}); free.set('target',{position:[1,1]});
  const table=put('table','affine:database',['row'],{columns:[
    {id:'tags',type:'multi-select',name:'Область',data:{options:[{id:'tag',value:'Креатив'}]}}
  ],cells:{row:{tags:{value:['tag']}}}});
  put('row','affine:paragraph',[],{text:new YText('Источник')});
  // Actual Yjs removals leave references behind, just as a stale document can.
  if (removeTarget) { blocks.delete('target'); blocks.delete('target-heading'); }
  if (removeOption) table.set('prop:columns',[
    {id:'tags',type:'multi-select',name:'Область',data:{options:[]}}
  ]);
  const bytes=encodeStateAsUpdate(doc); doc.destroy(); return bytes;
}
function setup(options={}) {
  const state={options,requests:0};
  const tools=createAffineMediaTools({authorize:async()=>({cookie:'session=synthetic'}),
    fetchImpl:async()=>{state.requests++;return new Response(snapshot(state.options),
      {headers:{'Content-Type':'application/octet-stream'}});}});
  return {state,call:async(kind,args={})=>(await tools.callTool('affine_read_structure',
    {doc_id:PILOT_DOCUMENT_ID,kind,...args})).structuredContent};
}

test('note attachments retain IDs and obtain traceable current descendant headings',async()=>{
  const {call,state}=setup();
  const data=await call('connections');
  const edge=data.items.find(e=>e.id==='line');
  assert.equal(edge.source.id,'note');
  assert.equal(edge.source.label,'ЛИЧНЫЕ ДЕЛА');
  assert.equal(edge.source.label_source_id,'heading');
  assert.equal(edge.source.label_basis,'unique_descendant_heading');
  assert.equal(edge.target.label,'ФИНАНСЫ');
  assert.equal(edge.source.status,'resolved');
  state.options.heading='ДОМ';
  assert.equal((await call('connections')).items.find(e=>e.id==='line').source.label,'ДОМ');
  assert.equal(state.requests,2);
});

test('multiple headings and missing descendants cannot produce a guessed container label',async()=>{
  const {call,state}=setup({secondHeading:true});
  let source=(await call('connections')).items.find(e=>e.id==='line').source;
  assert.equal(source.resolved,true); assert.equal(source.label,null);
  assert.equal(source.label_basis,'ambiguous_descendants');
  state.options={missingChild:true};
  source=(await call('connections')).items.find(e=>e.id==='line').source;
  assert.equal(source.label,null); assert.equal(source.label_basis,'incomplete_descendants');
});

test('deleted targets and removed tag options stay unresolved with distinct diagnostics on every page',async()=>{
  const {call}=setup({removeTarget:true,removeOption:true});
  const full=await call('connections'), page=await call('connections',{limit:1});
  const edge=full.items.find(e=>e.id==='line'), free=full.items.find(e=>e.id==='free');
  assert.equal(edge.target.status,'missing_from_current_snapshot');
  assert.equal(edge.target.label,null); assert.equal(edge.target.resolved,false);
  assert.equal(free.source.status,'unbound');
  assert.equal(full.diagnostics.connections.missing_node_ids,1);
  assert.equal(full.diagnostics.connections.unbound_endpoints,2);
  assert.deepEqual(page.diagnostics,full.diagnostics);
  const tags=await call('tags');
  assert.equal(tags.items[0].label,null); assert.equal(tags.items[0].status,'option_not_in_column');
  assert.equal(tags.diagnostics.tags.unresolved_assignments,1);
  assert.ok(tags.warnings.some(w=>w.code==='TAG_OPTION_UNRESOLVED'&&w.column_id==='tags'));
  assert.ok(tags.warnings.some(w=>w.code==='CONNECTOR_ENDPOINTS_UNRESOLVED'));
});
