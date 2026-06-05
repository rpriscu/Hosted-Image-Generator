/**
 * Worker entry — wraps the MCP server in an OAuth 2.1 provider so it can be
 * added as a custom connector in Claude's UI (which only supports OAuth, not a
 * static bearer header).
 *
 * The OAuth consent screen is gated by MCP_AUTH_SECRET: a client can complete
 * the authorization flow only by entering the shared secret. This keeps anyone
 * else from running up the fal bill while remaining compatible with the
 * connector UI's OAuth-only flow.
 *
 * Endpoints:
 *   /mcp        -> MCP (Streamable HTTP), protected by OAuth access token
 *   /authorize  -> consent screen (enter MCP_AUTH_SECRET)
 *   /token      -> OAuth token exchange (implemented by the provider)
 *   /register   -> dynamic client registration (implemented by the provider)
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { ImageMcp, type Env } from "./mcp.ts";

export { ImageMcp };

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderConsent(oauthQuery: string, error?: string): Response {
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connect — Hosted Image Generator</title>
  <style>
    body { font-family: system-ui, sans-serif; background:#0b1224; color:#e8eefc; display:flex; min-height:100vh; align-items:center; justify-content:center; margin:0; }
    .card { background:#121a33; padding:32px; border-radius:14px; width:340px; box-shadow:0 10px 40px rgba(0,0,0,.4); }
    h1 { font-size:18px; margin:0 0 4px; }
    p { font-size:13px; color:#9fb0d6; margin:0 0 20px; }
    input { width:100%; box-sizing:border-box; padding:11px; border-radius:8px; border:1px solid #2a3a63; background:#0b1224; color:#e8eefc; font-size:14px; }
    button { width:100%; margin-top:14px; padding:11px; border:0; border-radius:8px; background:#3b5bdb; color:#fff; font-size:14px; cursor:pointer; }
    button:hover { background:#4c6ef5; }
    .err { color:#ff8787; font-size:13px; margin:10px 0 0; }
  </style>
</head>
<body>
  <form class="card" method="POST" action="/authorize">
    <h1>Hosted Image Generator</h1>
    <p>Enter the access secret to authorize this connector.</p>
    <input type="password" name="secret" placeholder="Access secret" autofocus required />
    <input type="hidden" name="oauth_query" value="${htmlEscape(oauthQuery)}" />
    ${error ? `<p class="err">${htmlEscape(error)}</p>` : ""}
    <button type="submit">Authorize</button>
  </form>
</body>
</html>`;
  return new Response(body, {
    status: error ? 401 : 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

type OAuthHelpers = {
  parseAuthRequest(request: Request): Promise<{ scope?: string[] } & Record<string, unknown>>;
  completeAuthorization(opts: {
    request: unknown;
    userId: string;
    scope: string[];
    metadata?: Record<string, unknown>;
    props?: Record<string, unknown>;
  }): Promise<{ redirectTo: string }>;
};

const defaultHandler = {
  async fetch(
    request: Request,
    env: Env & { OAUTH_PROVIDER: OAuthHelpers },
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize") {
      if (request.method === "GET") {
        // Validate it's a well-formed OAuth request, then show the consent form.
        try {
          await env.OAUTH_PROVIDER.parseAuthRequest(request);
        } catch {
          return new Response("Invalid authorization request", { status: 400 });
        }
        return renderConsent(url.search);
      }

      if (request.method === "POST") {
        const form = await request.formData();
        const secret = String(form.get("secret") ?? "");
        const oauthQuery = String(form.get("oauth_query") ?? "");

        // Reconstruct the original authorize request to recover its OAuth params.
        const origReq = new Request(`${url.origin}/authorize${oauthQuery}`);
        let oauthReqInfo: { scope?: string[] } & Record<string, unknown>;
        try {
          oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(origReq);
        } catch {
          return new Response("Invalid authorization request", { status: 400 });
        }

        if (!env.MCP_AUTH_SECRET || secret !== env.MCP_AUTH_SECRET) {
          return renderConsent(oauthQuery, "Invalid secret. Try again.");
        }

        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: oauthReqInfo,
          userId: "owner",
          scope: oauthReqInfo.scope ?? [],
          metadata: { label: "Hosted Image Generator" },
          props: { userId: "owner" },
        });
        return Response.redirect(redirectTo, 302);
      }

      return new Response("Method not allowed", { status: 405 });
    }

    if (url.pathname === "/") {
      return new Response(
        "Hosted Image Generator — remote MCP server. Connect a client to /mcp.",
        { status: 200, headers: { "Content-Type": "text/plain" } },
      );
    }

    return new Response("Not found", { status: 404 });
  },
};

export default new OAuthProvider({
  apiRoute: "/mcp",
  // Casts bridge a duplicate @cloudflare/workers-types copy bundled by the
  // provider (structurally identical handler types, nominally distinct).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiHandler: ImageMcp.serve("/mcp") as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultHandler: defaultHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
