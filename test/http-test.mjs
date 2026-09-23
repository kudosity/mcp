/**
 * Streamable HTTP transport test: runs dist/http.js against mock Kudosity v1/v2
 * APIs and a mock spec host. Proves the behaviour the Claude connector directory
 * checks for: authless initialize + tools/list, per-request header credentials,
 * actionable errors without credentials, and complete tool annotations.
 * No real credentials, no network. Run: node test/http-test.mjs
 */
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const received = [];

// ── Mock Kudosity API (v2 JSON, v1 form) + a tiny OpenAPI spec ─────────────
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ method: req.method, url: req.url, headers: req.headers, body });
    const send = (code, obj) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };
    if (req.url === "/spec.json") return send(200, { info: { title: "Mock API", version: "1" }, servers: [{ url: "https://mock" }], paths: { "/v2/sms": { post: { summary: "Send SMS" } } } });
    if (req.method === "POST" && req.url === "/v2/sms") return send(200, { id: "sms-1", status: "queued" });
    if (req.method === "GET" && req.url === "/v2/webhook") return send(200, [{ id: "wh-1" }]);
    if (req.method === "GET" && req.url === "/get-balance.json") return send(200, { balance: 42.5, currency: "AUD" });
    return send(404, { error: "not found" });
  });
});
await new Promise((r) => mock.listen(0, r));
const mockPort = mock.address().port;
const mockBase = `http://127.0.0.1:${mockPort}`;

// ── Pick a free port, spawn the HTTP MCP server ────────────────────────────
const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const srv = spawn("node", ["dist/http.js"], {
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    KUDOSITY_API_BASE_URL: mockBase,
    KUDOSITY_V1_BASE_URL: mockBase,
    KUDOSITY_SPEC_V2_URL: `${mockBase}/spec.json`,
    KUDOSITY_SPEC_V1_URL: `${mockBase}/spec.json`,
    // Set but NOT allowed (no KUDOSITY_HTTP_ALLOW_ENV_CREDENTIALS) → must be ignored.
    KUDOSITY_API_KEY: "env-key-must-be-ignored",
  },
  stdio: ["ignore", "ignore", "inherit"],
});
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) {
  try { const r = await fetch(`${base}/healthz`); if (r.ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

// ── JSON-RPC over POST /mcp (stateless: every call is independent) ─────────
let id = 0;
const rpc = async (method, params, headers = {}) => {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  assert.equal(res.status, 200, `${method} → HTTP ${res.status}`);
  return res.json();
};
const call = (name, args, headers) => rpc("tools/call", { name, arguments: args }, headers);
const text = (r) => r.result.content[0].text;
const basic = (k, s = "") => "Basic " + Buffer.from(`${k}:${s}`).toString("base64");

let pass = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); pass++; };

try {
  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.version, pkg.version, "server version must match package.json");
  ok(`GET /healthz → ok, version ${health.version} matches package.json`);

  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(init.result.serverInfo.name, "kudosity");
  assert.equal(init.result.serverInfo.version, pkg.version);
  ok("initialize without credentials → 200, serverInfo present");

  const list = await rpc("tools/list", {});
  const tools = list.result.tools;
  assert.equal(tools.length, 19);
  for (const t of tools) {
    assert.ok(t.title || t.annotations?.title, `${t.name} missing title`);
    assert.ok(t.name.length <= 64, `${t.name} > 64 chars`);
    const a = t.annotations ?? {};
    assert.ok(a.readOnlyHint === true || typeof a.destructiveHint === "boolean", `${t.name} lacks readOnlyHint/destructiveHint`);
    assert.ok(t.description && !/KUDOSITY_API_SECRET/.test(t.description), `${t.name} description leaks env-var name`);
  }
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName.send_sms.annotations.destructiveHint, true);
  assert.equal(byName.get_message.annotations.readOnlyHint, true);
  assert.equal(byName.delete_webhook.annotations.destructiveHint, true);
  ok("tools/list without credentials → 19 tools, every tool has title + readOnly/destructive hint, names ≤ 64");

  const specs = await call("list_specs", {});
  assert.equal(specs.result.isError, undefined);
  assert.equal(JSON.parse(text(specs))[0].endpoints, 1);
  ok("list_specs without credentials → works (discovery is authless)");

  const noCreds = await call("list_webhooks", {});
  assert.equal(noCreds.result.isError, true);
  assert.match(text(noCreds), /Authorization: Basic/);
  assert.match(text(noCreds), /Settings → API Settings/);
  assert.equal(received.some((r) => r.url === "/v2/webhook"), false, "must not call the API without credentials");
  ok("list_webhooks without credentials → isError with header instructions; env KUDOSITY_API_KEY correctly ignored");

  const sms = await call("send_sms", { recipient: "61400000000", sender: "Kudos", message: "hi" }, { authorization: basic("key-1") });
  assert.equal(sms.result.isError, undefined);
  assert.equal(JSON.parse(text(sms)).id, "sms-1");
  const smsReq = received.find((r) => r.url === "/v2/sms");
  assert.equal(smsReq.headers["x-api-key"], "key-1");
  ok("send_sms with `Authorization: Basic key:` → x-api-key forwarded, response parsed");

  const wh = await call("list_webhooks", {}, { "x-api-key": "key-2" });
  assert.equal(wh.result.isError, undefined);
  assert.equal(received.find((r) => r.url === "/v2/webhook").headers["x-api-key"], "key-2");
  ok("list_webhooks with `x-api-key` header → forwarded");

  const bal = await call("get_balance", {}, { authorization: basic("key-3", "sec-3") });
  assert.equal(bal.result.isError, undefined);
  assert.equal(JSON.parse(text(bal)).balance, 42.5);
  const balReq = received.find((r) => r.url === "/get-balance.json");
  assert.equal(balReq.headers.authorization, basic("key-3", "sec-3"));
  ok("get_balance with `Authorization: Basic key:secret` → v1 Basic auth forwarded");

  const balNoSecret = await call("get_balance", {}, { "x-api-key": "key-4" });
  assert.equal(balNoSecret.result.isError, true);
  assert.match(text(balNoSecret), /secret/i);
  ok("get_balance with key but no secret → clear error mentioning the secret");

  const bearer = await call("list_webhooks", {}, { authorization: "Bearer key-5" });
  assert.equal(bearer.result.isError, undefined);
  ok("`Authorization: Bearer key` accepted as API key");

  const get = await fetch(`${base}/mcp`);
  assert.equal(get.status, 405);
  const notFound = await fetch(`${base}/nope`, { method: "POST" });
  assert.equal(notFound.status, 404);
  ok("GET /mcp → 405 (stateless), POST /nope → 404");

  console.log(`\n✅ ALL ${pass} HTTP CHECKS PASSED`);
  process.exitCode = 0;
} catch (e) {
  console.error("\n❌ HTTP TEST FAILED:", e.message);
  process.exitCode = 1;
} finally {
  srv.kill();
  mock.close();
}
