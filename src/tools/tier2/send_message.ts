/**
 * send_message — Tier 2 tool.
 *
 * Routes an inter-agent message via the SwarmHost. The `to` field accepts
 * three address shapes:
 *   - A bare agentId (direct address)
 *   - "*" for broadcast to all peers
 *   - "role:<name>" for role broadcast
 *
 * The sender is always excluded from "*" and role broadcasts. Depth-1 scope
 * enforcement (rev-2 Option A) lives in StandaloneHost.send.
 */

import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema, AgentId } from "../../core/types.js";
import type { AgentMessage } from "../../swarm/host.js";
import { requireHost } from "./require-host.js";

const inputSchema = z.object({
  to: z.string().min(1).describe(
    'Recipient: agentId for direct, "*" for broadcast, "role:<name>" for role broadcast.',
  ),
  content: z.string().describe("Message body."),
  correlationId: z.string().optional().describe(
    "Optional correlation id for request/response flows.",
  ),
});

// concurrencySafe: false — Tier 2 tools touch shared orchestrator state
// (task registry, inbox, role index, spawn parents, stdin, transports)
// that isn't reentrant under Promise.all dispatch.
const spec: ToolSpec = {
  name: "send_message",
  description:
    "Send a message to another agent's inbox. " +
    'Use `to: "*"` to broadcast to all peers or `to: "role:<name>"` to reach a role. ' +
    "Returns a SendResult with delivered/dropped counts.",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: z.toJSONSchema(inputSchema) as JsonSchema,
  requiredPermission: "exec",
  tier: 2,
  concurrencySafe: false,
};

async function execute(
  raw: unknown,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const host = requireHost(ctx, "send_message");
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input = parsed.data;

  const message: AgentMessage = {
    from: host.agentId,
    to: input.to as AgentId, // narrowed in host.send when "*" / "role:" prefix is used
    content: input.content,
    timestamp: Date.now(),
    ...(input.correlationId !== undefined && {
      correlationId: input.correlationId,
    }),
  };

  const result = await host.send(
    input.to as AgentId | "*" | `role:${string}`,
    message,
  );
  if (!result.ok) {
    return {
      status: "error",
      message: `send_message failed: ${result.reason ?? "unknown"}`,
    };
  }
  return {
    status: "ok",
    output: JSON.stringify({
      delivered: result.delivered,
      dropped: result.dropped ?? 0,
      partial: result.partial ?? false,
    }),
  };
}

export const sendMessageTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
