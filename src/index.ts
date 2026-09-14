import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GitHubHandler, type AuthProps } from "./github-handler";

interface Env {
  AFFINE_MCP_URL: string;
  AFFINE_AUTH_HEADER: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_GITHUB_USERS: string;
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
}

export class MyMCP extends McpAgent<Env, Record<string, never>, AuthProps> {
  server = new McpServer({
    name: "AFFiNE ChatGPT Read-Only Bridge",
    version: "1.0.0",
  });

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

  private async rpc(body: unknown, extraHeaders: Record<string, string> = {}) {
    const response = await fetch(this.env.AFFINE_MCP_URL, {
      method: "POST",
      headers: this.headers(extraHeaders),
      body: JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`AFFiNE MCP HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    if (!text) return { response, json: null };

    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`AFFiNE MCP returned non-JSON data: ${text.slice(0, 500)}`);
    }

    if (json?.error) {
      throw new Error(`AFFiNE MCP error: ${JSON.stringify(json.error)}`);
    }

    return { response, json };
  }

  private async callAffineTool(name: "doc_search" | "read_document", args: Record<string, unknown>) {
    const init = await this.rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "affine-chatgpt-mcp-bridge",
          version: "1.0.0",
        },
      },
    });

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
    );

    return result.json?.result;
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
