/**
 * send_message — Tier 2 tool placeholder.
 *
 * Sends a message to another agent's inbox. Supports direct addressing
 * (agentId), broadcast ("*"), and role addressing ("role:<name>").
 *
 * Real implementation lands in M3a Phase 3.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";

const inputSchema = z.object({
  to: z.string().min(1).describe(
    'Recipient: agentId for direct, "*" for broadcast, "role:<name>" for role broadcast.',
  ),
  content: z.string().describe("Message body."),
  correlationId: z.string().optional().describe(
    "Optional correlation id for request/response flows.",
  ),
});

const spec: ToolSpec = {
  name: "send_message",
  description:
    "Send a message to another agent's inbox. " +
    'Use `to: "*"` to broadcast to all peers or `to: "role:<name>"` to reach a role. ' +
    "Returns a SendResult with delivered/dropped counts.",
  inputSchema: zodToJsonSchema(inputSchema as any) as JsonSchema,
  requiredPermission: "exec",
  tier: 2,
};

async function execute(_raw: unknown, _ctx: ToolExecutionContext): Promise<ToolResult> {
  // TODO M3a Phase 3: implement via host.send().
  return { status: "error", message: "M3a Phase 3 — not yet implemented" };
}

export const sendMessageTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
