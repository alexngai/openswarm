/**
 * framework-filter.ts — remove tools that don't make sense in a given
 * framework mode.
 *
 * In swarm-coder's "native" and "auto" modes the SwarmHost-routed tools
 * (send_message, check_inbox, task_stop, task_output, ask_user_question)
 * are available. In framework modes (codex-chatgpt, claude-agent-sdk) the
 * framework owns the turn loop and SwarmHost routing doesn't apply — so
 * those tools are REMOVED ENTIRELY from the surface the model sees. Not
 * degraded to no-op; absent.
 *
 * Orthogonal to ToolDispatcher.allowedTools (M3a role filter) which runs AT
 * DISPATCH time based on per-call role. This filter runs at factory time.
 * Composition: framework-filter → register in dispatcher → dispatcher applies
 * role allowlists per-call.
 */

import type { ToolImpl } from "./types.js";

const SWARM_HOST_TOOLS = new Set([
  "send_message",
  "check_inbox",
  "task_stop",
  "task_output",
  "ask_user_question",
]);

/**
 * Remove tools that don't make sense in the given framework mode.
 *
 * "native" and "auto" → return tools unchanged.
 * "claude-agent-sdk" and "codex-chatgpt" → strip SwarmHost-routed tools.
 */
export function filterToolsForFramework(
  tools: readonly ToolImpl[],
  framework: "native" | "claude-agent-sdk" | "codex-chatgpt" | "auto",
): readonly ToolImpl[] {
  if (framework === "native" || framework === "auto") return tools;
  return tools.filter((t) => !SWARM_HOST_TOOLS.has(t.spec.name));
}
