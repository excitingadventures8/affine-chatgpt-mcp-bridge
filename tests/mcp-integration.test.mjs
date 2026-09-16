import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { writeFile, unlink } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Doc, Map as YMap, encodeStateAsUpdate } from '../src/affine-media/vendor/yjs.mjs';
import { FakeSocket } from './helpers/sync-fixture.mjs';

// The real SDK handles schemas, tool registration and transport. Cloudflare-only
// lifecycle/auth entrypoints are stand-ins; this does NOT test deployed OAuth.
const builtPath = new URL(`./.mcp-validation-${process.pid}.mjs`, import.meta.url);
const result = await build({
  entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
  bundle: true, write: false, format: 'esm', platform: 'node', packages: 'external',
  plugins: [{ name: 'cloudflare-lifecycle-test-only', setup(b) {
    b.onResolve({ filter: /vendor\/yjs\.mjs$/ }, () => ({
      path: new URL('../src/affine-media/vendor/yjs.mjs', import.meta.url).pathname, external: true,
    }));
    b.onResolve({ filter: /^(agents\/mcp|@cloudflare\/workers-oauth-provider|\.\/github-handler)$/ },
      args => ({ path: args.path, namespace: 'test-only' }));
    b.onLoad({ filter: /.*/, namespace: 'test-only' }, args => ({ loader: 'js', contents:
      args.path === 'agents/mcp' ? 'export class McpAgent { static serve() { return {}; } }' :
      args.path === './github-handler' ? 'export const GitHubHandler = {};' :
      'export default class OAuthProvider { constructor(config) { this.config = config; } }' }));
  } }],
});
await writeFile(builtPath, result.outputFiles[0].contents);
after(() => unlink(builtPath));
const { MyMCP } = await import(builtPath.href);
const docId = 'example-document';
const owner = 'your-github-login';
const cookie = 'session=synthetic-bridge-owner';
const mcpUrl = 'https://mcp.affine.invalid/mcp';
const text = value => ({ content: [{ type: 'text', text: value }] });

async function connect(login = owner, allowed = owner) {
  const agent = new MyMCP();
  agent.props = login ? { login } : undefined;
  agent.env = { AFFINE_MCP_URL: mcpUrl, AFFINE_AUTH_HEADER: 'synthetic-mcp-key', AFFINE_SESSION_COOKIE: cookie,
    ALLOWED_GITHUB_USERS: allowed };
  await agent.init();
  const client = new Client({ name: 'media-integration-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await agent.server.connect(a); await client.connect(b);
  return { agent, client, close: async () => { await client.close(); await agent.server.close(); } };
}

test('SSE JSON-RPC response is consumed without waiting for a persistent stream to close', async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = 0;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.method === 'notifications/initialized') return new Response(null, {status:202});
    const result = request.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } }
      : text('sse-document');
    return new Response(new ReadableStream({
      start(controller) {
        const event = 'event: message\r\ndata: ' + JSON.stringify({jsonrpc:'2.0',id:request.id,result}) + '\r\n\r\n';
        const split = Math.floor(event.length/2);
        controller.enqueue(new TextEncoder().encode(event.slice(0,split)));
        controller.enqueue(new TextEncoder().encode(event.slice(split)));
        // Intentionally never close: the reader must stop on the matching ID.
      }, cancel() { cancelled++; }
    }), {headers:{'Content-Type':'text/event-stream','Mcp-Session-Id':'session'}});
  };
  const c = await connect();
  try {
    const result = await c.client.callTool({name:'read_document',arguments:{docId}});
    assert.equal(result.content[0].text,'sse-document');
    assert.equal(cancelled,2);
  } finally { await c.close(); globalThis.fetch=originalFetch; }
});

test('real MCP SDK lists eight read-only tools, retains text reads, and delivers a verified image', async () => {
  const originalFetch = globalThis.fetch, calls = [];
  const doc = new Doc(), image = new YMap();
  doc.getMap('blocks').set('image-one', image);
  image.set('sys:flavour', 'affine:image'); image.set('prop:sourceId', 'synthetic-image-key');
  const snapshot = encodeStateAsUpdate(doc); doc.destroy();
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5VQAAAAASUVORK5CYII='), c => c.charCodeAt(0));
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === mcpUrl) {
      const body = JSON.parse(options.body);
      assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer synthetic-mcp-key');
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (body.method === 'tools/call') {
        const previous = JSON.parse(calls.at(-2).options.body);
        assert.equal(previous.method, 'notifications/initialized');
        assert.equal(new Headers(options.headers).get('Mcp-Session-Id'), 'synthetic-session');
      }
      return Response.json({ jsonrpc: '2.0', id: body.id, result: body.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } }
        : text(body.params.name === 'doc_search' ? 'search-result' : 'document-text') },
        { headers: { 'Mcp-Session-Id': 'synthetic-session' } });
    }
    if (url.includes('/docs/')) {
      assert.equal(options.headers.get('Cookie'), cookie);
      return new Response(snapshot, { headers: { 'Content-Type': 'application/octet-stream' } });
    }
    if (url.includes('/blobs/')) return Response.json({ url: 'https://usercontent.affine.pro/fixture.png?signature=synthetic' });
    assert.equal(new URL(url).origin, 'https://usercontent.affine.pro');
    assert.equal(options.headers.get('Cookie'), null);
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  };
  const c = await connect();
  try {
    const { tools } = await c.client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), ['affine_list_images', 'affine_list_sections', 'affine_read_image', 'affine_read_structure', 'affine_sync_diagnostics', 'affine_write_diagnostics', 'doc_search', 'read_document']);
    assert.equal(tools.find(t => t.name === 'affine_read_image').annotations.readOnlyHint, true);
    assert.equal((await c.client.callTool({ name: 'read_document', arguments: { docId } })).content[0].text, 'document-text');
    assert.equal((await c.client.callTool({ name: 'doc_search', arguments: { query: 'test' } })).content[0].text, 'search-result');
    const otherDoc = 'example-colors';
    const sections = await c.client.callTool({ name: 'affine_list_sections', arguments: { doc_id: otherDoc, query: 'Цвет' } });
    assert.equal(sections.isError, undefined);
    assert.deepEqual(sections.structuredContent.sections, []);
    assert.ok(calls.some(c => c.url.includes('/docs/' + otherDoc)));
    assert.ok(calls.some(c => c.url === mcpUrl && JSON.parse(c.options.body).params?.arguments?.docId === otherDoc));
    const listed = await c.client.callTool({ name: 'affine_list_images', arguments: { doc_id: docId } });
    assert.equal(listed.structuredContent.images[0].block_id, 'image-one');
    assert.equal(listed.structuredContent.bridge_version, '1.3.5');
    const viewed = await c.client.callTool({ name: 'affine_read_image', arguments: { doc_id: docId, block_id: 'image-one' } });
    assert.equal(viewed.isError, undefined);
    assert.equal(viewed.structuredContent.bridge_version, '1.3.5');
    assert.deepEqual(Buffer.from(viewed.content[1].data, 'base64'), Buffer.from(png));
    const count = calls.length;
    assert.equal((await c.client.callTool({ name: 'affine_read_image', arguments: { doc_id: '../outside-workspace', block_id: 'image-one' } })).isError, true);
    assert.equal(calls.length, count);
  } finally { await c.close(); globalThis.fetch = originalFetch; }
});

test('real MCP tool call stops before REST after native authorization failure', async () => {
  const originalFetch = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(url); assert.equal(url, mcpUrl);
    return new Response('synthetic-private-upstream-error', { status: 403 });
  };
  const c = await connect();
  try {
    const result = await c.client.callTool({ name: 'affine_list_images', arguments: { doc_id: docId } });
    assert.equal(result.structuredContent.error, 'ACCESS_DENIED');
    assert.ok(!JSON.stringify(result).includes('synthetic-private'));
    assert.equal(calls.length, 1);
    c.agent.props.login = 'different-user';
    assert.equal((await c.client.callTool({ name: 'affine_list_images', arguments: { doc_id: docId } })).isError, true);
    assert.equal(calls.length, 1);
  } finally { await c.close(); globalThis.fetch = originalFetch; }
});

test('missing or foreign verified identity sees no private tools', async () => {
  for (const login of [undefined, 'other-user']) {
    const c = await connect(login === undefined ? '' : login);
    try { assert.deepEqual((await c.client.listTools()).tools.map(t => t.name), ['access_denied']); }
    finally { await c.close(); }
  }
});

test('clean allowlist policy is retained: extra allowed users see text tools only, empty policy denies owner', async () => {
  const other = await connect('other-user', owner + ', OTHER-USER');
  try {
    assert.deepEqual((await other.client.listTools()).tools.map(t => t.name).sort(), ['doc_search', 'read_document']);
  } finally { await other.close(); }
  const missing = await connect(owner, '');
  try { assert.deepEqual((await missing.client.listTools()).tools.map(t => t.name), ['access_denied']); }
  finally { await missing.close(); }
});

test('allowlist revocation blocks existing text and media sessions before any network request', async () => {
  const originalFetch = globalThis.fetch, c = await connect(); let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected network'); };
  try {
    c.agent.env.ALLOWED_GITHUB_USERS = 'different-user';
    const media = await c.client.callTool({ name: 'affine_list_images', arguments: { doc_id: docId } });
    assert.equal(media.structuredContent.error, 'AUTHORIZATION_REQUIRED');
    const doc = await c.client.callTool({ name: 'read_document', arguments: { docId } });
    assert.equal(doc.isError, true);
    const diagnostics = await c.client.callTool({ name: 'affine_write_diagnostics', arguments: { doc_id: docId } });
    assert.equal(diagnostics.isError, true);
    assert.equal(calls, 0);
  } finally { await c.close(); globalThis.fetch = originalFetch; }
});

test('diagnostics use paginated native discovery, preserve its session, and never invoke advertised writes', async () => {
  const originalFetch = globalThis.fetch, nativeCalls = [];
  globalThis.fetch = async (url, options) => {
    const req = JSON.parse(options.body);
    if (url !== mcpUrl) {
      assert.equal(url, 'https://app.affine.pro/graphql');
      assert.match(req.query, /^query /);
      return Response.json({ data: req.query.includes('Doc_Update')
        ? { workspace: { doc: { permissions: { Doc_Read: true, Doc_Update: true } } } }
        : { mcpCredentialReadWriteAvailable: false } });
    }
    nativeCalls.push(req);
    if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result;
    if (req.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: {} };
    else if (req.method === 'tools/call') {
      assert.equal(req.params.name, 'read_document');
      result = text('authorized');
    } else {
      assert.equal(req.method, 'tools/list');
      assert.equal(new Headers(options.headers).get('Mcp-Session-Id'), 'diagnostic-session');
      result = req.params.cursor === undefined
        ? { tools: [{ name: 'read_document' }], nextCursor: 'page2' }
        : { tools: [{ name: 'update_document' }, { name: 'doc_search' }] };
    }
    return Response.json({ jsonrpc: '2.0', id: req.id, result }, { headers: { 'Mcp-Session-Id': 'diagnostic-session' } });
  };
  const c = await connect();
  try {
    const tool = (await c.client.listTools()).tools.find(t => t.name === 'affine_write_diagnostics');
    assert.equal(tool.annotations.readOnlyHint, true);
    const result = await c.client.callTool({ name: tool.name, arguments: { doc_id: docId } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.native_mcp.update_document_advertised, true);
    assert.equal(result.structuredContent.ready_for_write, false);
    assert.equal(nativeCalls.filter(c => c.method === 'tools/list').length, 2);
    assert.equal(nativeCalls.filter(c => c.method === 'tools/call').length, 1);
  } finally { await c.close(); globalThis.fetch = originalFetch; }
});

test('diagnostics stop repeated cursors and report incomplete discovery as unverified', async () => {
  const originalFetch = globalThis.fetch; let pages = 0;
  globalThis.fetch = async (url, options) => {
    const req = JSON.parse(options.body);
    if (url !== mcpUrl) return Response.json({ errors: [{ message: 'synthetic-private-error' }] });
    if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (req.method === 'tools/list') pages++;
    const result = req.method === 'initialize' ? { capabilities: {} } :
      req.method === 'tools/call' ? text('authorized') : { tools: [], nextCursor: 'repeated' };
    return Response.json({ jsonrpc: '2.0', id: req.id, result });
  };
  const c = await connect();
  try {
    const result = await c.client.callTool({ name: 'affine_write_diagnostics', arguments: { doc_id: docId } });
    assert.equal(pages, 2);
    assert.equal(result.structuredContent.native_mcp.status, 'unverified');
    assert.ok(!JSON.stringify(result).includes('synthetic-private'));
  } finally { await c.close(); globalThis.fetch = originalFetch; }
});

test('real MCP sync tool checks authorization and returns read-only protocol results', async () => {
  const originalFetch = globalThis.fetch, socket = new FakeSocket();
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(url);
    if (url === 'https://app.affine.pro/socket.io/?EIO=4&transport=websocket') {
      assert.equal(options.headers.Cookie, cookie);
      return { status: 101, webSocket: socket };
    }
    const req = JSON.parse(options.body);
    if (url === 'https://app.affine.pro/graphql') return Response.json({ data: req.query.includes('Doc_Update')
      ? { workspace: { doc: { permissions: { Doc_Read: true, Doc_Update: true } } } }
      : { mcpCredentialReadWriteAvailable: false } });
    assert.equal(url, mcpUrl);
    if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result;
    if (req.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: {} };
    else if (req.method === 'tools/list') result = { tools: [{ name: 'read_document' }, { name: 'doc_search' }] };
    else { assert.equal(req.params.name, 'read_document'); result = text('authorized'); }
    return Response.json({ jsonrpc: '2.0', id: req.id, result });
  };
  const c = await connect();
  try {
    const tools = (await c.client.listTools()).tools, tool = tools.find(t => t.name === 'affine_sync_diagnostics');
    assert.equal(tool.annotations.readOnlyHint, true);
    const result = await c.client.callTool({ name: tool.name, arguments: { doc_id: docId } });
    assert.equal(result.structuredContent.sync_read_verified, true);
    assert.equal(result.structuredContent.snapshot.database_blocks, 1);
    assert.equal(result.structuredContent.document_modified, false);
    assert.equal(result.structuredContent.native_write_service.availability_scope, 'server_feature');
    assert.equal(socket.closed, true);
    const n = calls.length; c.agent.env.ALLOWED_GITHUB_USERS = 'revoked';
    assert.equal((await c.client.callTool({ name: tool.name, arguments: { doc_id: docId } })).isError, true);
    assert.equal(calls.length, n);
  } finally { await c.close(); globalThis.fetch = originalFetch; }
});
