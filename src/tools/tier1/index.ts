/**
 * Tier 1 tool factory.
 *
 * Returns the three Tier 1 ToolImpls owned by Worker A:
 *   - web_fetch  (HTML → Markdown, plaintext passthrough)
 *   - web_search (SDK built-in placeholder for registry symmetry)
 *   - skill      (loads a skill body from SkillRegistry)
 *
 * Note: structured_output is a RunConfig option (Worker B), not a ToolImpl,
 * and is intentionally absent from this list.
 *
 * See docs/10-m2-plan.md Phase 4.
 */

import type { ToolImpl } from "../types.js";
import type { SkillRegistry } from "../../skills/index.js";

import { webFetchTool } from "./web_fetch.js";
import { webSearchTool } from "./web_search.js";
import { buildSkillTool } from "./skill.js";
import { notebookEditTool } from "./notebook_edit.js";
import { viewImageTool } from "./view_image.js";
import { toolSearchTool } from "./tool_search.js";

export interface Tier1Deps {
  skillRegistry?: SkillRegistry;
}

/** Build all Tier 1 tools. Pass `skillRegistry` once Phase 7 is wired. */
export function buildTier1Tools(deps: Tier1Deps): ToolImpl[] {
  return [
    webFetchTool,
    webSearchTool,
    buildSkillTool(deps.skillRegistry),
    notebookEditTool,
    viewImageTool,
    toolSearchTool,
  ];
}

// Named re-exports for direct access.
export { webFetchTool, webSearchTool, buildSkillTool, notebookEditTool, viewImageTool, toolSearchTool };
