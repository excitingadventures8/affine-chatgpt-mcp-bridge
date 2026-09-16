import test from 'node:test';
import assert from 'node:assert/strict';
import { createWriteDiagnostics, summarizeNativeTools } from '../src/affine-media/write-diagnostics.mjs';
import { WORKSPACE_ID } from '../src/affine-media/media.mjs';

const docId = 'example-projects';
const cookie = 'session=synthetic-secret';
const read = { content: [{ type: 'text', text: 'private document text' }] };
function fixture(overrides = {}) {
  const calls = [];
  const options = {
    getLogin: () => 'your-github-login', getCookie: () => cookie,
    readDocument: async id => { calls.push(['read', id]); return read; },
    listUpstreamTools: async () => { calls.push(['list']); return [{ name: 'doc_search' }, { name: 'read_document' }]; },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(['http', url, init, body]);
      assert.equal(url, 'https://app.affine.pro/graphql');
      assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual');
      assert.equal(init.headers.Cookie, cookie);
      assert.match(body.query, /^query /); assert.ok(!body.query.includes('mutation'));
      return Response.json({ data: body.query.includes('Doc_Update')
        ? { workspace: { doc: { permissions: { Doc_Read: true, Doc_Update: true } } } }
        : { mcpCredentialReadWriteAvailable: false } });
    }, ...overrides,
  };
  return { call: createWriteDiagnostics(options), calls };
}

test('checks only fixed queries and exposes permission without claiming MCP write support', async () => {
  const f = fixture(), r = await f.call({ doc_id: docId }), data = r.structuredContent;
  assert.equal(data.bridge_version, '1.3.5');
  assert.equal(data.document_permissions.doc_update, true);
  assert.equal(data.document_permissions.grants_native_mcp_write, false);
  assert.equal(data.native_mcp.update_document_advertised, false);
  assert.equal(data.native_write_service.read_write_credential_available, false);
  assert.equal(data.ready_for_write, false); assert.equal(data.document_modified, false);
  assert.equal(data.sync_transport_tested, false);
  assert.equal(f.calls[0][0], 'read'); assert.equal(f.calls.filter(c => c[0] === 'http').length, 2);
  assert.deepEqual(f.calls.find(c => c[0] === 'http' && c[3].query.includes('Doc_Update'))[3].variables,
    { workspaceId: WORKSPACE_ID, docId });
  assert.ok(!JSON.stringify(r).includes('synthetic-secret'));
  assert.ok(!JSON.stringify(r).includes('private document text'));
});

test('foreign identity and invalid destinations make no requests', async () => {
  const f = fixture({ getLogin: () => 'other-user' });
  assert.equal((await f.call({ doc_id: docId })).structuredContent.error, 'ACCESS_DENIED');
  assert.equal(f.calls.length, 0);
  const valid = fixture();
  for (const args of [{ doc_id: '../escape' }, { doc_id: WORKSPACE_ID }, { doc_id: docId, cookie: 'injected' }]) {
    assert.equal((await valid.call(args)).structuredContent.error, 'INVALID_ARGUMENTS');
  }
  assert.equal(valid.calls.length, 0);
});

test('native denial or network error blocks all cookie and discovery operations', async () => {
  for (const readDocument of [async () => ({ isError: true, content: [] }), async () => { throw new Error(cookie); }]) {
    const f = fixture({ readDocument });
    assert.equal((await f.call({ doc_id: docId })).isError, true);
    assert.equal(f.calls.length, 0);
  }
});

test('revocation during the native read prevents use of the web session', async () => {
  let login = 'your-github-login';
  const f = fixture({ getLogin: () => login, readDocument: async () => { login = 'revoked'; return read; } });
  assert.equal((await f.call({ doc_id: docId })).structuredContent.error, 'ACCESS_DENIED');
  assert.equal(f.calls.length, 0);
});

test('missing or invalid cookies leave native discovery usable and never perform HTTP queries', async () => {
  for (const value of [undefined, '', 'bad\nheader=value', 'aff_mcp_v1.token=value']) {
    const f = fixture({ getCookie: () => value }), r = (await f.call({ doc_id: docId })).structuredContent;
    assert.equal(r.native_mcp.status, 'checked');
    assert.equal(r.document_permissions.code, 'SESSION_REQUIRED');
    assert.equal(r.native_write_service.code, 'SESSION_REQUIRED');
    assert.equal(f.calls.filter(c => c[0] === 'http').length, 0);
  }
});

test('partial failures retain successful checks and redact upstream text', async () => {
  const f = fixture({ listUpstreamTools: async () => { throw new Error(cookie); },
    fetchImpl: async (_url, init) => JSON.parse(init.body).query.includes('Doc_Update')
      ? Response.json({ data: { workspace: { doc: { permissions: { Doc_Read: true, Doc_Update: false } } } } })
      : Response.json({ errors: [{ message: cookie }] }),
  });
  const result = await f.call({ doc_id: docId }), r = result.structuredContent;
  assert.equal(r.native_mcp.status, 'unverified');
  assert.equal(r.document_permissions.doc_update, false);
  assert.equal(r.native_write_service.code, 'GRAPHQL_UNAVAILABLE_OR_DENIED');
  assert.ok(!JSON.stringify(result).includes(cookie));
});

test('redirects, auth failures, malformed, oversized and ambiguous results are never treated as permission', async () => {
  for (const [response, code] of [
    [() => new Response(null, { status: 302, headers: { Location: 'https://foreign.invalid' } }), 'REDIRECT_REJECTED'],
    [() => new Response(cookie, { status: 401 }), 'SESSION_OR_PERMISSION_DENIED'],
    [() => new Response(cookie), 'INVALID_RESPONSE'],
    [() => new Response('x'.repeat(128 * 1024 + 1)), 'RESPONSE_TOO_LARGE'],
    [() => Response.json({ data: { workspace: { doc: { permissions: { Doc_Read: true, Doc_Update: 'true' } } } } }), 'PERMISSIONS_NOT_RETURNED'],
  ]) {
    const f = fixture({ fetchImpl: async () => response() });
    const r = (await f.call({ doc_id: docId })).structuredContent;
    assert.equal(r.document_permissions.code, code);
    assert.equal(r.ready_for_write, false);
    assert.ok(!JSON.stringify(r).includes(cookie));
  }
});

test('timeouts stop a stalled request without exposing errors', async () => {
  const f = fixture({ timeoutMs: 10, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error(cookie)), { once: true });
  }) });
  const r = (await f.call({ doc_id: docId })).structuredContent;
  assert.equal(r.document_permissions.code, 'TIMEOUT');
  assert.equal(r.native_write_service.code, 'TIMEOUT');
});

test('advertised native write operations do not assert successful persistence or table support', () => {
  const r = summarizeNativeTools([{ name: 'update_document' }, { name: 'create_document' }]);
  assert.equal(r.update_document_advertised, true);
  assert.equal(r.database_write_support, 'not_verified');
  assert.equal(r.write_execution_tested, false);
  assert.throws(() => summarizeNativeTools([{ name: 'secret with spaces' }]));
});
