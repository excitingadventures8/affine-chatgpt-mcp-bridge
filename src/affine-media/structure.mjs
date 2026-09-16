// Read-only extraction from the current Yjs snapshot. No remote links are fetched.
import { Map as YMap, Text as YText } from './vendor/yjs.mjs';
import { validRect } from './sections.mjs';

const idOK = v => typeof v === 'string' && v.length > 0 && v.length <= 512;
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
export const read = (v, k) => v instanceof YMap ? v.get(k) : object(v) && own(v, k) ? v[k] : undefined;
export function unbox(v) {
  for (let n = 0; n < 8 && read(v, 'type') === '$blocksuite:internal:native$'; n++) v = read(v, 'value');
  return v;
}
export function entries(v) {
  v = unbox(v);
  return v instanceof YMap ? [...v.entries()] : object(v) ? Object.entries(v) : [];
}
export function array(v) {
  v = unbox(v);
  return Array.isArray(v) ? v : typeof v?.toArray === 'function' ? v.toArray() : [];
}
export function delta(v) {
  if (v instanceof YText) return v.toDelta();
  const d = read(v, 'delta');
  return Array.isArray(d) ? d : [];
}
export function label(v) {
  if (typeof v === 'string') return v.slice(0, 2000);
  if (v instanceof YText) return v.toString().slice(0, 2000);
  return delta(v).map(d => typeof d.insert === 'string' ? d.insert : '').join('').slice(0, 2000);
}
export function plain(value, state = { left: 200000 }, depth = 0) {
  if (--state.left < 0 || depth > 40) throw new Error('Structure value limit');
  const v = unbox(value);
  if (v == null || typeof v === 'boolean') return v ?? null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    if (v.length > 200000) throw new Error('Structure text limit');
    return v;
  }
  if (v instanceof YText) return v.toString();
  if (Array.isArray(v) || typeof v?.toArray === 'function') return array(v).map(x => plain(x, state, depth + 1));
  const out = Object.create(null);
  for (const [k, x] of entries(v)) out[k] = plain(x, state, depth + 1);
  return out;
}

// Labels belong to the attached object. Read only its stored descendants;
// never use nearby text, another document, or the opposite end of a line.
export function resolveNodeLabel(node, byId) {
  const result = (source, basis) => ({ label: source.title?.trim() || source.text?.trim() || null,
    label_basis: basis, label_source_id: source.id });
  if (!node) return { label: null, label_basis: null, label_source_id: null };
  if (node.title?.trim()) return result(node, 'own_title');
  if (node.text?.trim()) return result(node, 'own_text');
  if (!['affine:note', 'affine:edgeless-text', 'affine:frame', 'surface:group'].includes(node.flavour)) {
    return { label: null, label_basis: 'no_label', label_source_id: null };
  }
  const queue = [...(node.children || []), ...(node.elementChildren || [])], seen = new Set([node.id]);
  const headings = [], texts = [];
  let incomplete = false;
  for (let i = 0; i < queue.length; i++) {
    if (i >= 1000) return { label: null, label_basis: 'descendant_limit', label_source_id: null };
    const id = queue[i];
    if (seen.has(id)) continue;
    seen.add(id);
    const child = byId.get(id);
    if (!child) { incomplete = true; continue; }
    if (child.title?.trim() || child.text?.trim()) {
      texts.push(child);
      if (child.headingLevel || child.bold) headings.push(child);
    }
    // A page or surface reference must not pull unrelated content into a label.
    if (!['affine:page', 'affine:surface'].includes(child.flavour)) {
      queue.push(...(child.children || []), ...(child.elementChildren || []));
    }
  }
  if (incomplete) return { label: null, label_basis: 'incomplete_descendants', label_source_id: null };
  if (headings.length === 1) return result(headings[0], 'unique_descendant_heading');
  if (!headings.length && texts.length === 1) return result(texts[0], 'single_descendant_text');
  return { label: null, label_basis: texts.length ? 'ambiguous_descendants' : 'no_label', label_source_id: null };
}

// AFFiNE date properties store epoch milliseconds. Their display timezone is
// not stored in this column schema: a UTC instant is not a user's calendar day.
export function describeDate(value) {
  const base = { encoding: 'unix_epoch_milliseconds', display_timezone: null, calendar_day: null };
  if (value == null) return { ...base, status: 'empty', instant_utc: null };
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 8.64e15) {
    return { ...base, status: 'unsupported_value', instant_utc: null };
  }
  return { ...base, status: 'parsed', instant_utc: new Date(value).toISOString() };
}

function calendarViews(table) {
  return (Array.isArray(table.views) ? table.views : []).filter(v => v?.mode === 'calendar').map(view => {
    const startId = view.date?.startColumnId ?? null, endId = view.date?.endColumnId ?? null;
    const startColumn = table.columns.find(c => c.id === startId && c.type === 'date');
    const enabled = view.sources?.workspaceCalendar?.enabled;
    return { view_id: view.id, name: view.name, start_column_id: startId, end_column_id: endId,
      start_column_status: startColumn ? 'date_column' : 'unresolved',
      rows_with_valid_start_before_filters: startColumn ? table.rows.filter(r =>
        r.cells.some(c => c.column_id === startId && c.date?.status === 'parsed')).length : null,
      view_filters_applied: false, display_timezone: null,
      workspace_calendar_enabled: typeof enabled === 'boolean' ? enabled : null,
      workspace_calendar_events_fetched: false,
      coverage: enabled === false ? 'table_date_fields_only' : 'table_date_fields_only_other_sources_unread' };
  });
}

export function extractStructure(blocks, nodes, workspaceId) {
  const references = [], tables = [], connectors = [], warnings = [];
  const unresolvedTags = new Map();
  const known = new Set(nodes.map(n => n.id));
  const ids = v => array(v).filter(idOK);
  const selectedIds = v => entries(v).filter(([, flag]) => flag === true).map(([id]) => id).filter(idOK);
  let surfaceCount = 0;
  const surfaceTypes = Object.create(null);
  const urlReference = (source, url, basis, extra = {}) => {
    if (typeof url !== 'string' || url.length > 16384) return;
    let parsed;
    try { parsed = new URL(url, 'https://app.affine.pro'); } catch { return; }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return;
    // Relative references are accepted only for an explicit AFFiNE workspace path.
    if (!/^https?:\/\//i.test(url) && !url.startsWith('/workspace/')) return;
    const match = parsed.origin === 'https://app.affine.pro' && parsed.pathname.match(/^\/workspace\/([^/]+)\/([^/]+)$/);
    references.push({ source_id: source, basis, url: parsed.href,
      kind: match ? 'document_link' : 'external_url',
      ...(match ? { target_workspace_id: match[1], target_doc_id: match[2], same_workspace: match[1] === workspaceId } : {}),
      ...extra });
  };
  const docReference = (source, ref, basis, extra = {}) => {
    const pageId = read(ref, 'pageId');
    if (!idOK(pageId)) return;
    const params = read(ref, 'params');
    const blockIds = ids(read(params, 'blockIds'));
    references.push({ source_id: source, basis, kind: 'document_reference', target_doc_id: pageId,
      target_workspace_id: workspaceId, same_workspace: true, block_ids: blockIds,
      url: `https://app.affine.pro/workspace/${workspaceId}/${encodeURIComponent(pageId)}`, ...extra });
  };
  const textReferences = (source, value, extra = {}) => {
    for (const d of delta(value)) {
      urlReference(source, d.attributes?.link, 'rich_text_link', extra);
      docReference(source, d.attributes?.reference, 'rich_text_reference', extra);
    }
    const text = typeof value === 'string' ? value : value instanceof YText ? value.toString()
      : delta(value).map(d => typeof d.insert === 'string' ? d.insert : '').join('');
    if (text.length > 200000) throw new Error('Structure text limit');
    for (const url of text.match(/https?:\/\/[^\s<>"\]]+/g) || []) urlReference(source, url, 'text_url', extra);
  };
  for (const [blockId, block] of blocks.entries()) {
    if (!(block instanceof YMap)) continue;
    const flavour = block.get('sys:flavour');
    for (const key of ['prop:text', 'prop:title', 'prop:caption']) {
      textReferences(blockId, block.get(key), { source_property: key });
    }
    urlReference(blockId, block.get('prop:url'), 'block_url');
    if (typeof flavour === 'string' && /embed-(linked|synced)-doc/.test(flavour)) {
      docReference(blockId, { pageId: block.get('prop:pageId'), params: block.get('prop:params') }, 'embedded_document');
    }
    if (flavour === 'affine:surface') {
      for (const [id, element] of entries(block.get('prop:elements'))) {
        if (!idOK(id) || known.has(id)) throw new Error('Ambiguous surface element ID');
        if (++surfaceCount + nodes.length > 100000) throw new Error('Surface element limit');
        known.add(id);
        const type = read(element, 'type');
        const kind = typeof type === 'string' ? type : 'unknown';
        surfaceTypes[kind] = (surfaceTypes[kind] || 0) + 1;
        const node = { id, flavour: `surface:${kind}`, surface_id: blockId,
          children: [], elementChildren: kind === 'group' ? selectedIds(read(element, 'children')) : [],
          text: label(read(element, 'text')), title: label(read(element, 'title')),
          headingLevel: null, bold: false, rect: validRect(read(element, 'xywh')), rotation: read(element, 'rotate') ?? 0 };
        nodes.push(node);
        textReferences(id, read(element, 'text'));
        textReferences(id, read(element, 'title'));
        if (kind === 'connector') {
          const endpoint = v => ({ id: idOK(read(v, 'id')) ? read(v, 'id') : null,
            position: plain(read(v, 'position')) });
          connectors.push({ id, source: endpoint(read(element, 'source')), target: endpoint(read(element, 'target')),
            label: node.text, front_endpoint_style: plain(read(element, 'frontEndpointStyle')),
            rear_endpoint_style: plain(read(element, 'rearEndpointStyle')), basis: 'stored_connector',
            note: 'Source/target preserve storage order; arrow meaning is not inferred.' });
        }
      }
    }
    if (flavour === 'affine:database') {
      const columns = array(block.get('prop:columns')).map(c => ({ id: read(c, 'id'), type: read(c, 'type'),
        name: read(c, 'name'), data: plain(read(c, 'data')) })).filter(c => idOK(c.id));
      const cells = block.get('prop:cells');
      const childIds = ids(block.get('sys:children'));
      const rowIds = [...new Set([...childIds, ...entries(cells).map(([id]) => id).filter(idOK)])];
      if (rowIds.length > 50000 || columns.length > 500) throw new Error('Database size limit');
      const rows = rowIds.map(rowId => {
        const row = { row_id: rowId, title: label(blocks.get(rowId)?.get?.('prop:text')), cells: [] };
        const rowCells = read(cells, rowId);
        for (const c of columns) {
          const cell = read(rowCells, c.id);
          if (cell === undefined) continue;
          const raw = read(cell, 'value'), value = plain(raw);
          const out = { column_id: c.id, column_name: c.name, type: c.type, value };
          if (c.type === 'date') out.date = describeDate(raw);
          if (['select', 'multi-select'].includes(c.type)) {
            const selected = c.type === 'multi-select' ? array(raw) : (typeof raw === 'string' ? [raw] : []);
            out.tags = selected.filter(idOK).map(id => {
              const opt = Array.isArray(c.data?.options) ? c.data.options.find(o => o.id === id) : undefined;
              const resolved = typeof opt?.value === 'string' && !!opt.value.trim();
              const status = resolved ? 'resolved' : opt ? 'option_label_missing' : 'option_not_in_column';
              if (!resolved) {
                const key = JSON.stringify([blockId, c.id, id]);
                if (!unresolvedTags.has(key)) unresolvedTags.set(key, { code: 'TAG_OPTION_UNRESOLVED',
                  table_id: blockId, column_id: c.id, tag_id: id, status, assignment_count: 0, row_ids_sample: [] });
                const warning = unresolvedTags.get(key);
                warning.assignment_count++;
                if (warning.row_ids_sample.length < 20) warning.row_ids_sample.push(rowId);
              }
              return { id, label: resolved ? opt.value : null, color: opt?.color ?? null, resolved, status };
            });
          }
          row.cells.push(out);
          const extra = { table_id: blockId, row_id: rowId, column_id: c.id };
          if (c.type === 'link' || c.type === 'url') urlReference(rowId, value, 'table_cell_url', extra);
          if (c.type === 'rich-text') textReferences(rowId, raw, extra);
        }
        return row;
      });
      tables.push({ id: blockId, title: label(block.get('prop:title')), columns, rows,
        views: plain(block.get('prop:views')), row_count: rows.length });
    }
  }
  const byId = new Map(nodes.map(n => [n.id, n]));
  const labelCache = new Map();
  const missingIds = new Set();
  let missingEndpoints = 0, unboundEndpoints = 0;
  for (const edge of connectors) {
    for (const key of ['source', 'target']) {
      const node = byId.get(edge[key].id);
      edge[key].resolved = !!node;
      edge[key].status = node ? 'resolved' : edge[key].id ? 'missing_from_current_snapshot' : 'unbound';
      if (node && !labelCache.has(node.id)) labelCache.set(node.id, resolveNodeLabel(node, byId));
      Object.assign(edge[key], node ? labelCache.get(node.id) : resolveNodeLabel(null, byId));
      if (!node && edge[key].id) { missingEndpoints++; missingIds.add(edge[key].id); }
      else if (!node) unboundEndpoints++;
    }
  }
  if (missingEndpoints) warnings.push({ code: 'CONNECTOR_ENDPOINTS_UNRESOLVED',
    endpoint_count: missingEndpoints, node_count: missingIds.size, node_ids_sample: [...missingIds].slice(0,40),
    note: 'IDs are absent from the decoded current snapshot. Deletion or another cause is not proven.' });
  warnings.push(...[...unresolvedTags.values()].slice(0, 100));
  for (const n of nodes.filter(n => n.flavour === 'surface:group')) {
    const missing = n.elementChildren.filter(id => !byId.has(id));
    if (missing.length) warnings.push({ code: 'GROUP_MEMBERS_UNRESOLVED', group_id: n.id, ids: missing });
  }
  if (surfaceTypes.mindmap) warnings.push({ code: 'MINDMAP_SEMANTICS_NOT_DECODED', count: surfaceTypes.mindmap });
  const seen = new Set();
  const uniqueRefs = references.filter(r => { const key = JSON.stringify(r); if (seen.has(key)) return false; seen.add(key); return true; });
  const refsBySource = new Map();
  for (const reference of uniqueRefs) {
    if (!refsBySource.has(reference.source_id)) refsBySource.set(reference.source_id, []);
    refsBySource.get(reference.source_id).push(reference);
  }
  for (const table of tables) {
    table.row_scope = 'stored_rows_before_view_filters';
    for (const row of table.rows) {
      row.references = refsBySource.get(row.row_id) || [];
      row.title_references = row.references.filter(r => !r.column_id &&
        ['prop:text', 'prop:title'].includes(r.source_property));
      row.title_status = row.title.trim() ? 'text' : row.title_references.some(r =>
        ['document_link','document_reference'].includes(r.kind)) ? 'linked_document_title_not_fetched' : 'empty';
      row.content_block_ids = [...(byId.get(row.row_id)?.children || [])];
      row.nested_content_fetched = false;
    }
    table.calendar_views = calendarViews(table);
  }
  const diagnostics = {
    connections: { total: connectors.length,
      resolved: connectors.filter(e => e.source.resolved && e.target.resolved).length,
      with_missing_endpoints: connectors.filter(e => [e.source,e.target].some(p => p.status === 'missing_from_current_snapshot')).length,
      missing_endpoints: missingEndpoints, missing_node_ids: missingIds.size, unbound_endpoints: unboundEndpoints },
    tags: { unresolved_assignments: [...unresolvedTags.values()].reduce((n,t) => n+t.assignment_count,0),
      unresolved_options: unresolvedTags.size, warnings_truncated: unresolvedTags.size > 100 }
  };
  return { references: uniqueRefs, refsBySource, tables, connectors, surface_types: surfaceTypes, warnings, diagnostics };
}

export function structurePage(document, kind, offset, limit, tableId) {
  const { nodes, structure } = document;
  const groups = document.sections.filter(s => s.kind === 'group');
  const tags = structure.tables.flatMap(t => t.rows.flatMap(r => r.cells.flatMap(c =>
    (c.tags || []).map(tag => ({ table_id: t.id, table_title: t.title, row_id: r.row_id, row_title: r.title,
      column_id: c.column_id, column_name: c.column_name, ...tag })))));
  let items;
  if (kind === 'groups') items = groups.map(g => ({ ...g, child_ids: nodes.find(n => n.id === g.block_id).elementChildren }));
  else if (kind === 'connections') items = structure.connectors;
  else if (kind === 'references') items = structure.references;
  else if (kind === 'tags') items = tags;
  else if (kind === 'tables') items = structure.tables.map(({ rows, ...t }) => t);
  else if (kind === 'table_rows') {
    const table = structure.tables.find(t => t.id === tableId);
    if (!table) return null;
    items = table.rows;
  } else items = nodes;
  let selected = items.slice(offset, offset + limit);
  if (kind === 'nodes') {
    const byId = new Map(nodes.map(n => [n.id, n])), parents = new Map();
    for (const node of nodes) for (const id of new Set([...node.children, ...node.elementChildren])) {
      if (!parents.has(id)) parents.set(id, []);
      parents.get(id).push(node.id);
    }
    selected = selected.map(n => ({ id: n.id, type: n.flavour, title: n.title, text: n.text,
      text_is_summary: true, ...resolveNodeLabel(n, byId), parent_ids: parents.get(n.id) || [],
      children: n.children, element_children: n.elementChildren, xywh: n.rect,
      references: structure.refsBySource.get(n.id) || [],
      section_ids: document.sections.filter(s => s.block_id === n.id || s.container_id === n.id).map(s => s.section_id) }));
  }
  if (JSON.stringify(selected).length > 600000) throw new Error('Structure response limit; reduce limit');
  return { kind, total: items.length, items: selected, next_offset: offset + selected.length < items.length ? offset + selected.length : null,
    counts: { nodes: nodes.length, groups: groups.length, connections: structure.connectors.length,
      references: structure.references.length, tables: structure.tables.length, tag_assignments: tags.length },
    surface_types: structure.surface_types, warnings: structure.warnings, diagnostics: structure.diagnostics,
    coverage: { scope: 'current_document_snapshot', table_select_tags: true,
      workspace_document_tags: 'not_in_this_document_snapshot', external_content_fetched: false,
      linked_documents_fetched: false, row_nested_content_fetched: false,
      table_date_fields: 'read_without_display_timezone', table_view_filters_applied: false,
      calendar_view_definitions: 'read', workspace_calendar_events: 'not_fetched',
      arbitrary_custom_blocks: 'not_interpreted' } };
}
