import { BRIDGE_VERSION, WORKSPACE_ID, isDocumentId } from './media.mjs';
import { isOwner } from './bridge.mjs';

// These are GraphQL QUERY operations, not mutations. No endpoint or query is
// supplied by the caller. Cookie authorization remains scoped to this origin.
const GRAPHQL = 'https://app.affine.pro/graphql';
const PERMISSIONS_QUERY = `query BridgeWritePermissions($workspaceId: String!, $docId: String!) {
  workspace(id: $workspaceId) { doc(docId: $docId) { permissions { Doc_Read Doc_Update } } }
}`;
const AVAILABILITY_QUERY = 'query BridgeNativeWriteAvailability { mcpCredentialReadWriteAvailable }';
const MAX_RESPONSE = 128 * 1024;

class ProbeError extends Error {
  constructor(code, httpStatus) { super(code); this.code = code; this.httpStatus = httpStatus; }
}
const issue = error => ({ status: 'unverified', code: error instanceof ProbeError ? error.code : 'CHECK_FAILED',
  ...(error instanceof ProbeError && error.httpStatus ? { http_status: error.httpStatus } : {}) });
const result = (data, isError = false) => {
  const tagged = { bridge_version: BRIDGE_VERSION, ...data };
  return { content: [{ type: 'text', text: JSON.stringify(tagged) }], structuredContent: tagged,
    ...(isError ? { isError: true } : {}) };
};
const goodRead = r => r && (r.isError === undefined || r.isError === false) &&
  r.error === undefined && Array.isArray(r.content);

async function readJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new ProbeError('EMPTY_RESPONSE');
  const decoder = new TextDecoder(); let size = 0, text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      size += value?.byteLength ?? 0;
      if (size > MAX_RESPONSE) throw new ProbeError('RESPONSE_TOO_LARGE');
      text += decoder.decode(value, { stream: !done });
      if (done) break;
    }
    try { return JSON.parse(text); } catch { throw new ProbeError('INVALID_RESPONSE'); }
  } finally { await reader.cancel().catch(() => undefined); }
}

export function summarizeNativeTools(list) {
  if (!Array.isArray(list) || list.length > 100 || list.some(t =>
    !t || typeof t.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(t.name))) {
    throw new ProbeError('INVALID_TOOL_LIST');
  }
  const names = [...new Set(list.map(t => t.name))].sort();
  return { status: 'checked', tool_names: names,
    create_document_advertised: names.includes('create_document'),
    update_document_advertised: names.includes('update_document'),
    update_document_meta_advertised: names.includes('update_document_meta'),
    database_write_support: 'not_verified', write_execution_tested: false };
}

export function createWriteDiagnostics({ getLogin, getCookie, readDocument, listUpstreamTools,
  fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  if (![getLogin, getCookie, readDocument, listUpstreamTools, fetchImpl].every(f => typeof f === 'function') ||
      !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60000) {
    throw new TypeError('Trusted authorization callbacks and bounded timeout are required.');
  }

  async function query(cookie, document, variables) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(GRAPHQL, { method: 'POST', redirect: 'manual', credentials: 'omit',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: cookie },
        body: JSON.stringify({ query: document, variables }), signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProbeError(response.status >= 300 && response.status < 400 ? 'REDIRECT_REJECTED' :
          response.status === 401 || response.status === 403 ? 'SESSION_OR_PERMISSION_DENIED' : 'HTTP_ERROR', response.status);
      }
      const body = await readJson(response);
      if (!body || body.errors !== undefined || !body.data || typeof body.data !== 'object') {
        throw new ProbeError('GRAPHQL_UNAVAILABLE_OR_DENIED');
      }
      return body.data;
    } catch (error) {
      if (controller.signal.aborted) throw new ProbeError('TIMEOUT');
      if (error instanceof ProbeError) throw error;
      throw new ProbeError('NETWORK_OR_RESPONSE_ERROR');
    } finally { clearTimeout(timer); }
  }

  return async function diagnose(args) {
    if (!args || Object.keys(args).some(k => k !== 'doc_id') || !isDocumentId(args.doc_id) || args.doc_id === WORKSPACE_ID) {
      return result({ error: 'INVALID_ARGUMENTS' }, true);
    }
    if (!isOwner(getLogin())) return result({ error: 'ACCESS_DENIED' }, true);
    // The broader web session must never override a native-MCP read denial.
    try {
      if (!goodRead(await readDocument(args.doc_id))) return result({ error: 'NATIVE_READ_DENIED' }, true);
    } catch { return result({ error: 'NATIVE_READ_UNVERIFIED' }, true); }
    if (!isOwner(getLogin())) return result({ error: 'ACCESS_DENIED' }, true);

    const cookie = getCookie();
    const usableCookie = typeof cookie === 'string' && cookie.length > 0 && cookie.length <= 32768 &&
      cookie.includes('=') && !/[^\x20-\x7e]/.test(cookie) && !cookie.includes('aff_mcp_v1');
    const checks = await Promise.allSettled([
      Promise.resolve().then(() => listUpstreamTools()).then(summarizeNativeTools),
      usableCookie ? query(cookie, PERMISSIONS_QUERY, { workspaceId: WORKSPACE_ID, docId: args.doc_id }).then(data => {
        const p = data.workspace?.doc?.permissions;
        if (typeof p?.Doc_Read !== 'boolean' || typeof p?.Doc_Update !== 'boolean') throw new ProbeError('PERMISSIONS_NOT_RETURNED');
        return { status: 'checked', doc_read: p.Doc_Read, doc_update: p.Doc_Update,
          credential_basis: 'existing_web_session', grants_native_mcp_write: false };
      }) : Promise.reject(new ProbeError('SESSION_REQUIRED')),
      usableCookie ? query(cookie, AVAILABILITY_QUERY, {}).then(data => {
        if (typeof data.mcpCredentialReadWriteAvailable !== 'boolean') throw new ProbeError('AVAILABILITY_NOT_RETURNED');
        return { status: 'checked', read_write_credential_available: data.mcpCredentialReadWriteAvailable,
          availability_scope: 'server_feature', query_field: 'mcpCredentialReadWriteAvailable',
          current_credential_mode: 'not_inspected' };
      }) : Promise.reject(new ProbeError('SESSION_REQUIRED')),
    ]);
    const value = r => r.status === 'fulfilled' ? r.value : issue(r.reason);
    return result({ doc_id: args.doc_id, workspace_id: WORKSPACE_ID, read_only_diagnostics: true,
      native_mcp: value(checks[0]), document_permissions: value(checks[1]), native_write_service: value(checks[2]),
      bridge_write_tools_enabled: false, ready_for_write: false,
      sync_transport_tested: false, document_modified: false,
      interpretation: 'Advertised tools and web-session permissions are separate checks. Neither proves successful persistence. This release contains no write operation.' });
  };
}
