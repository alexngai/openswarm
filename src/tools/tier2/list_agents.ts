/**
 * list_agents — Tier 2 tool.
 *
 * v0.6 stage 6C federation prep. Returns the inbox backend's persistent
 * agent registry for the caller's scope. The agent-inbox library tracks
 * every agent that has sent or received a message, which makes this view
 * useful for resurrecting cross-restart federation handles — distinct from
 * `team_members`, which surfaces the LIVE peer roster from the
 * orchestrator's depth map.
 *
 * Returns an error when the active inbox backend doesn't track a registry
 * (the default `InMemoryInboxBackend`). Use `--agent-inbox` at startup to
 * get a backend that implements `listAgents`.
 */

import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { requireHost } from "./require-host.js";

const inputSchema = z.object({}).describe(
  "No input — the agent's own scope is used implicitly.",
);

// concurrencySafe: false — Tier 2 tools touch shared orchestrator state.
const spec: ToolSpec = {
  name: "list_agents",
  description:
    "List the agents known to the inbox backend in this agent's scope. " +
    "Returns the persistent registry (every agent that has sent or " +
    "received a message), not the live peer roster — use `team_members` " +
    "for that. Requires a registry-capable inbox backend (--agent-inbox).",
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
  const host = requireHost(ctx, "list_agents");
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }

  try {
    const agents = await host.listAgents();
    return {
      status: "ok",
      output: JSON.stringify(agents),
    };
  } catch (err) {
    return {
      status: "error",
      message: `list_agents failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export const listAgentsTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
