// Navigation is derived from the current snapshot. No labels or documents are written.
// Explicit links and heading order are distinct from geometric/proximity inferences.
const containers = new Set(['affine:note', 'affine:edgeless-text']);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function validRect(value) {
  if (typeof value === 'string' && value.length <= 256) {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) &&
    value.every(n => Math.abs(n) < 1e10) && value[2] > 0 && value[3] > 0 ? value : null;
}

function contains(a, b) {
  return a && b && b[0] >= a[0] && b[1] >= a[1] &&
    b[0] + b[2] <= a[0] + a[2] && b[1] + b[3] <= a[1] + a[3];
}

function rotatedBounds(rect, rotation = 0) {
  if (!rect || !Number.isFinite(rotation)) return null;
  const [x, y, w, h] = rect, rad = rotation * Math.PI / 180;
  const nw = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
  const nh = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
  return [x + (w - nw) / 2, y + (h - nh) / 2, nw, nh];
}

export function buildNavigation(nodes, images) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const byImage = new Map(images.map(i => [i.block_id, i]));
  const parents = new Map(), flowParents = new Map();
  let budget = 500000;
  const tick = () => { if (--budget < 0) throw new Error('Navigation graph limit'); };
  for (const n of nodes) {
    for (const child of new Set([...n.children, ...n.elementChildren])) {
      tick(); if (!byId.has(child)) continue;
      if (!parents.has(child)) parents.set(child, new Set());
      parents.get(child).add(n.id);
    }
    for (const child of n.children) {
      if (!flowParents.has(child)) flowParents.set(child, new Set());
      flowParents.get(child).add(n.id);
    }
  }
  const ancestorCache = new Map();
  function ancestors(id) {
    if (ancestorCache.has(id)) return ancestorCache.get(id);
    const seen = new Set(), queue = [...(parents.get(id) || [])];
    while (queue.length) {
      tick(); const next = queue.pop();
      if (next === id || seen.has(next)) continue;
      if (seen.size >= 256) throw new Error('Navigation depth limit');
      seen.add(next); queue.push(...(parents.get(next) || []));
    }
    ancestorCache.set(id, seen); return seen;
  }

  const sections = [], sectionByBlock = new Map(), frameSections = [], groupSections = [], memberships = new Map();
  function addSection(node, kind, level) {
    const section = { section_id: `${kind}:${node.id}`, block_id: node.id,
      title: node.title || node.text || '', kind, level: level || null,
      title_basis: kind === 'group' ? 'group_title' : kind === 'frame' ? 'frame_title' : kind === 'table' ? 'database_title' :
        node.headingLevel ? 'heading_text' : 'bold_label',
      xywh: node.rect, anchor_xywh: null, container_id: null,
      structural_image_count: 0, geometric_image_count: 0, candidate_image_count: 0 };
    if (sections.length >= 2000) throw new Error('Section count limit');
    sections.push(section); sectionByBlock.set(node.id, section);
    return section;
  }
  for (const n of nodes) {
    if (n.flavour === 'affine:frame') frameSections.push(addSection(n, 'frame'));
    else if (n.flavour === 'surface:group') groupSections.push(addSection(n, 'group'));
    else if (n.flavour === 'affine:database') addSection(n, 'table');
    else if (n.flavour === 'affine:paragraph' && n.text.trim() &&
        (n.headingLevel || (n.bold && n.text.length <= 120 && !n.text.includes('\n')))) {
      addSection(n, 'heading', n.headingLevel || 7);
    }
  }

  function link(imageId, sectionId, basis) {
    const links = memberships.get(imageId) || new Map();
    // A structural relationship takes priority over an inferred one for the same section.
    if (!links.has(sectionId) || links.get(sectionId) === 'frame_geometry') links.set(sectionId, basis);
    memberships.set(imageId, links);
  }

  // A heading's range is confined to its own ordered text container. Canvas sibling
  // order is never interpreted as a relationship between independent notes/images.
  for (const container of nodes.filter(n => containers.has(n.flavour))) {
    const seen = new Set(); let localOrder = 0;
    const headings = [], localImages = [];
    function walk(ids, inherited, depth = 0) {
      if (depth > 128) throw new Error('Document depth limit');
      let stack = [...inherited];
      for (const id of ids) {
        tick(); if (seen.has(id)) continue; seen.add(id);
        const n = byId.get(id); if (!n || containers.has(n.flavour)) continue;
        const section = sectionByBlock.get(id);
        if (section?.kind === 'table') section.container_id = container.id;
        if (section?.kind === 'heading') {
          stack = stack.filter(s => s.level < section.level);
          stack.push(section); headings.push(section);
          section.container_id = container.id;
        }
        if (byImage.has(id)) {
          localImages.push(id);
          const image = byImage.get(id);
          image.container_id = container.id;
          image.container_xywh = container.rect;
          image.document_order = localOrder++;
          for (const s of stack) link(id, s.section_id, 'document_heading');
        }
        walk(n.children, stack, depth + 1);
      }
    }
    walk(container.children, []);
    // Only an isolated label gets the container's rectangle as its spatial anchor.
    const meaningful = [...seen].map(id => byId.get(id)).filter(n => n?.text?.trim());
    if (headings.length === 1 && meaningful.length === 1 && localImages.length === 0) {
      headings[0].anchor_xywh = rotatedBounds(container.rect, container.rotation);
    }
  }

  for (const section of sections) {
    if (section.kind === 'heading' && !section.anchor_xywh) {
      const n = byId.get(section.block_id);
      if (n.rect) section.anchor_xywh = rotatedBounds(n.rect, n.rotation);
    }
  }

  for (const frame of frameSections) {
    if (!frame.title) {
      const labels = sections.filter(s => s.kind === 'heading' && ancestors(s.block_id).has(frame.block_id));
      if (labels.length === 1) { frame.title = labels[0].title; frame.title_basis = 'single_heading_in_frame'; }
    }
  }

  // Groups are stored as surface elements, distinct from frames and page flow.
  // A single label in the nearest group is an explicit alias for that group;
  // multiple headings remain ambiguous and never assign sibling images by order.
  const aliases = new Map();
  const nearestGroup = id => [...ancestors(id)].map(id => sectionByBlock.get(id))
    .filter(s => s?.kind === 'group')
    .sort((a, b) => ancestors(b.block_id).size - ancestors(a.block_id).size || compare(a.block_id, b.block_id))[0];
  for (const group of groupSections) {
    const labels = sections.filter(s => s.kind === 'heading' && nearestGroup(s.block_id)?.block_id === group.block_id);
    if (labels.length === 1) {
      aliases.set(group.block_id, labels[0]);
      labels[0].group_id = group.block_id;
      if (!group.title) { group.title = labels[0].title; group.title_basis = 'single_heading_in_group'; }
    }
  }

  for (const image of images) {
    const n = byId.get(image.block_id), ancestry = ancestors(image.block_id);
    const flowParent = [...(flowParents.get(image.block_id) || [])].map(id => byId.get(id));
    const inPageFlow = image.container_id || flowParent.some(p => p && p.flavour !== 'affine:surface');
    // Image xywh in page flow can be a placeholder; use the enclosing note as an
    // approximate canvas location, not invented per-image coordinates inside it.
    const bounds = inPageFlow
      ? rotatedBounds(byId.get(image.container_id)?.rect, byId.get(image.container_id)?.rotation || 0)
      : rotatedBounds(n?.rect, n?.rotation || 0);
    image.canvas_bounds = bounds;
    image.canvas_bounds_basis = inPageFlow ? (bounds ? 'container_bounds' : 'unavailable') : (bounds ? 'image_bounds' : 'unavailable');
    // A table title identifies the database block. Only actual descendant image
    // blocks count here; URLs or attachment values in cells are not image blocks.
    for (const ancestor of ancestry) {
      const section = sectionByBlock.get(ancestor);
      if (section?.kind === 'table') link(image.block_id, section.section_id, 'table_membership');
      if (section?.kind === 'group') {
        link(image.block_id, section.section_id, 'group_membership');
        const alias = aliases.get(ancestor);
        if (alias) link(image.block_id, alias.section_id, 'group_label_membership');
      }
    }
    for (const frame of frameSections) {
      tick();
      if (ancestry.has(frame.block_id)) link(image.block_id, frame.section_id, 'frame_membership');
      else if ((byId.get(frame.block_id)?.rotation || 0) === 0 && contains(frame.xywh, bounds)) {
        link(image.block_id, frame.section_id, 'frame_geometry');
      }
    }
    const links = memberships.get(image.block_id) || new Map();
    image.sections = [...links].map(([section_id, basis]) => ({ section_id, basis }));
    image.section_candidates = [];
    image.section_membership = links.size ? 'linked_with_basis' : 'unassigned';
  }

  // Proximity is a candidate only. It NEVER silently becomes section membership.
  const anchors = sections.filter(s => s.kind === 'heading' && s.anchor_xywh);
  for (const image of images) {
    if (image.sections.some(s => ['document_heading', 'group_membership', 'group_label_membership'].includes(s.basis)) || !image.canvas_bounds) continue;
    const b = image.canvas_bounds, ix = b[0] + b[2] / 2, iy = b[1] + b[3] / 2;
    const ranked = anchors.filter(s => !image.sections.some(m => m.section_id === s.section_id)).map(s => {
      tick(); const r = s.anchor_xywh;
      const dx = Math.max(r[0] - ix, 0, ix - r[0] - r[2]);
      const dy = Math.max(r[1] - iy, 0, iy - r[1] - r[3]);
      return { section_id: s.section_id, basis: 'nearby_label_only', distance: Math.round(Math.hypot(dx, dy)) };
    }).sort((a, b) => a.distance - b.distance || compare(a.section_id, b.section_id));
    // Do not call a label thousands of canvas units away a nearby candidate.
    image.section_candidates = ranked.filter(s => s.distance <= 1200).slice(0, 3);
  }

  const sectionById = new Map(sections.map(s => [s.section_id, s]));
  for (const image of images) {
    for (const m of image.sections) {
      const section = sectionById.get(m.section_id);
      if (m.basis === 'frame_geometry') section.geometric_image_count++;
      else section.structural_image_count++;
    }
    for (const m of image.section_candidates) sectionById.get(m.section_id).candidate_image_count++;
  }
  sections.sort((a, b) => compare(a.section_id, b.section_id));
  return { sections, unassigned_images: images.filter(i => !i.sections.length).length,
    navigation_basis: 'document_headings_groups_frames_tables; stored_group_membership; geometry_labeled; proximity_candidates_only' };
}
