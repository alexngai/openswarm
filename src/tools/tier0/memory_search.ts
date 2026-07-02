import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import {
  searchArchive,
  type ArchiveSearchResult,
} from "../../memory/archive.js";
import { getMemoryCoordinator } from "../../memory/coordinator.js";

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Search query to find relevant past sessions."),
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

  // Phase 3 B2 — fan the query out to the coordinator's search-capable
  // providers (minimem hybrid search, file session archive). Results are
  // grouped by provider with source labels, no cross-provider ranking
  // (decision Q5).
  const coordinator = getMemoryCoordinator();
  if (coordinator.searchProviderNames.length > 0) {
    const groups = await coordinator.search(input.query, { limit });
    if (groups.length === 0) {
      return {
        status: "ok",
        output: `No memories found matching: ${input.query}`,
      };
    }
    const sections = groups.map((group) => {
      const items = group.fragments
        .map((f, i) => `${i + 1}. [${f.source}]\n${f.content}`)
        .join("\n\n");
      return `## ${group.provider}\n\n${items}`;
    });
    const total = groups.reduce((n, g) => n + g.fragments.length, 0);
    return {
      status: "ok",
      output: `Found ${total} result${total === 1 ? "" : "s"} matching "${input.query}" (grouped by provider):\n\n${sections.join("\n\n")}`,
    };
  }

  // No search-capable providers registered (e.g. before session start) —
  // fall back to the archive store directly.
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
