/**
 * check_inbox — Tier 2 tool.
 *
 * Synchronously drains up to `max` messages from the calling agent's inbox.
 * Returns immediately with whatever messages are already queued — no blocking.
 * An empty array means nothing is queued right now.
 */

import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import { ToolAccesses } from "../access.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { requireHost } from "./require-host.js";

const inputSchema = z.object({
  max: z.number().int().positive().optional().default(10).describe(
    "Maximum messages to drain. Returns immediately with whatever is queued.",
  ),
});

// concurrencySafe: false — Tier 2 tools touch shared orchestrator state
// (task registry, inbox, role index, spawn parents, stdin, transports)
// that isn't reentrant under Promise.all dispatch.
const spec: ToolSpec = {
  name: "check_inbox",
  description:
    "Drain up to `max` messages from this agent's inbox. " +
    "Returns immediately — no blocking. " +
    "Call sparingly; an empty array means no messages are queued right now.",
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
  const host = requireHost(ctx, "check_inbox");
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input = parsed.data;

  // v0.6 stage 6A.1: drainInbox is async (InboxBackend may be library-backed).
  const messages = await host.drainInbox(input.max);
  return {
    status: "ok",
    output: JSON.stringify(messages),
  };
}

export const checkInboxTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
  accesses: () => ToolAccesses.all(),
};
