import { createAffineMediaTools, isDocumentId } from './media.mjs';

// The private workspace owner from the existing bridge. Never an open allowlist.
export const OWNER_LOGIN = 'your-github-login';
export const isOwner = login => typeof login === 'string' && login === OWNER_LOGIN;

/** Getters are supplied by MyMCP, using verified OAuth props and Worker secrets.
 * No principal, Cookie, asset URL or permission flag is accepted from tool input.
 */
export function createBridgeMedia({ getLogin, getCookie, callAffineTool, fetchImpl = globalThis.fetch }) {
  return createAffineMediaTools({
    // User requested all visual sections, including new project documents.
    // The REST origin/workspace remains fixed; upstream MCP permissions remain mandatory.
    allowedDocuments: null,
    fetchImpl,
    authorize: async (_context, docId) => {
      if (!isOwner(getLogin()) || !isDocumentId(docId)) return null;
      const cookie = getCookie();
      if (!cookie) return { cookie: '' }; // module returns SESSION_REQUIRED

      // Fresh native-MCP read on EVERY media call preserves its scope/revocation.
      // A separate, broader REST session must never override an MCP denial.
      const result = await callAffineTool('read_document', { docId });
      // A successful empty text result is valid for image-only canvases. HTTP/RPC
      // errors and isError:true still stop BEFORE any REST request.
      if (!result || (result.isError !== undefined && result.isError !== false) ||
          result.error !== undefined || !Array.isArray(result.content)) {
        return null;
      }
      return { cookie };
    },
  });
}
