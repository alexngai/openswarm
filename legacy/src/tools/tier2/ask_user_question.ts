/**
 * ask_user_question — Tier 2 tool.
 *
 * Routes through `SwarmHost.askUser()`. In standalone mode, prompts via TTY.
 * In worker mode, routes through the orchestrator for display to the operator.
 *
 * Real implementation: M3b Phase 6.
 */

import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import { ToolAccesses } from "../access.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { requireHost } from "./require-host.js";

const inputSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).optional(),
});

type Input = z.infer<typeof inputSchema>;

// concurrencySafe: false — Tier 2 tools touch shared orchestrator state
// (task registry, inbox, role index, spawn parents, stdin, transports)
// that isn't reentrant under Promise.all dispatch.
const spec: ToolSpec = {
  name: "ask_user_question",
  description:
    "Ask the user a question and wait for the answer. " +
    "In standalone mode, prompts via TTY. In worker mode, routes through " +
    "the orchestrator for display to the operator. " +
    "Returns a JSON `AskUserResponse` as the tool output: " +
    '`{status: "answered", answer}` on success, or ' +
    '`{status: "timed-out" | "cancelled" | "error", ...}`.',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: z.toJSONSchema(inputSchema) as JsonSchema,
  requiredPermission: "read",
  tier: 2,
  concurrencySafe: false,
};

async function execute(
  raw: unknown,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const host = requireHost(ctx, "ask_user_question");
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return { status: "error", message: parsed.error.message };
  const input: Input = parsed.data;

  try {
    const response = await host.askUser(input.question, input.options);
    return { status: "ok", output: JSON.stringify(response) };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export const askUserQuestionTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
  accesses: () => ToolAccesses.all(),
};
