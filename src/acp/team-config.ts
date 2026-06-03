/**
 * Resolve the team a team-mode ACP session is bound to. B0 ships a single
 * default: a coordinator with one long-lived "lead" root that spawns peers via
 * the `agent` tool. The user's prompt becomes the lead's prompt.
 *
 * Later: a `--team <template>` flag to pick an openteams template, and richer
 * coordination (aggregators, branch policies) per docs/33.
 */

import type { TeamSpec } from "../swarm/team-spec.js";

export function buildCoordinatorSpec(prompt: string): TeamSpec {
  return {
    name: "acp",
    topology: "coordinator",
    members: [{ role: "lead", prompt }],
    coordination: { completion: { kind: "all" } },
  };
}
