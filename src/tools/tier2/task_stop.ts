/**
 * task_stop — Tier 2 tool.
 *
 * Stops a running task. Orchestrators can stop any task; peer workers can
 * only stop tasks they (transitively) spawned (ancestry check).
 *
 * Real implementation: M3a Phase 4.
 */

import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import type { AgentId } from "../../core/types.js";
import { requireHost } from "./require-host.js";

const inputSchema = z.object({
  taskId: z.string().describe("Id of the task to stop."),
});

type Input = z.infer<typeof inputSchema>;

// concurrencySafe: false — Tier 2 tools touch shared orchestrator state
// (task registry, inbox, role index, spawn parents, stdin, transports)
// that isn't reentrant under Promise.all dispatch.
const spec: ToolSpec = {
  name: "task_stop",
  description:
    "Stop a running task. " +
    "Orchestrators can stop any task unconditionally. " +
    "Worker agents can only stop tasks they (transitively) spawned — " +
    "attempting to stop an unrelated task returns a permission error.",
  inputSchema: z.toJSONSchema(inputSchema) as JsonSchema,
  requiredPermission: "exec",
  tier: 2,
  concurrencySafe: false,
};

async function execute(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const host = requireHost(ctx, "task_stop");
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return { status: "error", message: parsed.error.message };
  const input: Input = parsed.data;

  const isOrchestratorCaller = host.kind === "standalone";
  const allowPeerStop = process.env.SWARM_HARNESS_ALLOW_PEER_TASK_STOP === "1";

  if (!isOrchestratorCaller && !allowPeerStop) {
    // Worker caller — perform ancestry check.
    const ownerAgentId = await host.task.ownerOf(input.taskId);
    if (ownerAgentId === undefined) {
      return { status: "error", message: `unknown taskId: ${input.taskId}` };
    }
    const isAncestor = await host.isAncestorOf(host.agentId as AgentId, ownerAgentId);
    if (!isAncestor) {
      return {
        status: "error",
        message: "permission denied: caller is not an ancestor of target task",
      };
    }
  }

  try {
    // Surface the caller identity so TaskRegistry.stop persists it on
    // TaskRecord.stoppedBy; the orchestrator reads this when building the
    // cancelled results.jsonl line.
    const by: AgentId | "orchestrator" = isOrchestratorCaller
      ? "orchestrator"
      : (host.agentId as AgentId);
    await host.task.stop(input.taskId, by);
    return { status: "ok", output: `stopped task ${input.taskId}` };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export const taskStopTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
