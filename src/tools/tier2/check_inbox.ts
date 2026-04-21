/**
 * check_inbox — Tier 2 tool.
 *
 * Synchronously drains up to `max` messages from the calling agent's inbox.
 * Returns immediately with whatever messages are already queued — no blocking.
 * An empty array means nothing is queued right now.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { requireHost } from "./require-host.js";

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: zodToJsonSchema(inputSchema as any) as JsonSchema,
  requiredPermission: "read",
  tier: 2,
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

  const messages = host.drainInbox(input.max);
  return {
    status: "ok",
    output: JSON.stringify(messages),
  };
}

export const checkInboxTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
