/**
 * FX-WORKER-001..005 — a swarm worker authorizes a call the way the CLI does
 * (docs/67 `WP-00a` surface remainder).
 *
 * Swarm orchestration is this project's primary product surface, and it does not
 * share the CLI's gate. `buildWorkerCanUseTool` checks containment, then grades
 * the *tool* by its declared permission; `makeCanUseTool` checks containment,
 * then authorizes each *resource* the call named, and runs the bash-validation
 * pipeline for anything that cannot name what it touches.
 *
 * These are differential rather than absolute on purpose. The question is not
 * whether the worker gate is defensible read on its own — it looks reasonable —
 * but whether two gates in one product agree, because when they do not, the
 * weaker one is the product's real security posture and the stronger one is what
 * gets read during review.
 *
 * The corpus is deliberately small and consists of cases where the two answers
 * differ. Agreement is cheap to assert broadly and proves little; each case here
 * is a specific thing a worker can do that the same call from the CLI cannot.
 *
 * Both gates are given an operator who *approves*, which took one wrong attempt
 * to get right. `exec` is denied in every mode but danger-full-access, so a
 * refusing operator makes both gates deny everything and the comparison measures
 * nothing. With an approving one the difference is visible and is the whole
 * point: the CLI refuses a path-submodule violation before anyone is asked,
 * because a Block is not a question, while the worker has nothing that
 * classifies the command and so asks about it as if it were ordinary.
 */

import { describe, it, expect, vi } from "vitest";

import { makeCanUseTool } from "../permissions/gate.js";
import { buildWorkerCanUseTool } from "./worker-entry.js";
import { PermissionBridge } from "../permissions/bridge.js";
import { PermissionEngine } from "../permissions/index.js";
import { ToolAccesses } from "../tools/access.js";
import type { ToolDispatcher } from "../tools/dispatcher.js";
import type { ToolImpl } from "../tools/types.js";
import type { PermissionMode } from "../core/types.js";
import type { PermissionDecision } from "../engine/index.js";
import type { LaneEvent } from "../swarm/events.js";

/** bash: declares `all()`, because it cannot say what a command will touch. */
const BASH: ToolImpl = {
  spec: {
    name: "bash",
    description: "bash",
    inputSchema: { type: "object" },
    requiredPermission: "exec",
    tier: 0,
  },
  execute: vi.fn(),
  accesses: () => ToolAccesses.all(),
};

const dispatcher = {
  get: (name: string) => (name === "bash" ? BASH : undefined),
  list: () => ["bash"],
} as unknown as ToolDispatcher;

/** The CLI's gate, with a bridge that would refuse anything it is asked. */
function cliGate(mode: PermissionMode, emitLaneEvent?: (e: unknown) => void) {
  const bridge = new PermissionBridge();
  // An operator who says yes to whatever reaches them. What matters is which
  // calls reach them at all: a Block never does, in either gate, if the two
  // agree.
  vi.spyOn(bridge, "request").mockResolvedValue({ allow: true } as PermissionDecision);
  return makeCanUseTool({
    dispatcher,
    permEngine: new PermissionEngine(mode),
    bridge,
    useHeadless: false,
    getCurrentMode: () => mode,
    cwd: "/workspace",
    ...(emitLaneEvent !== undefined ? { emitLaneEvent } : {}),
  });
}

/** The worker's gate, with an orchestrator that approves what it is asked. */
function workerGate(mode: PermissionMode) {
  return buildWorkerCanUseTool({
    dispatcher,
    permissionEngine: new PermissionEngine(mode),
    permissionMode: mode,
    cwd: "/workspace",
    escalate: async () => ({ outcome: "allow" as const }),
  });
}

const run = async (
  gate: (n: string, i: unknown) => Promise<PermissionDecision>,
  command: string,
) => gate("bash", { command });

/** A tool that names the file it writes, so the gate can authorize per resource. */
const WRITE: ToolImpl = {
  spec: {
    name: "write_file",
    description: "write",
    inputSchema: { type: "object" },
    requiredPermission: "write",
    tier: 0,
  },
  execute: vi.fn(),
  accesses: (i) => ToolAccesses.writeFile((i as { file_path: string }).file_path),
};

describe("worker and CLI gates agree", () => {
  it("FX-WORKER-001 refuses a command the path submodule blocks", async () => {
    // Blocked by bash validation in every mode, not by the mode check, so the
    // worker's tool-level grading never sees it.
    const cli = await run(cliGate("workspace-write"), "cat /etc/passwd");
    const worker = await run(workerGate("workspace-write"), "cat /etc/passwd");

    expect(cli.allow).toBe(false);
    expect(worker.allow).toBe(cli.allow);
  });

  it("FX-WORKER-002 refuses it in danger-full-access too, where nobody is asked", async () => {
    // The sharpest case, because it needs no operator at all. The mode allows
    // exec outright, so the worker's grading is satisfied and the command runs
    // unexamined; the CLI still puts it through validation first.
    const cli = await run(cliGate("danger-full-access"), "cat /etc/passwd");
    const worker = await run(workerGate("danger-full-access"), "cat /etc/passwd");

    expect(cli.allow).toBe(false);
    expect(worker.allow).toBe(cli.allow);
  });

  it("FX-WORKER-003 agrees about a command neither has reason to refuse", async () => {
    // The control. If this diverges, the two gates disagree about the ordinary
    // case and the comparisons above are measuring something else.
    const cli = await run(cliGate("workspace-write"), "ls -la");
    const worker = await run(workerGate("workspace-write"), "ls -la");

    expect(cli.allow).toBe(true);
    expect(worker.allow).toBe(cli.allow);
  });

  it("FX-WORKER-004 agrees under read-only", async () => {
    const cli = await run(cliGate("read-only"), "cat /etc/passwd");
    const worker = await run(workerGate("read-only"), "cat /etc/passwd");

    expect(cli.allow).toBe(false);
    expect(worker.allow).toBe(cli.allow);
  });

  it("FX-WORKER-005 emits the validation events the orchestrator is built to read", async () => {
    // `bash_validation_blocked` is a LaneEvent type, and bash-gate.ts is its only
    // emitter. A worker that never runs that gate leaves the orchestrator blind
    // to exactly the events the swarm event schema was extended to carry.
    const events: LaneEvent[] = [];
    await run(
      cliGate("workspace-write", (e) => events.push(e as LaneEvent)),
      "cat /etc/passwd",
    );
    expect(events.map((e) => e.type)).toContain("bash_validation_blocked");

    const workerEvents: LaneEvent[] = [];
    const gate = buildWorkerCanUseTool({
      dispatcher,
      permissionEngine: new PermissionEngine("workspace-write"),
      permissionMode: "workspace-write",
      cwd: "/workspace",
      emitLaneEvent: (e: unknown) => workerEvents.push(e as LaneEvent),
    });
    await run(gate, "cat /etc/passwd");
    expect(workerEvents.map((e) => e.type)).toContain("bash_validation_blocked");
  });

  it("FX-WORKER-006 records the attempt it authorized, which it could not before", async () => {
    // The requests existed on this path all along -- `makePathContainment` derived
    // them and returned only whether one escaped -- so there was nothing to build
    // a record from. This asserts they survive far enough to be recorded.
    const prepared: Array<{ request: { operationId: string } }> = [];
    const gate = buildWorkerCanUseTool({
      dispatcher: {
        get: (name: string) => (name === "write_file" ? WRITE : undefined),
        list: () => ["write_file"],
      } as unknown as ToolDispatcher,
      permissionEngine: new PermissionEngine("workspace-write"),
      permissionMode: "workspace-write",
      cwd: process.cwd(),
      attempts: {
        prepare: async (p) => void prepared.push(p as { request: { operationId: string } }),
      },
    });

    const decision = await gate("write_file", { file_path: "note.txt" });

    expect(decision.allow).toBe(true);
    expect(prepared).toHaveLength(1);
    // Reported back so the ledger can resolve it. Without the ids the record
    // would be a prepare nothing could ever close, which reads as a crash.
    expect(
      (decision as { preparedOperationIds?: readonly string[] }).preparedOperationIds,
    ).toEqual([prepared[0]!.request.operationId]);
  });
});
