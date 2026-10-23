/**
 * docs/05 Phase B exit criterion 1 in the container: the paired counterfactual. runner.mjs
 * seeds it at /opt/pilot/landing.mjs and runs it as the `landtrain` arm's last checkpoint
 * (weight 0), after the run is graded. The run landed its branches through the train
 * (OPENSWARM_TEAM_SPEC); this replays today's sequential queue on the SAME branches, as the
 * train first queued them (`train/enqueued`'s `tip`), and measures both the same way:
 *
 * - a landing merged cleanly when the train's check (the spec's `worktrees.train.checks`) passes
 *   on the tree it left: for the train, each commit it advanced the target to; for the queue,
 *   the tree after each of its merges;
 * - the queue runs from the run's base (the train's baseline tip), in a worktree of its own with
 *   the checkout's ignored environment linked in as the train's is, merging each entry `--no-ff`
 *   in today's order, worktree creation order (`created`; SwarmGit.mergeAll merges its worktrees
 *   as they were created), a conflict aborted and retained;
 * - the held-out reward of the queue's tree: test.sh with /app swapped to that tree, /app (HEAD,
 *   index, files) and /logs/verifier restored after. The train's is the graded run's own, which
 *   is the landed tree's only when the graded /app was the train's target tip, clean (the first
 *   checkpoint's `<task>.<host>.app-state.txt`): `train.gradedIsTip`.
 *
 * A tip that is not a commit here, or a replay merge that fails without a conflict, makes the
 * cell an `error` (never scored). A failed reward step is `queue.rewardError`, keeping the rest.
 * Writes /verifier-out/<task>.<host>.queue.{reward.json,stdout.txt} and
 * /verifier-out/<host>.landing.json. A cell without a train journal (another arm) writes nothing.
 *
 *   landing.mjs <task>          the counterfactual
 *   landing.mjs --base <task>   zero-token: the task's check (landing-checks.json) on /app's HEAD
 *                               in a linked worktree, as the train's baseline runs it; prints
 *                               { task, passed, ms } and exits 1 when it fails (landing-base.mjs)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const { linkIgnored } = await import(process.env.PILOT_GIT_MODULE ?? "/opt/openswarm/packages/git/dist/index.js");
const APP = process.env.PILOT_APP ?? "/app";
const HOST = process.env.HOSTNAME || hostname();
const AS = ["-c", "user.email=swarm@openswarm", "-c", "user.name=openswarm"];
const SHA = /^[0-9a-f]{40}$/;

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const isCommit = (ref) => typeof ref === "string" && SHA.test(ref) && spawnSync("git", ["cat-file", "-e", `${ref}^{commit}`], { cwd: APP }).status === 0;

/** The checks in order until one fails, as the train's verifier runs them: `bash -c` in the tree. */
function check(commands, cwd) {
  for (const command of commands) {
    const r = spawnSync("bash", ["-c", command], { cwd, encoding: "utf8", maxBuffer: 64 << 20 });
    if (r.status !== 0) return { passed: false, failed: command, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-1000) };
  }
  return { passed: true };
}

/**
 * `path` at `ref`, nothing of the last tree or its checks left but ignored files. The clean runs
 * first, under the ignore rules of the tree being left: after the checkout a tree that drops an
 * ignore rule would have it delete the environment that rule kept.
 */
function reset(path, ref) {
  git(path, "clean", "-fdq");
  git(path, "-c", "core.hooksPath=/dev/null", "checkout", "-q", "-f", "--detach", ref);
}

/** A detached worktree of /app at `ref`, its ignored environment linked in as the train's is. */
async function worktree(ref) {
  const path = join(mkdtempSync(join(tmpdir(), "osw-landing-")), "tree");
  git(APP, "worktree", "add", "-q", "--detach", path, ref);
  await linkIgnored(APP, path);
  return path;
}

function drop(path) {
  try {
    git(APP, "worktree", "remove", "--force", path);
  } catch {
    rmSync(path, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--base") {
  const task = process.argv[3];
  const commands = JSON.parse(readFileSync(process.env.PILOT_CHECKS ?? "/opt/pilot/landing-checks.json", "utf8"))[task];
  if (!commands) {
    console.error(`no landing check for ${task}`);
    process.exit(2);
  }
  const path = await worktree("HEAD");
  const started = Date.now();
  const verdict = check(commands, path);
  const ms = Date.now() - started;
  drop(path);
  console.log(JSON.stringify({ task, ...verdict, ms }));
  process.exit(verdict.passed ? 0 : 1);
}

/** A path going from `from` to `to` that /app holds as an ignored file (its environment), which a checkout would replace silently. */
function clobbers(from, to) {
  const changed = git(APP, "diff", "-z", "--name-only", "--no-renames", from, to).split("\0").filter(Boolean);
  const ignored = git(APP, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory").split("\0").filter(Boolean).map((e) => e.replace(/\/$/, ""));
  return changed.find((path) => ignored.some((e) => path === e || path.startsWith(`${e}/`) || e.startsWith(`${path}/`)));
}

/**
 * Run `fn` with /app swapped to `commit`: its files (tracked and untracked; ignored ones stay, as
 * the environment) snapshotted to a dangling commit first, and HEAD, index and files put back after.
 */
function swapped(commit, fn) {
  const head = git(APP, "rev-parse", "HEAD");
  const branch = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: APP, encoding: "utf8" }).stdout.trim();
  const index = join(git(APP, "rev-parse", "--absolute-git-dir"), "index");
  const savedIndex = join(mkdtempSync(join(tmpdir(), "osw-index-")), "index");
  copyFileSync(index, savedIndex);
  git(APP, "add", "-A");
  const snapshot = git(APP, ...AS, "commit-tree", git(APP, "write-tree"), "-p", head, "-m", "landing: /app before the queue's held-out run");
  copyFileSync(savedIndex, index);
  const clobbered = clobbers(snapshot, commit);
  if (clobbered !== undefined) throw new Error(`the queue's tree would overwrite ${clobbered}, which is ignored in ${APP}`);
  try {
    reset(APP, commit);
    return fn();
  } finally {
    // Back to the snapshot first, so the clean runs under /app's own ignore rules again.
    git(APP, "-c", "core.hooksPath=/dev/null", "checkout", "-q", "-f", "--detach", snapshot);
    git(APP, "clean", "-fdq");
    if (branch !== "") git(APP, "symbolic-ref", "HEAD", branch);
    else git(APP, "update-ref", "--no-deref", "HEAD", head);
    copyFileSync(savedIndex, index);
  }
}

/** test.sh in /app as the verifier checkpoint runs it, with the graded /logs/verifier set aside and put back. */
function heldOut(task, out) {
  const logs = process.env.PILOT_LOGS ?? "/logs/verifier";
  const graded = `${logs}.graded`;
  if (existsSync(logs)) renameSync(logs, graded);
  mkdirSync(logs, { recursive: true });
  try {
    spawnSync("bash", ["-c", `bash "$0" > "$1/stdout.txt" 2>&1`, process.env.PILOT_TEST ?? "/tests/test.sh", logs], { cwd: APP, stdio: "ignore" });
    for (const f of ["reward.json", "stdout.txt"]) if (existsSync(join(logs, f))) copyFileSync(join(logs, f), join(out, `${task}.${HOST}.queue.${f}`));
    return JSON.parse(readFileSync(join(logs, "reward.json"), "utf8")).reward ?? null;
  } finally {
    rmSync(logs, { recursive: true, force: true });
    if (existsSync(graded)) renameSync(graded, logs);
  }
}

const task = process.argv[2];
const out = process.env.PILOT_OUT_DIR ?? "/verifier-out";
const runs = process.env.PILOT_RUNS_DIR ?? "/tmp/openswarm-home/runs";
const journals = (existsSync(runs) ? readdirSync(runs) : []).map((d) => join(runs, d, "train.jsonl")).filter((p) => existsSync(p));
if (journals.length === 0) process.exit(0);
// One run per cell; the newest should a cell hold more.
const journal = journals.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
const events = readFileSync(journal, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const of = (type) => events.filter((e) => e.type === type).map((e) => e.data);

const started = Date.now();
const report = { task, run: basename(dirname(journal)), journals: journals.length };
try {
  const commands = JSON.parse(readFileSync(process.env.PILOT_SPEC ?? "/opt/pilot/spec.json", "utf8")).worktrees.train.checks;
  const entries = of("train/enqueued").filter((e) => e.after === undefined);
  for (const e of entries) {
    if (!isCommit(e.tip)) throw new Error(`entry ${e.key}: tip ${JSON.stringify(e.tip)} is not a commit in ${APP}`);
    if (!Number.isInteger(e.created)) throw new Error(`entry ${e.key}: train/enqueued has no worktree creation order (created)`);
  }
  // Today's order: SwarmGit.mergeAll merges its task worktrees as they were created.
  entries.sort((a, b) => a.created - b.created);
  const base = of("train/baseline")[0]?.tip ?? of("train/batch")[0]?.tip ?? of("train/unverified").find((u) => u.batch === 0)?.commit;
  if (entries.length > 0 && !isCommit(base)) throw new Error(`the run's base ${JSON.stringify(base)} is not a commit in ${APP}`);
  const landed = of("train/landed");
  const stopped = of("train/stopped").at(-1);
  const repairs = of("train/repair");
  const trainTip = landed.at(-1)?.commit ?? base;
  const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);
  const reward = read(join(process.env.PILOT_LOGS ?? "/logs/verifier", "reward.json"));
  // /app as it was graded: HEAD, then `git status --porcelain`.
  const [gradedHead, ...dirty] = (read(process.env.PILOT_APP_STATE ?? join(out, `${task}.${HOST}.app-state.txt`)) ?? "").split("\n").filter(Boolean);
  Object.assign(report, {
    check: commands,
    base: base ?? null,
    entries: entries.map(({ key, branch, tip, created, priority, commits }) => ({ key, branch, tip, created, priority, commits })),
    train: {
      landed: [...new Set(landed.map((l) => l.key))],
      ejected: of("train/ejected").map(({ key, reason }) => ({ key, reason })),
      withheld: stopped?.withheld ?? [],
      stopped: stopped?.reason ?? null,
      repairs: repairs.length,
      repaired: [...new Set(repairs.map((r) => r.key))],
      resolved: of("train/resolve").filter((r) => r.outcome === "resolved").map((r) => r.key),
      batches: of("train/batch").length,
      bisects: new Set(of("train/batch").flatMap((b) => (b.parent === undefined ? [] : [b.parent]))).size,
      tip: trainTip ?? null,
      graded: { head: gradedHead ?? null, dirty: dirty.slice(0, 20) },
      gradedIsTip: trainTip !== undefined && gradedHead === trainTip && dirty.length === 0,
      reward: reward === undefined ? null : (JSON.parse(reward).reward ?? null),
    },
  });
  if (entries.length > 0) {
    const tree = await worktree(base);
    try {
      const verdicts = new Map();
      const passes = (commit) => {
        if (!verdicts.has(commit)) {
          reset(tree, commit);
          verdicts.set(commit, check(commands, tree).passed);
        }
        return verdicts.get(commit);
      };
      report.train.cleanMerge = landed.map((l) => ({ key: l.key, commit: l.commit, clean: passes(l.commit) }));
      reset(tree, base);
      const queue = { landed: [], conflicts: [], cleanMerge: [] };
      for (const e of entries) {
        // Whatever the last check wrote goes, so only the merges shape the tree.
        reset(tree, "HEAD");
        try {
          git(tree, ...AS, "merge", "--no-ff", "--no-verify", "-q", "-m", `swarm: merge ${e.branch}`, e.tip);
        } catch (error) {
          const unmerged = git(tree, "diff", "--name-only", "--diff-filter=U");
          spawnSync("git", ["merge", "--abort"], { cwd: tree });
          if (unmerged === "") throw new Error(`replaying ${e.key}: the merge failed without a conflict: ${String(error?.stderr || error?.message).trim()}`);
          queue.conflicts.push(e.key);
          continue;
        }
        queue.landed.push(e.key);
        const verdict = check(commands, tree);
        queue.cleanMerge.push({ key: e.key, commit: git(tree, "rev-parse", "HEAD"), clean: verdict.passed, ...(verdict.passed ? {} : { failed: verdict.failed }) });
      }
      queue.tip = git(tree, "rev-parse", "HEAD");
      report.queue = queue;
    } finally {
      drop(tree);
    }
    report.sameTree = git(APP, "rev-parse", `${trainTip}^{tree}`) === git(APP, "rev-parse", `${report.queue.tip}^{tree}`);
    try {
      report.queue.reward = swapped(report.queue.tip, () => heldOut(task, out));
    } catch (error) {
      report.queue.rewardError = String(error?.message ?? error);
    }
  }
} catch (error) {
  report.error = String(error?.stack ?? error);
} finally {
  report.ms = Date.now() - started;
  writeFileSync(join(out, `${HOST}.landing.json`), JSON.stringify(report, null, 1));
}
