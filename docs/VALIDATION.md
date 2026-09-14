# Validation

This project is validated in two ways before release:

1. **Clean-install CI** — GitHub Actions checks out the repository into a fresh runner, installs dependencies from `package.json`, and runs the TypeScript type-check.
2. **Privacy audit** — the repository and its public commit history are checked for deployment-specific identifiers and credentials before publishing.

## Privacy checklist

The public repository must not contain real values for any of the following:

- AFFiNE MCP credentials or authorization headers
- AFFiNE workspace IDs
- GitHub OAuth client secrets
- deployment-specific GitHub OAuth client IDs
- Cloudflare KV namespace IDs
- Cloudflare `workers.dev` deployment URLs or account subdomains
- OpenAI tunnel IDs, API keys, or ChatGPT workspace IDs
- local usernames, home-directory paths, hostnames, or device names

Only placeholders and generic examples should be committed. Runtime credentials belong in Cloudflare Worker secrets or local `.dev.vars` files ignored by Git.

## Functional release checklist

A deployment is considered ready when:

- `npm install` succeeds from a fresh checkout;
- `npm run type-check` succeeds;
- the Worker deploys with a user-provided `OAUTH_KV` namespace ID;
- unauthenticated `/mcp` returns HTTP 401;
- OAuth protected-resource metadata is available;
- GitHub OAuth succeeds for an allowlisted account;
- ChatGPT discovers only `doc_search` and `read_document`;
- both tools successfully call the configured read-only AFFiNE MCP workspace.
