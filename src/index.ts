import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GitHubHandler, type AuthProps } from "./github-handler";
import { createBridgeMedia, isOwner } from "./affine-media/bridge.mjs";
import { BRIDGE_VERSION } from "./affine-media/media.mjs";
import { createWriteDiagnostics } from "./affine-media/write-diagnostics.mjs";
import { createSyncDiagnostics } from "./affine-media/sync-diagnostics.mjs";

interface Env {
  AFFINE_MCP_URL: string;
  AFFINE_AUTH_HEADER: string;
  // Existing Worker Secret. Never accepted as a tool argument.
  AFFINE_SESSION_COOKIE?: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_GITHUB_USERS: string;
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
}

export class MyMCP extends McpAgent<Env, Record<string, never>, AuthProps> {
  server = new McpServer({
    name: "AFFiNE ChatGPT Read-Only Bridge",
    version: BRIDGE_VERSION,
  });

  private allowedLogin(): string | undefined {
    const login = this.props?.login;
    if (typeof login !== "string" || !login) return undefined;
    const allowed = (this.env.ALLOWED_GITHUB_USERS ?? "")
      .split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
    return allowed.includes(login.toLowerCase()) ? login : undefined;
  }

  private headers(extra: Record<string, string> = {}): HeadersInit {
    const raw = this.env.AFFINE_AUTH_HEADER.trim();
    const authorization = raw.startsWith("Bearer ") ? raw : `Bearer ${raw}`;
    return {
      Authorization: authorization,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...extra,
    };
  }

  private async rpc(body: unknown, extraHeaders: Record<string, string> = {}, signal?: AbortSignal) {
    let response: Response;
    try {
      response = await fetch(this.env.AFFINE_MCP_URL, {
        method: "POST", signal, headers: this.headers(extraHeaders), body: JSON.stringify(body),
      });
    } catch (error: any) {
      if (signal?.aborted) throw new DOMException("AFFiNE request timed out", "TimeoutError");
      throw Object.assign(new Error("AFFiNE network request failed"), { upstreamCode: "NETWORK_ERROR" });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error("AFFiNE upstream HTTP error"), { upstreamStatus: response.status });
    }
    const requestId = (body as any)?.id;
    const stream = response.headers.get("Content-Type")?.includes("text/event-stream");
    const reader = response.body?.getReader();
    if (!reader) return { response, json: null };
    const decoder = new TextDecoder();
    let buffer = "", size = 0;
    const accept = (value: any) => {
      if (value?.error) throw Object.assign(new Error("AFFiNE MCP RPC error"), { upstreamCode: "MCP_RPC_ERROR" });
      return { response, json: value };
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        size += value?.byteLength ?? 0;
        if (size > 4 * 1024 * 1024) throw new Error("AFFiNE MCP response exceeds limit");
        buffer += decoder.decode(value, { stream: !done });
        if (stream) {
          // SSE may remain open after the matching JSON-RPC response arrives.
          // Stop on that response; waiting for EOF causes false timeouts.
          while (true) {
            const separator = /\r?\n\r?\n/.exec(buffer);
            if (!separator) break;
            const event = buffer.slice(0, separator.index);
            buffer = buffer.slice(separator.index + separator[0].length);
            const data = event.split(/\r?\n/).filter(line => line.startsWith("data:"))
              .map(line => line.slice(5).replace(/^ /, "")).join("\n");
            if (!data.trim()) continue;
            const parsed = JSON.parse(data);
            if (requestId !== undefined && parsed.id === requestId) return accept(parsed);
          }
        }
        if (done) break;
      }
      if (stream) {
        if (requestId === undefined) return { response, json: null };
        throw new Error("AFFiNE SSE ended without matching response");
      }
      return buffer.trim() ? accept(JSON.parse(buffer)) : { response, json: null };
    } catch (error) {
      if (signal?.aborted) throw new DOMException("AFFiNE request timed out", "TimeoutError");
      throw error;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  private async callAffineTool(name: "doc_search" | "read_document", args: Record<string, unknown>, signal?: AbortSignal) {
    if (!this.allowedLogin()) throw new Error("Access denied.");
    signal ??= AbortSignal.timeout(20_000);
    const init = await this.rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "affine-chatgpt-mcp-bridge",
          version: BRIDGE_VERSION,
        },
      },
    }, {}, signal);

    const sessionId = init.response.headers.get("Mcp-Session-Id");
    const sessionHeaders: Record<string, string> = sessionId
      ? { "Mcp-Session-Id": sessionId }
      : {};

    // AFFiNE accepts this notification in both stateless and session-based modes.
    await this.rpc(
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
      sessionHeaders,
      signal,
    );

    const result = await this.rpc(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name,
          arguments: args,
        },
      },
      sessionHeaders,
      signal,
    );

    return result.json?.result;
  }

  // Capability discovery is read-only. It never forwards tools/call to a
  // discovered name and therefore cannot turn discovery into a write proxy.
  private async listAffineTools(): Promise<Array<{ name: string }>> {
    if (!isOwner(this.allowedLogin())) throw new Error("Access denied.");
    const signal = AbortSignal.timeout(20_000);
    const init = await this.rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-06-18", capabilities: {},
      clientInfo: { name: "affine-chatgpt-mcp-bridge-diagnostics", version: BRIDGE_VERSION },
    } }, {}, signal);
    const sessionId = init.response.headers.get("Mcp-Session-Id");
    const headers: Record<string, string> = sessionId ? { "Mcp-Session-Id": sessionId } : {};
    await this.rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, headers, signal);
    const tools: Array<{ name: string }> = [], seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      if (!isOwner(this.allowedLogin())) throw new Error("Access denied.");
      const response = await this.rpc({ jsonrpc: "2.0", id: page + 2, method: "tools/list",
        params: cursor ? { cursor } : {} }, headers, signal);
      const data = response.json?.result;
      if (!Array.isArray(data?.tools) || data.tools.length + tools.length > 100) throw new Error("Invalid tool list.");
      tools.push(...data.tools.map((tool: any) => ({ name: tool?.name })));
      if (data.nextCursor === undefined) return tools;
      if (typeof data.nextCursor !== "string" || !data.nextCursor || data.nextCursor.length > 2048 || seen.has(data.nextCursor)) {
        throw new Error("Invalid pagination.");
      }
      seen.add(data.nextCursor); cursor = data.nextCursor;
    }
    throw new Error("Tool list is incomplete.");
  }

  private normalize(result: any) {
    if (result && Array.isArray(result.content)) return result;
    return {
      content: [
        {
          type: "text" as const,
          text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  async init() {
    const login = this.allowedLogin();
    if (!login) {
      this.server.tool("access_denied", "Current GitHub identity is not allowed on this server.", {},
        async () => ({ content: [{ type: "text" as const, text: "Access denied." }], isError: true }));
      return;
    }

    // Preserve the clean bridge's configurable text-access policy. The single
    // private AFFiNE image session remains limited to its original owner.
    if (isOwner(login)) {
      const media = createBridgeMedia({
        getLogin: () => this.allowedLogin(),
        getCookie: () => this.env.AFFINE_SESSION_COOKIE,
        callAffineTool: (name, args) => {
          if (name !== "read_document") throw new Error("Unsupported authorization check.");
          return this.callAffineTool(name, args, AbortSignal.timeout(20_000));
        },
      });
      const documentId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
        .describe("Document ID in the connected AFFiNE workspace, from doc_search/read_document.");
      const diagnoseWrites = createWriteDiagnostics({
        getLogin: () => this.allowedLogin(),
        getCookie: () => this.env.AFFINE_SESSION_COOKIE,
        readDocument: docId => this.callAffineTool("read_document", { docId }),
        listUpstreamTools: () => this.listAffineTools(),
      });
      this.server.tool("affine_write_diagnostics",
        "Read-only capability check for one authorized document: list upstream MCP tools, query native read-write availability and web-session Doc.Read/Doc.Update permissions. Does not create, modify, or delete content, change credentials, or test persistence. A web-session permission does not grant native MCP write access. Report unverified checks explicitly.",
        { doc_id: documentId },
        { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        async args => diagnoseWrites(args));
      const diagnoseSync = createSyncDiagnostics({
        getLogin: () => this.allowedLogin(),
        getCookie: () => this.env.AFFINE_SESSION_COOKIE,
        diagnoseWrites,
      });
      this.server.tool("affine_sync_diagnostics",
        "Read-only sync transport check for one authorized AFFiNE document. Rechecks native read and web-session permissions, opens the fixed AFFiNE WebSocket, joins only the selected document and reads a bounded Yjs snapshot. Reports handshake stages and database/text block counts without returning contents. Never sends document updates, deletions or awareness. Successful reading does not prove write delivery or persistence; ready_for_write remains false.",
        { doc_id: documentId },
        { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        async args => diagnoseSync(args));
      const listSections = media.tools.find(tool => tool.name === "affine_list_sections")!;
      const listImages = media.tools.find(tool => tool.name === "affine_list_images")!;
      const readImage = media.tools.find(tool => tool.name === "affine_read_image")!;
      const structure = media.tools.find(tool => tool.name === "affine_read_structure")!;
      this.server.tool(structure.name, structure.description!, {
        doc_id: documentId,
        kind: z.enum(["nodes", "groups", "connections", "references", "tables", "table_rows", "tags"]),
        table_id: z.string().min(1).max(512).optional(),
        offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional(),
      }, structure.annotations!, async args => media.callTool(structure.name, args));
      this.server.tool(listSections.name, listSections.description!, {
        doc_id: documentId, query: z.string().max(200).optional(),
        offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional(),
      }, listSections.annotations!, async args => media.callTool(listSections.name, args));
      this.server.tool(listImages.name, listImages.description!, {
        doc_id: documentId, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(40).optional(),
        section_id: z.string().min(1).max(520).optional(), include_candidates: z.boolean().optional(),
      }, listImages.annotations!, async args => media.callTool(listImages.name, args));
      this.server.tool(readImage.name, readImage.description!, {
        doc_id: documentId, block_id: z.string().min(1).max(512),
      }, readImage.annotations!, async args => media.callTool(readImage.name, args));
    }

    this.server.tool(
      "doc_search",
      "Search persisted documents in the connected AFFiNE workspace.",
      {
        query: z.string().describe("Search query."),
        doc_ids: z
          .array(z.string())
          .max(50)
          .optional()
          .describe("Optional document IDs to limit the search."),
        limit: z.number().int().min(1).max(20).optional().describe("Maximum number of results."),
      },
      async ({ query, doc_ids, limit }) => {
        const args: Record<string, unknown> = { query };
        if (doc_ids?.length) args.doc_ids = doc_ids;
        if (typeof limit === "number") args.limit = limit;
        return this.normalize(await this.callAffineTool("doc_search", args));
      },
    );

    this.server.tool(
      "read_document",
      "Read an AFFiNE document by document ID.",
      {
        docId: z.string().describe("AFFiNE document ID returned by search."),
      },
      async ({ docId }) => {
        return this.normalize(await this.callAffineTool("read_document", { docId }));
      },
    );
  }
}

export default new OAuthProvider({
  apiHandler: MyMCP.serve("/mcp"),
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: GitHubHandler as any,
  tokenEndpoint: "/token",
});
