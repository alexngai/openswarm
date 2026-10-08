/**
 * Zero-token check of the landtrain arm's train checks (landing-checks.json): each must pass on
 * its task's base tree, since the train verifies the base first and, by default, stops when it
 * fails. Each task's image runs as runner.mjs runs it (the built openswarm at /opt/openswarm, the
 * host's Node at /opt/node), /app is made a git repo as its INIT does, and `landing.mjs --base`
 * runs the check in a linked worktree, as the train's baseline does. Prints pass/fail and the
 * check's duration per task; exits 1 when any fails. No model is called.
 *
 *   (host) OPENSWARM_ROOT=~/openswarm node eval/pilot/landing-base.mjs [task,…]
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROADMAP_DIR = resolve(process.env.ROADMAP_DIR ?? join(HERE, ".roadmap"));
const OPENSWARM_ROOT = resolve(process.env.OPENSWARM_ROOT ?? `${process.env.HOME}/openswarm`);
const CHECKS = JSON.parse(readFileSync(join(HERE, "landing-checks.json"), "utf8"));
const tasks = (process.argv[2] ?? Object.keys(CHECKS).join(",")).split(",").filter(Boolean);
// runner.mjs's INIT, the part the check needs: /app a git repo with a base commit.
const INIT = "cd /app && git config --global --add safe.directory '*' && (git rev-parse --is-inside-work-tree >/dev/null 2>&1 || (git init -q && git add -A && git -c user.email=eval@local -c user.name=eval commit -qm base))";

let failed = 0;
for (const task of tasks) {
  const image = /docker_image\s*=\s*"([^"]+)"/.exec(readFileSync(join(ROADMAP_DIR, `${task}-roadmap/task.toml`), "utf8"))?.[1];
  const started = Date.now();
  const r = spawnSync(
    "docker",
    [
      "run", "--rm", "--cpus", process.env.ROADMAP_CPUS ?? "8", "--memory", process.env.ROADMAP_MEM ?? "16g",
      "-v", `${OPENSWARM_ROOT}:/opt/openswarm:ro`, "-v", "/opt/node:/opt/node:ro",
      "-v", `${join(HERE, "landing.mjs")}:/opt/pilot/landing.mjs:ro`, "-v", `${join(HERE, "landing-checks.json")}:/opt/pilot/landing-checks.json:ro`,
      image, "bash", "-c", `${INIT} && /opt/node/bin/node /opt/pilot/landing.mjs --base ${task}`,
    ],
    { encoding: "utf8", maxBuffer: 64 << 20 },
  );
  let verdict;
  try {
    verdict = JSON.parse(r.stdout.trim().split("\n").at(-1));
  } catch {
    verdict = { passed: false, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-1000) };
  }
  if (!verdict.passed) failed++;
  const check = verdict.ms === undefined ? "check did not run" : `check ${(verdict.ms / 1000).toFixed(1)}s`;
  console.log(`${task.padEnd(10)} ${verdict.passed ? "PASS" : "FAIL"}  ${check}, container ${((Date.now() - started) / 1000).toFixed(0)}s`);
  if (!verdict.passed) console.log(`  ${verdict.failed ?? ""}\n  ${(verdict.output ?? "").trim().replace(/\n/g, "\n  ")}`);
}
process.exit(failed === 0 ? 0 : 1);
