/**
 * In-container driver for the docs/07 §7.1 search arms; runner.mjs seeds it at
 * /opt/pilot/search.mjs and the harness calls it exactly as it calls the CLI:
 * `search.mjs <flags> "<prompt>"`.
 *
 *   PILOT_SEARCH=review  one agent, then the reviewer: the attempts behind arms (a) and (c)
 *   PILOT_SEARCH=rounds  up to PILOT_ROUNDS agent rounds; the reviewer's report on each
 *                        round opens the next (arm b, the budget-matched single agent)
 *   PILOT_SEARCH=self    the same rounds with no reviewer: each round opens with a prompt
 *                        to check the work against the roadmap itself (arm b0, the control
 *                        that separates the reviewer's feedback from the extra rounds)
 *
 * The reviewer is the same model in a fresh session. It sees the instruction and the
 * workspace, never the held-out tests (those reach the container only at grading), and
 * ends with one line of JSON: per-target status and a 0–100 score. What it changes in
 * /app is rolled back: tracked files, untracked files, and ignored files it creates
 * (changes outside the repository, such as installed packages, are not). Reports go to /verifier-out/<HOSTNAME>.search.json, beside
 * the verifier's <task>.<HOSTNAME>.reward.json, so search-report.py joins them.
 *
 * stdout forwards every child's message_stop, so the harness bills agent and reviewer
 * alike; the report keeps each step's usage so the arms can be split.
 */
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";

const argv = process.argv.slice(2);
const task = argv.at(-1);
const flags = argv.slice(0, -1);
const MODE = process.env.PILOT_SEARCH;
const ROUNDS = Number(process.env.PILOT_ROUNDS ?? 4);
// Overridable only so search.check.mjs can run it outside a task container.
const APP = process.env.PILOT_APP ?? "/app";
const CLI = (process.env.PILOT_CLI ?? "/opt/node/bin/node /opt/pilot/openswarm.mjs").split(" ");
const OUT = `${process.env.PILOT_OUT_DIR ?? "/verifier-out"}/${process.env.HOSTNAME || hostname()}.search.json`;
if (!["review", "rounds", "self"].includes(MODE)) {
  console.error(`PILOT_SEARCH must be review, rounds or self (got ${MODE})`);
  process.exit(2);
}

/**
 * One CLI run. An agent round forwards every line; a review forwards only its
 * message_stop, so a failed review cannot turn the attempt into an error.
 */
function cli(prompt, isAgent) {
  const started = Date.now();
  const r = spawnSync(CLI[0], [...CLI.slice(1), ...flags, prompt], {
    cwd: APP, encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "inherit"],
  });
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
  let text = "";
  for (const line of (r.stdout ?? "").split("\n")) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "text_delta") text += o.text;
    if (o.type === "message_stop") for (const k of Object.keys(usage)) usage[k] += o.usage?.[k] ?? 0;
    if (isAgent || o.type === "message_stop") process.stdout.write(`${line}\n`);
  }
  return { code: r.status ?? 1, text, usage, minutes: (Date.now() - started) / 60000 };
}

const git = (...args) => (spawnSync("git", ["-C", APP, ...args], { encoding: "utf8", maxBuffer: 256 << 20 }).stdout ?? "").trim();
const EXCLUDE = [".", ":(exclude).sbx"];
/** Commit the working tree so a reviewer's edits can be rolled back; returns the tree id. */
function snapshot(label) {
  git("add", "-A", "--", ...EXCLUDE);
  git("-c", "user.email=eval@local", "-c", "user.name=eval", "commit", "-q", "--no-verify", "--allow-empty", "-m", label);
  return { sha: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") };
}
/** Ignored files: node_modules, build outputs, caches. `clean -x` would take the image's own. */
const ignored = () => new Set(git("ls-files", "-z", "--others", "--ignored", "--exclude-standard").split("\0").filter(Boolean));
/** Back to the snapshot: tracked and untracked files, and the ignored files created since `before`. */
function restore(sha, before) {
  git("reset", "-q", "--hard", sha);
  git("clean", "-fdq", "-e", ".sbx");
  for (const f of ignored()) if (!before.has(f)) rmSync(join(APP, f), { force: true, recursive: true });
}

const REVIEW = `You are reviewing another engineer's implementation of the roadmap below, in this repository's working tree. Do not fix anything: your job is to measure.

For each target in the roadmap, decide whether it works as specified: check that the specified exports, signatures and behaviors exist, and run the repository's existing tests for the code involved plus small tests or scripts you write from the requirements. Everything you create or change in the repository is discarded after your review.

End your reply with exactly one line of JSON and nothing after it:
{"targets":[{"target":<number>,"status":"done"|"partial"|"missing"|"broken","notes":"<one sentence: what fails or is missing>"}],"regressions":"<existing tests that fail because of the change, or none>","score":<0-100, your estimate of the share of the roadmap's requirements that work as specified>}

# Roadmap

`;

function review() {
  const r = cli(REVIEW + task, false);
  const line = r.text.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  let verdict = null;
  try { verdict = JSON.parse(line); } catch {}
  const score = typeof verdict?.score === "number" ? verdict.score : null;
  return { score, targets: verdict?.targets ?? null, regressions: verdict?.regressions ?? null, usage: r.usage, minutes: r.minutes, tail: r.text.slice(-1500) };
}

const allDone = (rv) => Array.isArray(rv.targets) && rv.targets.length > 0 && rv.targets.every((t) => t.status === "done");

const continuation = (base, rv) => `${task}

## Continue

You have already worked on this roadmap: your changes are in this working tree (\`git diff ${base}\` shows them all). A reviewer then checked the result against the roadmap; its report follows. Finish what is missing or partial, fix what is broken, then stop.

${JSON.stringify({ targets: rv.targets, regressions: rv.regressions, score: rv.score }, null, 1)}`;

const selfContinuation = (base) => `${task}

## Continue

You have already worked on this roadmap: your changes are in this working tree (\`git diff ${base}\` shows them all). Check the result against the roadmap yourself: go through every target's requirements, run the repository's existing tests for the code involved plus small checks of your own, then finish what is missing or partial, fix what is broken, and stop.`;

const report = { mode: MODE, rounds: [] };
const save = () => writeFileSync(OUT, JSON.stringify(report, null, 1));
let code = 1;
let prompt = task;
let prevTree = snapshot("pre-agent").tree;
report.base = git("rev-parse", "HEAD");
save();

const maxRounds = MODE === "review" ? 1 : ROUNDS;
for (let i = 1; i <= maxRounds; i++) {
  const agent = cli(prompt, true);
  code = agent.code;
  const snap = snapshot(`round ${i}`);
  const round = { round: i, code, usage: agent.usage, minutes: agent.minutes, changed: snap.tree !== prevTree };
  report.rounds.push(round);
  save();
  // A round that changed nothing, or the last round, has no one to feed.
  if (MODE !== "review" && (!round.changed || i === maxRounds)) break;
  if (MODE === "self") {
    prompt = selfContinuation(report.base);
    prevTree = snap.tree;
    continue;
  }
  const before = ignored();
  round.review = review();
  restore(snap.sha, before);
  save();
  if (MODE === "rounds" && allDone(round.review)) break;
  prompt = continuation(report.base, round.review);
  prevTree = snap.tree;
}
process.exit(code);
