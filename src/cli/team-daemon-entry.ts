/**
 * team-daemon-entry.ts — CLI entry for the forked team daemon process.
 *
 * v0.5 stage 5E.2: thin wrapper that reads the daemon's spec + paths from
 * env vars set by the parent forker (5E.3 will add the forker), instantiates
 * a TeamDaemon, runs the team, and exits cleanly.
 *
 * Required env vars (set by `team start --detach` in 5E.3):
 *   OPENSWARM_DAEMON_SPEC    — path to a JSON file containing the TeamSpec
 *   OPENSWARM_DAEMON_SOCK    — Unix socket path
 *   OPENSWARM_DAEMON_PID     — pid file path
 *   OPENSWARM_DAEMON_EVENTS  — events.jsonl path
 *   OPENSWARM_DAEMON_STATE   — team-state.json path
 */

import * as fsp from "node:fs/promises";
import { TeamSpecSchema, type TeamSpec } from "../swarm/team-spec.js";
import { TeamDaemon } from "../swarm/team-daemon.js";

const REQUIRED_ENV = [
  "OPENSWARM_DAEMON_SPEC",
  "OPENSWARM_DAEMON_SOCK",
  "OPENSWARM_DAEMON_PID",
  "OPENSWARM_DAEMON_EVENTS",
  "OPENSWARM_DAEMON_STATE",
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

  const specPath = process.env.OPENSWARM_DAEMON_SPEC!;
  const sockPath = process.env.OPENSWARM_DAEMON_SOCK!;
  const pidPath = process.env.OPENSWARM_DAEMON_PID!;
  const eventsPath = process.env.OPENSWARM_DAEMON_EVENTS!;
  const statePath = process.env.OPENSWARM_DAEMON_STATE!;

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

  // v0.5 stage 5E.6: stay alive until an external `team stop`/`team kill`
  // RPC (or SIGTERM/SIGINT) tears the daemon down. The runTeam promise
  // resolves when the underlying topology completes; we observe the result
  // for events.jsonl + state.json but do NOT exit on it. Rationale: the
  // operator detached precisely so they can `team list`/`team logs` later;
  // exiting at team-completion would race the operator's first poll. The
  // daemon's signal handlers (installed in start()) own the actual exit.
  daemon.awaitTeamCompletion().catch(() => {
    /* errors are surfaced on the orchestrator's resultsOut stream */
  });

  // Block until signal handlers fire daemon.stop(). The promise here
  // intentionally never resolves — daemon.stop() is called from process.on
  // signal handlers OR the stop/kill RPC handlers, both of which take care
  // of clean shutdown + (for kill) process.exit.
  await new Promise<void>(() => {
    /* never resolves; the signal/RPC path drives shutdown */
  });
  return 0;
}
