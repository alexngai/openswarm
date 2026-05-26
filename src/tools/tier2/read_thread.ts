/**
 * read_thread — Tier 2 tool.
 *
 * v0.6 stage 6B. Returns the messages tagged with `threadId` from the
 * calling agent's scope. The orchestrator delegates to its `InboxBackend`'s
 * optional `readThread` method; backends without threading support
 * (InMemoryInboxBackend, the default) cause a structured error result so
 * the model can fall back to `check_inbox`.
 *
 * Threads are formed by callers stamping `threadTag` on `send_message`.
 * Subsequent `read_thread` calls return every message that shares the tag,
 * in storage order. Messages are NOT removed by reading a thread — repeated
 * reads return the same list (with whatever's been appended).
 */

import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { requireHost } from "./require-host.js";

const inputSchema = z.object({
  threadId: z.string().min(1).describe(
    "Thread identifier (the value passed as `threadTag` to send_message).",
  ),
});

// concurrencySafe: false — Tier 2 tools touch shared orchestrator state
// (task registry, inbox, role index, spawn parents, stdin, transports)
// that isn't reentrant under Promise.all dispatch.
const spec: ToolSpec = {
  name: "read_thread",
  description:
    "Return all messages tagged with `threadId` from this agent's scope. " +
    "Use the `threadTag` parameter on `send_message` to put messages in the " +
    "thread. Requires a threading-capable inbox backend (--agent-inbox); " +
    "returns an error when threading is unsupported.",
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
  const host = requireHost(ctx, "read_thread");
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input = parsed.data;

  try {
    const messages = await host.readThread(input.threadId);
    return {
      status: "ok",
      output: JSON.stringify(messages),
    };
  } catch (err) {
    return {
      status: "error",
      message: `read_thread failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export const readThreadTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
