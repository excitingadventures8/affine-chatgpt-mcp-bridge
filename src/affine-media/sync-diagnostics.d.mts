import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
export function createSyncDiagnostics(options: {
  getLogin: () => string | undefined;
  getCookie: () => string | undefined;
  diagnoseWrites: (args: { doc_id: string }) => Promise<CallToolResult>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): (args: { doc_id: string }) => Promise<CallToolResult>;
