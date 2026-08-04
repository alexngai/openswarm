/**
 * request_permissions — request elevated permissions mid-session (F5).
 *
 * The agent can request a permission mode upgrade (e.g., read-only →
 * workspace-write) when it discovers it needs to perform an action
 * beyond its current mode. The request is routed to the user for
 * approval.
 *
 * This is a Tier 0 tool (no SwarmHost dependency) — it uses a
 * module-level callback set during engine initialization.
 */

import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import { ToolAccesses } from "../access.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import type { PermissionMode } from "../../core/types.js";

const inputSchema = z.object({
  mode: z
    .enum(["workspace-write", "danger-full-access"])
    .describe(
      "The permission mode to request. Must be higher than the current mode.",
    ),
  reason: z
    .string()
    .describe(
      "Why the agent needs this permission level. Shown to the user for approval.",
    ),
});

type Input = z.infer<typeof inputSchema>;

const spec: ToolSpec = {
  name: "request_permissions",
  description:
    "Request elevated permissions from the user when the current permission " +
    "mode is insufficient for the task. The user sees the requested mode and " +
    "your reason, and can approve or deny. " +
    "Current modes: read-only < workspace-write < danger-full-access.",
  inputSchema: z.toJSONSchema(inputSchema) as JsonSchema,
  requiredPermission: "none",
  tier: 0,
  concurrencySafe: false,
};

// ---------------------------------------------------------------------------
// Callback — set by engine at startup
// ---------------------------------------------------------------------------

export interface PermissionRequestHandler {
  getCurrentMode: () => PermissionMode;
  requestElevation: (
    requestedMode: PermissionMode,
    reason: string,
  ) => Promise<{ granted: boolean; newMode: PermissionMode }>;
}

let _handler: PermissionRequestHandler | undefined;

export function setPermissionRequestHandler(
  handler: PermissionRequestHandler,
): void {
  _handler = handler;
}

export function clearPermissionRequestHandler(): void {
  _handler = undefined;
}

// ---------------------------------------------------------------------------
// Mode ordering
// ---------------------------------------------------------------------------

const MODE_RANK: Record<PermissionMode, number> = {
  "read-only": 0,
  "workspace-write": 1,
  "danger-full-access": 2,
};

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

async function execute(
  raw: unknown,
  _ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: Input = parsed.data;

  if (!_handler) {
    return {
      status: "error",
      message:
        "Permission escalation is not available in this environment. " +
        "The engine does not support mid-session permission changes.",
    };
  }

  const currentMode = _handler.getCurrentMode();
  const requestedMode = input.mode as PermissionMode;

  if (MODE_RANK[requestedMode] <= MODE_RANK[currentMode]) {
    return {
      status: "ok",
      output: JSON.stringify({
        granted: true,
        currentMode,
        message: `Already at ${currentMode}, which is >= ${requestedMode}.`,
      }),
    };
  }

  try {
    const result = await _handler.requestElevation(requestedMode, input.reason);
    return {
      status: "ok",
      output: JSON.stringify({
        granted: result.granted,
        newMode: result.newMode,
        message: result.granted
          ? `Permission elevated to ${result.newMode}.`
          : `User denied elevation to ${requestedMode}. Current mode: ${result.newMode}.`,
      }),
    };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export const requestPermissionsTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
  accesses: () => ToolAccesses.all(),
};
