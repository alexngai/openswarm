/**
 * Curated memory context fragment — injects Layer 1 memory into the system prompt.
 *
 * Priority 5 places it before all other fragments (environment is 10),
 * ensuring memory context is the first thing the agent sees.
 */

import type { ContextFragment, ContextState } from "../context/index.js";
import { getCuratedMemory, scopeKey } from "./curated.js";

export const curatedMemoryFragment: ContextFragment = {
  id: "curated-memory",
  priority: 5,
  generate(state: ContextState): string | null {
    const sections: string[] = [];

    if (state.userId) {
      const userMemory = getCuratedMemory(scopeKey("user", state.userId));
      if (userMemory) {
        sections.push(`## User Memory\n${userMemory}`);
      }
    }

    if (state.projectRoot) {
      const projectMemory = getCuratedMemory(scopeKey("project", state.projectRoot));
      if (projectMemory) {
        sections.push(`## Project Memory\n${projectMemory}`);
      }
    }

    if (sections.length === 0) return null;
    return sections.join("\n\n");
  },
};
