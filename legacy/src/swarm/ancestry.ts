import type { AgentId } from "../core/types.js";

/**
 * Returns true if `ancestor` is the same as `descendant` OR an ancestor of
 * `descendant` in the spawn tree. Uses the orchestrator's spawnParents map.
 * Walks up from descendant; stops at a max-depth sentinel to avoid infinite
 * loops on corrupt data.
 */
export function isAncestorOf(
  ancestor: AgentId,
  descendant: AgentId,
  spawnParents: ReadonlyMap<AgentId, AgentId>,
  maxDepth: number = 64,
): boolean {
  if (ancestor === descendant) return true;
  let current: AgentId | undefined = descendant;
  let hops = 0;
  while (current !== undefined && hops < maxDepth) {
    const parent = spawnParents.get(current);
    if (parent === undefined) return false;
    if (parent === ancestor) return true;
    current = parent;
    hops++;
  }
  return false;
}
