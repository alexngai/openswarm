/**
 * check_inbox — Tier 2 tool placeholder.
 *
 * Synchronously drains up to `max` messages from the calling agent's inbox.
 * Returns immediately with whatever messages are already queued — no blocking.
 *
 * Real implementation lands in M3a Phase 3.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";

const inputSchema = z.object({
  max: z.number().int().positive().optional().default(10).describe(
    "Maximum messages to drain. Returns immediately with whatever is queued.",
  ),
});

const spec: ToolSpec = {
  name: "check_inbox",
  description:
    "Drain up to `max` messages from this agent's inbox. " +
    "Returns immediately — no blocking. " +
    "Call sparingly; an empty array means no messages are queued right now.",
  inputSchema: zodToJsonSchema(inputSchema as any) as JsonSchema,
  requiredPermission: "read",
  tier: 2,
};

async function execute(_raw: unknown, _ctx: ToolExecutionContext): Promise<ToolResult> {
  // TODO M3a Phase 3: implement via orchestrator inbox drain.
  return { status: "error", message: "M3a Phase 3 — not yet implemented" };
}

export const checkInboxTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
