/** LIVE discovery test — fetches the real hosted specs. No credentials needed. */
import { spawn } from "node:child_process";

const srv = spawn("node", ["dist/index.js"], { env: { ...process.env, KUDOSITY_API_KEY: "discovery-only" }, stdio: ["pipe", "pipe", "inherit"] });
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
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
let id = 0;
const rpc = (m, p) => new Promise((r) => { const myId = ++id; pending.set(myId, r); srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method: m, params: p }) + "\n"); });
const notify = (m, p) => srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: m, params: p }) + "\n");
const call = async (name, args) => { const r = await rpc("tools/call", { name, arguments: args }); return r.result?.isError ? { ERROR: r.result.content[0].text } : JSON.parse(r.result.content[0].text); };

try {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "disc", version: "1" } });
  notify("notifications/initialized");

  console.log("── list_specs (fetched live from developer portal) ──");
  console.log(JSON.stringify(await call("list_specs", {}), null, 2));

  console.log("\n── search_endpoints 'delivery' ──");
  const found = await call("search_endpoints", { query: "delivery" });
  for (const f of found) console.log(`  ${f.method} ${f.path}  — ${f.summary}  [${f.spec}]`);

  console.log("\n── search_endpoints 'opt out' ──");
  for (const f of await call("search_endpoints", { query: "opt out" })) console.log(`  ${f.method} ${f.path}  — ${f.summary}`);

  console.log("\n── get_endpoint POST /v2/sms ──");
  const ep = await call("get_endpoint", { spec: "Transmit Message API", path: "/v2/sms", method: "POST" });
  console.log("summary:", ep.summary, "| server:", ep.server, "| security:", JSON.stringify(ep.security));

  console.log("\n✅ Discovery test complete (always-latest specs from developers.kudosity.com).");
} catch (e) {
  console.error("❌", e.message);
  process.exitCode = 1;
} finally {
  srv.kill();
}
