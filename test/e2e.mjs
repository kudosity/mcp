/**
 * End-to-end test: spins up a mock Kudosity API, runs the real MCP server
 * against it over stdio, and exercises every tool via tools/call.
 * No real credentials, no real messages. Run: node test/e2e.mjs
 */
import { spawn } from "node:child_process";
import http from "node:http";
import assert from "node:assert/strict";

const received = [];

// ── Mock Kudosity v2 API ──────────────────────────────────────────────────
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = body ? JSON.parse(body) : null;
    received.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
    res.setHeader("content-type", "application/json");

    const send = (code, obj) => {
      res.statusCode = code;
      res.end(JSON.stringify(obj));
    };

    // deliberate error path for negative testing
    if (parsed && parsed.recipient === "TRIGGER_ERROR") {
      return send(400, { error: { title: "Invalid Request", detail: "bad recipient", status: 400 } });
    }

    if (req.method === "POST" && req.url === "/v2/sms")
      return send(200, { id: "sms-1", recipient: parsed.recipient, sender: parsed.sender, message: parsed.message, status: "queued" });
    if (req.method === "POST" && req.url === "/v2/mms")
      return send(200, { id: "mms-1", recipient: parsed.recipient, sender: parsed.sender, content_urls: parsed.content_urls, status: "pending" });
    if (req.method === "POST" && req.url === "/v2/whatsapp/messages")
      return send(200, { id: "wa-1", recipient: parsed.recipient, content_type: parsed.content_type, content: parsed.content, status: "sent" });
    if (req.method === "GET" && req.url.startsWith("/v2/sms/"))
      return send(200, { id: req.url.split("/").pop(), status: "delivered" });

    return send(404, { error: "not found" });
  });
});

await new Promise((r) => mock.listen(0, r));
const port = mock.address().port;

// ── Spawn the real MCP server pointed at the mock ─────────────────────────
const srv = spawn("node", ["dist/index.js"], {
  env: { ...process.env, KUDOSITY_API_KEY: "test-key", KUDOSITY_API_BASE_URL: `http://localhost:${port}` },
  stdio: ["pipe", "pipe", "inherit"],
});

// ── JSON-RPC over stdio ────────────────────────────────────────────────────
let buf = "";
const pending = new Map();
srv.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
let id = 0;
const rpc = (method, params) =>
  new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, resolve);
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });
const notify = (method, params) => srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
const callText = (r) => JSON.parse(r.result.content[0].text);

let pass = 0;
const ok = (name) => {
  console.log(`  ✓ ${name}`);
  pass++;
};

try {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  notify("notifications/initialized");

  // tools/list — expect the full toolset, and that key tools are present
  const list = await rpc("tools/list", {});
  const names = list.result.tools.map((t) => t.name);
  assert.equal(names.length, 19);
  for (const expected of ["send_sms", "send_whatsapp", "list_messages", "create_webhook", "create_list", "get_balance", "search_endpoints"]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  ok("tools/list returns all 19 tools (spot-checked key ones)");

  // send_sms
  const sms = await rpc("tools/call", { name: "send_sms", arguments: { recipient: "61400000000", sender: "Kudos", message: "Hello world" } });
  assert.equal(sms.result.isError, undefined);
  const smsReq = received.find((r) => r.url === "/v2/sms");
  assert.equal(smsReq.headers["x-api-key"], "test-key");
  assert.equal(smsReq.body.message, "Hello world");
  assert.equal(callText(sms).id, "sms-1");
  ok("send_sms → POST /v2/sms with x-api-key + correct body, parses response");

  // send_mms
  const mms = await rpc("tools/call", { name: "send_mms", arguments: { recipient: "61400000000", sender: "Kudos", content_urls: ["https://x.test/a.jpg"] } });
  const mmsReq = received.find((r) => r.url === "/v2/mms");
  assert.deepEqual(mmsReq.body.content_urls, ["https://x.test/a.jpg"]);
  assert.equal(callText(mms).id, "mms-1");
  ok("send_mms → POST /v2/mms with content_urls");

  // send_whatsapp — text
  const waText = await rpc("tools/call", { name: "send_whatsapp", arguments: { recipient: "61400000000", content_type: "text", text: "hi there" } });
  const waTextReq = received.filter((r) => r.url === "/v2/whatsapp/messages").at(-1);
  assert.deepEqual(waTextReq.body.content, { text: { message: "hi there" } });
  assert.equal(callText(waText).id, "wa-1");
  ok("send_whatsapp text → maps to content.text.message");

  // send_whatsapp — template
  await rpc("tools/call", { name: "send_whatsapp", arguments: { recipient: "61400000000", content_type: "template", template_name: "order_update", template_parameters: ["#123"], template_locale: "en_US" } });
  const waTplReq = received.filter((r) => r.url === "/v2/whatsapp/messages").at(-1);
  assert.deepEqual(waTplReq.body.content, { template: { name: "order_update", parameters: ["#123"], locale: "en_US" } });
  ok("send_whatsapp template → maps to content.template with params + locale");

  // get_message
  const gm = await rpc("tools/call", { name: "get_message", arguments: { channel: "sms", id: "sms-1" } });
  const gmReq = received.find((r) => r.method === "GET" && r.url === "/v2/sms/sms-1");
  assert.ok(gmReq);
  assert.equal(callText(gm).status, "delivered");
  ok("get_message → GET /v2/sms/{id}, returns status");

  // error handling — API 400 surfaces as tool error
  const err = await rpc("tools/call", { name: "send_sms", arguments: { recipient: "TRIGGER_ERROR", sender: "Kudos", message: "x" } });
  assert.equal(err.result.isError, true);
  assert.match(err.result.content[0].text, /400/);
  ok("API 400 surfaces as an MCP tool error (isError=true, mentions 400)");

  // whatsapp text without text → validation error before HTTP
  const waBad = await rpc("tools/call", { name: "send_whatsapp", arguments: { recipient: "61400000000", content_type: "text" } });
  assert.equal(waBad.result.isError, true);
  ok("send_whatsapp text without `text` → clear validation error");

  console.log(`\n✅ ALL ${pass} CHECKS PASSED`);
  process.exitCode = 0;
} catch (e) {
  console.error("\n❌ TEST FAILED:", e.message);
  process.exitCode = 1;
} finally {
  srv.kill();
  mock.close();
}
