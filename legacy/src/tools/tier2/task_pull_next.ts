/**
 * task_pull_next — v0.5 stage 5C.
 *
 * Atomically claims the next pending task in a team's scope (default: the
 * caller's own scope). Sets the calling agent as the owner and transitions
 * the task from pending → running. Returns the claimed TaskRecord as JSON,
 * or the literal string "null" when no claimable task is available.
 *
 * Use case: a long-lived worker in a team that an external producer
 * (opentasks daemon, MAP federation) is feeding tasks into. Instead of
 * waiting for the orchestrator to push work via runMore, the model self-
 * pulls the next claimable item.
 */

import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import { ToolAccesses } from "../access.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { requireHost } from "./require-host.js";

const inputSchema = z.object({
  /**
   * Team scope to pull from. When omitted, the tool resolves the caller's
   * own scope via host.scopeOf(host.agentId).
   */
  scope: z.string().optional(),
});

type Input = z.infer<typeof inputSchema>;

const spec: ToolSpec = {
  name: "task_pull_next",
  description:
    "Atomically claim the next pending task in your team's scope (or an " +
    'explicit `scope`). Sets the calling agent as owner and transitions ' +
    "the task to running. Returns the TaskRecord as JSON, or the literal " +
    'string "null" when no claimable task is available.',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: z.toJSONSchema(inputSchema) as JsonSchema,
  requiredPermission: "read",
  tier: 2,
  concurrencySafe: false,
};

async function execute(
  raw: unknown,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const host = requireHost(ctx, "task_pull_next");
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: Input = parsed.data;

  // Resolve scope. If the caller didn't pass one, derive from host.scopeOf
  // (StandaloneHost + WorkerHost both implement it). Fall back to
  // "swarm:default" if scopeOf is unavailable on the host shape.
  let scope = input.scope;
  if (scope === undefined) {
    const hostWithScope = host as unknown as {
      scopeOf?: (id: typeof host.agentId) => string;
    };
    scope =
      typeof hostWithScope.scopeOf === "function"
        ? hostWithScope.scopeOf(host.agentId)
        : "swarm:default";
  }

  const claimed = await host.task.pullNext(scope, host.agentId);
  if (claimed === null) {
    return { status: "ok", output: "null" };
  }
  return { status: "ok", output: JSON.stringify(claimed) };
}

export const taskPullNextTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
  accesses: () => ToolAccesses.all(),
};
