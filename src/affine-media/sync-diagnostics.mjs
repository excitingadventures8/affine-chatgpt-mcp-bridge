import { BRIDGE_VERSION, WORKSPACE_ID, isDocumentId } from './media.mjs';
import { isOwner } from './bridge.mjs';
import { Doc, Map as YMap, applyUpdate } from './vendor/yjs.mjs';

// A bounded Engine.IO 4 / Socket.IO 5 read-only client for the documented
// AFFiNE batch subscription protocol. No caller-controlled origin or event.
const ENDPOINT = 'https://app.affine.pro/socket.io/?EIO=4&transport=websocket';
const CLIENT_PROTOCOL_VERSION = '0.27.5';
const MAX_DOC_BYTES = 16 * 1024 * 1024;
const MAX_PACKET_CHARS = 24 * 1024 * 1024;
const SERVER_CODES = new Set(['SPACE_ACCESS_DENIED', 'DOC_ACTION_DENIED', 'DOC_NOT_FOUND',
  'NOT_IN_SPACE', 'UNAUTHORIZED', 'FORBIDDEN', 'BAD_REQUEST', 'SYNC_PERMISSION_GENERATION_CHANGED']);

class SyncError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function fail(code) { throw new SyncError(code); }
function decode64(value, limit) {
  if (typeof value !== 'string' || value.length > Math.ceil(limit / 3) * 4 ||
      value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail('INVALID_SNAPSHOT');
  let raw;
  try { raw = atob(value); } catch { fail('INVALID_SNAPSHOT'); }
  if (raw.length > limit) fail('SNAPSHOT_TOO_LARGE');
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function snapshotSummary(payload) {
  if (!payload || !Number.isFinite(payload.timestamp) || payload.timestamp < 0) fail('INVALID_SNAPSHOT');
  const bytes = decode64(payload.missing, MAX_DOC_BYTES);
  const state = decode64(payload.state, 1024 * 1024);
  if (!state.length) fail('INVALID_SNAPSHOT');
  const doc = new Doc();
  try {
    applyUpdate(doc, bytes);
    if (doc.store.pendingStructs || doc.store.pendingDs || !doc.share.has('blocks')) fail('INCOMPLETE_SNAPSHOT');
    const blocks = doc.getMap('blocks');
    if (blocks.size > 100000) fail('SNAPSHOT_TOO_LARGE');
    let databaseBlocks = 0, simpleTableBlocks = 0, textBlocks = 0;
    for (const block of blocks.values()) {
      if (!(block instanceof YMap)) continue;
      const flavour = block.get('sys:flavour');
      if (flavour === 'affine:database') databaseBlocks++;
      if (flavour === 'affine:table') simpleTableBlocks++;
      if (['affine:paragraph', 'affine:list', 'affine:code'].includes(flavour)) textBlocks++;
    }
    return { status: 'checked', yjs_v1_valid: true, state_vector_checked: false,
      bytes: bytes.length, blocks: blocks.size, database_blocks: databaseBlocks,
      simple_table_blocks: simpleTableBlocks, text_blocks: textBlocks,
      content_returned: false };
  } catch (error) {
    if (error instanceof SyncError) throw error;
    fail('SNAPSHOT_FORMAT_UNSUPPORTED');
  } finally { doc.destroy(); }
}

const result = (data, isError = false) => {
  const tagged = { bridge_version: BRIDGE_VERSION, read_only_diagnostics: true,
    document_modified: false, write_execution_tested: false, persistence_verified: false,
    bridge_write_tools_enabled: false, ready_for_write: false, ...data };
  return { content: [{ type: 'text', text: JSON.stringify(tagged) }], structuredContent: tagged,
    ...(isError ? { isError: true } : {}) };
};

export function createSyncDiagnostics({ getLogin, getCookie, diagnoseWrites,
  fetchImpl = globalThis.fetch, timeoutMs = 20000 }) {
  if (![getLogin, getCookie, diagnoseWrites, fetchImpl].every(f => typeof f === 'function') ||
      !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000) throw new TypeError('Invalid trusted callbacks.');

  return async function diagnose(args) {
    if (!args || Object.keys(args).some(k => k !== 'doc_id') || !isDocumentId(args.doc_id) || args.doc_id === WORKSPACE_ID) {
      return result({ error: 'INVALID_ARGUMENTS' }, true);
    }
    if (!isOwner(getLogin())) return result({ error: 'ACCESS_DENIED' }, true);
    // Reuse fresh native read authorization and independent web-session rights.
    let checks;
    try { checks = await diagnoseWrites({ doc_id: args.doc_id }); }
    catch { return result({ error: 'AUTHORIZATION_UNVERIFIED' }, true); }
    const permissions = checks?.structuredContent?.document_permissions;
    if (checks?.isError || checks?.structuredContent?.doc_id !== args.doc_id ||
        checks?.structuredContent?.workspace_id !== WORKSPACE_ID ||
        permissions?.status !== 'checked' || permissions.doc_read !== true) {
      return result({ error: 'AUTHORIZATION_UNVERIFIED' }, true);
    }
    const cookie = getCookie();
    if (typeof cookie !== 'string' || !cookie.length || cookie.length > 32768 || !cookie.includes('=') ||
        /[^\x20-\x7e]/.test(cookie) || cookie.includes('aff_mcp_v1')) return result({ error: 'SESSION_REQUIRED' }, true);
    const stillAuthorized = () => isOwner(getLogin()) && getCookie() === cookie;
    if (!stillAuthorized()) return result({ error: 'ACCESS_DENIED' }, true);
    const progress = { websocket_upgrade: false, engine_handshake: false,
      socket_namespace_connected: false, document_joined: false, snapshot_received: false };
    const output = { doc_id: args.doc_id, workspace_id: WORKSPACE_ID,
      native_write_service: checks.structuredContent.native_write_service,
      document_permissions: permissions, credential_basis: 'existing_web_session',
      grants_native_mcp_write: false, transport: 'engine.io-v4_socket.io-v5_websocket',
      client_protocol_version: CLIENT_PROTOCOL_VERSION, progress };
    let phase = 'websocket_upgrade', ws, listener, onClose, onError;
    let rejectWire;
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); rejectWire?.(new SyncError('TIMEOUT')); }, timeoutMs);
    try {
      const response = await fetchImpl(ENDPOINT, { method: 'GET', redirect: 'manual', credentials: 'omit',
        headers: { Upgrade: 'websocket', Cookie: cookie }, signal: controller.signal });
      // Retain and close a returned socket even if the response is malformed.
      ws = response.webSocket;
      if (controller.signal.aborted) fail('TIMEOUT');
      if (response.status !== 101 || !ws) {
        await response.body?.cancel();
        fail(response.status === 401 || response.status === 403 ? 'SESSION_OR_PERMISSION_DENIED' :
          response.status >= 300 && response.status < 400 ? 'REDIRECT_REJECTED' : 'WEBSOCKET_UPGRADE_REJECTED');
      }
      progress.websocket_upgrade = true; phase = 'engine_handshake';
      const snapshot = await new Promise((resolve, reject) => {
        rejectWire = reject;
        let frames = 0, chars = 0, settled = false;
        const abort = code => { if (!settled) { settled = true; reject(new SyncError(code)); } };
        const send = packet => {
          if (!stillAuthorized()) fail('ACCESS_DENIED');
          ws.send(packet);
        };
        onClose = () => abort('SOCKET_CLOSED');
        onError = () => abort('SOCKET_ERROR');
        listener = event => {
          if (settled) return;
          try {
            if (!stillAuthorized()) fail('ACCESS_DENIED');
            const packet = event.data;
            if (typeof packet !== 'string') fail('BINARY_PACKET_UNSUPPORTED');
            if (++frames > 512 || packet.length > MAX_PACKET_CHARS || (chars += packet.length) > 32 * 1024 * 1024) {
              fail('RESPONSE_TOO_LARGE');
            }
            if (packet === '2') { send('3'); return; }
            if (packet === '6') return;
            if (packet === '1' || packet === '41') fail('SOCKET_CLOSED');
            if (packet.startsWith('44')) fail('SOCKET_AUTH_OR_NAMESPACE_REJECTED');
            // Unsolicited broadcasts are ignored; never send awareness or edits.
            if (packet.startsWith('42')) return;
            if (phase === 'engine_handshake' && packet.startsWith('0')) {
              const handshake = JSON.parse(packet.slice(1));
              if (typeof handshake.sid !== 'string' || !handshake.sid ||
                  !Number.isFinite(handshake.pingInterval) || !Number.isFinite(handshake.pingTimeout)) fail('INVALID_HANDSHAKE');
              progress.engine_handshake = true; phase = 'socket_namespace'; send('40{}'); return;
            }
            if (phase === 'socket_namespace' && packet.startsWith('40')) {
              const connected = JSON.parse(packet.slice(2));
              if (typeof connected.sid !== 'string' || !connected.sid) fail('INVALID_HANDSHAKE');
              progress.socket_namespace_connected = true; phase = 'document_join';
              send('420' + JSON.stringify(['space:join-batch', {
                spaces: [{ spaceType: 'workspace', spaceId: WORKSPACE_ID, docId: args.doc_id }],
                clientVersion: CLIENT_PROTOCOL_VERSION,
              }])); return;
            }
            const ack = /^43(\d+)(\[.*\])$/s.exec(packet);
            const expectedId = phase === 'document_join' ? '0' : phase === 'snapshot_load' ? '1' : null;
            if (!ack || ack[1] !== expectedId) fail('UNEXPECTED_PROTOCOL_PACKET');
            const values = JSON.parse(ack[2]);
            if (!Array.isArray(values) || values.length !== 1 || !values[0] || typeof values[0] !== 'object') fail('INVALID_ACK');
            const body = values[0];
            if ('error' in body) fail(SERVER_CODES.has(body.error?.name) ? body.error.name : 'SERVER_REJECTED');
            if (phase === 'document_join') {
              if (body.data?.success !== true) fail('JOIN_REJECTED_OR_PROTOCOL_UNSUPPORTED');
              progress.document_joined = true; phase = 'snapshot_load';
              send('421' + JSON.stringify(['space:load-doc', {
                spaceType: 'workspace', spaceId: WORKSPACE_ID, docId: args.doc_id,
              }])); return;
            }
            if (!body.data || typeof body.data !== 'object') fail('INVALID_SNAPSHOT');
            progress.snapshot_received = true; settled = true; resolve(body.data);
          } catch (error) { abort(error instanceof SyncError ? error.code : 'INVALID_PROTOCOL_RESPONSE'); }
        };
        ws.addEventListener('message', listener);
        ws.addEventListener('close', onClose);
        ws.addEventListener('error', onError);
        if (controller.signal.aborted) { abort('TIMEOUT'); return; }
        ws.accept();
      });
      phase = 'snapshot_validation';
      if (!stillAuthorized()) fail('ACCESS_DENIED');
      const summary = snapshotSummary(snapshot);
      return result({ ...output, sync_read_verified: true, snapshot: summary,
        next_step: permissions.doc_update === true ? 'implement_targeted_edit_adapter_then_test_authorized_write' : 'obtain_document_update_permission',
        interpretation: 'Authenticated sync read succeeded. This does not prove write delivery or persistence. No update, delete, lifecycle or awareness operation was sent.' });
    } catch (error) {
      return result({ ...output, sync_read_verified: false,
        failure: { stage: phase, code: controller.signal.aborted ? 'TIMEOUT' :
          error instanceof SyncError ? error.code : 'SYNC_CHECK_FAILED' },
        interpretation: 'Sync read is unverified. No content-changing operation was attempted.' });
    } finally {
      clearTimeout(timer); controller.abort();
      if (ws) {
        if (listener) ws.removeEventListener('message', listener);
        if (onClose) ws.removeEventListener('close', onClose);
        if (onError) ws.removeEventListener('error', onError);
        try { ws.close(1000, 'Diagnostics complete'); } catch { /* no raw upstream error */ }
      }
    }
  };
}
