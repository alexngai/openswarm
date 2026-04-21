import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import type { SpawnRequest } from "../../swarm/host.js";
import { requireHost } from "./require-host.js";

const inputSchema = z.object({
  prompt: z.string(),
  model: z.string().optional(),
  permissionMode: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .optional(),
  maxTurns: z.number().int().positive().optional(),
  wait: z.boolean().optional().default(true),
});

type Input = z.infer<typeof inputSchema>;

const spec: ToolSpec = {
  name: "agent",
  description:
    "Spawn a sub-agent to work on a subtask. The sub-agent runs as an " +
    "isolated subprocess worker with its own engine. When `wait` is true " +
    "(default), this returns the sub-agent's final result. When false, " +
    "returns the agentId and taskId so the caller can poll via task_get.",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: zodToJsonSchema(inputSchema as any) as JsonSchema,
  requiredPermission: "exec",
  tier: 2,
};

async function execute(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const host = requireHost(ctx, "agent");
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return { status: "error", message: parsed.error.message };
  const input: Input = parsed.data;

  // Permission clamping (Phase 6 will tighten this against an authoritative
  // parent-mode source via host). For now: use input.permissionMode if
  // provided, else default to workspace-write. TODO(M1 Phase 6): clamp against
  // parent's actual mode to guarantee sub-agents cannot escalate.
  const permissionMode = input.permissionMode ?? "workspace-write";

  // Register the task in the orchestrator's registry.
  const record = await host.task.create({
    prompt: input.prompt,
    branchPolicy: "main",
    commitPolicy: "never",
    escalationPolicy: "abort-on-error",
    budget: input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : undefined,
  });

  // Build the SpawnRequest. Intentionally omit `depth` — the orchestrator
  // computes it authoritatively (see plan §0.4).
  const spawnReq: SpawnRequest = {
    task: record,
    permissionMode,
    taskId: record.id,
    ...(input.model !== undefined && { model: input.model }),
    ...(ctx.toolUseId !== undefined && { parentToolUseId: ctx.toolUseId }),
  };

  const handle = await host.spawn(spawnReq);

  // Non-waiting mode: return the ids for polling.
  if (input.wait === false) {
    return {
      status: "ok",
      output: JSON.stringify({ agentId: handle.agentId, taskId: record.id }),
    };
  }

  // Waiting mode: block until the sub-agent finishes, then translate the
  // AgentResult into a ToolResult.
  const result = await handle.wait();
  switch (result.status) {
    case "success":
      return { status: "ok", output: result.output };
    case "failure":
      return {
        status: "error",
        message: `sub-agent failed: ${result.error}${result.partialOutput ? `\n\nPartial output:\n${result.partialOutput}` : ""}`,
      };
    case "timeout":
      return {
        status: "error",
        message: `sub-agent timed out after ${result.wallClockMs}ms${result.partialOutput ? `\n\nPartial output:\n${result.partialOutput}` : ""}`,
      };
    case "killed":
      return {
        status: "error",
        message: `sub-agent was killed after ${result.wallClockMs}ms`,
      };
  }
}

export const agentTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
