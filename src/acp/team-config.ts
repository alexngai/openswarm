/**
 * Resolve the team a team-mode ACP session is bound to. B0 ships a single
 * default: a coordinator with one long-lived "lead" root that spawns peers via
 * the `agent` tool. The user's prompt becomes the lead's prompt.
 *
 * Later: a `--team <template>` flag to pick an openteams template, and richer
 * coordination (aggregators, branch policies) per docs/33.
 */

import type { TeamSpec } from "../swarm/team-spec.js";

/**
 * @param prompt the user's text (becomes the lead root's prompt)
 * @param cwd    the ACP session's working directory (the editor's project
 *               root). Threaded to the root worker so file tools operate where
 *               the client expects. Omit to fall back to the orchestrator cwd.
 * @param sessionSidecarPath where the root persists its engine session id so a
 *               fresh process can resume it via `session/load` (B1.4). Omit to
 *               disable cross-process resume.
 */
export function buildCoordinatorSpec(
  prompt: string,
  cwd?: string,
  sessionSidecarPath?: string,
): TeamSpec {
  return {
    name: "acp",
    topology: "coordinator",
    members: [
      {
        role: "lead",
        prompt,
        ...(cwd !== undefined && { cwd }),
        ...(sessionSidecarPath !== undefined && { sessionSidecarPath }),
      },
    ],
    coordination: { completion: { kind: "all" } },
  };
}
