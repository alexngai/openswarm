import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";

// `id` is optional (Claude Code's TodoWrite has no id field; models trained
// on it omit one). Missing ids are filled with the item's array index.
const todoSchema = z.object({
  id: z.string().optional(),
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z.string().optional(),
});

const inputSchema = z.object({
  todos: z.array(todoSchema),
});

/** Stored todo — ids are always present (auto-filled from array index). */
export type Todo = z.infer<typeof todoSchema> & { id: string };
type Input = z.infer<typeof inputSchema>;

/** Module-level singleton for M0. Replaced on each execute call. */
let currentTodos: Todo[] = [];

/** Returns the current todo list (for session persistence in a later phase). */
export function getCurrentTodos(): readonly Todo[] {
  return currentTodos;
}

/** Exposed for testing — resets the singleton. */
export function _resetTodos(): void {
  currentTodos = [];
}

/**
 * todo_write is marked `concurrencySafe: false` because it maintains a
 * module-level `currentTodos` array. Two concurrent invocations would
 * race on the singleton. The dispatcher's batch path detects this and
 * serializes calls to todo_write.
 */
const spec: ToolSpec = {
  name: "todo_write",
  description:
    "Replace the current todo list with the provided array. " +
    "At most one item may have status 'in_progress' at a time. " +
    "Returns a formatted summary of the updated list.",
  inputSchema: z.toJSONSchema(inputSchema) as JsonSchema,
  requiredPermission: "none",
  tier: 0,
  // Module-level singleton races under parallel dispatch — must serialize.
  concurrencySafe: false,
};

async function execute(raw: unknown, _ctx: ToolExecutionContext): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: Input = parsed.data;

  const inProgressCount = input.todos.filter((t) => t.status === "in_progress").length;
  if (inProgressCount > 1) {
    return {
      status: "error",
      message: `only one todo may be in_progress at a time; found ${inProgressCount}`,
    };
  }

  currentTodos = input.todos.map((t, i) => ({ ...t, id: t.id ?? String(i + 1) }));
  // Claude Code's exact TodoWrite result string — trained models expect this
  // acknowledgement rather than an echo of the list (the list itself is
  // already in their context from the tool input).
  return {
    status: "ok",
    output:
      "Todos have been modified successfully. Ensure that you continue to use the todo list " +
      "to track your progress. Please proceed with the current tasks if applicable",
  };
}

export const todoWriteTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
