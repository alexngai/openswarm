/**
 * commit_changes — v0.7 stage 7B.
 *
 * Routes a git commit through git-cascade's tracker.commitChanges so the
 * commit gets a stable Change-Id trailer + audit-log entry. Only works
 * when the agent is operating inside a stream/fork worktree (i.e. the
 * member's branchPolicy was kind:"stream" or kind:"fork" at spawn AND
 * --git-cascade was enabled).
 *
 * Returns the new commit's sha + Change-Id as JSON, or the literal string
 * "null" when the agent isn't in a stream context — caller can fall back
 * to plain `git commit` via the bash tool for those cases.
 */

import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { requireHost } from "./require-host.js";

const inputSchema = z.object({
  message: z.string().min(1),
  /**
   * Free-form metadata threaded into the cascade/stream.committed event.
   * The tracker doesn't interpret it — observers can use it to correlate
   * commits with external concepts (task ids, run ids, etc.).
   */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

type Input = z.infer<typeof inputSchema>;

const spec: ToolSpec = {
  name: "commit_changes",
  description:
    "Commit changes in your worktree via git-cascade — adds Change-Id " +
    "trailer + audit-log entry. Returns {streamId, commitSha, changeId} " +
    'as JSON, or the literal string "null" when not in a stream context ' +
    "(then fall back to `git commit` via the bash tool).",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: z.toJSONSchema(inputSchema) as JsonSchema,
  requiredPermission: "exec",
  tier: 2,
  concurrencySafe: false,
};

async function execute(
  raw: unknown,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const host = requireHost(ctx, "commit_changes");
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: Input = parsed.data;

  const result = await host.commitChanges(input.message, input.metadata);
  if (result === null) {
    return { status: "ok", output: "null" };
  }
  return { status: "ok", output: JSON.stringify(result) };
}

export const commitChangesTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
