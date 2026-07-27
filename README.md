# Kudosity MCP Server

An installable [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI agents native tools to send **SMS, MMS and WhatsApp** messages, manage contacts and webhooks, and research the Kudosity API — powered by [Kudosity](https://kudosity.com).

Runs locally (or in your own infrastructure), authenticates with your Kudosity API key, and exposes one clean tool per action — so an agent calls `send_sms` instead of hand-building HTTP requests.

## Tools

**Messaging**

| Tool | Type | Description |
|---|---|---|
| `send_sms` | write | Send an SMS to a recipient |
| `send_mms` | write | Send an MMS with a media attachment |
| `send_whatsapp` | write | Send a WhatsApp message (free-form text or approved template) |
| `get_message` | read | Get a sent message and its status by channel + ID |
| `list_messages` | read | List sent/received messages with delivery status; filter by status, direction (sent/replies), recipient, dates |

**Webhooks**

| Tool | Type | Description |
|---|---|---|
| `create_webhook` | write | Register an HTTPS webhook for delivery status, inbound messages, link hits, opt-outs |
| `list_webhooks` | read | List configured webhooks |
| `delete_webhook` | write | Delete a webhook by ID |

**Contacts & lists** *(require `KUDOSITY_API_SECRET`)*

| Tool | Type | Description |
|---|---|---|
| `create_list` | write | Create a contact list |
| `get_lists` | read | List all contact lists |
| `get_list` | read | Get a list and optionally its members |
| `add_contact_to_list` | write | Add a contact to a list |
| `remove_contact_from_list` | write | Remove a contact from a list |
| `delete_list` | write | Delete a contact list |

**Account** *(requires `KUDOSITY_API_SECRET`)*

| Tool | Type | Description |
|---|---|---|
| `get_balance` | read | Get your account balance |

**API discovery** — research the whole Kudosity API, always current

| Tool | Type | Description |
|---|---|---|
| `list_specs` | read | List the Kudosity API specifications |
| `list_endpoints` | read | List all endpoints for a spec |
| `search_endpoints` | read | Search the API by keyword |
| `get_endpoint` | read | Get full detail for one endpoint |

The discovery tools read the live specs from `developers.kudosity.com`, so they always reflect the latest published docs.

## Requirements

- Node.js 18+
- A Kudosity account and API key — **Settings → API Settings** in the Kudosity platform
- For contact and balance tools, also your API **secret** (same settings page)

## Install & configure

Runs via `npx` — no clone required.

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "kudosity": {
      "command": "npx",
      "args": ["-y", "@kudosity/mcp"],
      "env": {
        "KUDOSITY_API_KEY": "your_api_key",
        "KUDOSITY_API_SECRET": "your_api_secret"
      }
    }
  }
}
```

`KUDOSITY_API_SECRET` is optional — omit it if you only need messaging, webhooks, and discovery. It's required for the contact-list and balance tools.

### Cursor — `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "kudosity": {
      "command": "npx",
      "args": ["-y", "@kudosity/mcp"],
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
      "args": ["-y", "@kudosity/mcp"],
      "env": { "KUDOSITY_API_KEY": "your_api_key", "KUDOSITY_API_SECRET": "your_api_secret" }
    }
  }
}
```

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

| Tools | Auth | Credentials |
|---|---|---|
| Messaging, webhooks, discovery | `x-api-key` header | `KUDOSITY_API_KEY` |
| Contact lists, balance | HTTP Basic | `KUDOSITY_API_KEY` + `KUDOSITY_API_SECRET` |

Credentials are read from environment variables and never written to disk. Treat them as secrets.

## Configuration

| Env var | Required | Default | Description |
|---|---|---|---|
| `KUDOSITY_API_KEY` | yes | — | Your Kudosity API key |
| `KUDOSITY_API_SECRET` | for contacts/balance | — | Your Kudosity API secret |
| `KUDOSITY_API_BASE_URL` | no | `https://api.transmitmessage.com` | Override the v2 API base URL |
| `KUDOSITY_V1_BASE_URL` | no | `https://api.transmitsms.com` | Override the v1 API base URL |

## Local development

```bash
git clone https://github.com/kudosity/mcp
cd mcp
npm install
npm run build
KUDOSITY_API_KEY=your_api_key npm start
```

Test tool listing with the MCP Inspector, or run the checks:

```bash
npm test              # mock integration tests (no credentials)
node test/discovery-test.mjs   # live spec-discovery test (no credentials)
```

## License

[MIT](./LICENSE)
