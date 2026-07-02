/**
 * codex-peer-tools.ts — V0.4.Q11 tool subset registered with codex peers
 * via the App Server `dynamicTools` mechanism.
 *
 * The full Tier 2 catalog is split: 8 tools that translate cleanly to a
 * peer-team workflow are exposed; 3 (`agent`, `task_create`, `task_update`)
 * are deferred because their semantics overlap with codex's own internal
 * task / planning surface and would confuse the agent. See
 * docs/archive/27-v0.4-teams-implementation-plan.md §V0.4.Q11.
 */

import type { ToolImpl } from "./types.js";

/**
 * Names of the 8 Tier 2 tools registered with codex framework workers.
 *
 * Order matches Tier 2 catalog order so filter() preserves the canonical
 * ordering when the worker entry uses this set against `buildTier2Tools()`.
 */
export const CODEX_PEER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "send_message",
  "check_inbox",
  "task_stop",
  "task_output",
  "ask_user_question",
  "task_get",
  "task_list",
  "team_members",
]);

/**
 * Filter a Tier 2 tool list down to the codex-peer subset. Pure helper —
 * does not mutate the input list. Returns tools in the order they appear
 * in `tier2Tools` (which is `buildTier2Tools()`'s canonical order).
 */
export function filterCodexPeerTools(
  tier2Tools: readonly ToolImpl[],
): readonly ToolImpl[] {
  return tier2Tools.filter((t) => CODEX_PEER_TOOL_NAMES.has(t.spec.name));
}
