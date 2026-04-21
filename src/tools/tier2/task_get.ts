import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { requireHost } from "./require-host.js";

const inputSchema = z.object({
  id: z.string(),
});

type Input = z.infer<typeof inputSchema>;

const spec: ToolSpec = {
  name: "task_get",
  description:
    "Read a task record from the swarm task registry by id. " +
    "Returns the full TaskRecord as JSON, or the literal string \"null\" " +
    "when the id is unknown.",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: zodToJsonSchema(inputSchema as any) as JsonSchema,
  requiredPermission: "read",
  tier: 2,
};

async function execute(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const host = requireHost(ctx, "task_get");
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return { status: "error", message: parsed.error.message };
  const input: Input = parsed.data;

  const record = await host.task.get(input.id);
  if (record === undefined) {
    return { status: "ok", output: "null" };
  }
  return { status: "ok", output: JSON.stringify(record) };
}

export const taskGetTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
