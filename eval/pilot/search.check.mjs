/**
 * Zero-token check of search.mjs: a scripted CLI stands in for openswarm, in a
 * temp git repo standing in for /app. Run: node eval/pilot/search.check.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const HERE = new URL(".", import.meta.url).pathname;
// The fake CLI: an agent appends a line to a.txt; a reviewer vandalizes the tree (which
// must be rolled back) and calls the roadmap done once a.txt has two lines.
const FAKE = `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const prompt = process.argv.at(-1);
appendFileSync("prompts.log", JSON.stringify(prompt) + "\\n");
const out = (o) => console.log(JSON.stringify(o));
if (prompt.startsWith("You are reviewing")) {
  const n = readFileSync("a.txt", "utf8").split("\\n").filter(Boolean).length;
  writeFileSync("a.txt", "vandal\\n"); writeFileSync("junk.txt", "x"); writeFileSync("cache.pyc", "x");
  const status = n >= 2 ? "done" : "partial";
  out({ type: "text_delta", text: "checked\\n" + JSON.stringify({ targets: [{ target: 1, status, notes: "" }], regressions: "none", score: n >= 2 ? 100 : 50 }) });
  out({ type: "message_stop", usage: { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0 } });
} else {
  appendFileSync("a.txt", "x\\n");
  out({ type: "text_delta", text: "worked" });
  out({ type: "message_stop", usage: { inputTokens: 100, outputTokens: 5, cacheReadInputTokens: 0 } });
}`;

function run(mode) {
  const dir = mkdtempSync(join(tmpdir(), "search-check-"));
  const app = join(dir, "app");
  const git = (...a) => spawnSync("git", ["-C", app, ...a], { encoding: "utf8" });
  spawnSync("mkdir", ["-p", app]);
  writeFileSync(join(app, "a.txt"), "");
  writeFileSync(join(app, ".gitignore"), "prompts.log\n*.pyc\n");
  writeFileSync(join(app, "image.pyc"), "the image's own ignored file");
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  writeFileSync(join(dir, "fake.mjs"), FAKE);
  const r = spawnSync(process.execPath, [join(HERE, "search.mjs"), "--single", "Build target 1."], {
    encoding: "utf8",
    env: { ...process.env, PILOT_SEARCH: mode, PILOT_APP: app, PILOT_CLI: `${process.execPath} ${join(dir, "fake.mjs")}`, PILOT_OUT_DIR: dir, HOSTNAME: "h1" },
  });
  assert.equal(r.status, 0, r.stderr);
  const stops = r.stdout.split("\n").filter((l) => l.includes('"message_stop"')).length;
  const texts = r.stdout.split("\n").filter((l) => l.includes('"text_delta"'));
  const prompts = readFileSync(join(app, "prompts.log"), "utf8").trim().split("\n").map(JSON.parse);
  return { report: JSON.parse(readFileSync(join(dir, "h1.search.json"), "utf8")), app, stops, texts, prompts };
}

// review: one agent, one review; the reviewer's edits are rolled back.
{
  const { report, app, stops, texts } = run("review");
  assert.equal(report.rounds.length, 1);
  assert.equal(report.rounds[0].review.score, 50);
  assert.equal(readFileSync(join(app, "a.txt"), "utf8"), "x\n");
  assert.ok(!existsSync(join(app, "junk.txt")));
  assert.ok(!existsSync(join(app, "cache.pyc")), "an ignored file the reviewer made is removed");
  assert.ok(existsSync(join(app, "image.pyc")), "an ignored file the image had is kept");
  assert.equal(stops, 2, "agent and reviewer usage both reach the harness");
  assert.ok(texts.every((l) => l.includes("worked")), "only the agent's text is forwarded");
}

// rounds: the review of round 1 opens round 2; round 2's review says done, so it stops.
{
  const { report, app, stops, prompts } = run("rounds");
  assert.equal(report.rounds.length, 2);
  assert.deepEqual(report.rounds.map((r) => r.review.score), [50, 100]);
  assert.ok(prompts[2].includes("## Continue") && prompts[2].includes(report.base), "round 2 gets the report and the base");
  assert.equal(readFileSync(join(app, "a.txt"), "utf8"), "x\nx\n");
  assert.ok(!existsSync(join(app, "junk.txt")));
  assert.equal(stops, 4);
}
// self: no reviewer; every round changes a.txt, so it runs all four rounds.
{
  const { report, stops, prompts } = run("self");
  assert.equal(report.rounds.length, 4);
  assert.ok(report.rounds.every((r) => !r.review));
  assert.ok(prompts.every((p) => !p.startsWith("You are reviewing")), "no reviewer runs");
  assert.ok(prompts.slice(1).every((p) => p.includes("Check the result against the roadmap yourself") && p.includes(report.base)));
  assert.equal(stops, 4);
}
console.log("search.check: ok");
