/**
 * Integration test for Layer 0b — driving the real recorder in a sessionlog
 * -enabled git repo and asserting a checkpoint is created.
 *
 * Guarded: skips when the installed sessionlog package does not provide a
 * openswarm agent adapter yet.
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
    const hasSwarmHarnessAgent =
      mod &&
      typeof mod.enable === "function" &&
      typeof (mod as { getAgent?: (name: string) => unknown }).getAgent === "function" &&
      (mod as { getAgent: (name: string) => unknown }).getAgent("openswarm");
    if (hasSwarmHarnessAgent) sl = mod;
  } catch {
    sl = undefined;
  }
});

afterEach(() => {
  delete process.env.OPENSWARM_SESSION_DIR;
  delete process.env.OPENSWARM_RECORD_SESSIONS;
});

const ev = (type: string, payload: unknown): LaneEvent =>
  ({ ts: 1, agentId: "a1", type, payload }) as unknown as LaneEvent;

describe("session checkpointer (integration)", () => {
  it("creates a sessionlog checkpoint from a recorded session", async () => {
    if (!sl) {
      console.warn("[skip] sessionlog openswarm adapter unavailable — integration skipped");
      return;
    }
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-int-"));
    const sh = (cmd: string): string => execSync(cmd, { cwd: repo, encoding: "utf8" });
    try {
      sh("git init -q -b main");
      sh("git config user.email t@t.co && git config user.name t");
      sh("git commit -q --allow-empty -m init");

      process.env.OPENSWARM_SESSION_DIR = path.join(
        repo,
        ".swarm",
        "openswarm",
        "sessions",
      );
      process.env.OPENSWARM_RECORD_SESSIONS = "1";
      await sl.enable({ cwd: repo, agent: "openswarm", skipAgentHooks: true });

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

  it("declares invoked skills to sessionlog as skillsUsed", async () => {
    if (!sl) {
      console.warn("[skip] sessionlog openswarm adapter unavailable — integration skipped");
      return;
    }
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-int-"));
    const sh = (cmd: string): string => execSync(cmd, { cwd: repo, encoding: "utf8" });
    try {
      sh("git init -q -b main");
      sh("git config user.email t@t.co && git config user.name t");
      sh("git commit -q --allow-empty -m init");

      process.env.OPENSWARM_SESSION_DIR = path.join(
        repo,
        ".swarm",
        "openswarm",
        "sessions",
      );
      process.env.OPENSWARM_RECORD_SESSIONS = "1";
      await sl.enable({ cwd: repo, agent: "openswarm", skipAgentHooks: true });

      const rec = await startSessionRecorder({
        sessionId: "sess2",
        agentId: "a1",
        prompt: "use the tdd skill",
        cwd: repo,
        surfacedSkills: [{ id: "tdd", name: "tdd", sourceType: "skill-tree" }],
      });
      expect(rec).not.toBeNull();
      // The agent invokes the `skill` tool (streamed input), successfully.
      rec!.record(ev("tool_use_start", { id: "t1", name: "skill" }));
      rec!.record(ev("tool_use_input", { id: "t1", jsonDelta: '{"id":"tdd"}' }));
      rec!.record(ev("tool_use_end", { id: "t1" }));
      rec!.record(ev("tool_result", { toolUseId: "t1", content: "skill body", isError: false }));
      // A second invocation that failed — must NOT be declared.
      rec!.record(ev("tool_use_start", { id: "t2", name: "skill" }));
      rec!.record(ev("tool_use_end", { id: "t2", input: { id: "nope" } }));
      rec!.record(ev("tool_result", { toolUseId: "t2", content: "not found", isError: true }));
      await rec!.close();

      // sessionlog session state carries both attribution legs.
      const stateFile = path.join(repo, ".git", "sessionlog-sessions", "sess2.json");
      expect(fs.existsSync(stateFile), "session state file should exist").toBe(true);
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
        skillsUsed?: { name: string; usedAt?: string }[];
        skillsSurfaced?: { name: string }[];
      };
      expect(state.skillsUsed?.map((s) => s.name)).toEqual(["tdd"]);
      expect(state.skillsUsed![0]!.usedAt).toBeDefined();
      expect(state.skillsSurfaced?.map((s) => s.name)).toEqual(["tdd"]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }, 30000);
});
