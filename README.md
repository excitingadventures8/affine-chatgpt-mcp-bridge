# AFFiNE ↔ ChatGPT MCP Bridge


[![CI](https://github.com/excitingadventures8/affine-chatgpt-mcp-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/excitingadventures8/affine-chatgpt-mcp-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Read-only ChatGPT ↔ AFFiNE Cloud bridge over MCP, running on Cloudflare Workers with GitHub OAuth.**

> [!NOTE]
> This is an independent community project. It is not affiliated with or endorsed by AFFiNE, OpenAI, GitHub, or Cloudflare.


A read-only cloud bridge that lets ChatGPT search and read an **AFFiNE Cloud** workspace over MCP without keeping a Mac, local proxy, or tunnel client running.

The bridge runs on **Cloudflare Workers**, authenticates the human user with **GitHub OAuth**, applies an explicit GitHub username allowlist, and exposes only the two AFFiNE tools verified for read-only access:

- `doc_search`
- `read_document`

## Architecture

```text
ChatGPT
   │ OAuth 2.1
   ▼
Cloudflare Worker
   │ GitHub OAuth + allowlist
   │ hidden AFFiNE bearer credential
   ▼
AFFiNE Cloud MCP
   ├─ doc_search
   └─ read_document
```

No always-on Mac, VPS, Cloudflare Zero Trust subscription, or OpenAI API key is required for this cloud path.

## Status

This project is deliberately **read-only**. It does not create, edit, move, or delete AFFiNE content.

It was extracted from a working AFFiNE Cloud ↔ ChatGPT setup and uses Cloudflare's OAuth provider / MCP agent stack. AFFiNE and ChatGPT are evolving products, so UI labels and upstream MCP behavior can change.

## Tested stack

The first public version is pinned to the versions used while building the working bridge:

- `agents` 0.17.4
- `@modelcontextprotocol/sdk` 1.29.0
- `@cloudflare/workers-oauth-provider` 0.8.1
- `wrangler` 4.131.1
- `@cloudflare/workers-types` 5.20260914.1
- `zod` 4.4.3

## Requirements

- AFFiNE Cloud workspace with MCP enabled
- dedicated **read-only** AFFiNE MCP credential
- Cloudflare account with Workers available
- GitHub account
- ChatGPT account/workspace that supports custom remote MCP apps/plugins
- Node.js 24.11+ and npm for deployment

## 1. Clone and install

```bash
git clone https://github.com/excitingadventures8/affine-chatgpt-mcp-bridge.git
cd affine-chatgpt-mcp-bridge
npm ci
npx wrangler login
```

## 2. Create the OAuth KV namespace

```bash
npx wrangler kv namespace create OAUTH_KV
```

Copy the returned namespace ID into `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "OAUTH_KV",
    "id": "YOUR_KV_NAMESPACE_ID"
  }
]
```

Keep the binding name exactly `OAUTH_KV`.

## 3. Deploy once to obtain the Worker URL

Optionally change `name` in `wrangler.jsonc`, then run:

```bash
npm run deploy
```

You will get a URL similar to:

```text
https://affine-chatgpt-mcp-bridge.<your-subdomain>.workers.dev
```

## 4. Create a GitHub OAuth App

GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**

Use your Worker URL:

```text
Homepage URL:
https://<your-worker>.workers.dev

Authorization callback URL:
https://<your-worker>.workers.dev/callback
```

Save the **Client ID** and generate a **Client Secret**.

Only GitHub's `read:user` scope is requested by the bridge.

## 5. Create a read-only AFFiNE MCP credential

In the target AFFiNE workspace, create a dedicated MCP credential with read-only access.

You need:

```text
AFFiNE MCP URL
https://app.affine.pro/api/workspaces/<workspace-id>/mcp
```

and the full authorization value issued for that credential, normally beginning with:

```text
Bearer ...
```

Do not reuse a write-capable credential.

## 6. Configure Worker secrets

Runtime values are stored as Worker secrets so they are not committed to Git and are not replaced by later `wrangler deploy` operations.

```bash
npx wrangler secret put AFFINE_MCP_URL
npx wrangler secret put AFFINE_AUTH_HEADER
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put ALLOWED_GITHUB_USERS
```

Enter:

- `AFFINE_MCP_URL` — full AFFiNE MCP endpoint
- `AFFINE_AUTH_HEADER` — complete authorization value, normally `Bearer ...`
- `GITHUB_CLIENT_ID` — GitHub OAuth App Client ID
- `GITHUB_CLIENT_SECRET` — GitHub OAuth App Client Secret
- `ALLOWED_GITHUB_USERS` — comma-separated GitHub logins allowed to use this bridge

Example allowlist:

```text
alice,bob
```

The server **fails closed** if `ALLOWED_GITHUB_USERS` is empty.

## 7. Deploy the configured bridge

```bash
npm run deploy
```

## 8. Verify OAuth protection

Without an OAuth access token, `/mcp` must reject the request:

```bash
curl -i https://<your-worker>.workers.dev/mcp
```

Expected behavior:

```text
HTTP 401
WWW-Authenticate: Bearer ...
```

Protected-resource metadata should also be available:

```bash
curl https://<your-worker>.workers.dev/.well-known/oauth-protected-resource/mcp
```

The response should identify your `/mcp` endpoint and authorization server.

## 9. Connect ChatGPT

Create a custom remote MCP app/plugin in ChatGPT:

```text
Server URL:
https://<your-worker>.workers.dev/mcp

Authentication:
OAuth
```

During connection:

1. ChatGPT discovers the OAuth metadata.
2. The Worker redirects your browser to GitHub.
3. GitHub authenticates you.
4. The Worker checks your exact GitHub login against `ALLOWED_GITHUB_USERS`.
5. ChatGPT receives an OAuth token for the Worker.
6. The AFFiNE credential remains hidden inside Cloudflare.

The tool scan should expose only:

```text
doc_search
read_document
```

## Example prompts

```text
Find the AFFiNE document "Project Notes" and summarize it.
```

```text
Search my AFFiNE workspace for notes about cinematography.
```

## Local development

Copy the example environment file:

```bash
cp .dev.vars.example .dev.vars
```

Fill it with test credentials, then run:

```bash
npm run dev
```

`.dev.vars` is ignored by Git. Never commit real secrets.

## Security model

- GitHub OAuth authenticates the person connecting the MCP client.
- `ALLOWED_GITHUB_USERS` restricts access to explicit GitHub accounts.
- OAuth state is random, short-lived, stored in Cloudflare KV, and bound to the browser with an HttpOnly/Secure cookie.
- The AFFiNE bearer credential is stored only as a Cloudflare Worker secret.
- The AFFiNE credential should be **read-only**.
- The Worker defines only `doc_search` and `read_document` as MCP tools.
- The AFFiNE bearer credential is never returned to ChatGPT or GitHub.

If a credential appears in a public issue, commit, screenshot, chat, or CI log, revoke it immediately and create a new one.

See [SECURITY.md](SECURITY.md).

## Troubleshooting

### AFFiNE returns `401`

Recreate a read-only AFFiNE MCP credential and put the exact working value into `AFFINE_AUTH_HEADER`. Do not shorten, redact, or reconstruct it manually.

### OAuth succeeds but the bridge returns `403`

Check `ALLOWED_GITHUB_USERS`. It must contain the exact GitHub login returned by GitHub, not a display name.

### `OAUTH_KV` errors

The KV **binding name** must remain `OAUTH_KV`, even if the namespace itself has another name.

### npm dependency conflict around `@cloudflare/workers-types`

This repository pins the 5.x Workers types release used with the tested Wrangler version. Older Cloudflare examples may still reference a 4.x package and can trigger `ERESOLVE` with current Wrangler releases.

### ChatGPT does not see the tools

Check these in order:

1. `/mcp` returns `401` without a token, not `404` or `500`.
2. `/.well-known/oauth-protected-resource/mcp` returns JSON metadata.
3. GitHub OAuth callback URL exactly matches `https://<worker>/callback`.
4. your login is in `ALLOWED_GITHUB_USERS`.
5. the AFFiNE MCP credential is still valid.

## Upstream / attribution

The OAuth/MCP architecture is based on Cloudflare's public remote MCP examples and libraries. Cloudflare's `cloudflare/ai` examples are MIT licensed.

- Cloudflare MCP docs: https://developers.cloudflare.com/agents/model-context-protocol/
- Cloudflare GitHub OAuth MCP example: https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-github-oauth
- AFFiNE MCP: https://affine.pro/mcp

## Documentation

- [Русская инструкция по установке](docs/SETUP_RU.md)
- [Validation & privacy checklist](docs/VALIDATION.md)

## License

MIT. See [LICENSE](LICENSE).

Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
