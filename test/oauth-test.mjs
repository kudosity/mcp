/**
 * OAuth (lazy-auth) test: runs dist/http.js in OAuth mode against a mock
 * Kudosity API and a mock CIMD host, then drives the whole flow the way Claude
 * does — discovery → 401 gate → DCR and CIMD clients → consent → PKCE code →
 * token → authenticated tool call → refresh. No network, no real credentials.
 * Run: node test/oauth-test.mjs
 */
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const received = [];

// ── Mock Kudosity API + CIMD document host ──────────────────────────────────
const mockPort = await freePort();
const mock = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ method: req.method, url: req.url, headers: req.headers, body });
    const send = (code, obj) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };
    if (req.url === "/client-metadata") return send(200, { client_id: `http://127.0.0.1:${mockPort}/client-metadata`, client_name: "Claude (test)", redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "http://localhost/callback", "http://127.0.0.1/callback"] });
    if (req.url === "/spec.json") return send(200, { info: { title: "Mock" }, paths: {} });
    const key = req.headers["x-api-key"];
    if (req.method === "GET" && req.url === "/v2/webhook") return key === "good-key" ? send(200, [{ id: "wh-1" }]) : send(401, { error: "unauthorised" });
    if (req.method === "GET" && req.url === "/get-balance.json") return req.headers.authorization === "Basic " + Buffer.from("good-key:good-secret").toString("base64") ? send(200, { balance: 7 }) : send(401, { error: "bad" });
    if (req.method === "POST" && req.url === "/v2/sms") return key === "good-key" ? send(200, { id: "sms-1" }) : send(401, { error: "bad" });
    return send(404, {});
  });
});
await new Promise((r) => mock.listen(mockPort, "127.0.0.1", r));
const mockBase = `http://127.0.0.1:${mockPort}`;

// ── Server in OAuth mode ────────────────────────────────────────────────────
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const srv = spawn("node", ["dist/http.js"], {
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", KUDOSITY_API_BASE_URL: mockBase, KUDOSITY_V1_BASE_URL: mockBase, KUDOSITY_SPEC_V2_URL: `${mockBase}/spec.json`, KUDOSITY_SPEC_V1_URL: `${mockBase}/spec.json`, KUDOSITY_MCP_PUBLIC_URL: base, KUDOSITY_MCP_TOKEN_KEY: "test-token-key-please-rotate-me" },
  stdio: ["ignore", "ignore", "inherit"],
});
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }

let id = 0;
const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
const rpc = (method, params, headers) => post("/mcp", { jsonrpc: "2.0", id: ++id, method, params }, headers);
const call = (name, args, headers) => rpc("tools/call", { name, arguments: args }, headers);
const form = (path, data, extra = {}) => fetch(`${base}${path}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...extra }, body: new URLSearchParams(data).toString() });
const pkce = () => { const verifier = randomBytes(32).toString("base64url"); return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }; };

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

/** Run the authorization-code flow for a given client_id + redirect_uri; returns the token response. */
async function authorize({ client_id, redirect_uri, api_key, api_secret = "", verifierOverride }) {
  const { verifier, challenge } = pkce();
  const params = { client_id, redirect_uri, response_type: "code", state: "st-1", code_challenge: challenge, code_challenge_method: "S256", scope: "kudosity", resource: `${base.toUpperCase()}/mcp/` };
  const page = await fetch(`${base}/authorize?` + new URLSearchParams(params));
  assert.equal(page.status, 200); const html = await page.text();
  assert.match(html, /Connect your Kudosity account/); assert.match(html, /API Settings/);
  const consent = await form("/authorize", { ...params, api_key, api_secret });
  return { consent, verifier: verifierOverride ?? verifier, params };
}

try {
  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.oauth, true);
  ok("healthz reports oauth: true");

  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${base}/mcp`); assert.deepEqual(prm.authorization_servers, [base]);
  const prmRoot = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
  assert.equal(prmRoot.resource, prm.resource);
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.issuer, base); assert.equal(as.client_id_metadata_document_supported, true);
  assert.ok(as.token_endpoint_auth_methods_supported.includes("none")); assert.deepEqual(as.code_challenge_methods_supported, ["S256"]); assert.ok(as.registration_endpoint);
  ok("discovery: PRM (root + /mcp) and AS metadata advertise CIMD, DCR, PKCE S256, public client");

  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(init.status, 200);
  const list = await rpc("tools/list", {}); assert.equal(list.status, 200); assert.equal((await list.json()).result.tools.length, 19);
  const pub = await call("list_specs", {}); assert.equal(pub.status, 200); assert.equal((await pub.json()).result.isError, undefined);
  ok("without a token: initialize, tools/list and public discovery tools return 200");

  const gated = await call("send_sms", { recipient: "6140", sender: "K", message: "x" });
  assert.equal(gated.status, 401);
  const www = gated.headers.get("www-authenticate");
  assert.match(www, /^Bearer error="invalid_token"/); assert.ok(www.includes(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`)); assert.match(www, /scope="kudosity"/);
  assert.equal(received.some((r) => r.url === "/v2/sms"), false);
  ok("protected tool without a token → HTTP 401 + WWW-Authenticate (lazy-auth gate, API never called)");

  const bad = await call("send_sms", { recipient: "6140", sender: "K", message: "x" }, { authorization: "Bearer not-a-real-token" });
  assert.equal(bad.status, 401); assert.match(bad.headers.get("www-authenticate"), /invalid_token/);
  assert.equal(received.some((r) => r.url === "/v2/sms"), false);
  ok("expired/garbage bearer on a protected tool → 401 (so Claude refreshes or re-authorises), API never called");
  const badPublic = await call("list_specs", {}, { authorization: "Bearer not-a-real-token" });
  assert.equal(badPublic.status, 200);
  ok("garbage bearer on a public tool → still 200 (public tools never require auth)");
  const headerMode = await call("list_webhooks", {}, { "x-api-key": "good-key" });
  assert.equal(headerMode.status, 200); assert.equal((await headerMode.json()).result.isError, undefined);
  ok("x-api-key header still works alongside OAuth (custom connectors with request headers)");

  // ── DCR client ──
  const reg = await post("/register", { client_name: "Test client", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" });
  assert.equal(reg.status, 201); const client = await reg.json();
  assert.ok(client.client_id.startsWith("dcr_")); assert.equal(client.token_endpoint_auth_method, "none");
  const regBad = await post("/register", { redirect_uris: ["http://evil.example/cb"] }); assert.equal(regBad.status, 400);
  ok("DCR: registers a public client statelessly; rejects non-https, non-loopback redirect URIs");

  const badRedirect = await fetch(`${base}/authorize?` + new URLSearchParams({ client_id: client.client_id, redirect_uri: "https://evil.example/cb", response_type: "code", code_challenge: "x", code_challenge_method: "S256" }), { redirect: "manual" });
  assert.equal(badRedirect.status, 400);
  ok("authorize with an unregistered redirect_uri → 400 (never redirects to an attacker)");

  const noPkce = await fetch(`${base}/authorize?` + new URLSearchParams({ client_id: client.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", response_type: "code", state: "s" }), { redirect: "manual" });
  assert.equal(noPkce.status, 302); assert.match(noPkce.headers.get("location"), /error=invalid_request/); assert.match(noPkce.headers.get("location"), /state=s/);
  ok("authorize without PKCE → redirected back with error=invalid_request and state");

  const wrongKey = await authorize({ client_id: client.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", api_key: "wrong-key" });
  assert.equal(wrongKey.consent.status, 200); assert.match(await wrongKey.consent.text(), /rejected that API key/);
  ok("consent with a bad API key → verified against Kudosity, re-shows the form with an error, no code issued");

  const flow = await authorize({ client_id: client.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", api_key: "good-key", api_secret: "good-secret" });
  assert.equal(flow.consent.status, 302);
  const loc = new URL(flow.consent.headers.get("location"));
  assert.equal(loc.origin + loc.pathname, "https://claude.ai/api/mcp/auth_callback"); assert.equal(loc.searchParams.get("state"), "st-1");
  const code = loc.searchParams.get("code"); assert.ok(code);
  ok("consent with a good key (+secret) → key AND secret verified, 302 to redirect_uri with code + state");

  const badVerifier = await form("/token", { grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: "nope" });
  assert.equal(badVerifier.status, 400); assert.equal((await badVerifier.json()).error, "invalid_grant");
  ok("token with wrong code_verifier → invalid_grant");

  const tok = await form("/token", { grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: flow.verifier });
  assert.equal(tok.status, 200); const t = await tok.json();
  assert.equal(t.token_type, "Bearer"); assert.ok(t.access_token && t.refresh_token && t.expires_in > 0);
  ok("token exchange (form-urlencoded, PKCE ok) → access + refresh tokens");

  const authed = await call("send_sms", { recipient: "61400000000", sender: "K", message: "hi" }, { authorization: `Bearer ${t.access_token}` });
  assert.equal(authed.status, 200); const aj = await authed.json(); assert.equal(aj.result.isError, undefined); assert.equal(JSON.parse(aj.result.content[0].text).id, "sms-1");
  assert.equal(received.filter((r) => r.url === "/v2/sms").at(-1).headers["x-api-key"], "good-key");
  const bal = await call("get_balance", {}, { authorization: `Bearer ${t.access_token}` });
  assert.equal(JSON.parse((await bal.json()).result.content[0].text).balance, 7);
  ok("bearer token → credentials unsealed per request; v2 (x-api-key) and v1 (Basic key:secret) both work");

  const reused = await form("/token", { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: client.client_id });
  assert.equal(reused.status, 200); const t2 = await reused.json(); assert.ok(t2.access_token && t2.access_token !== t.access_token);
  const badRefresh = await form("/token", { grant_type: "refresh_token", refresh_token: t.access_token });
  assert.equal(badRefresh.status, 400); assert.equal((await badRefresh.json()).error, "invalid_grant");
  ok("refresh_token grant → new tokens; an access token cannot be used as a refresh token (purpose-bound)");

  // ── CIMD client (how Claude identifies itself) ──
  const cimdId = `${mockBase}/client-metadata`;
  const cimd = await authorize({ client_id: cimdId, redirect_uri: "http://localhost:54321/callback", api_key: "good-key" });
  assert.equal(cimd.consent.status, 302);
  const cloc = new URL(cimd.consent.headers.get("location")); assert.equal(cloc.port, "54321");
  const ctok = await form("/token", { grant_type: "authorization_code", code: cloc.searchParams.get("code"), client_id: cimdId, redirect_uri: "http://localhost:54321/callback", code_verifier: cimd.verifier });
  assert.equal(ctok.status, 200);
  ok("CIMD client: metadata fetched from client_id URL; loopback redirect matched with the port ignored (Claude Code)");

  const cimdPage = await fetch(`${base}/authorize?` + new URLSearchParams({ client_id: cimdId, redirect_uri: "https://claude.ai/api/mcp/auth_callback", response_type: "code", code_challenge: "c", code_challenge_method: "S256" }));
  const cimdHtml = await cimdPage.text();
  assert.match(cimdHtml, new RegExp(`<strong>127\\.0\\.0\\.1:${mockPort}</strong> is asking`));
  ok("consent page names the CIMD host (not the self-asserted client_name) as the relying party");

  console.log(`\n✅ ALL ${pass} OAUTH CHECKS PASSED`);
  process.exitCode = 0;
} catch (e) {
  console.error("\n❌ OAUTH TEST FAILED:", e.message);
  process.exitCode = 1;
} finally {
  srv.kill(); mock.close();
}
