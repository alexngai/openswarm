import type { ToolSpec } from "../core/types.js";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "./types.js";

/**
 * ToolDispatcher manages a registry of ToolImpl instances and handles
 * validated dispatch of tool calls.
 */
export class ToolDispatcher {
  private readonly registry = new Map<string, ToolImpl>();

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

    if (tool.zodSchema !== undefined) {
      const result = tool.zodSchema.safeParse(input);
      if (!result.success) {
        return { status: "error", message: result.error.message };
      }
    }

    return tool.execute(input, ctx);
  }
}
