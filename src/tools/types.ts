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
}

export interface ToolExecutionContext {
  readonly cwd: string;
  readonly abort?: AbortSignal;
}

export type ToolResult =
  | { readonly status: "ok"; readonly output: string }
  | { readonly status: "error"; readonly message: string };
