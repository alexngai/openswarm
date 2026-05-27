/**
 * task_output — Tier 2 tool.
 *
 * Polls partial or final output of a task. For running tasks returns a
 * snapshot of accumulated output so far. For completed tasks returns
 * the full output, status, usage, and wallClockMs.
 *
 * Real implementation: M3a Phase 4.
 */

import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { requireHost } from "./require-host.js";

const inputSchema = z.object({
  taskId: z.string().describe("Id of the task to query."),
});

type Input = z.infer<typeof inputSchema>;

// concurrencySafe: false — Tier 2 tools touch shared orchestrator state
// (task registry, inbox, role index, spawn parents, stdin, transports)
// that isn't reentrant under Promise.all dispatch.
const spec: ToolSpec = {
  name: "task_output",
  description:
    "Poll the output of a task. " +
    "If the task is still running, returns partial output accumulated so far. " +
    "If the task has completed, returns the full output, final status, usage, and wallClockMs. " +
    "Unknown taskId returns an error.",
  inputSchema: z.toJSONSchema(inputSchema) as JsonSchema,
  requiredPermission: "read",
  tier: 2,
  concurrencySafe: false,
};

async function execute(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const host = requireHost(ctx, "task_output");
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return { status: "error", message: parsed.error.message };
  const input: Input = parsed.data;

  const record = await host.task.get(input.taskId);
  if (record === undefined) {
    return { status: "error", message: `unknown taskId: ${input.taskId}` };
  }

  if (record.status === "running" || record.status === "pending") {
    return {
      status: "ok",
      output: JSON.stringify({
        status: "running",
        partialOutput: record.output ?? "",
        sizeBytes: (record.output ?? "").length,
      }),
    };
  }

  // Terminal state.
  return {
    status: "ok",
    output: JSON.stringify({
      status: record.status,
      output: record.output,
      usage: record.usage,
      wallClockMs: record.wallClockMs,
    }),
  };
}

export const taskOutputTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
