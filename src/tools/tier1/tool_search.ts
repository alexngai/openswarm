/**
 * Tool search (F3): dynamic tool discovery for the agent.
 *
 * Allows the model to search available tools by name or description
 * keywords. Returns matching tool specs with their descriptions and
 * input schemas. Useful when the agent isn't sure which tool to use.
 */

import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";

const inputSchema = z.object({
  query: z.string().describe("Search query — matched against tool names and descriptions"),
  maxResults: z.number().int().positive().optional().default(10),
});

type Input = z.infer<typeof inputSchema>;

const spec: ToolSpec = {
  name: "tool_search",
  description:
    "Search available tools by name or description keyword. " +
    "Returns matching tools with their descriptions and parameter schemas. " +
    "Use when you're not sure which tool to use for a task.",
  inputSchema: z.toJSONSchema(inputSchema) as JsonSchema,
  requiredPermission: "none",
  tier: 1,
};

let _toolRegistry: readonly ToolSpec[] = [];

/**
 * Populate the searchable registry. Called by the runtime assembly once the
 * full tool surface is registered on the dispatcher: `buildAgentRuntime()`
 * (tier0 + tier1 + plugins + MCP) and the worker entry (tier0 + tier2,
 * post-allowlist). Per-process singleton — orchestrator and workers are
 * separate processes with independent surfaces.
 */
export function setToolRegistry(tools: readonly ToolSpec[]): void {
  _toolRegistry = tools;
}

function scoreMatch(query: string, tool: ToolSpec): number {
  const q = query.toLowerCase();
  const name = tool.name.toLowerCase();
  const desc = (tool.description ?? "").toLowerCase();

  let score = 0;

  if (name === q) score += 100;
  else if (name.includes(q)) score += 50;

  const words = q.split(/\s+/);
  for (const word of words) {
    if (word.length < 2) continue;
    if (name.includes(word)) score += 20;
    if (desc.includes(word)) score += 10;
  }

  return score;
}

async function execute(raw: unknown, _ctx: ToolExecutionContext): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: Input = parsed.data;

  const scored = _toolRegistry
    .map((tool) => ({ tool, score: scoreMatch(input.query, tool) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.maxResults);

  if (scored.length === 0) {
    return {
      status: "ok",
      output: `No tools found matching "${input.query}". Available tools: ${_toolRegistry.map((t) => t.name).join(", ")}`,
    };
  }

  const lines = scored.map(({ tool }) => {
    const params = tool.inputSchema
      ? Object.keys((tool.inputSchema as Record<string, unknown>).properties ?? {}).join(", ")
      : "none";
    return `- **${tool.name}** (tier ${tool.tier}, requires: ${tool.requiredPermission})\n  ${tool.description ?? "No description"}\n  Parameters: ${params}`;
  });

  return { status: "ok", output: lines.join("\n\n") };
}

export const toolSearchTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
