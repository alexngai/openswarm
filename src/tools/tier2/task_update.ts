import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema, AgentId } from "../../core/types.js";
import { requireHost } from "./require-host.js";

const inputSchema = z
  .object({
    id: z.string(),
    status: z
      .enum(["pending", "running", "succeeded", "failed", "stopped", "timeout"])
      .optional(),
    owner: z.string().optional(),
    output: z.string().optional(),
    error: z.string().optional(),
  })
  .refine(
    (data) =>
      data.status !== undefined ||
      data.owner !== undefined ||
      data.output !== undefined ||
      data.error !== undefined,
    { message: "At least one patch field (status, owner, output, error) must be provided" },
  );

type Input = z.infer<typeof inputSchema>;

// concurrencySafe: false — Tier 2 tools touch shared orchestrator state
// (task registry, inbox, role index, spawn parents, stdin, transports)
// that isn't reentrant under Promise.all dispatch.
const spec: ToolSpec = {
  name: "task_update",
  description:
    "Update an existing task in the swarm task registry. " +
    "At least one of status, owner, output, or error must be provided. " +
    "If the task id is unknown, the call will throw an error.",
  inputSchema: zodToJsonSchema(inputSchema as any) as JsonSchema,
  requiredPermission: "none",
  tier: 2,
  concurrencySafe: false,
};

async function execute(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const host = requireHost(ctx, "task_update");
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return { status: "error", message: parsed.error.message };
  const input: Input = parsed.data;

  const { id, ...rest } = input;
  // `owner` comes in as a plain string at the tool boundary; cast to the
  // branded AgentId at the edge so the TaskAPI keeps its strict typing.
  const patch = {
    ...(rest.status !== undefined && { status: rest.status }),
    ...(rest.owner !== undefined && { owner: rest.owner as AgentId }),
    ...(rest.output !== undefined && { output: rest.output }),
    ...(rest.error !== undefined && { error: rest.error }),
  };
  await host.task.update(id, patch);
  return { status: "ok", output: "updated" };
}

export const taskUpdateTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
