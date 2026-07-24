#!/usr/bin/env bun
/**
 * cache-ab.ts — local A/B cache/token efficiency harness (docs/55 TE-22).
 *
 * Runs a fixed prompt through `openswarm prompt --headless` N times per arm
 * and prints a comparison table: total tokens, cache-read share, ctx/turn,
 * and honest $ (via MODEL_PRICING — unpriced models show n/a). The fast inner
 * loop for judging an efficiency change without a full swarmkit-eval run:
 *
 *   # cache warmth on repeat runs (single arm, 2 runs — run 2 should hit):
 *   bun scripts/cache-ab.ts --model claude-haiku-4-5 -- "explain src/cli.ts in one line"
 *
 *   # flag on/off comparison (arm B gets extra env):
 *   bun scripts/cache-ab.ts --b OPENSWARM_MEMORY_MAX_BYTES=4096 --label-b small-mem -- "task…"
 *
 *   # baseline vs HEAD: run once per branch and compare the printed means.
 *
 * Self-check (docs/55): two identical arms should show delta ≈ 0 (modulo
 * model nondeterminism — responses vary a little run to run).
 *
 * Requires provider auth in the environment (same as `openswarm prompt`).
 * Column math lives in src/core/efficiency-report.ts (unit-tested; same
 * formulas as /cost, /status, and the cost-frontier eval).
 */

import { spawn } from "bun";
import { join } from "node:path";
import {
  parseRunJsonl,
  formatArm,
  formatDelta,
  type ArmResult,
  type RunStats,
} from "../src/core/efficiency-report.js";

const REPO_ROOT = join(import.meta.dir, "..");
const CLI_PATH = join(REPO_ROOT, "src", "cli.ts");

interface Args {
  runs: number;
  model?: string;
  timeoutMs: number;
  labelA: string;
  labelB?: string;
  envA: Record<string, string>;
  envB: Record<string, string>;
  prompt: string;
}

function usageExit(msg?: string): never {
  if (msg !== undefined) console.error(`cache-ab: ${msg}\n`);
  console.error(
    `Usage: bun scripts/cache-ab.ts [options] -- <prompt>
  --runs N          runs per arm (default 2; run 2+ shows warm-cache behavior)
  --model M         model id — passed to the CLI and used for $ pricing
  --a KEY=VAL       env var for arm A (repeatable)
  --b KEY=VAL       env var for arm B (repeatable; any --b/--label-b enables arm B)
  --label-a NAME    arm A display label (default "A")
  --label-b NAME    arm B display label
  --timeout SECS    per-run timeout (default 300)`,
  );
  process.exit(msg === undefined ? 0 : 2);
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    runs: 2,
    timeoutMs: 300_000,
    labelA: "A",
    envA: {},
    envB: {},
    prompt: "",
  };
  let haveB = false;
  let i = 0;
  const next = (flag: string): string => {
    i += 1;
    const v = argv[i];
    if (v === undefined) usageExit(`${flag} needs a value`);
    return v;
  };
  const parseKv = (flag: string): [string, string] => {
    const kv = next(flag);
    const eq = kv.indexOf("=");
    if (eq <= 0) usageExit(`${flag} expects KEY=VAL, got "${kv}"`);
    return [kv.slice(0, eq), kv.slice(eq + 1)];
  };
  for (; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      args.prompt = argv.slice(i + 1).join(" ");
      break;
    } else if (arg === "--runs") {
      args.runs = Number(next(arg));
      if (!Number.isInteger(args.runs) || args.runs < 1) usageExit("--runs must be a positive integer");
    } else if (arg === "--model") {
      args.model = next(arg);
    } else if (arg === "--timeout") {
      args.timeoutMs = Number(next(arg)) * 1000;
      if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) usageExit("--timeout must be positive seconds");
    } else if (arg === "--a") {
      const [k, v] = parseKv(arg);
      args.envA[k] = v;
    } else if (arg === "--b") {
      const [k, v] = parseKv(arg);
      args.envB[k] = v;
      haveB = true;
    } else if (arg === "--label-a") {
      args.labelA = next(arg);
    } else if (arg === "--label-b") {
      args.labelB = next(arg);
      haveB = true;
    } else if (arg === "-h" || arg === "--help") {
      usageExit();
    } else {
      usageExit(`unknown option "${arg}"`);
    }
  }
  if (args.prompt.trim() === "") usageExit("missing prompt (after --)");
  if (haveB && args.labelB === undefined) args.labelB = "B";
  return args;
}

async function runOnce(args: Args, env: Record<string, string>): Promise<RunStats> {
  const cmd = ["bun", CLI_PATH, "prompt", args.prompt, "--headless"];
  if (args.model !== undefined) cmd.push("--model", args.model);
  const started = Date.now();
  const proc = spawn({
    cmd,
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const timer = setTimeout(() => proc.kill(), args.timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (exitCode !== 0) {
    const tail = stderr.split("\n").slice(-6).join("\n");
    throw new Error(`run exited ${exitCode}; stderr tail:\n${tail}`);
  }
  const stats = parseRunJsonl(stdout.split("\n"));
  if (stats.turns === 0) {
    throw new Error("run produced no message_stop event — nothing to measure");
  }
  return { ...stats, wallClockMs: Date.now() - started };
}

async function runArm(
  args: Args,
  label: string,
  env: Record<string, string>,
): Promise<ArmResult> {
  const runs: RunStats[] = [];
  for (let r = 1; r <= args.runs; r++) {
    process.stderr.write(`[cache-ab] arm ${label}: run ${r}/${args.runs}…\n`);
    runs.push(await runOnce(args, env));
  }
  return { label, runs };
}

const args = parseArgs(process.argv.slice(2));
const armA = await runArm(args, args.labelA, args.envA);
console.log(formatArm(armA, args.model));
if (args.labelB !== undefined) {
  const armB = await runArm(args, args.labelB, args.envB);
  console.log("");
  console.log(formatArm(armB, args.model));
  console.log("");
  console.log(formatDelta(armA, armB, args.model));
}
