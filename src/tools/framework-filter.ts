/**
 * framework-filter.ts — remove tools that don't make sense in a given
 * framework mode.
 *
 * History: prior to v0.4 stage 4G this stripped 5 SwarmHost-routed tools
 * (send_message, check_inbox, task_stop, task_output, ask_user_question)
 * in framework modes on the assumption that they couldn't dispatch through
 * the framework's tool surface. Track A (docs/26 §Track A) verified
 * empirically that they work fine under --framework claude-agent-sdk —
 * canUseTool routes the framework's call back to the swarm-harness
 * implementation. The strip was conservative, not technically required.
 *
 * v0.4 stage 4G: dropped the strip uniformly. Tier 2 tools are now
 * available across all framework modes; outside a team scope they
 * degrade gracefully (send_message returns delivered: 0; check_inbox
 * returns []). The function is kept as a no-op for future
 * framework-specific filtering needs.
 */

import type { ToolImpl } from "./types.js";

export function filterToolsForFramework(
  tools: readonly ToolImpl[],
  framework: "native" | "claude-agent-sdk" | "codex-chatgpt" | "auto",
): readonly ToolImpl[] {
  // No-op as of v0.4 stage 4G. See module-level jsdoc for rationale.
  void framework; // signature preserved for callers; reserved for future use
  return tools;
}
