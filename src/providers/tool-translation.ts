/**
 * Tool translation — converts our ToolSpec to the Vercel AI SDK v6 ToolSet.
 *
 * We intentionally do NOT set `execute` on any tool. External dispatch through
 * our permission engine happens after the SDK emits a `tool-call` part.
 */

import { jsonSchema, type ToolSet } from "ai";
import type { ToolSpec } from "../core/types.js";

/**
 * Converts an array of ToolSpec to a Vercel AI SDK v6 ToolSet.
 *
 * Each tool entry:
 *   - description: spec.description
 *   - inputSchema: jsonSchema(spec.inputSchema) — wraps the raw JSON Schema so
 *     the SDK treats it as an already-validated schema (no Zod required).
 *   - No `execute` field — we dispatch externally via NativeEngine.
 *
 * Note: ai v6 Tool uses `inputSchema` (not `parameters`) for the schema field.
 */
export function toolSpecsToVercelTools(tools: readonly ToolSpec[]): ToolSet {
  const toolSet: ToolSet = {};
  for (const spec of tools) {
    toolSet[spec.name] = {
      description: spec.description,
      // jsonSchema() from ai v6 wraps a raw JSON Schema object so streamText
      // accepts it without requiring a Zod schema.
      inputSchema: jsonSchema(spec.inputSchema as Parameters<typeof jsonSchema>[0]),
    };
  }
  return toolSet;
}
