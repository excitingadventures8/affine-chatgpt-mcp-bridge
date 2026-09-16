# Validation — public edition 1.3.5

The public edition is based on the 1.3.5 source package. The owner verified that
the installed source files match that package's manifest. Public source and test
fixtures replace private workspace/document identifiers and the owner login with
examples. Declaration types for configurable owner/workspace exports use `string`.
This packaging does not change the read-only transport algorithm or enable writes.

## Automated checks

Run these in a clean checkout:

```bash
npm ci
npm test
npm run type-check
npx wrangler deploy --dry-run --outdir dist
```

The JavaScript suite covers media reads, group membership, structure and table
extraction, authorization/revocation, SSE responses, diagnostics, bounded sync
snapshots, timeouts and error handling. Integration tests use the real MCP SDK
with synthetic fetch/WebSocket responses and stubbed Cloudflare lifecycle entrypoints.
They do not establish deployed OAuth success or live write persistence.

CI checks public-file privacy and commit email privacy as well as installation,
tests, types and bundle generation. Credential scanning distinguishes long
token-like values from the literal token prefix used for validation and short
synthetic negative test fixtures. No access credential is included in tests.

## Live diagnostic result — September 16, 2026

Two authorized documents were checked using `affine_sync_diagnostics` on Bridge
1.3.5. Private identifiers and document contents are intentionally omitted.

| Field | Both documents |
| --- | --- |
| `progress.websocket_upgrade` | `true` |
| `progress.engine_handshake` | `true` |
| `progress.socket_namespace_connected` | `true` |
| `progress.document_joined` | `false` |
| `progress.snapshot_received` | `false` |
| `sync_read_verified` | `false` |
| `snapshot` | Not returned |
| `failure.stage` | `document_join` |
| `failure.code` | `TIMEOUT` |
| `document_permissions.doc_read` | `true` |
| `document_permissions.doc_update` | `true` |
| `native_write_service.read_write_credential_available` | `false` |
| `bridge_write_tools_enabled` | `false` |
| `write_execution_tested` | `false` |
| `persistence_verified` | `false` |
| `ready_for_write` | `false` |
| `document_modified` | `false` |

Native READ_WRITE availability is a server-feature check, not an inspection of
the current credential mode. Web-session permissions do not grant native MCP
write access. The timeout does not identify its underlying cause or prove a
permission denial. Successful reading would not prove writing either.

## Public release contents

Publish generic source, synthetic tests, dependencies, license notices and guides.
Keep these out of public commits:

- AFFiNE MCP credentials and web-session cookies;
- real workspace/document identifiers and document contents;
- GitHub OAuth client IDs/secrets and private allowlists;
- Cloudflare account/KV identifiers and deployment-specific Worker URLs;
- local device paths, installer backups and diagnostic exports.

The public `wrangler.jsonc` remains a new-install template. Existing deployment
names, bindings, migration history and secrets must be preserved during upgrades.

## Next development step

Investigate the document-join timeout before attempting a live snapshot check.
Writing ordinary text and existing table rows/cells is a future implementation.
It must preserve unrelated structure and verify persistence after an authorized
operation. This release does not include that implementation.
