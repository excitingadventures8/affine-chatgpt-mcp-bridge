import test from 'node:test';
import assert from 'node:assert/strict';
import { Doc, Map as YMap, Text as YText, encodeStateAsUpdate } from '../src/affine-media/vendor/yjs.mjs';
import { createAffineMediaTools, PILOT_DOCUMENT_ID } from '../src/affine-media/media.mjs';

function fixture({ emptyDates = false } = {}) {
  const doc = new Doc(), blocks = doc.getMap('blocks');
  const put = (id, flavour, children = [], props = {}) => {
    const b = new YMap(); blocks.set(id,b); b.set('sys:flavour',flavour); b.set('sys:children',children);
    for (const [k,v] of Object.entries(props)) b.set('prop:'+k,v);
    return b;
  };
  const title = new YText();
  const comment = {delta:[{insert:'Первый источник',attributes:{link:'https://example.org/source'}}]};
  put('linked-row','affine:paragraph',['details'],{text:title});
  title.insert(0,' ',{reference:{pageId:'project-target'}});
  put('details','affine:paragraph',[],{text:new YText('Авторский контекст внутри карточки')});
  put('done-row','affine:paragraph',[],{text:new YText('Завершённая задача')});
  put('invalid-row','affine:paragraph',[],{text:new YText('Неподдержанный формат даты')});
  put('table','affine:database',['linked-row','done-row','invalid-row'],{
    title:new YText('TASKS'), columns:[
      {id:'title',name:'Название',type:'title',data:{}},
      {id:'status',name:'Статус',type:'select',data:{options:[{id:'todo',value:'К выполнению'},{id:'done',value:'Готово'}]}},
      {id:'due',name:'Срок',type:'date',data:{}},
      {id:'comment',name:'Комментарии',type:'rich-text',data:{}}
    ],cells:{
      'linked-row':{due:{value:emptyDates?null:1789592400000},status:{value:'todo'},comment:{value:comment}},
      'done-row':{due:{value:emptyDates?null:0},status:{value:'done'}},
      'invalid-row':{due:{value:emptyDates?null:'tomorrow'}}
    },views:[{id:'calendar',mode:'calendar',name:'Календарь',date:{startColumnId:'due'},
      sources:{workspaceCalendar:{enabled:true}},filter:{conditions:[{status:'todo'}],op:'and'}}]
  });
  const bytes = encodeStateAsUpdate(doc); doc.destroy(); return bytes;
}
function setup(options={}) {
  const requests=[];
  const tools=createAffineMediaTools({authorize:async()=>({cookie:'session=synthetic'}),
    fetchImpl:async url=>{requests.push(url);return new Response(fixture(options),{headers:{'Content-Type':'application/octet-stream'}});}});
  return {requests,call:async(kind,args={})=>{
    const result=await tools.callTool('affine_read_structure',{doc_id:PILOT_DOCUMENT_ID,kind,...args});
    assert.equal(result.isError,undefined);
    return result.structuredContent;
  }};
}

test('reference-only row titles retain project access and distinguish title, comment and nested content',async()=>{
  const {call,requests}=setup();
  const result=await call('table_rows',{table_id:'table'});
  const row=result.items.find(r=>r.row_id==='linked-row');
  assert.equal(row.title_status,'linked_document_title_not_fetched');
  assert.deepEqual(row.title_references.map(r=>r.target_doc_id),['project-target']);
  assert.ok(row.references.some(r=>r.column_id==='comment'&&r.url==='https://example.org/source'));
  assert.deepEqual(row.content_block_ids,['details']);
  assert.equal(row.nested_content_fetched,false);
  assert.equal(row.cells.find(c=>c.column_id==='status').tags[0].label,'К выполнению');
  assert.equal(result.coverage.linked_documents_fetched,false);
  assert.equal(requests.length,1);
  assert.ok(requests.every(url=>url.endsWith('/docs/'+PILOT_DOCUMENT_ID)));
});

test('calendar configuration and date fields never imply full event access or an inferred local date',async()=>{
  const {call}=setup();
  const table=(await call('tables')).items[0], view=table.calendar_views[0];
  assert.equal(table.row_scope,'stored_rows_before_view_filters');
  assert.equal(view.workspace_calendar_enabled,true);
  assert.equal(view.workspace_calendar_events_fetched,false);
  assert.equal(view.view_filters_applied,false);
  assert.equal(view.rows_with_valid_start_before_filters,2);
  const rows=(await call('table_rows',{table_id:'table'})).items;
  assert.equal(rows.length,3,'a calendar view filter must not silently filter the source table');
  const date=rows[0].cells.find(c=>c.type==='date').date;
  assert.equal(date.instant_utc,'2026-09-16T21:00:00.000Z');
  assert.equal(date.display_timezone,null); assert.equal(date.calendar_day,null);
  assert.equal(rows[1].cells.find(c=>c.type==='date').date.instant_utc,'1970-01-01T00:00:00.000Z');
  assert.equal(rows[2].cells.find(c=>c.type==='date').date.status,'unsupported_value');
  const empty=(await setup({emptyDates:true}).call('tables')).items[0].calendar_views[0];
  assert.equal(empty.rows_with_valid_start_before_filters,0);
  assert.equal(empty.coverage,'table_date_fields_only_other_sources_unread');
});

test('node context locates nested material and reference-only titles with independent pagination',async()=>{
  const {call}=setup();
  const first=await call('nodes',{limit:1});
  assert.equal(first.items[0].id,'linked-row');
  assert.ok(first.items[0].references.some(r=>r.target_doc_id==='project-target'));
  assert.deepEqual(first.items[0].parent_ids,['table']);
  assert.equal(first.next_offset,1);
  const next=await call('nodes',{limit:1,offset:first.next_offset});
  assert.equal(next.items[0].id,'details');
  assert.deepEqual(next.items[0].parent_ids,['linked-row']);
  assert.equal(next.items[0].text,'Авторский контекст внутри карточки');
  assert.equal(next.items[0].text_is_summary,true);
});
