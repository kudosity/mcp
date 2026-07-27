#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { KudosityClient } from "./kudosity.js";
import { loadSpecs, forEachOperation } from "./specs.js";

const apiKey = process.env.KUDOSITY_API_KEY;
if (!apiKey) {
  console.error(
    "Error: KUDOSITY_API_KEY environment variable is required.\n" +
      "Find your API key in the Kudosity platform under Settings → API Settings.",
  );
  process.exit(1);
}
// Optional — only needed for v1 tools (contact lists, balance).
const apiSecret = process.env.KUDOSITY_API_SECRET;

const kudosity = new KudosityClient(apiKey, apiSecret);
const server = new McpServer({ name: "kudosity", version: "0.5.0" });

const asText = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

const EVENT_TYPES = [
  "LINK_HIT", "OPT_OUT", "SMS_STATUS", "SMS_INBOUND", "MMS_STATUS", "MMS_INBOUND",
  "WHATSAPP_STATUS", "WHATSAPP_INBOUND", "RCS_STATUS", "RCS_INBOUND",
] as const;

// ── send_sms ────────────────────────────────────────────────────────────────
server.registerTool(
  "send_sms",
  {
    title: "Send SMS",
    description: "Send an SMS text message to a single recipient via Kudosity.",
    inputSchema: {
      recipient: z.string().describe("Destination number in E.164 international format, e.g. 61438333061."),
      sender: z.string().describe("Sender number, or an alphanumeric ID (max 11 chars) registered to your account."),
      message: z.string().describe("Message body. Long messages are automatically split into multiple parts."),
      message_ref: z.string().max(500).optional().describe("Your own reference; echoed back in webhook events."),
      track_links: z.boolean().optional().describe("Replace links with shortened, tracked links."),
    },
    annotations: { title: "Send SMS", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async (args) => asText(await kudosity.v2("POST", "/v2/sms", args)),
);

// ── send_mms ────────────────────────────────────────────────────────────────
server.registerTool(
  "send_mms",
  {
    title: "Send MMS",
    description: "Send an MMS (media) message to a recipient via Kudosity.",
    inputSchema: {
      recipient: z.string().describe("Destination number in E.164 format. Australia only at present."),
      sender: z.string().describe("Sender number registered to your account."),
      content_urls: z.array(z.string().url()).min(1).describe("Absolute URL(s) to media. One image up to 400KB. jpg, gif, png, mp3, mp4."),
      subject: z.string().max(20).optional().describe("Subject line, max 20 ASCII characters."),
      message: z.string().optional().describe("Message body, max 1000 characters."),
      message_ref: z.string().max(500).optional().describe("Your reference; echoed in webhooks."),
      track_links: z.boolean().optional().describe("Shorten and track links in the message."),
    },
    annotations: { title: "Send MMS", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async (args) => asText(await kudosity.v2("POST", "/v2/mms", args)),
);

// ── send_whatsapp ─────────────────────────────────────────────────────────────
server.registerTool(
  "send_whatsapp",
  {
    title: "Send WhatsApp message",
    description:
      "Send a WhatsApp message via Kudosity — either free-form text (only within an open 24h " +
      "customer-service window) or a pre-approved template (sendable anytime).",
    inputSchema: {
      recipient: z.string().describe("Recipient WhatsApp number in E.164 format, e.g. 61411122211."),
      content_type: z.enum(["text", "template"]).describe("'text' for free-form; 'template' for a pre-approved WhatsApp template."),
      text: z.string().optional().describe("Message body — required when content_type is 'text'."),
      template_name: z.string().optional().describe("Approved template name — required when content_type is 'template'."),
      template_parameters: z.array(z.string()).optional().describe("Ordered values that fill the template's placeholders."),
      template_locale: z.string().optional().describe("Template locale, e.g. en_US. Defaults to 'en'."),
      sender: z.string().optional().describe("Registered WhatsApp sender number. Optional if the account has a single sender."),
      message_ref: z.string().max(500).optional().describe("Your reference; echoed in webhooks."),
    },
    annotations: { title: "Send WhatsApp message", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async (a) => {
    let content: Record<string, unknown>;
    if (a.content_type === "text") {
      if (!a.text) throw new Error("`text` is required when content_type is 'text'.");
      content = { text: { message: a.text } };
    } else {
      if (!a.template_name) throw new Error("`template_name` is required when content_type is 'template'.");
      const template: Record<string, unknown> = { name: a.template_name, locale: a.template_locale ?? "en" };
      if (a.template_parameters && a.template_parameters.length) template.parameters = a.template_parameters;
      content = { template };
    }
    const body: Record<string, unknown> = { recipient: a.recipient, content_type: a.content_type, content };
    if (a.sender) body.sender = a.sender;
    if (a.message_ref) body.message_ref = a.message_ref;
    return asText(await kudosity.v2("POST", "/v2/whatsapp/messages", body));
  },
);

// ── get_message ───────────────────────────────────────────────────────────────
server.registerTool(
  "get_message",
  {
    title: "Get message",
    description: "Retrieve a previously sent message and its current status by channel and ID.",
    inputSchema: {
      channel: z.enum(["sms", "mms", "whatsapp"]).describe("The channel the message was sent on."),
      id: z.string().describe("The message ID returned when the message was sent."),
    },
    annotations: { title: "Get message", readOnlyHint: true, openWorldHint: true },
  },
  async ({ channel, id }) => asText(await kudosity.v2("GET", `/v2/${channel}/${id}`)),
);

// ── create_webhook ─────────────────────────────────────────────────────────────
server.registerTool(
  "create_webhook",
  {
    title: "Create webhook",
    description: "Register a webhook (HTTPS URL) to receive event callbacks — delivery status, inbound messages, link hits, opt-outs.",
    inputSchema: {
      name: z.string().min(2).max(100).describe("A name for the webhook."),
      url: z.string().url().describe("HTTPS URL that will receive JSON POST callbacks."),
      event_types: z.array(z.enum(EVENT_TYPES)).optional().describe("Event types to subscribe to. Omit to receive all."),
      senders: z.array(z.string()).optional().describe("Only fire for these sender numbers."),
      statuses: z.array(z.string()).optional().describe("Only fire for these statuses (status events only), e.g. DELIVERED, FAILED."),
      rate_limit: z.number().int().min(0).max(10000).optional().describe("Max callbacks per second (0 = system default)."),
    },
    annotations: { title: "Create webhook", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async (a) => {
    const filter: Record<string, unknown> = {};
    if (a.event_types?.length) filter.event_type = a.event_types;
    if (a.senders?.length) filter.sender = a.senders;
    if (a.statuses?.length) filter.status = a.statuses;
    const body: Record<string, unknown> = { name: a.name, url: a.url };
    if (Object.keys(filter).length) body.filter = filter;
    if (a.rate_limit !== undefined) body.rate_limit = a.rate_limit;
    return asText(await kudosity.v2("POST", "/v2/webhook", body));
  },
);

// ── list_webhooks ──────────────────────────────────────────────────────────────
server.registerTool(
  "list_webhooks",
  {
    title: "List webhooks",
    description: "List all webhooks configured on your account.",
    inputSchema: {},
    annotations: { title: "List webhooks", readOnlyHint: true, openWorldHint: true },
  },
  async () => asText(await kudosity.v2("GET", "/v2/webhook")),
);

// ── delete_webhook ─────────────────────────────────────────────────────────────
server.registerTool(
  "delete_webhook",
  {
    title: "Delete webhook",
    description: "Delete a webhook by its ID.",
    inputSchema: { id: z.string().describe("The webhook ID to delete.") },
    annotations: { title: "Delete webhook", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ id }) => asText(await kudosity.v2("DELETE", `/v2/webhook/${id}`)),
);

// ── get_balance (v1 — requires KUDOSITY_API_SECRET) ────────────────────────────
server.registerTool(
  "get_balance",
  {
    title: "Get account balance",
    description: "Get your Kudosity account balance. Requires KUDOSITY_API_SECRET (v1 Basic auth).",
    inputSchema: {},
    annotations: { title: "Get account balance", readOnlyHint: true, openWorldHint: true },
  },
  async () => asText(await kudosity.v1("GET", "/get-balance.json")),
);

// ── Contact lists (v1 — require KUDOSITY_API_SECRET) ───────────────────────────
server.registerTool(
  "create_list",
  {
    title: "Create contact list",
    description: "Create a new contact list. Requires KUDOSITY_API_SECRET (v1 auth).",
    inputSchema: { name: z.string().describe("A unique name for the list.") },
    annotations: { title: "Create contact list", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ name }) => asText(await kudosity.v1("POST", "/add-list.json", { name })),
);

server.registerTool(
  "get_lists",
  {
    title: "Get contact lists",
    description: "List all contact lists on your account. Requires KUDOSITY_API_SECRET (v1 auth).",
    inputSchema: {},
    annotations: { title: "Get contact lists", readOnlyHint: true, openWorldHint: true },
  },
  async () => asText(await kudosity.v1("GET", "/get-lists.json")),
);

server.registerTool(
  "get_list",
  {
    title: "Get contact list",
    description: "Get a contact list, optionally including its members. Requires KUDOSITY_API_SECRET (v1 auth).",
    inputSchema: {
      list_id: z.number().int().describe("Numeric list ID."),
      members: z.boolean().optional().describe("Include member contacts in the response."),
    },
    annotations: { title: "Get contact list", readOnlyHint: true, openWorldHint: true },
  },
  async ({ list_id, members }) => {
    const form: Record<string, string> = { list_id: String(list_id) };
    if (members) form.members = "true";
    return asText(await kudosity.v1("POST", "/get-list.json", form));
  },
);

server.registerTool(
  "add_contact_to_list",
  {
    title: "Add contact to list",
    description: "Add a contact (mobile number) to a list. Requires KUDOSITY_API_SECRET (v1 auth).",
    inputSchema: {
      list_id: z.number().int().describe("Numeric ID of the list to add to."),
      number: z.string().describe("Mobile number in E.164 format (or local with country_code)."),
      first_name: z.string().optional().describe("Contact first name."),
      last_name: z.string().optional().describe("Contact last name."),
      country_code: z.string().optional().describe("2-letter ISO country code to format a local number, e.g. AU."),
    },
    annotations: { title: "Add contact to list", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async (a) => {
    const form: Record<string, string> = { list_id: String(a.list_id), msisdn: a.number };
    if (a.first_name) form.first_name = a.first_name;
    if (a.last_name) form.last_name = a.last_name;
    if (a.country_code) form.countrycode = a.country_code;
    return asText(await kudosity.v1("POST", "/add-to-list.json", form));
  },
);

server.registerTool(
  "remove_contact_from_list",
  {
    title: "Remove contact from list",
    description: "Remove a contact from a list (list_id 0 = remove from all lists). Requires KUDOSITY_API_SECRET (v1 auth).",
    inputSchema: {
      number: z.string().describe("Mobile number in E.164 format."),
      list_id: z.number().int().optional().describe("List ID to remove from. 0 removes from all lists."),
      country_code: z.string().optional().describe("2-letter ISO country code for a local number."),
    },
    annotations: { title: "Remove contact from list", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async (a) => {
    const form: Record<string, string> = { msisdn: a.number };
    if (a.list_id !== undefined) form.list_id = String(a.list_id);
    if (a.country_code) form.countrycode = a.country_code;
    return asText(await kudosity.v1("POST", "/delete-from-list.json", form));
  },
);

server.registerTool(
  "delete_list",
  {
    title: "Delete contact list",
    description: "Delete a contact list by ID. Requires KUDOSITY_API_SECRET (v1 auth).",
    inputSchema: { list_id: z.number().int().describe("Numeric list ID to delete.") },
    annotations: { title: "Delete contact list", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ list_id }) => asText(await kudosity.v1("POST", "/remove-list.json", { list_id: String(list_id) })),
);

// ── Tier-1: reporting & replies ────────────────────────────────────────────────
const MESSAGE_STATUSES = [
  "PENDING", "SENT", "DELIVERED", "FAILED", "ACCEPTED", "SOFT_BOUNCE", "HARD_BOUNCE",
  "REJECTED", "UNDELIVERABLE", "READ", "OTHER",
] as const;
const LIST_PATHS: Record<string, string> = { sms: "/v2/sms", whatsapp: "/v2/whatsapp/messages" };

server.registerTool(
  "list_messages",
  {
    title: "List messages",
    description:
      "List sent or received messages with their delivery status. Filter by status, recipient, direction " +
      "(OUT = sent, IN = inbound replies), and date range. This is the delivery-report and reply view.",
    inputSchema: {
      channel: z.enum(["sms", "whatsapp"]).describe("Channel to list (MMS has no list endpoint; use get_message by id)."),
      status: z.enum(MESSAGE_STATUSES).optional().describe("Only messages with this status, e.g. DELIVERED, FAILED."),
      direction: z.enum(["OUT", "IN"]).optional().describe("OUT = messages you sent; IN = inbound replies."),
      recipient: z.string().optional().describe("Filter by recipient number."),
      sender: z.string().optional().describe("Filter by sender number."),
      start_date: z.string().optional().describe("Only messages created on/after this RFC3339 datetime."),
      end_date: z.string().optional().describe("Only messages created on/before this RFC3339 datetime."),
      limit: z.number().int().min(1).max(1000).optional().describe("Max results (default 100)."),
    },
    annotations: { title: "List messages", readOnlyHint: true, openWorldHint: true },
  },
  async (a) => {
    const p = new URLSearchParams();
    for (const k of ["status", "direction", "recipient", "sender", "start_date", "end_date"] as const) {
      if (a[k]) p.set(k, a[k] as string);
    }
    if (a.limit !== undefined) p.set("limit", String(a.limit));
    const qs = p.toString();
    return asText(await kudosity.v2("GET", `${LIST_PATHS[a.channel]}${qs ? `?${qs}` : ""}`));
  },
);

// ── API discovery (reads the live specs from the Kudosity developer portal) ────
// These let a user research the full Kudosity API — every endpoint, not just the
// tools above. Specs are fetched live so they always reflect the latest docs.

server.registerTool(
  "list_specs",
  {
    title: "List API specs",
    description: "List the available Kudosity API specifications and how many endpoints each has. Use this to see what the Kudosity platform can do beyond the built-in tools.",
    inputSchema: {},
    annotations: { title: "List API specs", readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    const specs = await loadSpecs();
    const out = Object.entries(specs).map(([title, s]) => ({
      title,
      version: s.info?.version,
      description: (s.info?.description || "").replace(/\s+/g, " ").slice(0, 400),
      server: s.servers?.[0]?.url,
      endpoints: Object.keys(s.paths || {}).length,
    }));
    return asText(out);
  },
);

server.registerTool(
  "list_endpoints",
  {
    title: "List API endpoints",
    description: "List all endpoints (path + method + summary) for a given Kudosity API spec. Use list_specs first to get spec titles.",
    inputSchema: {
      spec: z.string().describe("Spec title, e.g. 'Transmit Message API' or 'Transmit SMS API'."),
    },
    annotations: { title: "List API endpoints", readOnlyHint: true, openWorldHint: true },
  },
  async ({ spec }) => {
    const specs = await loadSpecs();
    if (!specs[spec]) return asText({ error: `Unknown spec '${spec}'. Use list_specs to see available specs.` });
    const out: unknown[] = [];
    forEachOperation(specs, (m) => out.push({ path: m.path, method: m.method, summary: m.summary }), spec);
    return asText(out);
  },
);

server.registerTool(
  "search_endpoints",
  {
    title: "Search API endpoints",
    description: "Search the Kudosity API for endpoints matching a keyword — across paths, summaries, descriptions, tags and parameters. Use this to discover what the API can do.",
    inputSchema: {
      query: z.string().describe("Keyword to search for, e.g. 'delivery', 'opt out', 'balance'."),
      spec: z.string().optional().describe("Optional spec title to limit the search."),
    },
    annotations: { title: "Search API endpoints", readOnlyHint: true, openWorldHint: true },
  },
  async ({ query, spec }) => {
    const specs = await loadSpecs();
    const q = query.toLowerCase();
    const out: unknown[] = [];
    forEachOperation(
      specs,
      (m) => {
        const hay = [m.path, m.op.summary, m.op.description, (m.op.tags || []).join(" "), JSON.stringify(m.op.parameters || m.op.requestBody || "")]
          .join(" ")
          .toLowerCase();
        if (hay.includes(q)) out.push({ spec: m.spec, path: m.path, method: m.method, summary: m.op.summary });
      },
      spec,
    );
    return asText(out.slice(0, 50));
  },
);

server.registerTool(
  "get_endpoint",
  {
    title: "Get endpoint details",
    description: "Get the full details of one Kudosity API endpoint — description, parameters, request body schema, and auth. Use search_endpoints or list_endpoints first.",
    inputSchema: {
      spec: z.string().describe("Spec title, e.g. 'Transmit Message API'."),
      path: z.string().describe("The endpoint path, e.g. '/v2/sms'."),
      method: z.string().describe("HTTP method, e.g. 'POST'."),
    },
    annotations: { title: "Get endpoint details", readOnlyHint: true, openWorldHint: true },
  },
  async ({ spec, path, method }) => {
    const specs = await loadSpecs();
    const s = specs[spec];
    if (!s) return asText({ error: `Unknown spec '${spec}'. Use list_specs.` });
    const op = s.paths?.[path]?.[method.toLowerCase()];
    if (!op) return asText({ error: `No ${method.toUpperCase()} ${path} in '${spec}'. Use list_endpoints.` });
    return asText({
      spec,
      path,
      method: method.toUpperCase(),
      server: s.servers?.[0]?.url,
      summary: op.summary,
      description: op.description,
      parameters: op.parameters,
      requestBody: op.requestBody,
      security: op.security,
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Kudosity MCP server running on stdio.");
