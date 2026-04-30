import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";

const todoSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z.string().optional(),
});

const inputSchema = z.object({
  todos: z.array(todoSchema),
});

export type Todo = z.infer<typeof todoSchema>;
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

const STATUS_ICON: Record<Todo["status"], string> = {
  pending: "☐",
  in_progress: "▶",
  completed: "✓",
};

function formatTodos(todos: readonly Todo[]): string {
  if (todos.length === 0) return "(no todos)";
  return todos
    .map((t) => `${STATUS_ICON[t.status]} ${t.status}: ${t.id} - ${t.content}`)
    .join("\n");
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
  inputSchema: zodToJsonSchema(inputSchema as never) as JsonSchema,
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

  currentTodos = [...input.todos];
  return { status: "ok", output: formatTodos(currentTodos) };
}

export const todoWriteTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
