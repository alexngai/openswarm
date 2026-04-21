#!/usr/bin/env node
/**
 * Mock MCP server used by the McpStdioClient tests.
 *
 * Exposes two tools:
 *   - get_time  (read-only pattern): returns ISO timestamp.
 *   - echo      (writey): returns the input.
 *
 * Uses the low-level Server + setRequestHandler API. The SDK resolves imports
 * via the parent project's `node_modules` (this fixture has no deps of its own).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "mock-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_time",
      description: "Returns the current ISO timestamp.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "echo",
      description: "Returns the value it was sent.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
    },
    {
      name: "boom",
      description: "Always errors (for error-path tests).",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  switch (name) {
    case "get_time": {
      return {
        content: [{ type: "text", text: new Date().toISOString() }],
      };
    }
    case "echo": {
      const msg = args && typeof args === "object" ? args.message : "";
      return {
        content: [{ type: "text", text: String(msg ?? "") }],
      };
    }
    case "boom": {
      return {
        content: [{ type: "text", text: "mock error" }],
        isError: true,
      };
    }
    default:
      return {
        content: [{ type: "text", text: `unknown tool: ${name}` }],
        isError: true,
      };
  }
});

await server.connect(new StdioServerTransport());
