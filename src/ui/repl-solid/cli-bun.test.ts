/**
 * cli-bun.test.ts — subprocess tests that exercise the full CLI stack under
 * the Bun runtime. Complements the component/e2e tests (which mount pieces
 * of the Solid REPL in-process via testRender) by verifying that Bun can
 * launch `bun src/cli.ts` and drive real commands end-to-end.
 *
 * Runs via `bun test src/ui/repl-solid/cli-bun.test.ts`.
 *
 * Scenarios:
 *   - `bun src/cli.ts --help`   (offline, always runs)
 *   - `bun src/cli.ts doctor`   (offline, always runs)
 *   - `bun src/cli.ts prompt "..." --headless`   (live; skipped without
 *     CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY)
 *
 * Skipped unless auth is present; set OPENSWARM_SKIP_LIVE=1 to force-skip.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const CLI_PATH = join(REPO_ROOT, "src", "cli.ts");

const haveAuth = Boolean(
  process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY,
);
const skipLive = process.env.OPENSWARM_SKIP_LIVE === "1";
const runLive = haveAuth && !skipLive;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  args: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<RunResult> {
  const proc = spawn({
    cmd: ["bun", CLI_PATH, ...args],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(opts.env ?? {}) },
  });

  let timer: Timer | undefined;
  if (opts.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      proc.kill();
    }, opts.timeoutMs);
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return { exitCode, stdout, stderr };
}

// Both cases spawn a cold CLI subprocess. Idle in a container it takes about
// 2s; inside the full parity run under x86 emulation it has been measured past
// 15s, a spread of roughly 7x that comes from contention rather than from
// anything the CLI does. Budget for the loaded case: these tests spawn and
// exit, so a genuine hang still fails, just later. A budget tuned to the idle
// case instead buys a faster failure at the price of a gate that fails for
// reasons unrelated to the code under test.
const SPAWN_BUDGET_MS = 60_000;
// The outer timeout has to exceed the inner one, or bun kills the test before
// runCli can report which command stalled.
const SPAWN_TIMEOUT_MS = 75_000;

describe("CLI under Bun runtime", () => {
  test(
    "--help prints usage",
    async () => {
      const { exitCode, stdout } = await runCli(["--help"], { timeoutMs: SPAWN_BUDGET_MS });
      expect(exitCode).toBe(0);
      expect(stdout).toContain("openswarm");
      expect(stdout).toContain("swarm run flags");
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "doctor runs all checks",
    async () => {
      const { exitCode, stdout } = await runCli(["doctor"], { timeoutMs: SPAWN_BUDGET_MS });
      // 0 = every check passed, 1 = at least one check failed. Both mean doctor
      // ran and reported, which is what this test is about. Asserting 0 asserted
      // that the HOST is healthy: with no Anthropic credential the auth check
      // fails by design, so this passed on a developer laptop and failed on CI —
      // a property of the environment, not of the CLI.
      expect([0, 1]).toContain(exitCode);
      // Assert every check is present rather than any one of them: that is what
      // "runs all checks" claims, and an alternation regex passes on a single
      // match.
      for (const check of ["auth:", "config:", "install:", "workspace:"]) {
        expect(stdout).toContain(check);
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe.skipIf(!runLive)("CLI live agent under Bun", () => {
  test(
    "prompt --headless produces a real assistant response via JSONL",
    async () => {
      const { exitCode, stdout, stderr } = await runCli(
        ["prompt", "say hi in 3 words", "--headless", "--model", "haiku"],
        { timeoutMs: 90_000 },
      );

      if (exitCode !== 0) {
        console.error("CLI stderr:", stderr);
        console.error("CLI stdout (first 500 chars):", stdout.slice(0, 500));
      }
      expect(exitCode).toBe(0);

      // Headless output is JSONL. Each line should parse; look for text_delta
      // or message_stop events indicating the engine completed a turn.
      const lines = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      expect(lines.length).toBeGreaterThan(0);

      let sawText = false;
      let sawMessageStop = false;
      for (const line of lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // non-JSON lines are fine (e.g. some diagnostics)
        }
        const obj = parsed as { type?: string; text?: string };
        if (obj.type === "text_delta" && (obj.text ?? "").length > 0) {
          sawText = true;
        }
        if (obj.type === "message_stop") {
          sawMessageStop = true;
        }
      }
      expect(sawText).toBe(true);
      expect(sawMessageStop).toBe(true);
    },
    120_000,
  );
});
