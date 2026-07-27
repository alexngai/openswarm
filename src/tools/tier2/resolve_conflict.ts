/**
 * resolve_conflict — docs/44 P2.
 *
 * Called by a resolver agent after it has resolved an assigned merge conflict
 * and committed the fix. Signals the orchestrator's recovery coordinator (via
 * `host.resolveConflict`) so a `waitForConflictResolution` waiter wakes and the
 * merge is retried.
 *
 * Feature-detects `host.resolveConflict`: today only StandaloneHost implements
 * it, so a resolver running as a subprocess WorkerHost reports unsupported
 * until the IPC proxy lands (P2b).
 */

import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import { ToolAccesses } from "../access.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { requireHost } from "./require-host.js";
import { TaskResolveConflictParamsSchema } from "../../swarm/ipc/protocol.js";

// review LOW: reuse the IPC param schema rather than redeclaring an identical
// one here — a second copy can silently drift from the handler's validation.
const inputSchema = TaskResolveConflictParamsSchema;

const spec: ToolSpec = {
  name: "resolve_conflict",
  description:
    "Signal that you have resolved an assigned merge conflict and committed " +
    "the fix. Pass the `conflictId` you were given (and optionally the " +
    "resolution commit sha). This unblocks the team's merge retry.",
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
  const host = requireHost(ctx, "resolve_conflict");
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  if (host.resolveConflict === undefined) {
    return {
      status: "error",
      message:
        "resolve_conflict is not supported in this context (no recovery coordinator)",
    };
  }
  await host.resolveConflict(
    parsed.data.conflictId,
    parsed.data.resolutionCommit !== undefined
      ? { resolutionCommit: parsed.data.resolutionCommit }
      : undefined,
  );
  return {
    status: "ok",
    output: JSON.stringify({
      resolved: true,
      conflictId: parsed.data.conflictId,
    }),
  };
}

export const resolveConflictTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
  accesses: () => ToolAccesses.all(),
};
