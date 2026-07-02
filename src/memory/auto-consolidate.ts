/**
 * Auto-consolidation cadence gating for the cognitive-core learning loop.
 *
 * OpenSwarm records sessions (sessionlog) and consumes distilled skills
 * read-only (SkillProvider), but the heavy learning/ingest is delegated to the
 * cognitive-core daemon (`cogcore`) out-of-band. Nothing in openswarm decided
 * *when* to run that consolidation — users had to run `cogcore run`/`cogcore
 * dream` themselves.
 *
 * This module borrows MiMoCode's `auto-dream` cadence pattern: on a natural
 * trigger (session end), check a persisted last-run timestamp against an
 * interval + an in-process spawn-gap debounce, and — if due and `cogcore` is
 * installed — spawn a detached, best-effort consolidation pass. It never blocks
 * or throws into the turn loop, and no-ops cleanly when cognitive-core is
 * absent (the decoupled architecture is preserved: this only *kicks* the
 * external daemon; it does not embed it).
 *
 * Config (env):
 *   OPENSWARM_AUTO_CONSOLIDATE           "0"/"off"/"false" disables (default on)
 *   OPENSWARM_AUTO_CONSOLIDATE_INTERVAL_HOURS   min hours between runs (default 24)
 *   OPENSWARM_AUTO_CONSOLIDATE_CMD       full shell override (run via /bin/sh -c)
 *   OPENSWARM_AUTO_CONSOLIDATE_STATE     override the last-run marker path
 *   OPENSWARM_MEMORY_DEBUG=1             log decisions to stderr
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";

const SPAWN_GAP_MS = 10_000;
const DEFAULT_INTERVAL_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_BIN = "cogcore";

export interface ConsolidateState {
  /** Epoch ms of the last consolidation spawn, or null if never. */
  readonly lastRunMs: number | null;
}

export interface CadenceOptions {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly spawnGapMs: number;
}

export interface CadenceDecision {
  readonly shouldRun: boolean;
  readonly reason: string;
}

/**
 * Pure cadence decision — no I/O. `lastSpawnMs` is the in-process debounce
 * clock (the last time *this* process attempted a spawn).
 */
export function evaluateConsolidationCadence(
  state: ConsolidateState,
  opts: CadenceOptions,
  now: number,
  lastSpawnMs: number,
): CadenceDecision {
  if (!opts.enabled) return { shouldRun: false, reason: "disabled" };

  if (now - lastSpawnMs < opts.spawnGapMs) {
    return { shouldRun: false, reason: "spawn-gap debounce" };
  }

  if (state.lastRunMs !== null && now - state.lastRunMs < opts.intervalMs) {
    const agoH = ((now - state.lastRunMs) / HOUR_MS).toFixed(1);
    const intervalH = (opts.intervalMs / HOUR_MS).toFixed(1);
    return {
      shouldRun: false,
      reason: `last run too recent (${agoH}h ago, interval ${intervalH}h)`,
    };
  }

  return { shouldRun: true, reason: state.lastRunMs === null ? "never run" : "interval elapsed" };
}

function isDisabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "0" || v === "off" || v === "false" || v === "no";
}

export function resolveCadenceOptions(env: NodeJS.ProcessEnv = process.env): CadenceOptions {
  const enabled = !isDisabled(env.OPENSWARM_AUTO_CONSOLIDATE);
  const rawHours = env.OPENSWARM_AUTO_CONSOLIDATE_INTERVAL_HOURS;
  const hours = rawHours ? Number.parseFloat(rawHours) : NaN;
  const intervalMs = Number.isFinite(hours) && hours > 0 ? hours * HOUR_MS : DEFAULT_INTERVAL_HOURS * HOUR_MS;
  return { enabled, intervalMs, spawnGapMs: SPAWN_GAP_MS };
}

export function stateFilePath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENSWARM_AUTO_CONSOLIDATE_STATE;
  if (override && override.length > 0) return override;
  return path.join(cwd, ".openswarm", "cognitive-core", "last-consolidate.json");
}

export function readState(file: string): ConsolidateState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { lastRunMs?: unknown };
    const lastRunMs = typeof parsed.lastRunMs === "number" ? parsed.lastRunMs : null;
    return { lastRunMs };
  } catch {
    return { lastRunMs: null };
  }
}

export function writeState(file: string, state: ConsolidateState): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), "utf8");
  } catch {
    // best-effort — marker is an optimization, not correctness-critical
  }
}

/**
 * Resolve an executable on PATH without executing it (a `which`-style scan).
 * Returns the absolute path, or null if not found.
 */
export function resolveOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const pathVar = env.PATH ?? "";
  if (!pathVar) return null;
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not here — keep scanning
    }
  }
  return null;
}

/** Resolve the consolidation command. Returns null when nothing is runnable. */
export function resolveCommand(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[]; shell: boolean } | null {
  const override = env.OPENSWARM_AUTO_CONSOLIDATE_CMD;
  if (override && override.trim().length > 0) {
    return { file: override, args: [], shell: true };
  }
  // Resolve to the absolute binary path so the detached child does not re-resolve
  // the bare name against a (possibly different) child PATH.
  const resolved = resolveOnPath(DEFAULT_BIN, env);
  if (!resolved) return null;
  return { file: resolved, args: ["run", "--once", "--repo", cwd], shell: false };
}

export type SpawnFn = typeof nodeSpawn;

export interface MaybeConsolidateOptions {
  readonly cwd?: string;
  readonly now?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnFn?: SpawnFn;
}

export interface MaybeConsolidateResult {
  readonly triggered: boolean;
  readonly reason: string;
  readonly pid?: number;
}

// In-process debounce clock, shared across calls within one process.
let lastSpawnMs = 0;

/** Reset the in-process spawn-gap clock (test seam). */
export function resetSpawnClock(): void {
  lastSpawnMs = 0;
}

function debug(msg: string, env: NodeJS.ProcessEnv): void {
  if (env.OPENSWARM_MEMORY_DEBUG === "1") {
    process.stderr.write(`[auto-consolidate] ${msg}\n`);
  }
}

/**
 * Evaluate cadence and, if due, spawn a detached best-effort consolidation
 * pass. Never throws; safe to call fire-and-forget from a lifecycle hook.
 */
export async function maybeAutoConsolidate(
  opts: MaybeConsolidateOptions = {},
): Promise<MaybeConsolidateResult> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? Date.now();
  const spawnFn = opts.spawnFn ?? nodeSpawn;

  try {
    const cadence = resolveCadenceOptions(env);
    const file = stateFilePath(cwd, env);
    const state = readState(file);
    const decision = evaluateConsolidationCadence(state, cadence, now, lastSpawnMs);
    if (!decision.shouldRun) {
      debug(`skip — ${decision.reason}`, env);
      return { triggered: false, reason: decision.reason };
    }

    const cmd = resolveCommand(cwd, env);
    if (!cmd) {
      debug("skip — cogcore not found on PATH (set OPENSWARM_AUTO_CONSOLIDATE_CMD to override)", env);
      return { triggered: false, reason: "cogcore not found" };
    }

    // Claim the slot before spawning so a concurrent/rapid second call debounces.
    lastSpawnMs = now;

    const child = cmd.shell
      ? spawnFn(cmd.file, { cwd, env, detached: true, stdio: "ignore", shell: true })
      : spawnFn(cmd.file, cmd.args, { cwd, env, detached: true, stdio: "ignore" });

    // ENOENT / launch failures surface asynchronously — swallow them.
    child.on?.("error", (err: Error) => {
      debug(`spawn error: ${err.message}`, env);
    });
    child.unref?.();

    writeState(file, { lastRunMs: now });
    debug(`triggered (${decision.reason}) pid=${child.pid ?? "?"} — ${cmd.file} ${cmd.args.join(" ")}`, env);
    return { triggered: true, reason: decision.reason, pid: child.pid };
  } catch (err) {
    debug(`unexpected failure: ${err instanceof Error ? err.message : String(err)}`, env);
    return { triggered: false, reason: "error" };
  }
}
