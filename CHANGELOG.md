# Changelog

## 0.6.0

Remote transport + Claude Desktop extension, built for the Claude Connectors Directory.

- **Streamable HTTP transport** (`kudosity-mcp-http` / `node dist/http.js`): a stateless remote MCP server. Credentials are read per request from `Authorization: Basic key:secret`, `Authorization: Bearer key` or `x-api-key` (+ `x-api-secret`) and never stored. Without credentials the server initialises, lists tools and runs the discovery tools; API tools return instructions for adding the header.
- **Claude Desktop extension** (`.mcpb`): `manifest.json` + `npm run build:mcpb`. API key and secret are entered in the extension's settings (stored by Claude Desktop, masked), not pasted into chat.
- **Dockerfile** for hosting the HTTP server; `GET /healthz`.
- Tool factory refactor (`src/server.ts`) shared by both transports; no tool changes except annotations and wording:
  - `send_sms`, `send_mms`, `send_whatsapp` now carry `destructiveHint: true` — sending is billable and irreversible, so clients ask before calling.
  - Discovery tool descriptions name the API reference they query and say no credentials are needed.
  - Secret-requiring tools say "Requires your API secret" instead of naming an environment variable.
- New test `test/http-test.mjs` (mock APIs, no network); CI validates the MCPB manifest and builds the bundle.

## 0.5.0

Initial public release.

- Messaging: `send_sms`, `send_mms`, `send_whatsapp`, `get_message`
- Reporting: `list_messages` (delivery status + inbound replies, with filters)
- Webhooks: `create_webhook`, `list_webhooks`, `delete_webhook`
- Contacts & lists: `create_list`, `get_lists`, `get_list`, `add_contact_to_list`, `remove_contact_from_list`, `delete_list`
- Account: `get_balance`
- API discovery (live specs): `list_specs`, `list_endpoints`, `search_endpoints`, `get_endpoint`
- Dual authentication: `x-api-key` for messaging/webhooks, HTTP Basic for contacts/balance
