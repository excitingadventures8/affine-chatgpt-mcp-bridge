import { Doc, Map as YMap, Text as YText, applyUpdate } from './vendor/yjs.mjs';
import { buildNavigation, validRect } from './sections.mjs';
import { extractStructure, structurePage, entries } from './structure.mjs';

export const WORKSPACE_ID = '00000000-0000-4000-8000-000000000000';
export const BRIDGE_VERSION = '1.3.5';
export const PILOT_DOCUMENT_ID = 'example-document';
const ORIGIN = 'https://app.affine.pro';
const PREFIX = `${ORIGIN}/api/workspaces/${WORKSPACE_ID}`;
const DOC_LIMIT = 16 * 1024 * 1024;
const IMAGE_LIMIT = 8 * 1024 * 1024;
const STORAGE_ORIGIN = 'https://usercontent.affine.pro';
const TOOL_NAMES = new Set(['affine_list_sections', 'affine_list_images', 'affine_read_image', 'affine_read_structure']);
export const isDocumentId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

class MediaError extends Error {
  constructor(code, stage, message, httpStatus) {
    super(message);
    this.code = code;
    this.stage = stage;
    this.httpStatus = httpStatus;
  }
}

const fail = (code, stage, message, httpStatus) => {
  throw new MediaError(code, stage, message, httpStatus);
};

const textResult = data => {
  const tagged = { bridge_version: BRIDGE_VERSION, ...data };
  return { content: [{ type: 'text', text: JSON.stringify(tagged) }], structuredContent: tagged };
};

function cookieValue(cookie) {
  if (typeof cookie !== 'string' || !cookie.length || cookie.length > 32768 ||
      !cookie.includes('=') || /[^\x20-\x7e]/.test(cookie) || cookie.includes('aff_mcp_v1')) {
    fail('SESSION_REQUIRED', 'authorization', 'Нужна действующая сессия AFFiNE в защищённом хранилище сервера.');
  }
  return cookie;
}

function shortText(value, limit = 500) {
  if (value instanceof YText) return value.toString().slice(0, limit);
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function sourceId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 &&
    !/[\x00-\x20\x7f]/.test(value) && !value.includes('://') &&
    !value.startsWith('blob:') && !value.startsWith('data:') && !['.', '..'].includes(value);
}

function rect(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  try {
    const r = JSON.parse(value);
    return Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) &&
      r[2] >= 0 && r[3] >= 0 ? r : null;
  } catch { return null; }
}

function decodeDocument(bytes) {
  const doc = new Doc();
  try {
    applyUpdate(doc, bytes);
    if (doc.store.pendingStructs || doc.store.pendingDs || !doc.share.has('blocks')) throw new Error();
    const blocks = doc.getMap('blocks');
    if (blocks.size > 100000) throw new Error();
    const images = [], frames = [], nodes = [];
    let imageBlocks = 0;
    let documentTitle = null;
    let titleIsTruncated = false;
    for (const [blockId, block] of blocks.entries()) {
      if (!(block instanceof YMap) || typeof blockId !== 'string' || blockId.length > 512) continue;
      const flavour = block.get('sys:flavour');
      if (flavour === 'affine:page' && documentTitle === null) {
        // A page title is context for the whole document, not an image category.
        const rawTitle = shortText(block.get('prop:title'), 501);
        if (rawTitle.trim()) {
          documentTitle = rawTitle.slice(0, 500);
          titleIsTruncated = rawTitle.length > 500;
        }
      }
      const rawChildren = block.get('sys:children');
      const children = (Array.isArray(rawChildren) ? rawChildren : rawChildren?.toArray?.() || [])
        .filter(id => typeof id === 'string' && id.length <= 512);
      const rawElements = block.get('prop:childElementIds');
      const elementChildren = entries(rawElements).filter(([, value]) => value === true).map(([id]) => id);
      const textValue = block.get('prop:text');
      const text = shortText(textValue);
      const delta = textValue instanceof YText ? textValue.toDelta().filter(d => typeof d.insert === 'string' && d.insert.trim()) : [];
      const type = block.get('prop:type');
      nodes.push({ id: blockId, flavour, children, elementChildren,
        text, title: shortText(block.get('prop:title')),
        bold: delta.length > 0 && delta.every(d => d.attributes?.bold === true),
        headingLevel: typeof type === 'string' && /^h[1-6]$/.test(type) ? Number(type[1]) : null,
        rect: validRect(block.get('prop:xywh')), rotation: block.get('prop:rotate') ?? 0 });
      if (flavour === 'affine:frame') {
        frames.push({ block_id: blockId, title: shortText(block.get('prop:title')),
          xywh: rect(block.get('prop:xywh')) });
      }
      if (flavour !== 'affine:image') continue;
      imageBlocks++;
      const key = block.get('prop:sourceId');
      if (!sourceId(key)) continue;
      images.push({ block_id: blockId, source_id: key,
        caption: shortText(block.get('prop:caption')),
        xywh: rect(block.get('prop:xywh')) });
    }
    images.sort((a, b) => a.block_id < b.block_id ? -1 : a.block_id > b.block_id ? 1 : 0);
    const structure = extractStructure(blocks, nodes, WORKSPACE_ID);
    const navigation = buildNavigation(nodes, images);
    const sectionById = new Map(navigation.sections.map(section => [section.section_id, section]));
    const labelSection = membership => {
      const section = sectionById.get(membership.section_id);
      return { ...membership, title: section?.title || null, kind: section?.kind || null,
        title_basis: section?.title_basis || null };
    };
    for (const image of images) {
      image.sections = image.sections.map(labelSection);
      image.section_candidates = image.section_candidates.map(labelSection);
    }
    return { imageBlocks, images, frames, nodes, structure, ...navigation,
      documentContext: { title: documentTitle,
        title_basis: documentTitle === null ? 'unavailable' : 'affine_page_title',
        title_is_truncated: titleIsTruncated } };
  } catch {
    fail('DOCUMENT_FORMAT_UNSUPPORTED', 'document_decode', 'Не удалось прочитать полную структуру AFFiNE/Yjs V1.');
  } finally { doc.destroy(); }
}

function imageMime(bytes, servedMime) {
  let mime;
  const prefix = (...values) => values.every((v, i) => bytes[i] === v);
  if (bytes.length >= 24 && prefix(137, 80, 78, 71, 13, 10, 26, 10)) mime = 'image/png';
  else if (bytes.length >= 4 && prefix(255, 216, 255)) mime = 'image/jpeg';
  else if (bytes.length >= 13 && (prefix(71, 73, 70, 56, 55, 97) || prefix(71, 73, 70, 56, 57, 97))) mime = 'image/gif';
  else if (bytes.length >= 12 && prefix(82, 73, 70, 70) &&
           bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) mime = 'image/webp';
  else fail('IMAGE_FORMAT_UNSUPPORTED', 'image_validation', 'Файл не распознан как PNG/JPEG/WebP/GIF.');
  if (![mime, 'application/octet-stream', 'binary/octet-stream', ''].includes(servedMime)) {
    fail('IMAGE_TYPE_MISMATCH', 'image_validation', 'Сигнатура файла не совпадает с типом ответа сервера.');
  }
  return mime;
}

function base64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 16384) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  }
  return btoa(binary);
}

function storageUrl(value) {
  if (typeof value !== 'string' || value.length > 16384 || /[\x00-\x20\x7f]/.test(value)) {
    fail('STORAGE_URL_REJECTED', 'storage_url_validation', 'Неподдерживаемый адрес хранилища.');
  }
  let url;
  try { url = new URL(value); } catch {
    fail('STORAGE_URL_REJECTED', 'storage_url_validation', 'Неподдерживаемый адрес хранилища.');
  }
  if (url.origin !== STORAGE_ORIGIN || url.username || url.password || url.hash) {
    fail('STORAGE_URL_REJECTED', 'storage_url_validation', 'Разрешено только подтверждённое HTTPS-хранилище usercontent.affine.pro.');
  }
  return url.href;
}

function definitions(allowedDocuments) {
  const document = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$',
    ...(allowedDocuments ? { enum: [...allowedDocuments] } : {}),
    description: 'Document ID in the connected AFFiNE workspace. Find it using doc_search/read_document.' };
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  return [{
    name: 'affine_read_structure', title: 'Контекст и организация материалов AFFiNE',
    description: 'Read the organization of one current document: tables, rows, tags, references, node parents, groups, date fields and calendar-view definitions, with document_context. Use AFFiNE when the user request calls for personal materials; the user brief sets scope. Read relevant documents, not the entire workspace by default. Interpret tags within their table, column and user context; independent areas need not be related. Follow reference-only titles to their target documents. Full text uses read_document; actual images use affine_read_image; external sources require separate reading. Calendar date fields exclude workspace events and do not establish the display timezone. View filters are returned, not applied. Paginate each kind independently. Read-only.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      doc_id: document, kind: { type: 'string', enum: ['nodes', 'groups', 'connections', 'references', 'tables', 'table_rows', 'tags'] },
      table_id: { type: 'string', minLength: 1, maxLength: 512 },
      offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 }
    }, required: ['doc_id', 'kind'] }, annotations,
  }, {
    name: 'affine_list_sections', title: 'Разделы документа AFFiNE',
    description: 'Find current group/frame/database titles and headings with document_context. Query matches titles. Use these labels and nearby text to understand the material in the user task. Counts distinguish structural membership, frame containment geometry and unconfirmed nearby-label candidates; proximity alone does not prove membership. Use section_id with affine_list_images. If no useful section or image match exists, list images without section_id and read the document: a composition reference collection does not need individual image labels. Database URL and attachment cells are not image blocks.',
    inputSchema: { type: 'object', additionalProperties: false,
      properties: { doc_id: document, query: { type: 'string', maxLength: 200 },
        offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['doc_id'] }, annotations,
  }, {
    name: 'affine_list_images', title: 'Изображения документа AFFiNE',
    description: 'List current image blocks with document_context, captions, section titles and membership basis. Optionally filter by section_id from affine_list_sections; include_candidates adds explicitly unconfirmed proximity matches. Unassigned means no technical section membership was found, not that an image has no meaning or document context. For document-wide material or an empty section result, omit section_id and paginate. Metadata is not visual inspection: use affine_read_image. Interpret composition, style and relevance from the actual image and context; no compulsory per-image taxonomy. IDs are not canvas order.',
    inputSchema: { type: 'object', additionalProperties: false,
      properties: { doc_id: document, offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 40 },
        section_id: { type: 'string', minLength: 1, maxLength: 520 },
        include_candidates: { type: 'boolean', default: false } }, required: ['doc_id'] },
    annotations,
  }, {
    name: 'affine_read_image', title: 'Прочитать изображение AFFiNE',
    description: 'View one actual PNG/JPEG/WebP/GIF image, up to 8 MiB, with current document_context, caption and named sections. Obtain block_id from affine_list_images. Analyze visible composition, color, light, geometry and style independently using visual knowledge; the user need not label every example. Relate it to the document, user comments and requested task; distinguish observation, stored membership and your interpretation of taste or project relevance. Offer familiar or new directions when the creative task calls for them, not as a mandatory result of reading or a technical check. A still image does not establish animation behavior. Returns fresh image bytes without a local browser.',
    inputSchema: { type: 'object', additionalProperties: false,
      properties: { doc_id: document, block_id: { type: 'string', minLength: 1, maxLength: 512 } },
      required: ['doc_id', 'block_id'] }, annotations,
  }];
}

/**
 * Extension module only: no HTTP listener, login flow, storage, or deployment.
 * authorize(context, docId) MUST validate the calling principal in the existing
 * bridge, enforce document scope, and return that principal's {cookie} from a
 * server-side secret store. context MUST come from verified server middleware,
 * never from MCP tool arguments. Default remains the pilot; allowedDocuments:null
 * explicitly enables the fixed workspace subject to authorize() on EVERY call.
 */
export function createAffineMediaTools({ authorize, allowedDocuments = [PILOT_DOCUMENT_ID],
  fetchImpl = globalThis.fetch, requestTimeoutMs = 20000 } = {}) {
  if (typeof authorize !== 'function' || typeof fetchImpl !== 'function') {
    throw new TypeError('An authorization callback and fetch are required.');
  }
  if (allowedDocuments !== null && (!Array.isArray(allowedDocuments) || !allowedDocuments.length || allowedDocuments.length > 1000 ||
      !allowedDocuments.every(isDocumentId))) {
    throw new TypeError('Explicit document scope is required.');
  }
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 60000) {
    throw new TypeError('Invalid request timeout.');
  }
  const allowed = allowedDocuments === null ? null : new Set(allowedDocuments);
  const tools = definitions(allowed);

  async function request(url, cookie, limit, stage, allowLocation = false) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    let response;
    try {
      const headers = new Headers({ Accept: 'application/octet-stream, application/json, image/*', 'Accept-Encoding': 'identity' });
      if (cookie) {
        if (!url.startsWith(PREFIX + '/')) fail('INVALID_TARGET', stage, 'Запрос вне разрешённого пространства.');
        headers.set('Cookie', cookie);
      }
      response = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual', credentials: 'omit', signal: controller.signal });
      const status = response.status;
      if (allowLocation && [301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.get('Location');
        if (location) return { location, bytes: new Uint8Array(), mime: '' };
      }
      if (status !== 200) {
        if (status === 401 || status === 403) fail('ACCESS_DENIED', stage, 'AFFiNE или хранилище отказали в доступе. Нужна проверка сессии и прав подключения.', status);
        if (status === 404) fail('RESOURCE_NOT_FOUND', stage, 'Запрошенный ресурс не найден.', status);
        if (status === 405 || status === 426) fail('API_INCOMPATIBLE', stage, 'Сервер не принимает этот протокол. Версия клиента не подменяется.', status);
        if (status === 429) fail('RATE_LIMITED', stage, 'Сервер ограничил частоту запросов.', status);
        if (status >= 300 && status < 400) fail('REDIRECT_REJECTED', stage, 'Дополнительное перенаправление остановлено.', status);
        fail('HTTP_ERROR', stage, 'Ошибка HTTP при чтении материала.', status);
      }
      const length = response.headers.get('Content-Length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
        fail('RESPONSE_TOO_LARGE', stage, 'Размер ответа превышает лимит модуля.');
      }
      const mime = (response.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
      if (!response.body) fail('EMPTY_RESPONSE', stage, 'Сервер не вернул содержимое.');
      const reader = response.body.getReader(), parts = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > limit) fail('RESPONSE_TOO_LARGE', stage, 'Размер ответа превышает лимит модуля.');
        parts.push(value);
      }
      if (length !== null && !response.headers.get('Content-Encoding') && total !== Number(length)) {
        fail('INCOMPLETE_RESPONSE', stage, 'Ответ получен не полностью.');
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.length; }
      return { bytes, mime };
    } catch (error) {
      if (error instanceof MediaError) throw error;
      fail(controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR', stage,
        controller.signal.aborted ? 'Превышено время запроса.' : 'Не удалось выполнить HTTPS-запрос.');
    } finally {
      controller.abort();
      clearTimeout(timeout);
      // Abort also stops any unread error/redirect body; no response bodies are logged.
    }
  }

  async function callTool(name, args, context) {
    try {
      if (!TOOL_NAMES.has(name)) fail('UNKNOWN_TOOL', 'input', 'Неизвестный инструмент.');
      if (!args || typeof args !== 'object' || Array.isArray(args)) fail('INVALID_ARGUMENTS', 'input', 'Неверные аргументы.');
      const fields = name === 'affine_read_structure' ? ['doc_id', 'kind', 'table_id', 'offset', 'limit'] : name === 'affine_list_images' ? ['doc_id', 'offset', 'limit', 'section_id', 'include_candidates'] :
        name === 'affine_list_sections' ? ['doc_id', 'offset', 'limit', 'query'] : ['doc_id', 'block_id'];
      if (Object.keys(args).some(key => !fields.includes(key))) fail('INVALID_ARGUMENTS', 'input', 'Неподдерживаемые аргументы.');
      if (!isDocumentId(args.doc_id) || (allowed && !allowed.has(args.doc_id))) fail('DOCUMENT_NOT_ALLOWED', 'authorization', 'Неверный ID или документ вне разрешённой области.');
      const offset = args.offset ?? 0, limit = args.limit ?? 20;
      if (name !== 'affine_read_image' && (!Number.isSafeInteger(offset) || offset < 0 ||
          !Number.isInteger(limit) || limit < 1 || limit > (['affine_list_sections', 'affine_read_structure'].includes(name) ? 100 : 40))) fail('INVALID_ARGUMENTS', 'input', 'Неверная страница списка.');
      if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 200)) fail('INVALID_ARGUMENTS', 'input', 'Неверный запрос раздела.');
      if (args.section_id !== undefined && (typeof args.section_id !== 'string' || !args.section_id.length || args.section_id.length > 520)) fail('INVALID_ARGUMENTS', 'input', 'Неверный section_id.');
      if (args.include_candidates !== undefined && typeof args.include_candidates !== 'boolean') fail('INVALID_ARGUMENTS', 'input', 'include_candidates должен быть логическим значением.');
      if (args.include_candidates && !args.section_id) fail('INVALID_ARGUMENTS', 'input', 'Для просмотра кандидатов укажите section_id.');
      if (name === 'affine_read_image' && (typeof args.block_id !== 'string' || !args.block_id.length || args.block_id.length > 512)) {
        fail('INVALID_ARGUMENTS', 'input', 'Нужен block_id из списка изображений.');
      }
      if (name === 'affine_read_structure') {
        if (!['nodes', 'groups', 'connections', 'references', 'tables', 'table_rows', 'tags'].includes(args.kind)) fail('INVALID_ARGUMENTS', 'input', 'Нужен поддерживаемый вид структуры kind.');
        if (args.kind === 'table_rows' && (typeof args.table_id !== 'string' || !args.table_id.length || args.table_id.length > 512)) fail('INVALID_ARGUMENTS', 'input', 'Для строк нужен table_id.');
        if (args.kind !== 'table_rows' && args.table_id !== undefined) fail('INVALID_ARGUMENTS', 'input', 'table_id применяется только к table_rows.');
      }
      let session;
      try { session = await authorize(context, args.doc_id); } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') fail('UPSTREAM_TIMEOUT', 'authorization_check', 'Проверка доступа AFFiNE не успела завершиться; это не подтверждённый отказ авторизации.');
        const status = error?.upstreamStatus;
        if (status === 429) fail('UPSTREAM_RATE_LIMITED', 'authorization_check', 'AFFiNE ограничил частоту запросов. Повторите позже.', status);
        if (Number.isInteger(status) && status >= 500 && status <= 599) fail('UPSTREAM_UNAVAILABLE', 'authorization_check', 'Сервис AFFiNE временно недоступен.', status);
        if (status === 401 || status === 403) fail('ACCESS_DENIED', 'authorization_check', 'AFFiNE отказал в доступе. Проверьте подключение и разрешения.', status);
        if (error?.upstreamCode === 'NETWORK_ERROR') fail('UPSTREAM_NETWORK_ERROR', 'authorization_check', 'Сетевой сбой при проверке доступа AFFiNE.');
        fail('AUTHORIZATION_CHECK_FAILED', 'authorization_check', 'Проверка доступа завершилась ошибкой; её причина не установлена.');
      }
      if (!session) fail('AUTHORIZATION_REQUIRED', 'authorization', 'Не удалось подтвердить доступ вызывающего клиента.');
      const cookie = cookieValue(session.cookie);
      const documentResponse = await request(`${PREFIX}/docs/${encodeURIComponent(args.doc_id)}`, cookie, DOC_LIMIT, 'document_download');
      if (documentResponse.mime !== 'application/octet-stream') fail('DOCUMENT_TYPE_UNEXPECTED', 'document_download', 'Вместо структуры документа получен другой тип ответа.');
      const document = decodeDocument(documentResponse.bytes);
      const documentUrl = `${ORIGIN}/workspace/${WORKSPACE_ID}/${encodeURIComponent(args.doc_id)}?mode=edgeless`;
      const documentContext = { doc_id: args.doc_id, ...document.documentContext };
      const normalize = value => value.normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё', 'е').trim();
      if (name === 'affine_read_structure') {
        let result;
        try { result = structurePage(document, args.kind, offset, limit, args.table_id); }
        catch { fail('STRUCTURE_RESPONSE_TOO_LARGE', 'structure_output', 'Страница структуры слишком велика. Уменьшите limit.'); }
        if (!result) fail('TABLE_NOT_FOUND', 'structure_lookup', 'Таблица отсутствует в текущем снимке.');
        return textResult({ document_url: documentUrl, document_context: documentContext, ...result });
      }
      if (name === 'affine_list_sections') {
        const matches = document.sections.filter(s => !args.query || normalize(s.title).includes(normalize(args.query)));
        const items = matches.slice(offset, offset + limit);
        return textResult({ document_url: documentUrl, document_context: documentContext, section_count: document.sections.length,
          matched_sections: matches.length, sections: items,
          next_offset: offset + items.length < matches.length ? offset + items.length : null,
          readable_image_blocks: document.images.length, unassigned_images: document.unassigned_images,
          navigation_basis: document.navigation_basis,
          note: 'Соседство с подписью — кандидат, а не доказанная принадлежность. Внешние видео и неподдерживаемые вложения не считаются просмотренными изображениями.' });
      }
      if (name === 'affine_list_images') {
        const section = args.section_id ? document.sections.find(s => s.section_id === args.section_id) : null;
        if (args.section_id && !section) fail('SECTION_NOT_FOUND', 'section_lookup', 'Раздел отсутствует в текущем документе. Обновите affine_list_sections.');
        const matches = document.images.filter(item => !section ||
          item.sections.some(s => s.section_id === args.section_id) ||
          (args.include_candidates && item.section_candidates.some(s => s.section_id === args.section_id)));
        const items = matches.slice(offset, offset + limit).map(({ source_id, ...item }) => ({ ...item,
          ...(section ? { filter_match: item.sections.some(s => s.section_id === args.section_id) ? 'linked' : 'candidate_only' } : {}) }));
        return textResult({ document_url: documentUrl, document_context: documentContext, image_blocks: document.imageBlocks,
          readable_image_blocks: document.images.length, images: items,
          matched_images: matches.length, selected_section: section,
          next_offset: offset + items.length < matches.length ? offset + items.length : null,
          order: 'block_id_not_canvas_order', section_membership: 'see_each_image_basis',
          unassigned_images: document.unassigned_images,
          frames: document.frames.slice(0, 100), frames_truncated: document.frames.length > 100 });
      }
      const selected = document.images.find(item => item.block_id === args.block_id);
      if (!selected) fail('IMAGE_BLOCK_NOT_FOUND', 'image_lookup', 'В текущем документе нет такого блока изображения. Обновите список.');
      const imageResponse = await request(`${PREFIX}/blobs/${encodeURIComponent(selected.source_id)}?redirect=manual`,
        cookie, IMAGE_LIMIT, 'image_download', true);
      let location = imageResponse.location;
      if (imageResponse.mime === 'application/json') {
        try {
          if (imageResponse.bytes.length > 32768) throw new Error();
          const data = JSON.parse(new TextDecoder().decode(imageResponse.bytes));
          if (!data || typeof data.url !== 'string') throw new Error();
          location = data.url;
        } catch { fail('BLOB_RESPONSE_UNEXPECTED', 'image_download', 'Вместо файла получен неподдерживаемый ответ.'); }
      }
      const image = location === undefined ? imageResponse :
        await request(storageUrl(location), null, IMAGE_LIMIT, 'storage_download');
      const mimeType = imageMime(image.bytes, image.mime);
      const metadata = { bridge_version: BRIDGE_VERSION, document_url: documentUrl,
        document_context: documentContext, block_id: selected.block_id,
        caption: selected.caption, xywh: selected.xywh, bytes: image.bytes.length,
        mime_type: mimeType, sections: selected.sections, section_candidates: selected.section_candidates,
        section_membership: selected.section_membership, container_id: selected.container_id || null };
      return { content: [{ type: 'text', text: JSON.stringify(metadata) },
        { type: 'image', data: base64(image.bytes), mimeType }], structuredContent: metadata };
    } catch (error) {
      const known = error instanceof MediaError;
      const data = { error: known ? error.code : 'INTERNAL_ERROR',
        stage: known ? error.stage : 'internal',
        message: known ? error.message : 'Внутренняя ошибка модуля. Секреты и ответы сервера не выводятся.' };
      if (known && error.httpStatus !== undefined) data.http_status = error.httpStatus;
      return { ...textResult(data), isError: true };
    }
  }
  return { tools, callTool, handles: name => TOOL_NAMES.has(name) };
}
