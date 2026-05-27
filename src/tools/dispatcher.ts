import type { ToolSpec } from "../core/types.js";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "./types.js";
import type { HookRuntime } from "../hooks/runtime.js";
import { ToolAccesses, type ToolAccesses as ToolAccessesType } from "./access.js";
import { ToolScheduler } from "./scheduler.js";

// ---------------------------------------------------------------------------
// M3b Phase 0.6 — batch dispatch types
// ---------------------------------------------------------------------------

export interface ToolRequest {
  readonly name: string;
  readonly input: unknown;
  readonly ctx: ToolExecutionContext;
}

export interface ToolDispatcherOptions {
  /**
   * Optional HookRuntime. When present, `dispatch()` fires `PreToolUse` before
   * executing any tool (regardless of tier) and `PostToolUse` after. This is
   * the Tier 2 coverage path (rev-2 Major M6): Tier 2 tools bypass the SDK's
   * hook pipeline, so the dispatcher owns the invocation for them.
   */
  readonly hooks?: HookRuntime;
  /**
   * Optional sessionId surfaced in hook payloads.
   */
  readonly sessionId?: string;
  /**
   * Optional agentId surfaced in hook payloads.
   */
  readonly agentId?: string;
  /**
   * When set, only tools whose `spec.name` appears in this allowlist are
   * registered. Filtered tools never appear in `list()` and the engine
   * never sees them in the tool surface advertised to the model.
   *
   * This is ORTHOGONAL to `canUseTool` (per-call permission) and
   * `clampPermissionMode` (permission ceiling). Role-driven filtering
   * (M3a Phase 6) writes this from the worker entry.
   */
  readonly allowedTools?: readonly string[];
}

/**
 * ToolDispatcher manages a registry of ToolImpl instances and handles
 * validated dispatch of tool calls.
 */
export class ToolDispatcher {
  private readonly registry = new Map<string, ToolImpl>();
  private readonly hooks?: HookRuntime;
  private readonly sessionId?: string;
  private readonly agentId?: string;
  /**
   * When set, `register()` silently skips tools whose name isn't in this
   * allowlist. `undefined` means "no filtering" (prior behaviour).
   */
  private readonly allowedTools?: ReadonlySet<string>;

  constructor(options: ToolDispatcherOptions = {}) {
    if (options.hooks !== undefined) this.hooks = options.hooks;
    if (options.sessionId !== undefined) this.sessionId = options.sessionId;
    if (options.agentId !== undefined) this.agentId = options.agentId;
    if (options.allowedTools !== undefined) {
      this.allowedTools = new Set(options.allowedTools);
    }
  }

  /**
   * Register a tool. Throws if a tool with the same name is already
   * registered. When an `allowedTools` allowlist is configured, tools
   * outside the list are silently skipped — the model never sees them
   * in `list()` and `get(name)` returns undefined.
   */
  register(tool: ToolImpl): void {
    const name = tool.spec.name;
    if (this.allowedTools !== undefined && !this.allowedTools.has(name)) {
      return;
    }
    if (this.registry.has(name)) {
      throw new Error(
        `ToolDispatcher: duplicate tool registration — a tool named "${name}" is already registered`,
      );
    }
    this.registry.set(name, tool);
  }

  /**
   * List all registered tool specs for advertising to the engine.
   */
  list(): readonly ToolSpec[] {
    return Array.from(this.registry.values()).map((t) => t.spec);
  }

  /**
   * Retrieve a registered ToolImpl by name, or undefined if not found.
   */
  get(name: string): ToolImpl | undefined {
    return this.registry.get(name);
  }

  /**
   * Dispatch a tool call by name. Validates input via zodSchema when present.
   * Never throws — errors are returned as ToolResult with status "error".
   *
   * When a HookRuntime is configured, `PreToolUse` hooks fire before execute
   * (deny / fail short-circuits; allow may mutate `input` via `updatedInput`).
   * `PostToolUse` fires best-effort after execute.
   */
  async dispatch(
    name: string,
    input: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const tool = this.registry.get(name);
    if (tool === undefined) {
      return { status: "error", message: `unknown tool: ${name}` };
    }

    // PreToolUse hook (fires for ALL tiers — covers Tier 2 tools that bypass
    // the SDK's hook path).
    let effectiveInput: unknown = input;
    if (this.hooks !== undefined) {
      const pre = await this.hooks.invoke("PreToolUse", {
        event: "PreToolUse",
        toolName: name,
        toolInput: input,
        ...(this.sessionId !== undefined && { sessionId: this.sessionId }),
        ...(this.agentId !== undefined && { agentId: this.agentId }),
      });
      if (pre.decision === "deny") {
        return {
          status: "error",
          message:
            pre.systemMessage !== undefined
              ? `hook denied ${name}: ${pre.systemMessage}`
              : `hook denied ${name}`,
        };
      }
      if (pre.decision === "fail") {
        return {
          status: "error",
          message: pre.error ?? `hook failed for ${name}`,
        };
      }
      if (pre.updatedInput !== undefined) {
        effectiveInput = pre.updatedInput;
      }
    }

    if (tool.zodSchema !== undefined) {
      const result = tool.zodSchema.safeParse(effectiveInput);
      if (!result.success) {
        return { status: "error", message: result.error.message };
      }
    }

    // v0.4 stage 4I (Defect 2): wrap tool.execute in try/catch so a thrown
    // error becomes a structured ToolResult rather than an unhandled
    // rejection. Tools that already return `{status: "error"}` are
    // unaffected — this only catches the case where execute() throws.
    let result: ToolResult;
    try {
      result = await tool.execute(effectiveInput, ctx);
    } catch (err) {
      result = {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // PostToolUse hook — best-effort; errors don't alter the tool result.
    if (this.hooks !== undefined) {
      try {
        await this.hooks.invoke("PostToolUse", {
          event: "PostToolUse",
          toolName: name,
          toolInput: effectiveInput,
          toolResult: result,
          ...(this.sessionId !== undefined && { sessionId: this.sessionId }),
          ...(this.agentId !== undefined && { agentId: this.agentId }),
        });
      } catch {
        // swallow — PostToolUse is observational
      }
    }

    return result;
  }

  /**
   * Dispatch a batch of tool requests and return results in input order.
   *
   * Each request declares the resources it touches via `tool.accesses(input,
   * ctx)`. The scheduler runs requests whose accesses don't conflict
   * concurrently and serializes the rest in input order. Result emission is
   * always in input (provider) order regardless of completion order.
   *
   * Tools without an `accesses` callback fall back to `spec.concurrencySafe`:
   *   - `false` → `ToolAccesses.all()` (global barrier, serializes in
   *     input order against every other task — matches the legacy
   *     "unsafe goes serial" guarantee for e.g. todo_write).
   *   - `true` / `undefined` → `ToolAccesses.none()` (parallel — matches the
   *     legacy "safe fans out" path).
   *
   * Note: parallel_tool_batch lane events are emitted by upstream callers
   * rather than here, to avoid emitter-plumbing complexity in the dispatcher.
   */
  async dispatchBatch(requests: readonly ToolRequest[]): Promise<readonly ToolResult[]> {
    const scheduler = new ToolScheduler<ToolResult>();
    const pending: Array<Promise<ToolResult>> = new Array(requests.length);

    for (let i = 0; i < requests.length; i++) {
      const req = requests[i]!;
      const accesses = this.computeAccesses(req);
      pending[i] = scheduler.add({
        accesses,
        start: async () => ({
          result: this.dispatch(req.name, req.input, req.ctx),
        }),
      });
    }

    // Await in input order so the returned array preserves provider order
    // even when scheduled tasks finish out of order.
    const results: ToolResult[] = new Array(requests.length);
    for (let i = 0; i < pending.length; i++) {
      results[i] = await pending[i]!;
    }
    return results;
  }

  /**
   * Resolve the access set for one request. Prefers the tool's declared
   * `accesses(input, ctx)` when present; otherwise falls back to the legacy
   * `concurrencySafe` flag. Unregistered tools are treated as conflict-free
   * — `dispatch()` will return a structured `unknown tool` error in parallel.
   */
  private computeAccesses(req: ToolRequest): ToolAccessesType {
    const tool = this.registry.get(req.name);
    if (tool === undefined) return ToolAccesses.none();
    if (tool.accesses !== undefined) {
      try {
        return tool.accesses(req.input, req.ctx);
      } catch {
        // A buggy access declaration must not stall the batch — fall back to
        // the most pessimistic option so we never run conflicting work.
        return ToolAccesses.all();
      }
    }
    return tool.spec.concurrencySafe === false
      ? ToolAccesses.all()
      : ToolAccesses.none();
  }
}
