/**
 * ToolImpl — how tools plug into the engine.
 *
 * ToolSpec (core/types.ts) is pure metadata the model sees: name, description,
 * inputSchema, requiredPermission, tier. ToolImpl adds the dispatcher-side
 * execute function that actually runs the tool.
 *
 * The engine's in-process MCP server (M0 Phase 4) wraps each ToolImpl so
 * execute is invoked after canUseTool gates. Outer code builds a ToolImpl[]
 * and passes it to RunConfig.tools; the engine never reaches past the
 * ToolImpl boundary.
 */

import type { ZodTypeAny } from "zod";
import type { ToolSpec } from "../core/types.js";
import type { SwarmHost } from "../swarm/host.js";
import type { ToolAccesses } from "./access.js";

export interface ToolImpl {
  readonly spec: ToolSpec;
  readonly execute: (input: unknown, ctx: ToolExecutionContext) => Promise<ToolResult>;
  /**
   * Zod schema for validating input at dispatch time.
   * This is the single source of truth for input shape; `spec.inputSchema`
   * (JSON Schema) is derived from this via `zodToJsonSchema`.
   * Optional to allow test fixtures without full schema setup.
   */
  readonly zodSchema?: ZodTypeAny;
  /**
   * Declare the resources this call will touch so the dispatcher can schedule
   * non-conflicting calls concurrently. Should be a pure, side-effect-free
   * description derived from `input` (path resolution against `ctx.cwd` is
   * fine). Throwing or returning malformed accesses is treated as
   * `ToolAccesses.all()` (pessimistic — serializes against everything).
   *
   * When omitted, the dispatcher falls back to `spec.concurrencySafe`:
   *   - `false` → `ToolAccesses.all()` (legacy serial-after-safe behavior)
   *   - `true` or `undefined` → `ToolAccesses.none()` (parallel)
   */
  readonly accesses?: (input: unknown, ctx: ToolExecutionContext) => ToolAccesses;
}

/**
 * Execution context passed to every tool's `execute` function.
 *
 * `host` is present when the runtime is swarm-aware; Tier 0 tools ignore it,
 * Tier 2 tools require it via `requireHost()`.
 *
 * `toolUseId` is the SDK's tool_use_id for this invocation, used by the
 * `agent` tool to set `parentToolUseId` on spawned children (per plan §0.5).
 */
export interface ToolExecutionContext {
  readonly cwd: string;
  readonly abort?: AbortSignal;
  /** Present when the runtime is swarm-aware. Tier 0 tools ignore this field. */
  readonly host?: SwarmHost;
  /**
   * The SDK's tool_use_id for this invocation. Used by the `agent` tool to
   * propagate `parentToolUseId` to spawned child agents (plan §0.5).
   */
  readonly toolUseId?: string;
}

export type ToolResult =
  | { readonly status: "ok"; readonly output: string }
  | { readonly status: "error"; readonly message: string };
