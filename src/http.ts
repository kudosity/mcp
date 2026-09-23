#!/usr/bin/env node
/**
 * Streamable HTTP entry point — a stateless remote MCP server for claude.ai,
 * Claude Code, Cursor and any HTTP MCP client.
 *
 *   node dist/http.js            (or: kudosity-mcp-http)
 *   PORT=8080 HOST=0.0.0.0 KUDOSITY_MCP_PATH=/mcp
 *
 * Credentials are per request and never stored. Two ways in:
 *
 *  A) Request headers — for custom connectors, Claude Code, Cursor, curl:
 *       Authorization: Basic base64(API_KEY:API_SECRET)   ← secret may be empty
 *       Authorization: Bearer API_KEY
 *       x-api-key: API_KEY   [+ x-api-secret: API_SECRET]
 *
 *  B) OAuth (lazy auth) — for the Claude Connectors Directory. Enabled when
 *     KUDOSITY_MCP_PUBLIC_URL and KUDOSITY_MCP_TOKEN_KEY are set. Users click
 *     Connect in Claude, enter their API key on our consent page, and Claude
 *     receives an encrypted bearer token that carries the credentials. Public
 *     tools (discovery) work without signing in; a protected tool call without
 *     a token returns 401 + WWW-Authenticate so Claude starts the OAuth flow.
 *     See src/oauth.ts.
 *
 * KUDOSITY_HTTP_ALLOW_ENV_CREDENTIALS=true makes the server fall back to
 * KUDOSITY_API_KEY / KUDOSITY_API_SECRET from its own environment when a
 * request carries none. Only for single-tenant self-hosting — never set it
 * on a shared or public deployment.
 */
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, SERVER_NAME, SERVER_VERSION, PUBLIC_TOOLS, type Credentials } from "./server.js";
import { KudosityClient } from "./kudosity.js";
import { OAuthProvider, readBody, sendHtml, sendJson, type AuthorizeParams } from "./oauth.js";

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const MCP_PATH = process.env.KUDOSITY_MCP_PATH || "/mcp";
const ALLOW_ENV_CREDENTIALS = process.env.KUDOSITY_HTTP_ALLOW_ENV_CREDENTIALS === "true";
const PUBLIC_URL = (process.env.KUDOSITY_MCP_PUBLIC_URL || "").replace(/\/$/, "");
const TOKEN_KEY = process.env.KUDOSITY_MCP_TOKEN_KEY || "";

/** Check an API key by making a cheap read-only call. Returns a user-facing message on failure. */
async function verifyCredentials(creds: Credentials): Promise<{ ok: boolean; message?: string }> {
  try {
    const client = new KudosityClient(creds.apiKey!, creds.apiSecret);
    await client.v2("GET", "/v2/webhook");
    if (creds.apiSecret) await client.v1("GET", "/get-balance.json");
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/\b40[13]\b/.test(msg)) return { ok: false, message: creds.apiSecret ? "Kudosity rejected the API key or secret. Check both under Settings → API Settings." : "Kudosity rejected that API key. Check it under Settings → API Settings." };
    return { ok: false, message: "Could not reach the Kudosity API to verify the key. Please try again." };
  }
}

const oauth = PUBLIC_URL && TOKEN_KEY ? new OAuthProvider({ publicUrl: PUBLIC_URL, mcpPath: MCP_PATH, tokenKey: TOKEN_KEY, verifyCredentials }) : null;
if ((PUBLIC_URL || TOKEN_KEY) && !oauth) {
  console.error("OAuth is disabled: set BOTH KUDOSITY_MCP_PUBLIC_URL and KUDOSITY_MCP_TOKEN_KEY to enable it.");
}

export const HTTP_CREDENTIAL_HELP =
  "This tool needs your Kudosity API credentials and the request carried none. " +
  "Send them as a request header on the connector — recommended: " +
  "`Authorization: Basic <base64 of API_KEY:API_SECRET>` (leave the secret empty, i.e. base64 of `API_KEY:`, " +
  "unless you need the contact-list and balance tools); or `x-api-key: <API_KEY>`. " +
  "In Claude, add the header under Request headers when adding the connector (Settings → Connectors → Add custom connector → No sign-in). " +
  "In Claude Code: `claude mcp add --transport http kudosity <server URL> --header \"Authorization: Basic <base64>\"`. " +
  "Find your API key and secret in the Kudosity platform under Settings → API Settings. " +
  "The API-discovery tools (list_specs, list_endpoints, search_endpoints, get_endpoint) work without credentials.";

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

/** Extract Kudosity credentials from request headers (raw API key forms, or an OAuth bearer we issued). */
export function credentialsFromHeaders(headers: http.IncomingHttpHeaders, provider: OAuthProvider | null = oauth): Credentials {
  const auth = first(headers.authorization);
  if (auth) {
    const sp = auth.indexOf(" ");
    const scheme = sp === -1 ? auth : auth.slice(0, sp);
    const value = sp === -1 ? "" : auth.slice(sp + 1).trim();
    if (/^basic$/i.test(scheme) && value) {
      const decoded = Buffer.from(value, "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon === -1) return { apiKey: decoded || undefined };
      return { apiKey: decoded.slice(0, colon) || undefined, apiSecret: decoded.slice(colon + 1) || undefined };
    }
    if (/^bearer$/i.test(scheme) && value) {
      // OAuth mode: a bearer must be a token we issued. Anything else (expired, garbage)
      // yields no credentials, so a protected call gets a 401 and Claude refreshes or re-authorises.
      if (provider) return provider.credentialsFromAccessToken(value) ?? {};
      // Header mode: treat the bearer value as a raw API key (custom connectors, curl).
      return { apiKey: value };
    }
  }
  const apiKey = first(headers["x-api-key"]);
  if (apiKey) return { apiKey, apiSecret: first(headers["x-api-secret"]) };
  if (ALLOW_ENV_CREDENTIALS && process.env.KUDOSITY_API_KEY) {
    return { apiKey: process.env.KUDOSITY_API_KEY, apiSecret: process.env.KUDOSITY_API_SECRET || undefined };
  }
  return {};
}

/** True if the JSON-RPC body (single or batch) calls a tool that needs credentials. */
export function callsProtectedTool(body: unknown): boolean {
  for (const msg of Array.isArray(body) ? body : [body]) {
    if (msg && typeof msg === "object" && (msg as { method?: unknown }).method === "tools/call") {
      const name = (msg as { params?: { name?: unknown } }).params?.name;
      if (typeof name === "string" && !PUBLIC_TOOLS.has(name)) return true;
    }
  }
  return false;
}

const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

/** Per-IP limit on consent submissions (each one verifies a key against Kudosity). */
const CONSENT_LIMIT = Number(process.env.KUDOSITY_MCP_CONSENT_RATE_LIMIT || 10); // per minute
const consentHits = new Map<string, { n: number; reset: number }>();
function consentAllowed(req: http.IncomingMessage): boolean {
  const ip = (first(req.headers["x-forwarded-for"]) ?? "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  const t = Date.now();
  const hit = consentHits.get(ip);
  if (!hit || hit.reset < t) { consentHits.set(ip, { n: 1, reset: t + 60_000 }); return true; }
  hit.n++;
  if (consentHits.size > 10_000) for (const [k, v] of consentHits) if (v.reset < t) consentHits.delete(k);
  return hit.n <= CONSENT_LIMIT;
}

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    // Stateless: no server-initiated SSE stream (GET) and no sessions to end (DELETE).
    res.setHeader("allow", "POST");
    return sendJson(res, 405, rpcError(-32000, "Method not allowed. This server is stateless: send JSON-RPC over POST."));
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req, 4 * 1024 * 1024));
  } catch {
    return sendJson(res, 400, rpcError(-32700, "Parse error: body must be JSON."));
  }

  const creds = credentialsFromHeaders(req.headers);

  // Lazy-auth gate (OAuth mode only): a protected tool call without credentials
  // must fail at the HTTP layer with 401 so Claude shows its Connect card.
  if (oauth && !creds.apiKey && callsProtectedTool(body)) {
    return sendJson(res, 401, { error: "invalid_token", error_description: "Authentication required for this tool" }, { "www-authenticate": oauth.wwwAuthenticate() });
  }

  // One server + transport per request: credentials never outlive the request.
  const server = createServer(creds, { credentialHelp: HTTP_CREDENTIAL_HELP });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

async function handleOAuth(o: OAuthProvider, url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const path = url.pathname;
  if (req.method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === `/.well-known/oauth-protected-resource${MCP_PATH}`)) {
    sendJson(res, 200, o.protectedResourceMetadata(), { "access-control-allow-origin": "*" }); return true;
  }
  if (req.method === "GET" && (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration")) {
    sendJson(res, 200, o.authorizationServerMetadata(), { "access-control-allow-origin": "*" }); return true;
  }
  if (path === "/register") {
    if (req.method !== "POST") { sendJson(res, 405, { error: "invalid_request" }); return true; }
    let body: unknown;
    try { body = JSON.parse(await readBody(req, 64 * 1024)); } catch { sendJson(res, 400, { error: "invalid_client_metadata", error_description: "Body must be JSON." }); return true; }
    const r = o.register(body); sendJson(res, r.status, r.json); return true;
  }
  if (path === "/authorize") {
    if (req.method === "GET") {
      const a = await o.authorizeRequest(url.searchParams);
      if (!a.ok) {
        if (a.redirect) { res.statusCode = 302; res.setHeader("location", a.redirect); res.setHeader("cache-control", "no-store"); res.end(); }
        else sendHtml(res, a.status, errorPage(a.error, a.description));
        return true;
      }
      sendHtml(res, 200, o.consentPage(a)); return true;
    }
    if (req.method === "POST") {
      if (!consentAllowed(req)) { sendHtml(res, 429, errorPage("too_many_requests", "Too many attempts. Please wait a minute and try again.")); return true; }
      const form = new URLSearchParams(await readBody(req, 64 * 1024));
      const a = await o.authorizeRequest(form);
      if (!a.ok) {
        if (a.redirect) { res.statusCode = 302; res.setHeader("location", a.redirect); res.end(); } else sendHtml(res, a.status, errorPage(a.error, a.description));
        return true;
      }
      const issued = await o.issueCode(a.params as AuthorizeParams, { apiKey: form.get("api_key")?.trim() || undefined, apiSecret: form.get("api_secret")?.trim() || undefined });
      if (!issued.ok) { sendHtml(res, 200, o.consentPage({ ...a, error: issued.message })); return true; }
      res.statusCode = 302; res.setHeader("location", issued.redirect); res.setHeader("cache-control", "no-store"); res.end(); return true;
    }
    sendJson(res, 405, { error: "invalid_request" }); return true;
  }
  if (path === "/token") {
    if (req.method !== "POST") { sendJson(res, 405, { error: "invalid_request" }); return true; }
    const ct = first(req.headers["content-type"]) ?? "";
    const raw = await readBody(req, 64 * 1024);
    let form: URLSearchParams;
    if (ct.includes("application/json")) { try { form = new URLSearchParams(Object.entries(JSON.parse(raw) as Record<string, string>)); } catch { sendJson(res, 400, { error: "invalid_request", error_description: "Malformed JSON." }); return true; } }
    else form = new URLSearchParams(raw);
    const r = o.token(form); sendJson(res, r.status, r.json); return true;
  }
  return false;
}

const errorPage = (error: string, description: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Kudosity — ${error}</title></head><body style="font-family:sans-serif;max-width:520px;margin:10vh auto;padding:0 16px"><h1>Can't continue</h1><p><code>${error}</code></p><p>${description.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string)}</p></body></html>`;

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  (async () => {
    if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/")) {
      return sendJson(res, 200, { ok: true, name: SERVER_NAME, version: SERVER_VERSION, mcp: MCP_PATH, transport: "streamable-http", oauth: Boolean(oauth) });
    }
    if (oauth && (await handleOAuth(oauth, url, req, res))) return;
    if (url.pathname !== MCP_PATH) return sendJson(res, 404, rpcError(-32000, `Not found. The MCP endpoint is ${MCP_PATH}.`));
    await handleMcp(req, res);
  })().catch((err) => {
    console.error("request failed:", err instanceof Error ? err.message : err);
    if (!res.headersSent) sendJson(res, 500, rpcError(-32603, "Internal server error"));
  });
});

httpServer.listen(PORT, HOST, () => {
  console.error(`Kudosity MCP server (streamable HTTP) listening on http://${HOST}:${PORT}${MCP_PATH}` + (oauth ? ` — OAuth enabled, issuer ${oauth.issuer}` : " — header credentials only"));
});

const shutdown = () => httpServer.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
