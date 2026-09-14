# Security

This bridge sits between ChatGPT and an AFFiNE Cloud workspace. Treat every credential used by it as sensitive.

## Recommended configuration

- Create a dedicated **read-only** AFFiNE MCP credential.
- Store `AFFINE_AUTH_HEADER` only as a Cloudflare Worker secret.
- Restrict access with `ALLOWED_GITHUB_USERS`.
- Keep GitHub OAuth Client Secret in Worker secrets.
- Do not expose write-capable AFFiNE credentials through this project.
- Revoke and rotate any credential that appears in a screenshot, chat, issue, commit, CI log, or terminal transcript.

## Secrets that must never be committed

- AFFiNE MCP credentials
- GitHub OAuth Client Secret
- any Cloudflare API token
- `.dev.vars`

`GITHUB_CLIENT_ID`, Worker URLs, and AFFiNE workspace MCP URLs are identifiers, not bearer credentials, but you may still prefer not to publish workspace-specific URLs.

## Access model

The bridge authenticates the person through GitHub OAuth. After GitHub returns the authenticated login, the bridge checks it against `ALLOWED_GITHUB_USERS`. If the allowlist is empty, authorization fails closed.

After authorization, ChatGPT receives an OAuth token for this Worker. The AFFiNE bearer credential remains inside the Worker and is never returned to the MCP client.

## Reporting a vulnerability

Please open a GitHub issue for non-sensitive problems. For vulnerabilities involving credentials or a private exploit path, contact the repository owner privately rather than posting secrets or exploit details in a public issue.
