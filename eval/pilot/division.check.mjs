/**
 * Zero-token check of division.mjs: a scripted CLI stands in for openswarm, a temp git
 * repo for /app, and the real SwarmGit (packages/git, built) makes the worktrees.
 * Run: node eval/pilot/division.check.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const HERE = new URL(".", import.meta.url).pathname;
const GIT_MODULE = join(HERE, "../../packages/git/dist/index.js");
// Writers put <thread>.txt in their tree (thread 0 also the contract check, which needs
// t0.txt); scoped reviews pass; the whole-roadmap review calls target 2 partial until
// t2's repair writes t2-fixed.txt.
const FAKE = `import { appendFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
const prompt = process.argv.at(-1);
appendFileSync(process.env.PROMPT_LOG, JSON.stringify({ cwd: process.cwd(), prompt }) + "\\n");
const out = (o) => console.log(JSON.stringify(o));
const verdict = (targets) => out({ type: "text_delta", text: "checked\\n" + JSON.stringify({ targets, regressions: "none", score: 90 }) });
const thread = /## Your thread: (t\\d)/.exec(prompt)?.[1];
if (prompt.startsWith("You are reviewing")) {
  if (prompt.includes("# Scope")) verdict([{ target: 1, status: "done", notes: "" }]);
  else verdict([{ target: 1, status: "done", notes: "" }, { target: 2, status: existsSync("t2-fixed.txt") ? "done" : "partial", notes: "x" }]);
} else if (prompt.includes("## Repair")) {
  writeFileSync(thread + "-fixed.txt", "fixed");
  out({ type: "text_delta", text: "repaired" });
} else {
  writeFileSync(thread + ".txt", thread);
  if (thread === "t0") { mkdirSync(".pilot", { recursive: true }); writeFileSync(".pilot/contract-check.sh", "test -f t0.txt\\n"); }
  out({ type: "text_delta", text: "worked" });
}
out({ type: "message_stop", usage: { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0 } });`;

const PLAN = {
  workers: 1,
  threads: [
    { id: "t0", assignment: "Shared contracts only." },
    { id: "t1", blockedBy: ["t0"], assignment: "Target 1: the first thing." },
    { id: "t2", blockedBy: ["t0"], assignment: "Target 2: the second thing." },
  ],
};

function run(arm) {
  const dir = mkdtempSync(join(tmpdir(), "division-check-"));
  const app = join(dir, "app");
  mkdirSync(app);
  const git = (...a) => spawnSync("git", ["-C", app, ...a], { encoding: "utf8" });
  writeFileSync(join(app, "README"), "base\n");
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  writeFileSync(join(dir, "fake.mjs"), FAKE);
  writeFileSync(join(dir, "plan.json"), JSON.stringify(PLAN));
  const log = join(dir, "prompts.log");
  const r = spawnSync(process.execPath, [join(HERE, "division.mjs"), "--single", "The roadmap. Target 1. Target 2."], {
    encoding: "utf8",
    env: {
      ...process.env, PILOT_DIVISION: arm, PILOT_APP: app, PILOT_PLAN: join(dir, "plan.json"), PILOT_OUT_DIR: dir,
      PILOT_CLI: `${process.execPath} ${join(dir, "fake.mjs")}`, PILOT_GIT_MODULE: GIT_MODULE, HOSTNAME: "h1", PROMPT_LOG: log,
    },
  });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(readFileSync(join(dir, "h1.division.json"), "utf8"));
  const prompts = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  const stops = r.stdout.split("\n").filter((l) => l.includes('"message_stop"')).length;
  return { report, app, prompts, stops };
}

for (const arm of ["sharded", "program"]) {
  const { report, app, prompts, stops } = run(arm);
  for (const f of ["t0.txt", "t1.txt", "t2.txt", "t2-fixed.txt", ".pilot/contract-check.sh"]) assert.ok(existsSync(join(app, f)), `${arm}: ${f} landed`);
  // Thread 0 lands first; program lands t1 and t2 in whichever order they finish.
  assert.equal(report.landings[0].thread, "t0");
  assert.deepEqual(report.landings.map((l) => [l.thread, l.outcome, l.check?.ok]).sort(), [["t0", "merged", true], ["t1", "merged", true], ["t2", "merged", true]]);
  const cuts = ["t1", "t2"].map((id) => report.threads[id].cut);
  if (arm === "sharded") assert.ok(cuts.every((c) => c === report.base), "sharded cuts every thread from the base");
  else assert.ok(cuts.every((c) => c !== report.base), "program cuts dependents after thread 0 lands");
  assert.ok(prompts.filter((p) => !p.prompt.startsWith("You are reviewing") && !p.prompt.includes("## Repair")).every((p) => p.cwd.includes(".swarm/worktrees/div-")), "writers work in their worktrees");
  assert.ok(prompts.find((p) => p.prompt.includes("## Your thread: t0")).prompt.includes(".pilot/contract-check.sh"), "thread 0 is asked for contract tests");
  assert.deepEqual(report.final.repairs.map((x) => [x.thread, x.targets]), [["t2", [2]]], "the unfinished target goes to its owner");
  // 3 writers + 3 scoped reviews + 1 whole review + 1 repair
  assert.equal(stops, 8);
}
console.log("division.check: ok");
