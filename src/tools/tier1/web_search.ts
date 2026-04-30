import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolImpl } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";

const inputSchema = z.object({
  query: z.string().min(1),
  num_results: z.number().int().min(1).max(20).optional(),
});

const spec: ToolSpec = {
  name: "web_search",
  description: "Search the web. Returns ranked results with titles, URLs, and snippets.",
  inputSchema: zodToJsonSchema(inputSchema as never) as JsonSchema,
  requiredPermission: "network",
  tier: 1,
};

/**
 * web_search is implemented by the Anthropic SDK's built-in WebSearch
 * tool, enabled via RunConfig.enabledBuiltinTools = ["WebSearch"]
 * (see Phase 2.5 engine surgery). The model's calls are intercepted
 * by the SDK before reaching our MCP dispatcher — this execute fn
 * should never actually run in production.
 *
 * This ToolImpl exists for registry symmetry so buildTier1Tools()
 * returns a complete catalog for discovery and UI listing.
 */
export const webSearchTool: ToolImpl = {
  spec,
  zodSchema: inputSchema,
  execute: async () => ({
    status: "error",
    message:
      "web_search should be handled by the SDK built-in; if you see this, the engine is misconfigured (RunConfig.enabledBuiltinTools missing 'WebSearch')",
  }),
};
