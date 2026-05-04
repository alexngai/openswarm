import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import type { SpawnRequest } from "../../swarm/host.js";
import { requireHost } from "./require-host.js";
import { clampPermissionMode } from "../../swarm/permission-order.js";

const inputSchema = z.object({
  prompt: z.string(),
  model: z.string().optional(),
  permissionMode: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .optional(),
  maxTurns: z.number().int().positive().optional(),
  wait: z.boolean().optional().default(true),
  // Added v0.4 stage 4E.1: team scope and framework selection.
  team: z
    .enum(["self", "child"])
    .optional()
    .describe(
      'Team scope of the spawned agent. "self" = land in caller\'s team ' +
        '(peer); "child" = sub-agent under caller (default). Omitted = "child".',
    ),
  framework: z
    .enum(["claude-agent-sdk", "codex-chatgpt"])
    .optional()
    .describe(
      "Framework provider for this spawn. Plumbs through to the spawn " +
        "request; engine selection is handled by the framework provider.",
    ),
});

type Input = z.infer<typeof inputSchema>;

// concurrencySafe: false — Tier 2 tools touch shared orchestrator state
// (task registry, inbox, role index, spawn parents, stdin, transports)
// that isn't reentrant under Promise.all dispatch.
const spec: ToolSpec = {
  name: "agent",
  description:
    "Spawn a sub-agent to work on a subtask. The sub-agent runs as an " +
    "isolated subprocess worker with its own engine. When `wait` is true " +
    "(default), this returns the sub-agent's final result. When false, " +
    "returns the agentId and taskId so the caller can poll via task_get. " +
    'Use `team: "self"` to spawn into the caller\'s team scope (peer); ' +
    "default is a child sub-agent. Use `framework` to opt into a specific " +
    "framework provider.",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: zodToJsonSchema(inputSchema as any) as JsonSchema,
  requiredPermission: "exec",
  tier: 2,
  concurrencySafe: false,
};

async function execute(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const host = requireHost(ctx, "agent");
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return { status: "error", message: parsed.error.message };
  const input: Input = parsed.data;

  // v0.4 stage 4M.7: worker-side `team: "self"` peer-spawn now works.
  // WorkerHost exposes scopeOf() (env-derived); the spawn IPC handler
  // forwards teamScope; the spawn handler injects it on the spawned child.
  // Closes the V0.4.Q1 follow-up that the B2 fix in 4M.1 had to defer.

  // Permission clamping: sub-agent mode cannot exceed parent's mode.
  // The authoritative clamp also happens inside StandaloneHost.spawn() — this
  // pre-clamp in the tool just makes the intent visible in the SpawnRequest.
  const requested = input.permissionMode ?? host.permissionMode;
  const permissionMode = clampPermissionMode(requested, host.permissionMode);

  // Register the task in the orchestrator's registry.
  const record = await host.task.create({
    prompt: input.prompt,
    branchPolicy: { kind: "none" },
    commitPolicy: { kind: "none" },
    escalationPolicy: { kind: "none" },
    budget: input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : undefined,
  });

  // Resolve team scope. v0.4 stage 4E.1:
  //   "self"  → spawn lands in caller's team scope (peer).
  //   "child" / undefined → leave teamScope undefined; child gets default scope.
  // host.scopeOf is implemented on StandaloneHost; WorkerHost callers fall
  // through to undefined (peer-spawn from a worker is a future stage).
  const hostWithScope = host as unknown as {
    scopeOf?: (id: typeof host.agentId) => string;
  };
  const teamScope =
    input.team === "self" && typeof hostWithScope.scopeOf === "function"
      ? hostWithScope.scopeOf(host.agentId)
      : undefined;

  // Build the SpawnRequest. Intentionally omit `depth` — the orchestrator
  // computes it authoritatively (see plan §0.4).
  const spawnReq: SpawnRequest = {
    task: record,
    permissionMode,
    taskId: record.id,
    ...(input.model !== undefined && { model: input.model }),
    ...(input.framework !== undefined && { framework: input.framework }),
    ...(teamScope !== undefined && { teamScope }),
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
