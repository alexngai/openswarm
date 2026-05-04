/**
 * team-daemon-entry.ts — CLI entry for the forked team daemon process.
 *
 * v0.5 stage 5E.2: thin wrapper that reads the daemon's spec + paths from
 * env vars set by the parent forker (5E.3 will add the forker), instantiates
 * a TeamDaemon, runs the team, and exits cleanly.
 *
 * Required env vars (set by `team start --detach` in 5E.3):
 *   SWARM_HARNESS_DAEMON_SPEC    — path to a JSON file containing the TeamSpec
 *   SWARM_HARNESS_DAEMON_SOCK    — Unix socket path
 *   SWARM_HARNESS_DAEMON_PID     — pid file path
 *   SWARM_HARNESS_DAEMON_EVENTS  — events.jsonl path
 *   SWARM_HARNESS_DAEMON_STATE   — team-state.json path
 */

import * as fsp from "node:fs/promises";
import { TeamSpecSchema, type TeamSpec } from "../swarm/team-spec.js";
import { TeamDaemon } from "../swarm/team-daemon.js";

const REQUIRED_ENV = [
  "SWARM_HARNESS_DAEMON_SPEC",
  "SWARM_HARNESS_DAEMON_SOCK",
  "SWARM_HARNESS_DAEMON_PID",
  "SWARM_HARNESS_DAEMON_EVENTS",
  "SWARM_HARNESS_DAEMON_STATE",
] as const;

export async function runTeamDaemonEntry(): Promise<number> {
  for (const key of REQUIRED_ENV) {
    if (process.env[key] === undefined || process.env[key] === "") {
      process.stderr.write(
        `team-daemon-entry: missing required env var ${key}\n`,
      );
      return 2;
    }
  }

  const specPath = process.env.SWARM_HARNESS_DAEMON_SPEC!;
  const sockPath = process.env.SWARM_HARNESS_DAEMON_SOCK!;
  const pidPath = process.env.SWARM_HARNESS_DAEMON_PID!;
  const eventsPath = process.env.SWARM_HARNESS_DAEMON_EVENTS!;
  const statePath = process.env.SWARM_HARNESS_DAEMON_STATE!;

  let spec: TeamSpec;
  try {
    const raw = await fsp.readFile(specPath, "utf8");
    const parsed = TeamSpecSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      process.stderr.write(
        `team-daemon-entry: invalid spec at ${specPath}: ${parsed.error.message}\n`,
      );
      return 2;
    }
    spec = parsed.data as TeamSpec;
  } catch (err) {
    process.stderr.write(
      `team-daemon-entry: failed to read spec at ${specPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  const daemon = new TeamDaemon({
    spec,
    paths: { sockPath, pidPath, eventsPath, statePath },
  });

  try {
    await daemon.start();
  } catch (err) {
    process.stderr.write(
      `team-daemon-entry: start failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  // Wait for the team to finish naturally OR a signal to trigger stop().
  // Errors from runTeam are surfaced on the underlying orchestrator's
  // resultsOut stream; the daemon process exits cleanly in either case.
  try {
    await daemon.awaitTeamCompletion();
  } catch {
    /* runTeam errors are recorded; daemon still tears down cleanly */
  }
  await daemon.stop();
  return 0;
}
