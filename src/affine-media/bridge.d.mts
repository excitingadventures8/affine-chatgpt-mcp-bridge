import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

export const OWNER_LOGIN: string;
export function isOwner(login: unknown): boolean;
export function createBridgeMedia(options: {
  getLogin: () => unknown;
  getCookie: () => string | undefined;
  callAffineTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  fetchImpl?: typeof globalThis.fetch;
}): {
  tools: Tool[];
  handles: (name: string) => boolean;
  callTool: (name: string, args: Record<string, unknown>, context?: unknown) => Promise<CallToolResult>;
};
