/**
 * The completion gate the pilot's in-container drivers share (search.mjs, division.mjs):
 * an agent round, then a reviewer, whose report opens the next round.
 *
 * The reviewer is the same model in a fresh session. It sees the instruction and the
 * working tree, never the held-out tests (those reach the container only at grading),
 * and ends with one line of JSON: per-target status and a 0–100 score. What it changes
 * in the tree is rolled back: tracked files, untracked files, and ignored files it
 * creates (changes outside the repository, such as installed packages, are not).
 *
 * Every agent run's JSONL is forwarded to stdout once the run ends (whole runs, so
 * concurrent threads never interleave); a review forwards only its message_stop, so
 * the harness bills it but a failed review cannot turn the cell into an error.
 */
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

// Overridable only so the checks can run the drivers outside a task container.
const CLI = (process.env.PILOT_CLI ?? "/opt/node/bin/node /opt/pilot/openswarm.mjs").split(" ");

/** The harness's flags, passed to every CLI run: everything before the prompt. */
export const flags = process.argv.slice(2, -1);
export const task = process.argv.at(-1);

/** One CLI run in `cwd`. */
export function cli(cwd, prompt, isAgent) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(CLI[0], [...CLI.slice(1), ...flags, prompt], { cwd, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (d) => { stdout += d; });
    child.on("close", (status) => {
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
      let text = "";
      let out = "";
      for (const line of stdout.split("\n")) {
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (o.type === "text_delta") text += o.text;
        if (o.type === "message_stop") for (const k of Object.keys(usage)) usage[k] += o.usage?.[k] ?? 0;
        if (isAgent || o.type === "message_stop") out += `${line}\n`;
      }
      process.stdout.write(out);
      resolve({ code: status ?? 1, text, usage, minutes: (Date.now() - started) / 60000 });
    });
  });
}

export const git = (cwd, ...args) => (spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 256 << 20 }).stdout ?? "").trim();
const EXCLUDE = [".", ":(exclude).sbx"];
/** Commit the working tree so a reviewer's edits can be rolled back. */
export function snapshot(cwd, label) {
  git(cwd, "add", "-A", "--", ...EXCLUDE);
  git(cwd, "-c", "user.email=eval@local", "-c", "user.name=eval", "commit", "-q", "--no-verify", "--allow-empty", "-m", label);
  return { sha: git(cwd, "rev-parse", "HEAD"), tree: git(cwd, "rev-parse", "HEAD^{tree}") };
}
/** Ignored files: node_modules, build outputs, caches. `clean -x` would take the image's own. */
const ignored = (cwd) => new Set(git(cwd, "ls-files", "-z", "--others", "--ignored", "--exclude-standard").split("\0").filter(Boolean));
/** Back to the snapshot: tracked and untracked files, and the ignored files created since `before`. */
function restore(cwd, sha, before) {
  git(cwd, "reset", "-q", "--hard", sha);
  git(cwd, "clean", "-fdq", "-e", ".sbx");
  for (const f of ignored(cwd)) if (!before.has(f)) rmSync(join(cwd, f), { force: true, recursive: true });
}

const REVIEW = `You are reviewing another engineer's implementation of the roadmap below, in this repository's working tree. Do not fix anything: your job is to measure.

For each target in the roadmap, decide whether it works as specified: check that the specified exports, signatures and behaviors exist, and run the repository's existing tests for the code involved plus small tests or scripts you write from the requirements. Everything you create or change in the repository is discarded after your review.

End your reply with exactly one line of JSON and nothing after it:
{"targets":[{"target":<number>,"status":"done"|"partial"|"missing"|"broken","notes":"<one sentence: what fails or is missing>"}],"regressions":"<existing tests that fail because of the change, or none>","score":<0-100, your estimate of the share of the roadmap's requirements that work as specified>}

# Roadmap

`;

/**
 * Review the tree at `cwd` (committed first, rolled back after). `scope`, when given, is
 * the part of the roadmap one engineer was assigned; the reviewer judges only that part.
 */
export async function review(cwd, roadmap, scope) {
  const snap = snapshot(cwd, "pre-review");
  const before = ignored(cwd);
  const scoped = scope === undefined ? "" : `\n\n# Scope\n\nThe engineer was assigned only this part of the roadmap. Judge and list only the targets it covers; work that belongs to other parts is not theirs:\n\n${scope}`;
  const r = await cli(cwd, REVIEW + roadmap + scoped, false);
  restore(cwd, snap.sha, before);
  const line = r.text.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  let verdict = null;
  try { verdict = JSON.parse(line); } catch {}
  const score = typeof verdict?.score === "number" ? verdict.score : null;
  return { score, targets: verdict?.targets ?? null, regressions: verdict?.regressions ?? null, usage: r.usage, minutes: r.minutes, tail: r.text.slice(-1500) };
}

export const allDone = (rv) => Array.isArray(rv.targets) && rv.targets.length > 0 && rv.targets.every((t) => t.status === "done");

const continuation = (prompt, base, rv) => `${prompt}

## Continue

You have already worked on this roadmap: your changes are in this working tree (\`git diff ${base}\` shows them all). A reviewer then checked the result against the roadmap; its report follows. Finish what is missing or partial, fix what is broken, then stop.

${JSON.stringify({ targets: rv.targets, regressions: rv.regressions, score: rv.score }, null, 1)}`;

const selfContinuation = (prompt, base) => `${prompt}

## Continue

You have already worked on this roadmap: your changes are in this working tree (\`git diff ${base}\` shows them all). Check the result against the roadmap yourself: go through every target's requirements, run the repository's existing tests for the code involved plus small checks of your own, then finish what is missing or partial, fix what is broken, and stop.`;

/**
 * The gate at `cwd`: agent rounds on `prompt`, each committed.
 *   review  one round, then one review (the search attempts)
 *   rounds  up to `maxRounds`; after each round but the last the reviewer's report opens the
 *           next; stops when the reviewer calls every target done or a round changes nothing
 *   self    the same rounds opened by a self-check prompt instead of a review
 * `record` receives the loop's state after every step.
 */
export async function gate({ cwd, prompt, roadmap, scope, mode, maxRounds, record = () => {} }) {
  const state = { base: "", rounds: [], code: 1 };
  let prevTree = snapshot(cwd, "pre-agent").tree;
  state.base = git(cwd, "rev-parse", "HEAD");
  record(state);
  let next = prompt;
  const last = mode === "review" ? 1 : maxRounds;
  for (let i = 1; i <= last; i++) {
    const agent = await cli(cwd, next, true);
    state.code = agent.code;
    const snap = snapshot(cwd, `round ${i}`);
    const round = { round: i, code: agent.code, usage: agent.usage, minutes: agent.minutes, changed: snap.tree !== prevTree };
    state.rounds.push(round);
    record(state);
    // A round that changed nothing, or the last round, has no one to feed.
    if (mode !== "review" && (!round.changed || i === last)) break;
    prevTree = snap.tree;
    if (mode === "self") {
      next = selfContinuation(prompt, state.base);
      continue;
    }
    round.review = await review(cwd, roadmap, scope);
    record(state);
    if (mode === "rounds" && allDone(round.review)) break;
    next = continuation(prompt, state.base, round.review);
  }
  return state;
}
