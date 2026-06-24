/**
 * Integration test for Layer 0b — driving the real recorder in a sessionlog
 * -enabled git repo and asserting a checkpoint is created.
 *
 * Guarded: skips when `sessionlog` is not resolvable (e.g. CI without the dev
 * symlink, since it is an optional dependency).
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { startSessionRecorder } from "./session-recorder.js";
import type { LaneEvent } from "./events.js";

let sl: { enable: (o: unknown) => Promise<unknown> } | undefined;

beforeAll(async () => {
  try {
    const mod = (await import("sessionlog")) as unknown as typeof sl;
    if (mod && typeof mod.enable === "function") sl = mod;
  } catch {
    sl = undefined;
  }
});

afterEach(() => {
  delete process.env.SWARM_HARNESS_SESSION_DIR;
  delete process.env.SWARM_HARNESS_RECORD_SESSIONS;
});

const ev = (type: string, payload: unknown): LaneEvent =>
  ({ ts: 1, agentId: "a1", type, payload }) as unknown as LaneEvent;

describe("session checkpointer (integration)", () => {
  it("creates a sessionlog checkpoint from a recorded session", async () => {
    if (!sl) {
      console.warn("[skip] sessionlog not resolvable — integration skipped");
      return;
    }
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-int-"));
    const sh = (cmd: string): string => execSync(cmd, { cwd: repo, encoding: "utf8" });
    try {
      sh("git init -q -b main");
      sh("git config user.email t@t.co && git config user.name t");
      sh("git commit -q --allow-empty -m init");

      process.env.SWARM_HARNESS_SESSION_DIR = path.join(
        repo,
        ".swarm",
        "swarm-harness",
        "sessions",
      );
      process.env.SWARM_HARNESS_RECORD_SESSIONS = "1";
      await sl.enable({ cwd: repo, agent: "swarm-harness", skipAgentHooks: true });

      // Drive the real recorder: begin -> record a Write -> close (finish).
      const rec = await startSessionRecorder({
        sessionId: "sess1",
        agentId: "a1",
        prompt: "create x.ts",
        cwd: repo,
      });
      expect(rec).not.toBeNull();
      rec!.record(ev("tool_use_start", { id: "t1", name: "Write" }));
      rec!.record(
        ev("tool_use_input", {
          id: "t1",
          jsonDelta: '{"file_path":"x.ts","content":"hi"}',
        }),
      );
      rec!.record(ev("tool_use_end", { id: "t1" }));
      fs.writeFileSync(path.join(repo, "x.ts"), "hi");
      await rec!.close();

      // A sessionlog checkpoint ref (a `sessionlog/<hash>` branch) should exist.
      const refs = sh("git for-each-ref --format='%(refname)'").split("\n");
      const checkpoint = refs.find(
        (r) => /\bsessionlog\//.test(r) && !/checkpoints/.test(r),
      );
      expect(checkpoint, "a sessionlog checkpoint ref should exist").toBeTruthy();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }, 30000);
});
