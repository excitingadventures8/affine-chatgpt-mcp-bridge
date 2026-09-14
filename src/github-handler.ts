import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

type Env = {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_GITHUB_USERS: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
};

export type AuthProps = {
  login: string;
  name: string | null;
};

const STATE_TTL_SECONDS = 600;
const STATE_COOKIE = "__Host-AFFINE_MCP_STATE";

function allowedUsers(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie") ?? "";
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1);
  }
  return null;
}

async function redirectToGitHub(request: Request, env: Env, state: string) {
  const redirectUri = new URL("/callback", request.url).href;
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");

  const stateHash = await sha256Hex(state);
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      "Set-Cookie": `${STATE_COOKIE}=${stateHash}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${STATE_TTL_SECONDS}`,
    },
  });
}

async function exchangeCodeForToken(
  env: Env,
  code: string,
  redirectUri: string,
): Promise<string> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) throw new Error(`GitHub token exchange failed: ${response.status}`);

  const body = (await response.json()) as { access_token?: string; error?: string };
  if (!body.access_token) throw new Error(body.error ?? "GitHub access token missing");
  return body.access_token;
}

async function getGitHubUser(accessToken: string): Promise<{ login: string; name: string | null }> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "affine-chatgpt-mcp-bridge",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) throw new Error(`GitHub user lookup failed: ${response.status}`);
  const body = (await response.json()) as { login: string; name: string | null };
  return { login: body.login, name: body.name };
}

export const GitHubHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize") {
      const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      if (!oauthReqInfo.clientId) return new Response("Invalid OAuth request", { status: 400 });

      const state = crypto.randomUUID();
      await env.OAUTH_KV.put(`oauth:state:${state}`, JSON.stringify(oauthReqInfo), {
        expirationTtl: STATE_TTL_SECONDS,
      });

      return redirectToGitHub(request, env, state);
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) return new Response("Missing OAuth code or state", { status: 400 });

      const stored = await env.OAUTH_KV.get(`oauth:state:${state}`);
      if (!stored) return new Response("Invalid or expired OAuth state", { status: 400 });

      const expectedHash = await sha256Hex(state);
      const cookieHash = getCookie(request, STATE_COOKIE);
      if (!cookieHash || cookieHash !== expectedHash) {
        return new Response("OAuth session binding failed", { status: 400 });
      }

      await env.OAUTH_KV.delete(`oauth:state:${state}`);
      const oauthReqInfo = JSON.parse(stored) as AuthRequest;
      if (!oauthReqInfo.clientId) return new Response("Invalid OAuth request", { status: 400 });

      const redirectUri = new URL("/callback", request.url).href;
      const githubToken = await exchangeCodeForToken(env, code, redirectUri);
      const user = await getGitHubUser(githubToken);

      const allowlist = allowedUsers(env.ALLOWED_GITHUB_USERS ?? "");
      if (allowlist.size === 0) {
        return new Response("Server owner has not configured ALLOWED_GITHUB_USERS", { status: 403 });
      }
      if (!allowlist.has(user.login.toLowerCase())) {
        return new Response("This GitHub account is not allowed to use this MCP server", { status: 403 });
      }

      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReqInfo,
        userId: user.login,
        metadata: { label: user.name ?? user.login },
        scope: oauthReqInfo.scope,
        props: { login: user.login, name: user.name } satisfies AuthProps,
      });

      return new Response(null, {
        status: 302,
        headers: {
          Location: redirectTo,
          "Set-Cookie": `${STATE_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`,
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
