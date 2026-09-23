# Kudosity MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI agents native tools to send **SMS, MMS and WhatsApp** messages, manage contacts and webhooks, and research the Kudosity API — powered by [Kudosity](https://kudosity.com).

One tool per action — an agent calls `send_sms` instead of hand-building HTTP requests. Three ways to run it:

| | Best for | Credentials |
|---|---|---|
| **Local (`npx kudosity-mcp`)** | Claude Code, Cursor, VS Code, Gemini CLI, any stdio client | environment variables |
| **Claude Desktop extension (`.mcpb`)** | One-click install in Claude Desktop | entered once in the extension's settings |
| **Remote (Streamable HTTP)** | claude.ai / Claude mobile, team-wide connectors, hosted agents | OAuth sign-in, or a request header |

## Tools

**Messaging**

| Tool | Type | Description |
|---|---|---|
| `send_sms` | write | Send an SMS to a recipient |
| `send_mms` | write | Send an MMS with a media attachment |
| `send_whatsapp` | write | Send a WhatsApp message (free-form text or approved template) |
| `get_message` | read | Get a sent message and its status by channel + ID |
| `list_messages` | read | List sent/received messages with delivery status; filter by status, direction (sent/replies), recipient, dates |

Sending is billable and irreversible, so the three `send_*` tools are annotated `destructiveHint: true` — Claude and other clients ask before calling them.

**Webhooks**

| Tool | Type | Description |
|---|---|---|
| `create_webhook` | write | Register an HTTPS webhook for delivery status, inbound messages, link hits, opt-outs |
| `list_webhooks` | read | List configured webhooks |
| `delete_webhook` | write | Delete a webhook by ID |

**Contacts & lists** *(need the API secret as well as the key)*

| Tool | Type | Description |
|---|---|---|
| `create_list` | write | Create a contact list |
| `get_lists` | read | List all contact lists |
| `get_list` | read | Get a list and optionally its members |
| `add_contact_to_list` | write | Add a contact to a list |
| `remove_contact_from_list` | write | Remove a contact from a list |
| `delete_list` | write | Delete a contact list |

**Account** *(needs the API secret)*

| Tool | Type | Description |
|---|---|---|
| `get_balance` | read | Get your account balance |

**API discovery** — research the whole Kudosity API, always current, **no credentials needed**

| Tool | Type | Description |
|---|---|---|
| `list_specs` | read | List the Kudosity API specifications |
| `list_endpoints` | read | List all endpoints for a spec |
| `search_endpoints` | read | Search the API by keyword |
| `get_endpoint` | read | Get full detail for one endpoint |

The discovery tools read the live specs from `developers.kudosity.com`, so they always reflect the latest published docs.

## Requirements

- A Kudosity account and API key — **Settings → API Settings** in the Kudosity platform
- For contact and balance tools, also your API **secret** (same settings page)
- Node.js 18+ for the local and self-hosted options (Claude Desktop bundles its own)

## Install & configure

### Claude Desktop — extension (one click)

1. Download `kudosity-mcp-<version>.mcpb` from the [latest release](https://github.com/kudosity/mcp/releases/latest).
2. Open it with Claude Desktop (double-click, or drag it onto **Settings → Extensions**).
3. Enter your Kudosity API key, and optionally the API secret. Claude Desktop stores them for you; they are never pasted into a chat.

To build the extension yourself: `npm run build:mcpb` → `dist-mcpb/kudosity-mcp-<version>.mcpb`.

### Claude Desktop / Claude Code — `npx`

```json
{
  "mcpServers": {
    "kudosity": {
      "command": "npx",
      "args": ["-y", "kudosity-mcp"],
      "env": {
        "KUDOSITY_API_KEY": "your_api_key",
        "KUDOSITY_API_SECRET": "your_api_secret"
      }
    }
  }
}
```

Or from the terminal: `claude mcp add kudosity -e KUDOSITY_API_KEY=your_api_key -- npx -y kudosity-mcp`

`KUDOSITY_API_SECRET` is optional — omit it if you only need messaging, webhooks, and discovery. It's required for the contact-list and balance tools.

### Cursor — `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "kudosity": {
      "command": "npx",
      "args": ["-y", "kudosity-mcp"],
      "env": { "KUDOSITY_API_KEY": "your_api_key", "KUDOSITY_API_SECRET": "your_api_secret" }
    }
  }
}
```

### VS Code — `.vscode/mcp.json`

```json
{
  "servers": {
    "kudosity": {
      "command": "npx",
      "args": ["-y", "kudosity-mcp"],
      "env": { "KUDOSITY_API_KEY": "your_api_key", "KUDOSITY_API_SECRET": "your_api_secret" }
    }
  }
}
```

## Remote server (Streamable HTTP)

The same 19 tools as a stateless remote MCP server — for claude.ai, Claude mobile, org-wide connectors, and hosted agents. Start it with `kudosity-mcp-http` (or `node dist/http.js`, or the [Dockerfile](./Dockerfile)); it serves MCP at `/mcp` and a health check at `/healthz`.

Credentials are supplied **per request** and never stored on the server. There are two ways to supply them.

### A. OAuth sign-in (Claude "Connect" button)

When `KUDOSITY_MCP_PUBLIC_URL` and `KUDOSITY_MCP_TOKEN_KEY` are set, the server also acts as a small OAuth 2.1 authorization server:

- Anyone can connect and use the discovery tools without signing in.
- The first time a tool needs your account, Claude shows a **Connect** card. You enter your Kudosity API key (and optional secret) on a consent page served from this server's domain — never in the chat.
- The key is verified with Kudosity, then sealed into an encrypted access token that Claude sends on later requests. The server holds no user data: rotating `KUDOSITY_MCP_TOKEN_KEY` invalidates every token.

Supports Dynamic Client Registration and Client ID Metadata Documents, PKCE (S256), refresh tokens, and the Claude Code loopback redirect. Discovery documents live at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`.

Add it in Claude as a custom connector with just the server URL (**Settings → Connectors → Add custom connector**), or in Claude Code:

```bash
claude mcp add --transport http kudosity https://<your-host>/mcp
```

### B. Request header (no sign-in)

For a connector your whole team shares, or for scripts and tools that can set headers, send the credentials on every request:

| Header | Value | Covers |
|---|---|---|
| `Authorization` | `Basic <base64 of API_KEY:API_SECRET>` — leave the secret empty (`API_KEY:`) if you don't need lists/balance | everything |
| `x-api-key` (+ `x-api-secret`) | the raw key (and secret) | everything |
| `Authorization` | `Bearer API_KEY` | messaging, webhooks, reporting (header-only mode, i.e. when OAuth is not enabled) |

In Claude: **Add custom connector → No sign-in → Request headers**, header `authorization`, value `Basic …`. In Claude Code:

```bash
claude mcp add --transport http kudosity https://<your-host>/mcp \
  --header "Authorization: Basic $(printf '%s:%s' "$KUDOSITY_API_KEY" "$KUDOSITY_API_SECRET" | base64)"
```

Without credentials the server still initialises and lists tools; discovery works, and tools that need your account return an error explaining how to add the header (or, in OAuth mode, start the sign-in).

### Self-hosting

```bash
npm install -g kudosity-mcp
PORT=8080 kudosity-mcp-http
# or
docker build -t kudosity-mcp . && docker run -p 8080:8080 -e KUDOSITY_MCP_PUBLIC_URL=https://mcp.example.com -e KUDOSITY_MCP_TOKEN_KEY="$(openssl rand -base64 32)" kudosity-mcp
```

Put it behind HTTPS (Claude only connects to `https://`). Then verify:

```bash
curl -s https://<your-host>/healthz
curl -s https://<your-host>/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

| Env var | Default | Description |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `KUDOSITY_MCP_PATH` | `/mcp` | MCP endpoint path |
| `KUDOSITY_MCP_PUBLIC_URL` | — | Public origin, e.g. `https://mcp.example.com`. Enables OAuth together with the token key. |
| `KUDOSITY_MCP_TOKEN_KEY` | — | Secret used to encrypt tokens (`openssl rand -base64 32`). Rotate to revoke all tokens. |
| `KUDOSITY_MCP_CONSENT_RATE_LIMIT` | `10` | Consent-page submissions per IP per minute |
| `KUDOSITY_HTTP_ALLOW_ENV_CREDENTIALS` | unset | `true` lets requests without credentials fall back to `KUDOSITY_API_KEY`/`_SECRET` from the server's environment. **Single-tenant only** — never on a shared or public host. |

## Usage examples

- *"Send an SMS to 61438333061 from KudosityDemo saying the order shipped."*
- *"Send the order_status_sample WhatsApp template to 61411122211."*
- *"List my delivered SMS from the last day."* / *"Show me inbound SMS replies."*
- *"Create a contact list called VIPs and add 61438333061."*
- *"Register a webhook at https://example.com/hook for SMS delivery status."*
- *"What's my account balance?"*
- *"Search the Kudosity API for anything about opt-outs."*

## Authentication

Kudosity has two API surfaces, and this server uses each where it's authoritative:

| Tools | Kudosity auth | Credentials |
|---|---|---|
| Messaging, webhooks, reporting | `x-api-key` header | API key |
| Contact lists, balance | HTTP Basic | API key + API secret |
| API discovery | none | — |

Locally, credentials are read from environment variables (or the extension's settings) and never written to disk. Remotely, they arrive per request in a header or an encrypted OAuth token, are used for that request, and are discarded. Treat them as secrets.

## Configuration (local)

| Env var | Required | Default | Description |
|---|---|---|---|
| `KUDOSITY_API_KEY` | yes | — | Your Kudosity API key |
| `KUDOSITY_API_SECRET` | for contacts/balance | — | Your Kudosity API secret |
| `KUDOSITY_API_BASE_URL` | no | `https://api.transmitmessage.com` | Override the v2 API base URL |
| `KUDOSITY_V1_BASE_URL` | no | `https://api.transmitsms.com` | Override the v1 API base URL |

## Privacy Policy

This software is a thin client for the Kudosity API. What it does with your data:

- **What it collects.** Only the inputs you give a tool — recipient numbers, message text, media URLs, list and webhook details — and the API credentials you supply. It reads nothing else from your device, your files, or your conversation.
- **How it is used and stored.** Inputs are sent to the Kudosity API over HTTPS to perform the requested action, and the API's response is returned to your AI client. The server stores nothing: no database, no logs of message content or credentials. Locally, credentials live in environment variables or your client's settings store. Remotely, they are carried in the request (a header, or an encrypted OAuth token that only the server's key can open) and discarded when the request completes.
- **Third parties.** Data goes to Kudosity's API (`api.transmitmessage.com`, `api.transmitsms.com`) and, for the discovery tools, public API specifications are fetched from `developers.kudosity.com`. Nothing is sent anywhere else. No analytics or telemetry.
- **Retention.** None by this software. Messages, contacts and account data are retained by Kudosity under the [Kudosity Privacy Policy](https://kudosity.com/legal/privacy-policy).
- **Contact.** [help.kudosity.com](https://help.kudosity.com) or [GitHub issues](https://github.com/kudosity/mcp/issues).

## Support

- Help centre and tickets: [help.kudosity.com](https://help.kudosity.com)
- Bugs and feature requests: [github.com/kudosity/mcp/issues](https://github.com/kudosity/mcp/issues)
- API documentation: [developers.kudosity.com](https://developers.kudosity.com/docs/mcp)

## Local development

```bash
git clone https://github.com/kudosity/mcp
cd mcp
npm install
npm run build
KUDOSITY_API_KEY=your_api_key npm start          # stdio
npm run start:http                                # streamable HTTP on :8080
```

```bash
npm test                        # build + mock tests: stdio, HTTP, OAuth (no credentials, no network)
node test/discovery-test.mjs    # live spec-discovery test (no credentials)
npm run build:mcpb              # Claude Desktop extension → dist-mcpb/
```

## License

[MIT](./LICENSE)
