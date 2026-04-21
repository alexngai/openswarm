import type { ToolSpec } from "../core/types.js";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "./types.js";
import type { HookRuntime } from "../hooks/runtime.js";

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

  constructor(options: ToolDispatcherOptions = {}) {
    if (options.hooks !== undefined) this.hooks = options.hooks;
    if (options.sessionId !== undefined) this.sessionId = options.sessionId;
    if (options.agentId !== undefined) this.agentId = options.agentId;
  }

  /**
   * Register a tool. Throws if a tool with the same name is already registered.
   */
  register(tool: ToolImpl): void {
    const name = tool.spec.name;
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

    const result = await tool.execute(effectiveInput, ctx);

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
}
