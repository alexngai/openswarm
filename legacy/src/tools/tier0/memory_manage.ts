import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import { ToolAccesses } from "../access.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { executeCuratedAction, getCuratedMemoryLimits } from "../../memory/curated.js";

const inputSchema = z.object({
  action: z
    .enum(["add", "replace", "remove"])
    .describe("The action to perform on curated memory."),
  scope: z
    .enum(["project", "user"])
    .describe(
      "Memory scope. 'project' persists across sessions in the same project. " +
        "'user' persists across all sessions for this user.",
    ),
  entry: z
    .string()
    .min(1)
    .optional()
    .describe("The memory entry text. Required for 'add' action."),
  index: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based entry index. Required for 'replace' and 'remove' actions."),
  replacement: z
    .string()
    .min(1)
    .optional()
    .describe("Replacement text. Required for 'replace' action."),
});

type Input = z.infer<typeof inputSchema>;

const spec: ToolSpec = {
  name: "memory_manage",
  description:
    "Manage curated memory entries that persist across sessions. " +
    "Use 'add' to remember important facts, preferences, or decisions. " +
    "Use 'replace' to update an existing entry by index. " +
    "Use 'remove' to delete an obsolete entry by index. " +
    "Memory is bounded — remove stale entries to make room for new ones. " +
    "Returns the updated memory with numbered entries.",
  inputSchema: z.toJSONSchema(inputSchema) as JsonSchema,
  requiredPermission: "none",
  tier: 0,
  concurrencySafe: false,
};

async function execute(
  raw: unknown,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: Input = parsed.data;

  const scopeIdentifier =
    input.scope === "project" ? (ctx.cwd ?? "default") : "default";

  const result = executeCuratedAction({
    action: input.action,
    scope: input.scope,
    scopeIdentifier,
    entry: input.entry,
    index: input.index,
    replacement: input.replacement,
  });

  if (!result.ok) {
    return { status: "error", message: result.error };
  }

  const limits = getCuratedMemoryLimits();
  const maxChars =
    input.scope === "project" ? limits.projectMaxChars : limits.userMaxChars;
  const used = result.formatted.length;

  const header =
    result.entries.length === 0
      ? `${input.scope} memory is now empty.`
      : `${input.scope} memory (${result.entries.length} entries, ${used}/${maxChars} chars):`;

  const output = result.entries.length === 0 ? header : `${header}\n${result.formatted}`;

  return { status: "ok", output };
}

export const memoryManageTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
  accesses: () => ToolAccesses.all(),
};
