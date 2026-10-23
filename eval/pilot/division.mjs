/**
 * In-container driver for docs/07 §7's division arms, rebuilt to its five conditions;
 * runner.mjs seeds it at /opt/pilot/division.mjs and the harness calls it as it calls the
 * CLI: `division.mjs <flags> "<prompt>"`. The plan is the pilot's hand-written one.
 *
 *   PILOT_DIVISION=sharded  every thread cut from the base, all at once, landed at the end
 *                           in plan order
 *   PILOT_DIVISION=program  a thread starts once its blockedBy threads have settled (landed,
 *                           or failed or conflicted, which does not hold it back), cut
 *                           from the checkout as it then is (so it sees thread 0's
 *                           contracts), and lands as soon as it finishes
 *
 * Those rules are the only difference between the arms. In both:
 * - each thread is one writer under the completion gate (gate.mjs: up to PILOT_ROUNDS
 *   rounds, the reviewer scoped to the thread's assignment), in its own worktree with the
 *   checkout's ignored environment linked in (openswarm's SwarmGit);
 * - thread 0 also writes contract tests for the interfaces it exports, and the command
 *   that runs them to .pilot/contract-check.sh;
 * - after every landing that check runs in /app, and a failure gets one repair round
 *   from the landed thread's writer (a check still failing after it blocks nothing);
 * - after the last landing the worktrees are removed, so /app is the integrated tree;
 * - after the last landing one reviewer checks the whole roadmap in /app, and every
 *   target it does not call done goes to its owner (the thread other than thread 0
 *   whose assignment names it, else thread 0) for one repair round.
 *
 * PILOT_ONE_THREAD=1 collapses the plan to one thread that owns the whole roadmap (arm f,
 * docs/07 §7.2's control): the same gate, contract check, final review and repair, with
 * reviews unscoped as in the single-agent arms, so only the division itself differs.
 *
 * The report goes to /verifier-out/<HOSTNAME>.division.json.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { cli, gate, git, review, snapshot, task } from "./gate.mjs";

const { SwarmGit } = await import(process.env.PILOT_GIT_MODULE ?? "/opt/openswarm/packages/git/dist/index.js");

const ARM = process.env.PILOT_DIVISION;
if (!["sharded", "program"].includes(ARM)) {
  console.error(`PILOT_DIVISION must be sharded or program (got ${ARM})`);
  process.exit(2);
}
const APP = process.env.PILOT_APP ?? "/app";
const ROUNDS = Number(process.env.PILOT_ROUNDS ?? 3);
const OUT = `${process.env.PILOT_OUT_DIR ?? "/verifier-out"}/${process.env.HOSTNAME || hostname()}.division.json`;
const ONE = process.env.PILOT_ONE_THREAD === "1";
const threads = ONE
  ? [{ id: "t0", assignment: "The whole roadmap: every target.", blockedBy: [] }]
  : JSON.parse(readFileSync(process.env.PILOT_PLAN ?? "/opt/pilot/plan.json", "utf8")).threads
      .map((t) => ({ id: t.id, assignment: t.assignment, blockedBy: t.blockedBy ?? [] }));
const t0 = threads[0];
const CHECK = ".pilot/contract-check.sh";

const report = { arm: ONE ? "onethread" : ARM, rounds: ROUNDS, threads: {}, landings: [], final: null };
const save = () => writeFileSync(OUT, JSON.stringify(report, null, 1));

const CONTRACTS = `\nAlso write contract tests for the shared interfaces you export (each exists, with the roadmap's signature and basic behavior) in the repository's usual test layout, and put the shell command that runs exactly those tests, on one line, in ${CHECK} (run from the repository root).`;
const promptOf = (t) =>
  `${task}\n\n## Your thread: ${t.id}\n${t.assignment}${t === t0 ? CONTRACTS : ""}` +
  (ONE ? "" : "\nOther threads own the rest of the roadmap; stay within your assignment.");

/** One thread's gated writer in its own worktree, cut from `cut`; its branch, or null. */
async function runThread(t, cut) {
  try {
    return await gatedThread(t, cut);
  } catch (error) {
    (report.threads[t.id] ??= { cut, landed: null }).error = String(error?.stack ?? error);
    save();
    return null;
  }
}

async function gatedThread(t, cut) {
  const rec = (report.threads[t.id] = { cut, startMs: Date.now(), landed: null });
  const progress = [];
  const wt = await new SwarmGit({ repoRoot: APP, teamId: `div-${t.id}`, baseRef: cut, onProgress: (l) => progress.push(l) }).worktree("w");
  rec.worktree = progress;
  rec.path = wt.path;
  save();
  const state = await gate({
    cwd: wt.path, prompt: promptOf(t), roadmap: task, scope: ONE ? undefined : t.assignment, mode: "rounds", maxRounds: ROUNDS,
    record: (s) => { rec.rounds = s.rounds; save(); },
  });
  rec.endMs = Date.now();
  rec.branch = wt.branch;
  save();
  return wt.branch;
}

function contractCheck() {
  if (!existsSync(join(APP, CHECK))) return null;
  const r = spawnSync("bash", [CHECK], { cwd: APP, encoding: "utf8", timeout: 15 * 60 * 1000, maxBuffer: 64 << 20 });
  return { ok: r.status === 0, tail: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-3000) };
}

/** Merge a thread into /app, run the contract check, and give a failure one repair round. */
async function land(t, branch) {
  const rec = report.threads[t.id];
  if (branch === null) return false;
  const landing = { thread: t.id };
  report.landings.push(landing);
  const merged = spawnSync("git", ["-C", APP, "-c", "user.email=eval@local", "-c", "user.name=eval", "merge", "--no-ff", "--no-verify", "-m", `land ${t.id}`, branch], { encoding: "utf8" });
  if (merged.status !== 0) {
    git(APP, "merge", "--abort");
    rec.landed = landing.outcome = "conflict";
    save();
    return false;
  }
  rec.landed = landing.outcome = "merged";
  landing.check = contractCheck();
  save();
  if (landing.check && !landing.check.ok) {
    const fix = await cli(APP, `${promptOf(t)}\n\n## Repair\n\nYour thread has just been merged into this checkout, and the contract tests (\`bash ${CHECK}\`) now fail:\n\n${landing.check.tail}\n\nFix the code so they pass, without weakening the contract tests, then stop.`, true);
    snapshot(APP, `repair ${t.id}`);
    landing.repair = { usage: fix.usage, minutes: fix.minutes, check: contractCheck() };
    save();
  }
  return true;
}

snapshot(APP, "pre-division");
report.base = git(APP, "rev-parse", "HEAD");
save();

if (ARM === "sharded") {
  const branches = await Promise.all(threads.map((t) => runThread(t, report.base)));
  for (const [i, t] of threads.entries()) await land(t, branches[i]);
} else {
  const landed = new Set();
  const running = new Map();
  const settled = new Set();
  const launchReady = () => {
    const head = git(APP, "rev-parse", "HEAD");
    for (const t of threads) {
      if (running.has(t.id) || settled.has(t.id) || !t.blockedBy.every((b) => settled.has(b))) continue;
      const unlanded = t.blockedBy.filter((b) => !landed.has(b));
      running.set(t.id, runThread(t, head).then((branch) => [t, branch]));
      if (unlanded.length > 0) report.threads[t.id].blockersNotLanded = unlanded;
    }
  };
  // One loop lands and launches, so landings are serialized and every cut reads a
  // HEAD no landing is halfway through.
  launchReady();
  while (running.size > 0) {
    const [t, branch] = await Promise.race(running.values());
    running.delete(t.id);
    settled.add(t.id);
    if (await land(t, branch)) landed.add(t.id);
    launchReady();
  }
}

// The worktrees live under /app/.swarm; nothing below needs them, and grading must see
// only the integrated tree (the branches stay).
for (const t of threads) {
  const path = report.threads[t.id]?.path;
  if (path) git(APP, "worktree", "remove", "--force", path);
}
git(APP, "worktree", "prune");
rmSync(join(APP, ".swarm"), { recursive: true, force: true });

// Integrate and repair: one whole-roadmap review, each unfinished target to its owner.
const owner = (n) => threads.find((t) => t !== t0 && new RegExp(`Target ${n}\\b`).test(t.assignment)) ?? t0;
const final = (report.final = { review: await review(APP, task), repairs: [] });
save();
const open = (final.review.targets ?? []).filter((x) => x.status !== "done");
for (const t of threads) {
  const mine = open.filter((x) => owner(x.target) === t);
  if (mine.length === 0) continue;
  const fix = await cli(APP, `${promptOf(t)}\n\n## Repair\n\nEvery thread has been merged into this checkout, and a reviewer checked the whole roadmap. These targets of yours are not done:\n\n${JSON.stringify(mine, null, 1)}\n\nFix them in this checkout, then stop.`, true);
  snapshot(APP, `final repair ${t.id}`);
  final.repairs.push({ thread: t.id, targets: mine.map((x) => x.target), usage: fix.usage, minutes: fix.minutes });
  save();
}
process.exit(0);
