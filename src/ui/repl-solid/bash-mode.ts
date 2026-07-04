/**
 * bash-mode.ts — run a `!cmd` shell escape from the prompt (doc 49 Phase E1).
 *
 * When the user submits a line starting with `!`, app.tsx runs the remainder as
 * a local shell command and injects the output into the transcript as system
 * entries — it is NOT sent to the model (matching Claude Code's `!` bash mode).
 *
 * The command is user-typed and runs in the user's own session, so this is a
 * deliberate shell escape, not an agent action; it doesn't route through the
 * tool permission gate.
 */

import { spawn } from "node:child_process";

export interface BangResult {
  readonly output: string;
  readonly code: number;
}

const MAX_OUTPUT = 64 * 1024;
const TIMEOUT_MS = 60_000;

/**
 * Run a shell command, capturing combined stdout+stderr (capped). Resolves with
 * the exit code (or a synthetic non-zero code on spawn error / timeout). Never
 * rejects — callers render whatever came back.
 */
export function runBangCommand(command: string): Promise<BangResult> {
  return new Promise<BangResult>((resolve) => {
    let out = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      const trimmed =
        out.length > MAX_OUTPUT
          ? `${out.slice(0, MAX_OUTPUT)}\n… (output truncated)`
          : out;
      resolve({ output: trimmed.replace(/\s+$/, ""), code });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, {
        shell: true,
        cwd: process.cwd(),
        env: process.env,
      });
    } catch (err) {
      finish(-1);
      out += String(err);
      return;
    }

    const timer = setTimeout(() => {
      out += `\n[timed out after ${TIMEOUT_MS / 1000}s]`;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    timer.unref?.();

    child.stdout?.on("data", (d: Buffer) => {
      if (out.length < MAX_OUTPUT) out += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (out.length < MAX_OUTPUT) out += d.toString();
    });
    child.on("error", (err) => {
      out += String(err);
      clearTimeout(timer);
      finish(-1);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code ?? 0);
    });
  });
}
