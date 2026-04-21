/**
 * MCP → ToolImpl bridge.
 *
 * Each discovered MCP tool is wrapped as a first-class ToolImpl the dispatcher
 * can register, respecting the tool-name policy from rev-2 Major M4:
 *
 *   mcp__<serverName>__<toolName>
 *
 * Permission gating (rev-2 Major M3): if the tool name matches the read-only
 * whitelist pattern (list_*, get_*, read_*, search_*, describe/discover/inspect),
 * `requiredPermission` is "none"; otherwise "write". Under read-only mode the
 * permission engine allows tools marked "none" without prompting; workspace-write
 * and danger-full-access modes flow through `canUseTool` like any other tool.
 */

import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../tools/types.js";
import type { ToolSpec, JsonSchema } from "../core/types.js";
import type { McpStdioClient, McpToolDescriptor } from "./client.js";

// ---------------------------------------------------------------------------
// Read-only MCP tool classifier (rev-2 Major M3)
// ---------------------------------------------------------------------------

/**
 * Returns true if the (un-prefixed) MCP tool name matches a read-only pattern
 * and can safely run under `read-only` permission mode without prompting.
 *
 * Matchers:
 *   - prefix: list_, get_, read_, search_
 *   - substring: describe, discover, inspect (case-insensitive)
 *
 * The prefix/substring intentionally accepts both snake_case and camelCase
 * (getFoo, listBar) — MCP ecosystem uses both conventions.
 */
export function isReadOnlyMcpTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();

  // Prefix match: list_*, list*, get_*, get*, read_*, read*, search_*, search*
  const prefixes = ["list", "get", "read", "search"];
  for (const p of prefixes) {
    if (lower === p) return true;
    if (lower.startsWith(`${p}_`)) return true;
    // camelCase: getFoo, listBar — next char after prefix must be uppercase in original
    if (lower.startsWith(p) && lower.length > p.length) {
      const origNext = toolName.charAt(p.length);
      if (origNext >= "A" && origNext <= "Z") return true;
    }
  }

  // Substring markers.
  if (lower.includes("describe")) return true;
  if (lower.includes("discover")) return true;
  if (lower.includes("inspect")) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Build ToolImpl for an MCP tool descriptor
// ---------------------------------------------------------------------------

/**
 * Build a ToolImpl that dispatches to the given MCP tool over the client.
 * Name policy: `mcp__<serverName>__<descriptor.name>`.
 */
export function buildMcpToolImpl(
  client: McpStdioClient,
  descriptor: McpToolDescriptor,
): ToolImpl {
  const readOnly = isReadOnlyMcpTool(descriptor.name);

  const inputSchema: JsonSchema =
    (descriptor.inputSchema && typeof descriptor.inputSchema === "object"
      ? (descriptor.inputSchema as JsonSchema)
      : { type: "object" });

  const spec: ToolSpec = {
    name: `mcp__${client.serverName}__${descriptor.name}`,
    description: descriptor.description || `MCP tool from ${client.serverName}`,
    inputSchema,
    requiredPermission: readOnly ? "none" : "write",
    tier: 4,
  };

  return {
    spec,
    // Lenient local validation — the MCP server re-validates against its
    // published inputSchema, so wrap everything as unknown.
    zodSchema: z.unknown(),
    execute: async (
      input: unknown,
      _ctx: ToolExecutionContext,
    ): Promise<ToolResult> => {
      try {
        const raw = await client.callTool(descriptor.name, input);
        return mapResult(raw);
      } catch (err) {
        return {
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Result mapping
// ---------------------------------------------------------------------------

/**
 * Map an SDK CallToolResult into our ToolResult shape.
 *
 * CallToolResult shape (MCP spec):
 *   { content: Array<{type:"text"|"image"|...; text?; data?; ...}>, isError?: boolean }
 * or the legacy compatibility shape:
 *   { toolResult: unknown }
 *
 * We stringify non-text content conservatively — the model sees a textual
 * rendering only. Binary/image content is described as `[image: <mimeType>]`
 * rather than base64-inlined (to keep transcripts small).
 */
function mapResult(raw: unknown): ToolResult {
  if (raw === null || typeof raw !== "object") {
    return { status: "ok", output: String(raw ?? "") };
  }

  const obj = raw as Record<string, unknown>;

  const isError = obj.isError === true;

  if (Array.isArray(obj.content)) {
    const parts: string[] = [];
    for (const item of obj.content) {
      if (item === null || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      const type = typeof it.type === "string" ? it.type : "";
      if (type === "text" && typeof it.text === "string") {
        parts.push(it.text);
      } else if (type === "image") {
        const mime = typeof it.mimeType === "string" ? it.mimeType : "unknown";
        parts.push(`[image: ${mime}]`);
      } else if (type === "resource") {
        parts.push(`[resource: ${JSON.stringify(it.resource ?? null)}]`);
      } else {
        parts.push(JSON.stringify(it));
      }
    }
    const output = parts.join("\n");
    return isError
      ? { status: "error", message: output || "mcp tool reported an error" }
      : { status: "ok", output };
  }

  // Legacy compatibility shape.
  if ("toolResult" in obj) {
    const tr = obj.toolResult;
    const output = typeof tr === "string" ? tr : JSON.stringify(tr);
    return isError
      ? { status: "error", message: output }
      : { status: "ok", output };
  }

  // Fallback: JSON-encode the whole result.
  const output = JSON.stringify(obj);
  return isError
    ? { status: "error", message: output }
    : { status: "ok", output };
}
