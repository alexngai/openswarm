import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import { ToolAccesses } from "../access.js";
import type { ToolSpec, JsonSchema, AgentId } from "../../core/types.js";
import { requireHost } from "./require-host.js";

const inputSchema = z.object({
  status: z
    .enum(["pending", "running", "succeeded", "failed", "stopped", "timeout"])
    .optional(),
  owner: z.string().optional(),
  parentTaskId: z.string().optional(),
});

type Input = z.infer<typeof inputSchema>;

// concurrencySafe: false — Tier 2 tools touch shared orchestrator state
// (task registry, inbox, role index, spawn parents, stdin, transports)
// that isn't reentrant under Promise.all dispatch.
const spec: ToolSpec = {
  name: "task_list",
  description:
    "List tasks in the swarm task registry, optionally filtered by status, owner, " +
    "or parentTaskId. Returns a JSON array of terse records (id, status, owner, " +
    "prompt truncated to 100 chars) to keep the response compact.",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: z.toJSONSchema(inputSchema) as JsonSchema,
  requiredPermission: "read",
  tier: 2,
  concurrencySafe: false,
};

async function execute(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const host = requireHost(ctx, "task_list");
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return { status: "error", message: parsed.error.message };
  const input: Input = parsed.data;

  const filter: {
    status?: "pending" | "running" | "succeeded" | "failed" | "stopped" | "timeout";
    owner?: AgentId;
    parentTaskId?: string;
  } = {};
  if (input.status !== undefined) filter.status = input.status;
  if (input.owner !== undefined) filter.owner = input.owner as AgentId;
  if (input.parentTaskId !== undefined) filter.parentTaskId = input.parentTaskId;

  const records = await host.task.list(filter);
  const terse = records.map((r) => ({
    id: r.id,
    status: r.status,
    owner: r.owner,
    prompt: r.prompt.length > 100 ? r.prompt.slice(0, 100) + "…" : r.prompt,
  }));
  return { status: "ok", output: JSON.stringify(terse) };
}

export const taskListTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
  accesses: () => ToolAccesses.all(),
};
