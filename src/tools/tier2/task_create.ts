import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { requireHost } from "./require-host.js";
import {
  BranchPolicySchema,
  CommitPolicySchema,
  EscalationPolicySchema,
} from "../../swarm/policies.js";
import { z } from "zod";

const inputSchema = z.object({
  prompt: z.string(),
  branchPolicy: BranchPolicySchema,
  commitPolicy: CommitPolicySchema,
  escalationPolicy: EscalationPolicySchema,
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

// concurrencySafe: false — Tier 2 tools touch shared orchestrator state
// (task registry, inbox, role index, spawn parents, stdin, transports)
// that isn't reentrant under Promise.all dispatch.
const spec: ToolSpec = {
  name: "task_create",
  description:
    "Create a new task in the swarm task registry. " +
    "Returns the task id and initial status. " +
    "The task is not immediately executed — use the `agent` tool to spawn a worker for it.",
  inputSchema: z.toJSONSchema(inputSchema) as JsonSchema,
  requiredPermission: "none",
  tier: 2,
  concurrencySafe: false,
};

async function execute(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const host = requireHost(ctx, "task_create");
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return { status: "error", message: parsed.error.message };
  const input: Input = parsed.data;

  const record = await host.task.create(input);
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
