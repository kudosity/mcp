/**
 * Minimal OAuth 2.1 authorization server that wraps Kudosity API credentials.
 *
 * Kudosity's API authenticates with an API key (+ secret). Claude's connector
 * directory requires OAuth for authenticated services, so this module puts a
 * standards-compliant OAuth front door on the MCP server itself:
 *
 *   1. Claude discovers us via RFC 9728 (protected resource metadata) and
 *      RFC 8414 (authorization server metadata).
 *   2. Claude identifies itself with a Client ID Metadata Document (CIMD) or
 *      Dynamic Client Registration (RFC 7591) — both stateless here.
 *   3. /authorize shows a consent page on OUR domain where the user pastes
 *      their Kudosity API key (and optional secret). We verify the key against
 *      the Kudosity API, then issue an authorization code.
 *   4. /token exchanges the code (PKCE S256 required) for an access token.
 *
 * Codes and tokens are AES-256-GCM envelopes containing the user's
 * credentials, encrypted with a server-held key. Nothing is stored server-side:
 * no database, no session table. Rotating KUDOSITY_MCP_TOKEN_KEY invalidates
 * every token at once. The Kudosity API itself is untouched.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Credentials } from "./server.js";

export interface OAuthConfig {
  /** Public origin of this deployment, e.g. https://mcp.kudosity.com (no trailing slash). */
  publicUrl: string;
  /** Path of the MCP endpoint, e.g. /mcp. */
  mcpPath: string;
  /** Secret used to derive the token-encryption key. */
  tokenKey: string;
  /** Verify an API key/secret pair against Kudosity before issuing a code. */
  verifyCredentials: (creds: Credentials) => Promise<{ ok: boolean; message?: string }>;
  /** Lifetimes in seconds. */
  codeTtl?: number;
  accessTtl?: number;
  refreshTtl?: number;
  /** Fetch implementation (injectable for tests). */
  fetch?: typeof fetch;
}

type Purpose = "code" | "access" | "refresh" | "client";

interface CodePayload {
  k: string; s?: string; exp: number;
  client_id: string; redirect_uri: string; code_challenge: string; resource?: string; nonce: string;
}
interface TokenPayload { k: string; s?: string; exp: number; client_id: string }
interface RegisteredClient { redirect_uris: string[]; client_name?: string; iat: number }

export const SCOPES = ["kudosity"] as const;

const b64u = (b: Buffer) => b.toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");

export class OAuthProvider {
  private readonly key: Buffer;
  private readonly cfg: Required<Pick<OAuthConfig, "codeTtl" | "accessTtl" | "refreshTtl">> & OAuthConfig;
  private readonly cimdCache = new Map<string, { at: number; doc: RegisteredClient }>();

  constructor(cfg: OAuthConfig) {
    if (!cfg.tokenKey || cfg.tokenKey.length < 16) throw new Error("KUDOSITY_MCP_TOKEN_KEY must be a strong secret (≥16 chars; use `openssl rand -base64 32`).");
    if (!/^https?:\/\/[^/]+$/.test(cfg.publicUrl)) throw new Error("KUDOSITY_MCP_PUBLIC_URL must be an origin like https://mcp.example.com (no path, no trailing slash).");
    this.key = createHash("sha256").update(cfg.tokenKey).digest();
    this.cfg = { codeTtl: 300, accessTtl: 3600, refreshTtl: 30 * 24 * 3600, ...cfg };
  }

  get issuer(): string { return this.cfg.publicUrl; }
  get resource(): string { return `${this.cfg.publicUrl}${this.cfg.mcpPath}`; }
  get prmUrl(): string { return `${this.cfg.publicUrl}/.well-known/oauth-protected-resource${this.cfg.mcpPath}`; }

  // ── Sealed envelopes ─────────────────────────────────────────────────────
  private seal(purpose: Purpose, payload: object): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(purpose));
    const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    return b64u(Buffer.concat([iv, ct, cipher.getAuthTag()]));
  }
  private open<T extends object>(purpose: Purpose, token: string): T | null {
    try {
      const raw = unb64u(token);
      if (raw.length < 12 + 16 + 1) return null;
      const iv = raw.subarray(0, 12), tag = raw.subarray(raw.length - 16), ct = raw.subarray(12, raw.length - 16);
      const d = createDecipheriv("aes-256-gcm", this.key, iv);
      d.setAAD(Buffer.from(purpose));
      d.setAuthTag(tag);
      const obj = JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8")) as T & { exp?: number };
      if (typeof obj.exp === "number" && obj.exp < now()) return null;
      return obj;
    } catch { return null; }
  }

  /** Credentials from a bearer token issued by this provider, or null. */
  credentialsFromAccessToken(token: string): Credentials | null {
    const p = this.open<TokenPayload>("access", token);
    return p ? { apiKey: p.k, apiSecret: p.s } : null;
  }

  // ── Discovery documents ──────────────────────────────────────────────────
  protectedResourceMetadata() {
    return { resource: this.resource, authorization_servers: [this.issuer], bearer_methods_supported: ["header"], scopes_supported: [...SCOPES] };
  }
  authorizationServerMetadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      registration_endpoint: `${this.issuer}/register`,
      scopes_supported: [...SCOPES],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      service_documentation: "https://developers.kudosity.com/docs/mcp",
    };
  }
  wwwAuthenticate(error = "invalid_token", description = "Authentication required for this tool"): string {
    return `Bearer error="${error}", error_description="${description}", resource_metadata="${this.prmUrl}", scope="${SCOPES.join(" ")}"`;
  }

  // ── Clients: DCR (stateless) and CIMD ────────────────────────────────────
  /** RFC 7591: register a public client. The client_id is a sealed envelope of its redirect URIs. */
  register(body: unknown): { status: number; json: object } {
    const b = (body ?? {}) as Record<string, unknown>;
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    if (!uris.length || !uris.every(isAcceptableRedirect)) {
      return { status: 400, json: { error: "invalid_redirect_uri", error_description: "redirect_uris must be one or more https URLs or loopback http URLs." } };
    }
    const iat = now();
    const client: RegisteredClient = { redirect_uris: uris, client_name: typeof b.client_name === "string" ? b.client_name.slice(0, 100) : undefined, iat };
    const client_id = "dcr_" + this.seal("client", client);
    return {
      status: 201,
      json: {
        client_id, client_id_issued_at: iat, redirect_uris: uris, client_name: client.client_name,
        token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      },
    };
  }

  private async resolveClient(clientId: string): Promise<RegisteredClient | null> {
    if (clientId.startsWith("dcr_")) return this.open<RegisteredClient>("client", clientId.slice(4));
    if (isCimdUrl(clientId)) {
      const hit = this.cimdCache.get(clientId);
      if (hit && now() - hit.at < 3600) return hit.doc;
      try {
        const f = this.cfg.fetch ?? fetch;
        const res = await f(clientId, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
        if (!res.ok) return null;
        const doc = (await res.json()) as { client_id?: string; redirect_uris?: unknown; client_name?: string };
        if (doc.client_id !== clientId || !Array.isArray(doc.redirect_uris)) return null;
        const uris = doc.redirect_uris.filter((u): u is string => typeof u === "string" && isAcceptableRedirect(u));
        if (!uris.length) return null;
        const client: RegisteredClient = { redirect_uris: uris, client_name: doc.client_name, iat: now() };
        this.cimdCache.set(clientId, { at: now(), doc: client });
        return client;
      } catch { return null; }
    }
    return null;
  }

  // ── /authorize ───────────────────────────────────────────────────────────
  /** Validate an authorization request. Returns the client + display info, or an error to show/redirect. */
  async authorizeRequest(q: URLSearchParams): Promise<
    | { ok: true; client: RegisteredClient; params: AuthorizeParams; relyingParty: string; redirectHost: string }
    | { ok: false; status: number; error: string; description: string; redirect?: string }
  > {
    const p: AuthorizeParams = {
      client_id: q.get("client_id") ?? "", redirect_uri: q.get("redirect_uri") ?? "", response_type: q.get("response_type") ?? "",
      state: q.get("state") ?? undefined, code_challenge: q.get("code_challenge") ?? "", code_challenge_method: q.get("code_challenge_method") ?? "",
      scope: q.get("scope") ?? undefined, resource: q.get("resource") ?? undefined,
    };
    if (!p.client_id) return { ok: false, status: 400, error: "invalid_request", description: "client_id is required." };
    const client = await this.resolveClient(p.client_id);
    if (!client) return { ok: false, status: 400, error: "invalid_client", description: "Unknown client_id. Register with /register or use a Client ID Metadata Document URL." };
    if (!p.redirect_uri || !redirectUriAllowed(p.redirect_uri, client.redirect_uris)) {
      return { ok: false, status: 400, error: "invalid_request", description: "redirect_uri is not registered for this client." };
    }
    // From here on, errors go back to the client via redirect (RFC 6749 §4.1.2.1).
    const fail = (error: string, description: string) => ({ ok: false as const, status: 302, error, description, redirect: withParams(p.redirect_uri, { error, error_description: description, state: p.state }) });
    if (p.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
    if (!p.code_challenge || p.code_challenge_method !== "S256") return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    if (p.resource && normaliseUrl(p.resource) !== normaliseUrl(this.resource)) return fail("invalid_target", `resource must be ${this.resource}.`);
    const relyingParty = isCimdUrl(p.client_id) ? new URL(p.client_id).host : (client.client_name ?? "an MCP client");
    return { ok: true, client, params: p, relyingParty, redirectHost: new URL(p.redirect_uri).host };
  }

  /** Verify credentials and mint the redirect carrying the authorization code. */
  async issueCode(p: AuthorizeParams, creds: Credentials): Promise<{ ok: true; redirect: string } | { ok: false; message: string }> {
    if (!creds.apiKey) return { ok: false, message: "Enter your Kudosity API key." };
    const v = await this.cfg.verifyCredentials(creds);
    if (!v.ok) return { ok: false, message: v.message ?? "Kudosity rejected that API key." };
    const payload: CodePayload = {
      k: creds.apiKey, s: creds.apiSecret || undefined, exp: now() + this.cfg.codeTtl,
      client_id: p.client_id, redirect_uri: p.redirect_uri, code_challenge: p.code_challenge, resource: p.resource, nonce: b64u(randomBytes(8)),
    };
    const code = this.seal("code", payload);
    return { ok: true, redirect: withParams(p.redirect_uri, { code, state: p.state }) };
  }

  // ── /token ───────────────────────────────────────────────────────────────
  token(form: URLSearchParams): { status: number; json: object } {
    const grant = form.get("grant_type");
    const err = (status: number, error: string, error_description: string) => ({ status, json: { error, error_description } });

    if (grant === "authorization_code") {
      const code = form.get("code") ?? "", verifier = form.get("code_verifier") ?? "", clientId = form.get("client_id") ?? "";
      const c = this.open<CodePayload>("code", code);
      if (!c) return err(400, "invalid_grant", "Authorization code is invalid or expired.");
      if (clientId && clientId !== c.client_id) return err(400, "invalid_grant", "client_id does not match the authorization code.");
      const ru = form.get("redirect_uri");
      if (ru && ru !== c.redirect_uri) return err(400, "invalid_grant", "redirect_uri does not match the authorization request.");
      if (!verifier) return err(400, "invalid_request", "code_verifier is required (PKCE).");
      const expected = b64u(createHash("sha256").update(verifier).digest());
      if (!safeEqual(expected, c.code_challenge)) return err(400, "invalid_grant", "PKCE verification failed.");
      return { status: 200, json: this.mintTokens({ k: c.k, s: c.s, client_id: c.client_id }) };
    }
    if (grant === "refresh_token") {
      const r = this.open<TokenPayload>("refresh", form.get("refresh_token") ?? "");
      if (!r) return err(400, "invalid_grant", "Refresh token is invalid or expired.");
      const clientId = form.get("client_id");
      if (clientId && clientId !== r.client_id) return err(400, "invalid_grant", "client_id does not match the refresh token.");
      return { status: 200, json: this.mintTokens({ k: r.k, s: r.s, client_id: r.client_id }) };
    }
    return err(400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
  }

  private mintTokens(base: { k: string; s?: string; client_id: string }) {
    return {
      access_token: this.seal("access", { ...base, exp: now() + this.cfg.accessTtl } satisfies TokenPayload),
      token_type: "Bearer",
      expires_in: this.cfg.accessTtl,
      refresh_token: this.seal("refresh", { ...base, exp: now() + this.cfg.refreshTtl } satisfies TokenPayload),
      scope: SCOPES.join(" "),
    };
  }

  // ── Consent page ─────────────────────────────────────────────────────────
  consentPage(a: { params: AuthorizeParams; relyingParty: string; redirectHost: string; error?: string }): string {
    const h = escapeHtml;
    const hidden = Object.entries(a.params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `<input type="hidden" name="${h(k)}" value="${h(String(v))}">`)
      .join("\n      ");
    const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(a.redirectHost);
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Kudosity</title>
<style>
  :root{color-scheme:light}body{margin:0;background:#f5f6f8;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1a1d21}
  main{max-width:440px;margin:8vh auto;padding:0 16px}.card{background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:28px}
  h1{font-size:20px;margin:0 0 6px}p{margin:8px 0;color:#4a5058}label{display:block;font-weight:600;margin:16px 0 6px}
  input[type=password]{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #c9ced6;border-radius:8px;font:inherit}
  button{margin-top:20px;width:100%;padding:12px;border:0;border-radius:8px;background:#0b6bcb;color:#fff;font:inherit;font-weight:600;cursor:pointer}
  .rp{background:#f0f4f9;border-radius:8px;padding:10px 12px;font-size:14px}.err{background:#fdecec;color:#8a1f1f;border-radius:8px;padding:10px 12px}
  .warn{background:#fff7e6;color:#7a4b00;border-radius:8px;padding:10px 12px;font-size:14px}small{color:#6b727b}
</style></head><body><main><div class="card">
  <h1>Connect your Kudosity account</h1>
  <p class="rp"><strong>${h(a.relyingParty)}</strong> is asking to use Kudosity on your behalf. After you continue you will be sent back to <strong>${h(a.redirectHost)}</strong>.</p>
  ${loopback ? `<p class="warn">The return address is a local application on your computer. Only continue if you started this from an app you trust.</p>` : ""}
  ${a.error ? `<p class="err">${h(a.error)}</p>` : ""}
  <form method="post" action="/authorize" autocomplete="off">
      ${hidden}
    <label for="api_key">Kudosity API key</label>
    <input id="api_key" name="api_key" type="password" required autocomplete="off">
    <label for="api_secret">API secret <small>(optional — needed for contact lists and balance)</small></label>
    <input id="api_secret" name="api_secret" type="password" autocomplete="off">
    <p><small>Both are in the Kudosity platform under <strong>Settings → API Settings</strong>. Your credentials are verified with Kudosity, sealed into an encrypted token for this connection, and never stored on this server.</small></p>
    <button type="submit">Connect</button>
  </form>
  <p><small><a href="https://kudosity.com/legal/privacy-policy">Privacy policy</a> · <a href="https://developers.kudosity.com/docs/mcp">Documentation</a></small></p>
</div></main></body></html>`;
  }
}

export interface AuthorizeParams {
  client_id: string; redirect_uri: string; response_type: string; state?: string;
  code_challenge: string; code_challenge_method: string; scope?: string; resource?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────
const now = () => Math.floor(Date.now() / 1000);

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** A Client ID Metadata Document URL: https anywhere, or plain http only on loopback (local testing). */
export function isCimdUrl(clientId: string): boolean {
  try {
    const u = new URL(clientId);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && isLoopbackHost(u.hostname === "::1" ? "[::1]" : u.hostname);
  } catch { return false; }
}

export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** https anywhere, or http only on loopback (native apps, RFC 8252). */
export function isAcceptableRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && isLoopbackHost(u.hostname === "::1" ? "[::1]" : u.hostname);
  } catch { return false; }
}

/** Exact match, except loopback redirects compare with the port ignored (RFC 8252 §7.3). */
export function redirectUriAllowed(requested: string, registered: string[]): boolean {
  let r: URL;
  try { r = new URL(requested); } catch { return false; }
  if (!isAcceptableRedirect(requested)) return false;
  for (const reg of registered) {
    if (reg === requested) return true;
    try {
      const g = new URL(reg);
      const loop = isLoopbackHost(g.hostname === "::1" ? "[::1]" : g.hostname) && isLoopbackHost(r.hostname === "::1" ? "[::1]" : r.hostname);
      if (loop && g.protocol === r.protocol && g.hostname === r.hostname && g.pathname === r.pathname) return true;
    } catch { /* skip malformed registered uri */ }
  }
  return false;
}

/** Lower-case origin + path without a trailing slash, for RFC 8707 resource comparison. */
export function normaliseUrl(u: string): string {
  try { const x = new URL(u); return `${x.origin.toLowerCase()}${x.pathname.replace(/\/$/, "")}`; } catch { return u; }
}

export function withParams(url: string, params: Record<string, string | undefined>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** Read a request body (form or JSON) with a size cap. */
export async function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { size += c.length; if (size > limit) { reject(new Error("Body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-frame-options", "DENY");
  res.end(html);
}
