import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
export function createWriteDiagnostics(options: {
  getLogin: () => string | undefined;
  getCookie: () => string | undefined;
  readDocument: (docId: string) => Promise<unknown>;
  listUpstreamTools: () => Promise<Array<{ name: string }>>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): (args: { doc_id: string }) => Promise<CallToolResult>;
export function summarizeNativeTools(list: unknown): Record<string, unknown>;
