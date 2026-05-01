/**
 * Tests for worker-state-file.ts — atomic worker state persistence.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { AgentId } from "../core/types.js";
import {
  writeWorkerState,
  readWorkerState,
  listWorkerStates,
  removeWorkerState,
  isWorkerProcessAlive,
  workerStateFilePath,
  type WorkerStateFile,
} from "./worker-state-file.js";

function tmpDir(): string {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), `swarm-wsf-test-${crypto.randomUUID()}-`),
  );
}

function sampleState(overrides: Partial<WorkerStateFile> = {}): WorkerStateFile {
  return {
    agentId: crypto.randomUUID() as AgentId,
    pid: process.pid,
    startedAt: Date.now(),
    lifecycleState: "spawning",
    lastTransitionAt: Date.now(),
    ...overrides,
  };
}

// Clean up any tmp dirs created in SWARM_HARNESS_WORKERS_DIR override tests.
const dirsToCleanup: string[] = [];
afterEach(() => {
  delete process.env["SWARM_HARNESS_WORKERS_DIR"];
  for (const d of dirsToCleanup.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe("worker-state-file", () => {
  it("writes + reads round-trip", () => {
    const dir = tmpDir();
    dirsToCleanup.push(dir);
    const state = sampleState({ lifecycleState: "running", taskId: "task-abc" });

    writeWorkerState(state, dir);
    const read = readWorkerState(state.agentId, dir);

    expect(read).not.toBeNull();
    expect(read!.agentId).toBe(state.agentId);
    expect(read!.pid).toBe(state.pid);
    expect(read!.lifecycleState).toBe("running");
    expect(read!.taskId).toBe("task-abc");
    expect(read!.startedAt).toBe(state.startedAt);
    expect(read!.lastTransitionAt).toBe(state.lastTransitionAt);
  });

  it("writeWorkerState is atomic (uses temp + rename)", () => {
    const dir = tmpDir();
    dirsToCleanup.push(dir);
    const state = sampleState();

    writeWorkerState(state, dir);

    // Final file must exist.
    const finalPath = workerStateFilePath(state.agentId, dir);
    expect(fs.existsSync(finalPath)).toBe(true);

    // Temp file must NOT exist after the rename.
    const tmpPath = `${finalPath}.tmp`;
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it("missing file returns null", () => {
    const dir = tmpDir();
    dirsToCleanup.push(dir);
    const nonExistent = crypto.randomUUID() as AgentId;

    const result = readWorkerState(nonExistent, dir);
    expect(result).toBeNull();
  });

  it("malformed JSON returns null", () => {
    const dir = tmpDir();
    dirsToCleanup.push(dir);
    const agentId = crypto.randomUUID() as AgentId;
    const filePath = workerStateFilePath(agentId, dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, "{ not valid json }", "utf8");

    const result = readWorkerState(agentId, dir);
    expect(result).toBeNull();
  });

  it("listWorkerStates skips malformed entries", () => {
    const dir = tmpDir();
    dirsToCleanup.push(dir);
    fs.mkdirSync(dir, { recursive: true });

    // Write one valid state.
    const valid = sampleState({ lifecycleState: "finished" });
    writeWorkerState(valid, dir);

    // Write one malformed file directly.
    fs.writeFileSync(path.join(dir, "bad-agent.json"), "{{invalid", "utf8");

    const states = listWorkerStates(dir);
    expect(states).toHaveLength(1);
    expect(states[0]!.agentId).toBe(valid.agentId);
  });

  it("removeWorkerState is no-op on missing file", () => {
    const dir = tmpDir();
    dirsToCleanup.push(dir);
    const nonExistent = crypto.randomUUID() as AgentId;

    // Should not throw.
    expect(() => removeWorkerState(nonExistent, dir)).not.toThrow();
  });

  it("removeWorkerState removes an existing file", () => {
    const dir = tmpDir();
    dirsToCleanup.push(dir);
    const state = sampleState();
    writeWorkerState(state, dir);

    const filePath = workerStateFilePath(state.agentId, dir);
    expect(fs.existsSync(filePath)).toBe(true);

    removeWorkerState(state.agentId, dir);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("isWorkerProcessAlive returns true for own pid", () => {
    expect(isWorkerProcessAlive(process.pid)).toBe(true);
  });

  it("isWorkerProcessAlive returns false for unrealistic pid (999999)", () => {
    // pid 999999 is almost certainly not alive; skip if somehow it is.
    expect(isWorkerProcessAlive(999999)).toBe(false);
  });

  it("respects SWARM_HARNESS_WORKERS_DIR override", () => {
    const dir = tmpDir();
    dirsToCleanup.push(dir);
    process.env["SWARM_HARNESS_WORKERS_DIR"] = dir;

    const state = sampleState({ lifecycleState: "failed", failureClass: "panic" });
    writeWorkerState(state); // no explicit baseDir — uses env override

    const read = readWorkerState(state.agentId); // no explicit baseDir
    expect(read).not.toBeNull();
    expect(read!.lifecycleState).toBe("failed");
    expect(read!.failureClass).toBe("panic");
  });
});
