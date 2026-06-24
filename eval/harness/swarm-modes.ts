/**
 * swarm-modes.ts — single-vs-team as an ARM axis (docs/45 H1/H4).
 *
 * The eval base toolset is [Bash,Read,Write,Edit,Glob,Grep] — no teammate-spawn tool — so a bare
 * `swarm-harness "<prompt>"` headless run is single-agent by construction. The TEAM arm simply adds
 * swarm-harness's spawn + coordination tools via `scaffold.extraTools`, letting the agent fan out
 * (the "orchestrator may decline to fan out" mode). One adapter, one template build, two arms; the
 * paired single-vs-team delta falls out of `buildReport`.
 *
 * ⚠ LIVE-VALIDATE: confirm that a headless `swarm-harness "<prompt>"` with these tools present actually
 * spins up a functioning TeamSession (team scope/host wired) — the `agent` tool needs a host that can
 * spawn into a team. If a bare prompt run can't, the team arm needs a dedicated headless team entrypoint.
 */
import type { Arm } from "swarmkit-eval";

/** swarm-harness teammate-spawn + coordination tools (from src/tools, src/swarm). */
export const SWARM_TEAM_TOOLS = [
  "agent",
  "send_message",
  "check_inbox",
  "team_members",
  "task_create",
  "task_get",
  "task_list",
  "task_update",
] as const;

/** Single (baseline) vs homogeneous team — same model, same template; only the spawn tools differ. */
export const H1_ARMS: Arm[] = [
  { id: "single", label: "single-agent", scaffold: {} },
  { id: "team", label: "homogeneous team", scaffold: { extraTools: [...SWARM_TEAM_TOOLS] } },
];
