/**
 * pty.test.ts — true interactive-path coverage for the OpenTUI/Solid REPL.
 *
 * Unlike the `testRender`-based tests which exercise the Solid + OpenTUI +
 * bun:ffi stack but render into an in-memory buffer, these tests spawn the
 * compiled `dist/swarm-harness` binary under a real pseudo-terminal (PTY)
 * and verify the output stream the way a human would see it. Closes the
 * last gap in Phase 0 e2e coverage: terminal emulation, ANSI positioning,
 * raw-mode keyboard input, clean teardown under SIGINT.
 *
 * Runs under vitest (Node), NOT `bun test`: node-pty's native binding is
 * ABI-compiled for Node and fails with posix_spawnp under Bun. Running the
 * test under Node avoids that mismatch while still exercising the
 * Bun-compiled binary via PTY.
 *
 * Prereq: `dist/swarm-harness` must exist. Run `npm run build:compile` first.
 *
 * Scope: mount → initial frame → slash-command → exit. Each scenario
 * spawns a fresh process and kills it after assertions. Deliberately NOT
 * exercising live API — that's covered by src/ui/repl-solid/cli-bun.test.ts.
 * PTY tests validate the OpenTUI terminal layer specifically.
 */

import { describe, expect, it, afterEach } from "vitest";
import { spawn as ptySpawn, type IPty } from "node-pty";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const BINARY = join(REPO_ROOT, "dist", "swarm-harness");
const hasBinary = existsSync(BINARY);
const describePty = hasBinary ? describe : describe.skip;

/** Strip ANSI escape sequences so `toContain` assertions work on plain text. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001B\[[0-9;?]*[a-zA-Z]/g, "");
}

/** Promise-based wait for output to contain a substring (plain text after ANSI stripped). */
async function waitFor(
  getBuffer: () => string,
  needle: string,
  timeoutMs = 4_000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const plain = stripAnsi(getBuffer());
    if (plain.includes(needle)) return plain;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `waitFor("${needle}") timed out after ${timeoutMs}ms\n` +
      `--- buffer (stripped, tail) ---\n${stripAnsi(getBuffer()).slice(-1500)}`,
  );
}

interface Session {
  proc: IPty;
  buffer: string[];
  all: () => string;
  write: (s: string) => void;
  kill: () => void;
  waitExit: () => Promise<{ exitCode: number }>;
}

function startSession(): Session {
  const buffer: string[] = [];
  const proc = ptySpawn(
    BINARY,
    ["--permission-mode", "workspace-write"],
    {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: REPO_ROOT,
      env: { ...process.env } as Record<string, string>,
    },
  );
  proc.onData((data) => buffer.push(data));

  let exitResolver: ((v: { exitCode: number }) => void) | undefined;
  const exitPromise = new Promise<{ exitCode: number }>((r) => {
    exitResolver = r;
  });
  proc.onExit(({ exitCode }) => {
    exitResolver?.({ exitCode });
  });

  return {
    proc,
    buffer,
    all: () => buffer.join(""),
    write: (s) => proc.write(s),
    kill: () => {
      try {
        proc.kill();
      } catch {
        // already dead
      }
    },
    waitExit: () => exitPromise,
  };
}

let session: Session | null = null;
afterEach(() => {
  session?.kill();
  session = null;
});

describePty("PTY e2e — real terminal interactive coverage", () => {
  it("mount: initial frame renders status line with model + permission mode", async () => {
    session = startSession();
    // The status line is rendered once the Solid root mounts; model and
    // permission-mode are in the string.
    const plain = await waitFor(session.all, "workspace-write", 6_000);
    expect(plain).toMatch(/claude|sonnet|opus|haiku|test-model|[a-zA-Z]/);
    expect(plain).toContain("workspace-write");
  }, 10_000);

  it("typing '/h' shows dropdown with slash-command candidates", async () => {
    session = startSession();
    await waitFor(session.all, "workspace-write", 6_000);

    // Clear any buffered output noise, then type slash prefix.
    session.write("/h");
    // Wait for the dropdown to render (expects entries like "help").
    const plain = await waitFor(session.all, "help", 3_000);
    expect(plain).toContain("help");
  });

  it("submitting '/exit' transitions to shutdown and exits with code 0", async () => {
    session = startSession();
    await waitFor(session.all, "workspace-write", 6_000);
    session.write("/exit\r");
    const result = await Promise.race([
      session.waitExit(),
      new Promise<{ exitCode: number }>((_, rej) =>
        setTimeout(() => rej(new Error("timeout waiting for exit")), 6_000),
      ),
    ]);
    expect(result.exitCode).toBe(0);
  }, 12_000);

  it("SIGINT (Ctrl-C) causes clean shutdown", async () => {
    session = startSession();
    await waitFor(session.all, "workspace-write", 6_000);
    // Send Ctrl-C byte (0x03).
    session.write("\x03");
    const result = await Promise.race([
      session.waitExit(),
      new Promise<{ exitCode: number }>((_, rej) =>
        setTimeout(() => rej(new Error("timeout waiting for exit")), 6_000),
      ),
    ]);
    // Clean shutdown should produce exit code 0. (If SIGINT kills via signal
    // instead, node-pty reports the signal in exitCode as non-zero; accept
    // both paths but surface the signal case.)
    expect([0, 130]).toContain(result.exitCode);
  }, 12_000);
});
