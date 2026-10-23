/**
 * Zero-token check of landing.mjs, the paired counterfactual queue: a temp git repo stands in for
 * /app (an ignored node_modules the check needs, so an unlinked tree would fail it, and an
 * ignored .env-local), the built train (packages/swarm, packages/git) lands six branches with a
 * planted bad commit (which also drops .env-local's ignore rule) and a conflict, its priorities
 * the reverse of the worktrees' creation order, scripted members repairing and resolving; the
 * workspace is fast-forwarded as the CLI does and graded by a stand-in test.sh, and landing.mjs
 * replays today's queue (creation order) on the same branches. Then the cells it must not score
 * or pair: a tip that is no commit, a graded checkout that was dirty, a reward step that failed.
 * Run after `npm run build`: node eval/pilot/landing.check.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const HERE = new URL(".", import.meta.url).pathname;
const GIT_MODULE = join(HERE, "../../packages/git/dist/index.js");
const { SwarmGit } = await import(GIT_MODULE);
const { SwarmJournal, landTrain, trainVerify } = await import(join(HERE, "../../packages/swarm/dist/index.js"));

const tmp = (prefix) => mkdtempSync(join(tmpdir(), `landing-check-${prefix}-`));
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// /app: a repo whose ignored environment the check needs, and an ignored file of the environment's own.
const app = tmp("app");
sh(app, "init", "-q", "-b", "main");
const IGNORE = "node_modules/\n.env-local\n";
writeFileSync(join(app, ".gitignore"), IGNORE);
writeFileSync(join(app, "README.md"), "base\n");
mkdirSync(join(app, "node_modules"));
writeFileSync(join(app, "node_modules", "marker"), "env\n");
writeFileSync(join(app, ".env-local"), "keep me\n");
sh(app, "add", ".");
sh(app, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
const base = sh(app, "rev-parse", "HEAD");

// The train's check: the linked environment, and no planted file.
const checks = ["test -f node_modules/marker", "test ! -f bad.txt"];
const pilot = tmp("pilot");
writeFileSync(join(pilot, "spec.json"), JSON.stringify({ topology: "peer-team", worktrees: { train: { checks, batchSize: 4, maxRepairs: 1 } } }));
// Stand-in test.sh, run in /app: a point per target present, zero for a tree holding the planted file; it leaves a report behind, as vbt's copies its tests in.
writeFileSync(
  join(pilot, "test.sh"),
  'n=0; for f in a.txt b.txt c.txt e.txt; do [ -f $f ] && n=$((n+1)); done; grep -qs two shared.txt && n=$((n+1)); [ -f bad.txt ] && n=0\n' +
    'echo "{\\"reward\\": $(awk "BEGIN { print $n / 5 }")}" > "$PILOT_LOGS/reward.json"; echo "Result: $n/5"; echo "$n" > test-report.txt\n',
);

// Six branches: c2 plants bad.txt and drops .env-local's ignore rule (its repair undoes both), c3 and c4 conflict on shared.txt.
const swarm = new SwarmGit({ repoRoot: app, teamId: "chk" });
const set = {
  c0: { "a.txt": "a\n" },
  c1: { "b.txt": "b\n" },
  c2: { "bad.txt": "x\n", "c.txt": "c\n", ".gitignore": "node_modules/\n" },
  c3: { "shared.txt": "one\n" },
  c4: { "shared.txt": "two\n" },
  c5: { "e.txt": "e\n" },
};
for (const [key, files] of Object.entries(set)) {
  const wt = await swarm.worktree(key);
  for (const [path, text] of Object.entries(files)) writeFileSync(join(wt.path, path), text);
  await swarm.autoCommit(wt, `work ${key}`);
}
const runs = tmp("runs");
const journal = SwarmJournal.open(join(runs, "run-check", "train.jsonl"));
const owners = new Map(Object.keys(set).map((key) => [key, { member: { name: `owner-${key}` }, prompt: `task ${key}` }]));
const outcome = await landTrain(swarm, { checks, batchSize: 4, maxRepairs: 1 }, {
  journal,
  owners,
  // Board order the reverse of creation order: the train lands by priority, today's queue merges as created.
  tasks: Object.keys(set).reverse().map((id) => ({ id, blockedBy: [] })),
  verify: trainVerify({ checks }),
  run: async (member, prompt, key) => {
    const cwd = (await swarm.worktree(key)).path;
    if (prompt.includes("## Integrate")) writeFileSync(join(cwd, "shared.txt"), "one\ntwo\n");
    else {
      rmSync(join(cwd, "bad.txt"));
      writeFileSync(join(cwd, ".gitignore"), IGNORE);
    }
    return { member: member.name, runId: "r", text: "done", output: [], stopReason: "completed" };
  },
});
await swarm.dispose();
assert.equal(outcome.landed.length, 6);

// As the CLI leaves it, then graded: /app fast-forwarded, its state as the first checkpoint records it, the graded logs, test.sh's leftovers untracked.
sh(app, "merge", "--ff-only", "-q", outcome.targetBranch);
const out = tmp("out");
writeFileSync(join(out, "task-x.cell.app-state.txt"), `${sh(app, "rev-parse", "HEAD")}\n${sh(app, "status", "--porcelain")}`);
const logs = join(tmp("logs"), "verifier");
mkdirSync(logs);
const env = { ...process.env, PILOT_APP: app, PILOT_RUNS_DIR: runs, PILOT_SPEC: join(pilot, "spec.json"), PILOT_TEST: join(pilot, "test.sh"), PILOT_LOGS: logs, PILOT_GIT_MODULE: GIT_MODULE, HOSTNAME: "cell" };
spawnSync("bash", [join(pilot, "test.sh")], { cwd: app, env });
assert.equal(JSON.parse(readFileSync(join(logs, "reward.json"), "utf8")).reward, 1);
// A staged file too, so the index is checked to come back as it was.
writeFileSync(join(app, "staged.txt"), "staged\n");
sh(app, "add", "staged.txt");
const before = { head: sh(app, "rev-parse", "HEAD"), status: sh(app, "status", "--porcelain"), staged: sh(app, "diff", "--cached", "--name-only") };

const run = spawnSync(process.execPath, [join(HERE, "landing.mjs"), "task-x"], { env: { ...env, PILOT_OUT_DIR: out }, encoding: "utf8" });
assert.equal(run.status, 0, run.stderr);
const report = JSON.parse(readFileSync(join(out, "cell.landing.json"), "utf8"));
assert.equal(report.error, undefined, report.error);

// The same six branches, as first queued, in creation order (their priorities run the other way).
assert.equal(report.base, base);
assert.deepEqual(report.entries.map((e) => [e.key, e.created, e.priority]), ["c0", "c1", "c2", "c3", "c4", "c5"].map((key, i) => [key, i, 5 - i]));
// The train: all six landed, every landing clean, the culprit bisected out and repaired, the conflict resolved.
assert.deepEqual([...report.train.landed].sort(), ["c0", "c1", "c2", "c3", "c4", "c5"]);
assert.ok(report.train.cleanMerge.length === 6 && report.train.cleanMerge.every((c) => c.clean), JSON.stringify(report.train.cleanMerge));
assert.ok(report.train.bisects >= 1);
assert.deepEqual(report.train.repaired, ["c2"]);
assert.equal(report.train.resolved.length, 1);
assert.equal(report.train.gradedIsTip, true);
assert.equal(report.train.reward, 1);
// Today's queue on the same tips, as created: the bad commit merges and every landing after it is broken; c4, after c3, conflicts and is retained.
assert.deepEqual(report.queue.landed, ["c0", "c1", "c2", "c3", "c5"]);
assert.deepEqual(report.queue.conflicts, ["c4"]);
assert.deepEqual(report.queue.cleanMerge.map((c) => c.clean), [true, true, false, false, false]);
assert.equal(report.queue.reward, 0);
assert.equal(report.sameTree, false);
assert.equal(JSON.parse(readFileSync(join(out, "task-x.cell.queue.reward.json"), "utf8")).reward, 0);
assert.match(readFileSync(join(out, "task-x.cell.queue.stdout.txt"), "utf8"), /Result: 0\/5/);

// /app and the graded logs are as they were: HEAD, branch, index, untracked leftovers, ignored environment.
assert.equal(sh(app, "rev-parse", "HEAD"), before.head);
assert.equal(sh(app, "symbolic-ref", "HEAD"), "refs/heads/main");
assert.equal(sh(app, "status", "--porcelain"), before.status);
assert.equal(sh(app, "diff", "--cached", "--name-only"), before.staged);
assert.equal(readFileSync(join(app, "test-report.txt"), "utf8"), "5\n");
assert.ok(existsSync(join(app, "node_modules", "marker")));
// The queue's tree dropped .env-local's ignore rule; /app's copy survives the swap there and back.
assert.equal(readFileSync(join(app, ".env-local"), "utf8"), "keep me\n");
assert.equal(JSON.parse(readFileSync(join(logs, "reward.json"), "utf8")).reward, 1);
assert.ok(!existsSync(`${logs}.graded`));
assert.equal(sh(app, "worktree", "list").split("\n").length, 1);

// A tip that is not a commit: the cell is an error, never scored, and /app is untouched.
const bad = join(tmp("runs-bad"), "run-bad");
mkdirSync(bad);
let swapped = false;
writeFileSync(
  join(bad, "train.jsonl"),
  readFileSync(join(runs, "run-check", "train.jsonl"), "utf8")
    .split("\n")
    .map((line) => (!swapped && line.includes('"train/enqueued"') && (swapped = true) ? line.replace(/"tip":"[0-9a-f]+"/, `"tip":"${"0".repeat(40)}"`) : line))
    .join("\n"),
);
const outBad = tmp("out-bad");
assert.equal(spawnSync(process.execPath, [join(HERE, "landing.mjs"), "task-x"], { env: { ...env, PILOT_RUNS_DIR: dirname(bad), PILOT_OUT_DIR: outBad } }).status, 0);
const badReport = JSON.parse(readFileSync(join(outBad, "cell.landing.json"), "utf8"));
assert.match(badReport.error, /entry c5: tip "0{40}" is not a commit/); // the first enqueued: highest priority
assert.equal(badReport.queue, undefined);
assert.equal(sh(app, "status", "--porcelain"), before.status);

// A graded checkout that was dirty is no pairing for the reward; a reward step that fails keeps the landings.
const outDirty = tmp("out-dirty");
writeFileSync(join(pilot, "no-reward.sh"), "exit 0\n");
writeFileSync(join(outDirty, "task-x.cell.app-state.txt"), `${before.head}\n M README.md\n`);
assert.equal(spawnSync(process.execPath, [join(HERE, "landing.mjs"), "task-x"], { env: { ...env, PILOT_OUT_DIR: outDirty, PILOT_TEST: join(pilot, "no-reward.sh") } }).status, 0);
const dirty = JSON.parse(readFileSync(join(outDirty, "cell.landing.json"), "utf8"));
assert.equal(dirty.error, undefined, dirty.error);
assert.equal(dirty.train.gradedIsTip, false);
assert.deepEqual(dirty.train.graded.dirty, [" M README.md"]);
assert.match(dirty.queue.rewardError, /reward\.json/);
assert.equal(dirty.queue.reward, undefined);
assert.deepEqual(dirty.queue.cleanMerge.map((c) => c.clean), [true, true, false, false, false]);
assert.equal(sh(app, "status", "--porcelain"), before.status);
assert.equal(readFileSync(join(app, ".env-local"), "utf8"), "keep me\n");

// Another arm's cell (no train journal) writes nothing.
const none = tmp("none");
assert.equal(spawnSync(process.execPath, [join(HERE, "landing.mjs"), "task-x"], { env: { ...env, PILOT_RUNS_DIR: join(none, "runs"), PILOT_OUT_DIR: none } }).status, 0);
assert.ok(!existsSync(join(none, "cell.landing.json")));

// The zero-token base check: passes on the base tree's environment, fails without it.
const checksFile = join(pilot, "checks.json");
writeFileSync(checksFile, JSON.stringify({ ok: checks, missing: ["test -f node_modules/nope"] }));
const base1 = spawnSync(process.execPath, [join(HERE, "landing.mjs"), "--base", "ok"], { env: { ...env, PILOT_CHECKS: checksFile }, encoding: "utf8" });
assert.equal(base1.status, 0, base1.stdout + base1.stderr);
assert.equal(JSON.parse(base1.stdout).passed, true);
const base2 = spawnSync(process.execPath, [join(HERE, "landing.mjs"), "--base", "missing"], { env: { ...env, PILOT_CHECKS: checksFile }, encoding: "utf8" });
assert.equal(base2.status, 1);
assert.equal(JSON.parse(base2.stdout).failed, "test -f node_modules/nope");

console.log("landing.check: ok", JSON.stringify({ train: report.train.cleanMerge.length, queue: report.queue.cleanMerge.map((c) => c.clean), rewards: [report.train.reward, report.queue.reward] }));
