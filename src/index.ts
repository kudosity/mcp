#!/usr/bin/env node
/**
 * stdio entry point — used by `npx kudosity-mcp`, the Claude Desktop extension
 * (.mcpb), Cursor, VS Code, Claude Code, and any other local MCP client.
 * Credentials come from the environment. For the HTTP transport see http.ts.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const apiKey = process.env.KUDOSITY_API_KEY;
if (!apiKey) {
  console.error(
    "Error: KUDOSITY_API_KEY environment variable is required.\n" +
      "Find your API key in the Kudosity platform under Settings → API Settings.",
  );
  process.exit(1);
}
// Optional — only needed for v1 tools (contact lists, balance).
const apiSecret = process.env.KUDOSITY_API_SECRET || undefined;

const server = createServer({ apiKey, apiSecret });
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Kudosity MCP server running on stdio.");
