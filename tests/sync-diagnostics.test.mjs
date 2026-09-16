import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncDiagnostics } from '../src/affine-media/sync-diagnostics.mjs';
import { WORKSPACE_ID } from '../src/affine-media/media.mjs';
import { FakeSocket, snapshot } from './helpers/sync-fixture.mjs';

const docId = 'example-projects', cookie = 'session=synthetic-secret';
function fixture(options = {}, socketOptions = {}) {
  let fetches = 0, checked = 0;
  const socket = new FakeSocket(socketOptions);
  const check = { structuredContent: { doc_id: docId, workspace_id: WORKSPACE_ID,
    document_permissions: { status: 'checked', doc_read: true, doc_update: true, grants_native_mcp_write: false },
    native_write_service: { read_write_credential_available: false, availability_scope: 'server_feature' } } };
  const call = createSyncDiagnostics({ getLogin: () => 'your-github-login', getCookie: () => cookie,
    diagnoseWrites: async args => { checked++; assert.deepEqual(args, { doc_id: docId }); return check; },
    fetchImpl: async (url, init) => {
      fetches++; assert.equal(checked, 1);
      assert.equal(url, 'https://app.affine.pro/socket.io/?EIO=4&transport=websocket');
      assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
      assert.equal(init.headers.Cookie, cookie); assert.equal(init.headers.Upgrade, 'websocket');
      return { status: 101, webSocket: socket };
    }, ...options });
  return { call: args => call(args ?? { doc_id: docId }), socket, check, fetches: () => fetches, checked: () => checked };
}

test('authenticates, reads the selected Yjs document and closes; never sends updates or returns contents', async () => {
  const f = fixture(), result = await f.call(), r = result.structuredContent;
  assert.equal(r.bridge_version, '1.3.5'); assert.equal(r.sync_read_verified, true);
  assert.ok(Object.values(r.progress).every(Boolean));
  assert.equal(r.snapshot.database_blocks, 1); assert.equal(r.snapshot.text_blocks, 1);
  assert.equal(r.snapshot.state_vector_checked, false);
  for (const name of ['document_modified', 'write_execution_tested', 'persistence_verified', 'ready_for_write']) assert.equal(r[name], false);
  assert.equal(f.socket.closed, true);
  assert.deepEqual(f.socket.sent.filter(p => !p.startsWith('42')), ['40{}', '3']);
  const emitted = f.socket.sent.filter(p => p.startsWith('42')).map(p => JSON.parse(p.slice(3)));
  assert.deepEqual(emitted.map(e => e[0]), ['space:join-batch', 'space:load-doc']);
  assert.deepEqual(emitted[0][1].spaces, [{ spaceType: 'workspace', spaceId: WORKSPACE_ID, docId }]);
  assert.equal(emitted[1][1].docId, docId);
  for (const secret of [cookie, 'synthetic-private-document', 'ignored-event', 'engine-id']) assert.ok(!JSON.stringify(result).includes(secret));
});

test('foreign identity, root, bad document IDs and injected arguments do not touch the network', async () => {
  const denied = fixture({ getLogin: () => 'foreign' });
  assert.equal((await denied.call()).structuredContent.error, 'ACCESS_DENIED'); assert.equal(denied.checked(), 0);
  const f = fixture();
  for (const args of [{ doc_id: WORKSPACE_ID }, { doc_id: '../doc' }, { doc_id: docId, cookie }, { doc_id: docId, event: 'edit' }]) {
    assert.equal((await f.call(args)).isError, true);
  }
  assert.equal(f.checked(), 0); assert.equal(f.fetches(), 0);
});

test('failed native diagnostics, mismatched document or unreadable web document never opens a socket', async () => {
  for (const mutate of [c => c.isError = true, c => c.structuredContent.doc_id = 'different',
    c => c.structuredContent.workspace_id = 'different', c => c.structuredContent.document_permissions.doc_read = false,
    c => c.structuredContent.document_permissions.status = 'unverified']) {
    const f = fixture(); mutate(f.check);
    assert.equal((await f.call()).structuredContent.error, 'AUTHORIZATION_UNVERIFIED'); assert.equal(f.fetches(), 0);
  }
});

test('web read permission alone permits a read check without asserting edit permission', async () => {
  const f = fixture(); f.check.structuredContent.document_permissions.doc_update = false;
  const r = (await f.call()).structuredContent;
  assert.equal(r.sync_read_verified, true); assert.equal(r.next_step, 'obtain_document_update_permission');
  assert.equal(r.ready_for_write, false);
});

test('invalid session formats do not open sockets', async () => {
  for (const value of ['', undefined, 'bad\nheader=1', 'aff_mcp_v1.token=x']) {
    const f = fixture({ getCookie: () => value });
    assert.equal((await f.call()).structuredContent.error, 'SESSION_REQUIRED'); assert.equal(f.fetches(), 0);
  }
});

test('permission revocation during handshake prevents document reads and closes socket', async () => {
  let login = 'your-github-login';
  const f = fixture({ getLogin: () => login }, { onSend: packet => { if (packet.startsWith('420')) login = 'revoked'; } });
  const r = (await f.call()).structuredContent;
  assert.equal(r.failure.code, 'ACCESS_DENIED'); assert.equal(r.progress.snapshot_received, false);
  assert.equal(f.socket.sent.some(p => p.startsWith('421')), false); assert.equal(f.socket.closed, true);
});

test('rotated session during handshake stops reads', async () => {
  let value = cookie;
  const f = fixture({ getCookie: () => value }, { onSend: () => { value = 'session=rotated'; } });
  assert.equal((await f.call()).structuredContent.failure.code, 'ACCESS_DENIED'); assert.equal(f.socket.closed, true);
});

test('redirects and authorization failures never follow an alternative endpoint or echo the body', async () => {
  for (const [status, code] of [[302, 'REDIRECT_REJECTED'], [401, 'SESSION_OR_PERMISSION_DENIED'], [403, 'SESSION_OR_PERMISSION_DENIED'], [200, 'WEBSOCKET_UPGRADE_REJECTED']]) {
    let calls = 0;
    const f = fixture({ fetchImpl: async () => { calls++; return new Response(cookie, { status }); } });
    const r = (await f.call()).structuredContent;
    assert.equal(r.failure.code, code); assert.equal(calls, 1); assert.ok(!JSON.stringify(r).includes(cookie));
  }
});

test('socket authentication denial is reported without message contents', async () => {
  const f = fixture({}, { stall: true, onAccept: s => s.packet('44' + JSON.stringify({ message: cookie })) });
  const r = (await f.call()).structuredContent;
  assert.equal(r.failure.code, 'SOCKET_AUTH_OR_NAMESPACE_REJECTED'); assert.equal(f.socket.closed, true);
  assert.ok(!JSON.stringify(r).includes(cookie));
});

test('join failures do not fall back to broader subscriptions', async () => {
  for (const [join, code] of [[{ data: { success: false } }, 'JOIN_REJECTED_OR_PROTOCOL_UNSUPPORTED'],
    [{ error: { name: 'DOC_ACTION_DENIED', message: cookie } }, 'DOC_ACTION_DENIED'],
    [{ error: { name: cookie, message: cookie } }, 'SERVER_REJECTED']]) {
    const f = fixture({}, { join }), r = (await f.call()).structuredContent;
    assert.equal(r.failure.code, code); assert.equal(f.socket.sent.some(p => p.startsWith('421')), false);
    assert.equal(f.socket.closed, true); assert.ok(!JSON.stringify(r).includes(cookie));
  }
});

test('load denial and invalid Yjs/state never claim a successful snapshot', async () => {
  const badState = snapshot(); badState.state = '!';
  for (const [load, code] of [[{ error: { name: 'DOC_NOT_FOUND', message: cookie } }, 'DOC_NOT_FOUND'],
    [{ data: { missing: '!', state: '', timestamp: 1 } }, 'INVALID_SNAPSHOT'],
    [{ data: { missing: 'AAAA', state: 'AA==', timestamp: 1 } }, 'INCOMPLETE_SNAPSHOT'],
    [{ data: badState }, 'INVALID_SNAPSHOT']]) {
    const f = fixture({}, { load }), r = (await f.call()).structuredContent;
    assert.equal(r.sync_read_verified, false); assert.equal(r.failure.code, code); assert.equal(f.socket.closed, true);
  }
});

test('bounded handshake timeout terminates stalled sockets', async () => {
  const f = fixture({ timeoutMs: 10 }, { stall: true });
  const r = (await f.call()).structuredContent;
  assert.equal(r.failure.code, 'TIMEOUT'); assert.equal(r.failure.stage, 'engine_handshake'); assert.equal(f.socket.closed, true);
});

test('fetch timeout aborts the network attempt', async () => {
  const f = fixture({ timeoutMs: 10, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error(cookie)), { once: true });
  }) });
  const r = (await f.call()).structuredContent;
  assert.equal(r.failure.code, 'TIMEOUT'); assert.equal(r.failure.stage, 'websocket_upgrade');
});

test('unexpected acknowledgement and binary packets stop the read-only protocol', async () => {
  for (const packet of ['4399[{}]', new Uint8Array([1, 2])]) {
    const f = fixture({}, { stall: true, onAccept: s => s.packet(packet) });
    const r = (await f.call()).structuredContent;
    assert.equal(r.sync_read_verified, false); assert.equal(f.socket.closed, true);
  }
});

test('frame floods are bounded and close the connection', async () => {
  const f = fixture({}, { stall: true, onAccept: s => { for (let i = 0; i < 513; i++) s.packet('6'); } });
  assert.equal((await f.call()).structuredContent.failure.code, 'RESPONSE_TOO_LARGE'); assert.equal(f.socket.closed, true);
});
