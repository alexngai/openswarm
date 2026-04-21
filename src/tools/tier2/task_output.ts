/**
 * task_output — Tier 2 tool placeholder.
 *
 * Polls partial or final output of a task. For running tasks returns a
 * snapshot of accumulated output so far. For completed tasks returns
 * the full output, status, usage, and wallClockMs.
 *
 * Real implementation lands in M3a Phase 4.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";

const inputSchema = z.object({
  taskId: z.string().describe("Id of the task to query."),
});

const spec: ToolSpec = {
  name: "task_output",
  description:
    "Poll the output of a task. " +
    "If the task is still running, returns partial output accumulated so far. " +
    "If the task has completed, returns the full output, final status, usage, and wallClockMs. " +
    "Unknown taskId returns an error.",
  inputSchema: zodToJsonSchema(inputSchema as any) as JsonSchema,
  requiredPermission: "read",
  tier: 2,
};

async function execute(_raw: unknown, _ctx: ToolExecutionContext): Promise<ToolResult> {
  // TODO M3a Phase 4: implement via host.task.output() + task registry lookup.
  return { status: "error", message: "M3a Phase 4 — not yet implemented" };
}

export const taskOutputTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
