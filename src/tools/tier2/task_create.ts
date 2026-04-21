import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { requireHost } from "./require-host.js";

const inputSchema = z.object({
  prompt: z.string(),
  // TODO M3a Phase 2: replace with BranchPolicySchema / CommitPolicySchema /
  // EscalationPolicySchema discriminated unions from src/swarm/policies.ts.
  // Kept as legacy enums here so existing tests remain green until Phase 2 migrates fixtures.
  branchPolicy: z.enum(["main", "worktree", "feature-branch", "detached"]),
  commitPolicy: z.enum(["never", "on-success", "on-every-tool", "manual"]),
  escalationPolicy: z.enum(["abort-on-error", "ask-user", "retry-with-backoff"]),
  budget: z
    .object({
      maxTurns: z.number().int().positive().optional(),
      maxTokens: z.number().int().positive().optional(),
      maxWallClockMs: z.number().int().positive().optional(),
    })
    .optional(),
  context: z
    .object({
      files: z.array(z.string()).optional(),
      parentTaskId: z.string().optional(),
    })
    .optional(),
});

type Input = z.infer<typeof inputSchema>;

const spec: ToolSpec = {
  name: "task_create",
  description:
    "Create a new task in the swarm task registry. " +
    "Returns the task id and initial status. " +
    "The task is not immediately executed — use the `agent` tool to spawn a worker for it.",
  inputSchema: zodToJsonSchema(inputSchema as any) as JsonSchema,
  requiredPermission: "none",
  tier: 2,
};

async function execute(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const host = requireHost(ctx, "task_create");
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return { status: "error", message: parsed.error.message };
  const input: Input = parsed.data;

  const record = await host.task.create(input as any);
  return {
    status: "ok",
    output: JSON.stringify({ id: record.id, status: record.status }),
  };
}

export const taskCreateTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
