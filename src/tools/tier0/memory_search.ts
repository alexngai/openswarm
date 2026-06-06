import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import {
  searchArchive,
  listArchive,
  type ArchiveSearchResult,
} from "../../memory/archive.js";

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Search query to find relevant past sessions."),
  scope: z
    .enum(["sessions", "all"])
    .optional()
    .describe("What to search. 'sessions' searches archived session summaries. 'all' searches everything (default: 'all')."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Maximum number of results (1-20, default 5)."),
});

type Input = z.infer<typeof inputSchema>;

const spec: ToolSpec = {
  name: "memory_search",
  description:
    "Search past session archives and memories. " +
    "Use this to recall what happened in previous sessions, find past decisions, " +
    "or look up how a similar task was handled before. " +
    "Returns session summaries with tags and tools used.",
  inputSchema: z.toJSONSchema(inputSchema) as JsonSchema,
  requiredPermission: "none",
  tier: 0,
};

function formatResult(result: ArchiveSearchResult, index: number): string {
  const lines: string[] = [];
  lines.push(`${index + 1}. [${result.sessionId}] ${result.summary}`);
  if (result.tags.length > 0) {
    lines.push(`   Tags: ${result.tags.join(", ")}`);
  }
  if (result.toolsUsed.length > 0) {
    lines.push(`   Tools: ${result.toolsUsed.join(", ")}`);
  }
  lines.push(`   Date: ${result.createdAt}`);
  return lines.join("\n");
}

async function execute(
  raw: unknown,
  _ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: Input = parsed.data;
  const limit = input.limit ?? 5;

  const results = searchArchive(input.query, limit);

  if (results.length === 0) {
    return {
      status: "ok",
      output: `No archived sessions found matching: ${input.query}`,
    };
  }

  const formatted = results.map((r, i) => formatResult(r, i)).join("\n\n");
  return {
    status: "ok",
    output: `Found ${results.length} session${results.length === 1 ? "" : "s"} matching "${input.query}":\n\n${formatted}`,
  };
}

export const memorySearchTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
