/**
 * task_stop — Tier 2 tool placeholder.
 *
 * Stops a running task. Orchestrators can stop any task; peer workers can
 * only stop tasks they (transitively) spawned (ancestry check).
 *
 * Real implementation lands in M3a Phase 4.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";

const inputSchema = z.object({
  taskId: z.string().describe("Id of the task to stop."),
});

const spec: ToolSpec = {
  name: "task_stop",
  description:
    "Stop a running task. " +
    "Orchestrators can stop any task unconditionally. " +
    "Worker agents can only stop tasks they (transitively) spawned — " +
    "attempting to stop an unrelated task returns a permission error.",
  inputSchema: zodToJsonSchema(inputSchema as any) as JsonSchema,
  requiredPermission: "exec",
  tier: 2,
};

async function execute(_raw: unknown, _ctx: ToolExecutionContext): Promise<ToolResult> {
  // TODO M3a Phase 4: implement ancestry check + host.task.stop().
  return { status: "error", message: "M3a Phase 4 — not yet implemented" };
}

export const taskStopTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
