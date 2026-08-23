import type { ToolExecutionContext } from "../types.js";
import type { SwarmHost } from "../../swarm/host.js";

/**
 * Assert that `ctx.host` is present and return it.
 *
 * Tier 2 tools call this at the top of their `execute` function. The thrown
 * error surfaces to the caller as a ToolResult error (the engine's error
 * boundary catches it and wraps it into `{ status: "error", message }` via
 * the dispatcher's try/catch in dispatcher.ts).
 *
 * @param ctx      - The ToolExecutionContext passed to execute().
 * @param toolName - Human-readable tool name used in the error message.
 * @returns The non-null SwarmHost.
 * @throws Error if `ctx.host` is absent.
 */
export function requireHost(
  ctx: ToolExecutionContext,
  toolName: string,
): SwarmHost {
  if (!ctx.host) {
    throw new Error(
      `${toolName} requires SwarmHost; this binary was invoked without swarm support`,
    );
  }
  return ctx.host;
}
