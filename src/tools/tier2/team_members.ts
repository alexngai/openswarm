/**
 * team_members — Tier 2 tool (v0.4 stage 4E.1).
 *
 * Returns the list of `[{memberId, role, agentId}]` for all members in the
 * caller's team scope (excluding the caller). Used by team peers to discover
 * who else is in the room before sending a message via send_message.
 *
 * Standalone path (root orchestrator): introspects host.listMembersInScope.
 * Worker path: IPC round-trip via transport.send("team.members", {}).
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema, AgentId } from "../../core/types.js";
import { requireHost } from "./require-host.js";

const inputSchema = z.object({}); // no input

// concurrencySafe: false — Tier 2 tools touch shared orchestrator state
// (here, agentToScope + RoleIndex on standalone, transport on worker).
// Kept consistent with the rest of Tier 2 to honor the C1 regression guard.
const spec: ToolSpec = {
  name: "team_members",
  description:
    "List all members of the calling agent's team. Returns an array of " +
    "{memberId, role, agentId} for each peer (excluding the caller). " +
    "Useful before send_message to discover who's in the team.",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: zodToJsonSchema(inputSchema as any) as JsonSchema,
  requiredPermission: "read",
  tier: 2,
  concurrencySafe: false,
};

interface MemberEntry {
  readonly memberId: string;
  readonly role: string;
  readonly agentId: AgentId;
}

interface StandaloneIntrospect {
  listMembersInScope: (
    scope: string,
    excludeAgentId?: AgentId,
  ) => MemberEntry[];
  scopeOf: (agentId: AgentId) => string;
}

interface WorkerIntrospect {
  requestTeamMembers: () => Promise<MemberEntry[]>;
}

async function execute(
  _raw: unknown,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const host = requireHost(ctx, "team_members");

  if (host.kind === "standalone") {
    const standalone = host as unknown as StandaloneIntrospect;
    const callerScope = standalone.scopeOf(host.agentId);
    const members = standalone.listMembersInScope(callerScope, host.agentId);
    return { status: "ok", output: JSON.stringify(members) };
  }

  // Worker host — IPC round-trip.
  try {
    const worker = host as unknown as WorkerIntrospect;
    const members = await worker.requestTeamMembers();
    return { status: "ok", output: JSON.stringify(members) };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export const teamMembersTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
