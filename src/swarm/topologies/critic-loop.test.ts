/**
 * critic-loop.test.ts — direct invocation of CriticLoopTopology (v0.5 stage 5A).
 *
 * Verifies executor-then-critic alternation, signal-based termination,
 * feedback-context plumbing across iterations, and the failure semantics
 * from docs/25 §9.5 (executor failure halts; critic failure takes
 * executor's last output).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CriticLoopTopology, hasApprovalSignal } from "./critic-loop.js";
import { WorkerPool } from "../worker-pool.js";
import { DeadLetterWriter } from "../dead-letter.js";
import type { TeamSpec, MemberSpec } from "../team-spec.js";
import type { TopologyContext } from "../topologies-types.js";
import type { StandaloneHost } from "../standalone-host.js";
import type { AgentHandle, AgentResult, SpawnRequest } from "../host.js";
import type { AgentId, SessionId } from "../../core/types.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface SpawnLog {
  readonly prompt: string;
  readonly role: string | undefined;
}

function makeHandle(
  result: AgentResult,
  agentId: AgentId,
  sessionId: SessionId,
): AgentHandle {
  return {
    agentId,
    sessionId,
    wait: () => Promise.resolve(result),
    kill: () => Promise.resolve(),
    events: async function* () {
      return;
    },
    runMore: () => Promise.reject(new Error("no runMore in test fake")),
    drain: () => Promise.resolve(),
  };
}

interface Harness {
  readonly host: StandaloneHost;
  readonly spawns: SpawnLog[];
}

function fakeHost(results: readonly AgentResult[]): Harness {
  let i = 0;
  const spawns: SpawnLog[] = [];
  const events = new EventEmitter();
  events.setMaxListeners(50);

  const spawn = async (req: SpawnRequest): Promise<AgentHandle> => {
    spawns.push({ prompt: req.task.prompt, role: req.role });
    const result = results[i] ?? {
      status: "failure",
      error: "no result configured",
      wallClockMs: 0,
    };
    const handle = makeHandle(
      result,
      `agent-${i + 1}` as AgentId,
      `session-${i + 1}` as SessionId,
    );
    i++;
    return handle;
  };

  const host = {
    mode: "standalone",
    agentId: "topology-host" as AgentId,
    depth: 0,
    spawn,
    emit: vi.fn(),
    send: vi.fn(),
    inbox: async function* () {
      return;
    },
    task: {} as StandaloneHost["task"],
    events,
  } as unknown as StandaloneHost;

  return { host, spawns };
}

/** Resident fake (docs/52 Phase B ①a): each member (keyed by role) has its own result queue;
 *  spawn/wait serve the first, runMore serves the next. Records longLived spawns + runMore calls. */
function residentFakeHost(queues: { executor: AgentResult[]; critic: AgentResult[] }): {
  host: StandaloneHost;
  spawns: Array<{ role: string | undefined; longLived: boolean }>;
  runMore: { executor: number; critic: number };
} {
  const spawns: Array<{ role: string | undefined; longLived: boolean }> = [];
  const runMore = { executor: 0, critic: 0 };
  const events = new EventEmitter();
  const kindOf = (role: string | undefined): "executor" | "critic" => (role === "reviewer" ? "critic" : "executor");
  const drained: AgentResult = { status: "failure", error: "drained", wallClockMs: 0 };
  const spawn = async (req: SpawnRequest): Promise<AgentHandle> => {
    const kind = kindOf(req.role);
    spawns.push({ role: req.role, longLived: (req as { longLived?: boolean }).longLived === true });
    const first = queues[kind].shift() ?? drained;
    return {
      agentId: `${kind}-agent` as AgentId,
      sessionId: `${kind}-session` as SessionId,
      wait: () => Promise.resolve(first),
      kill: () => Promise.resolve(),
      events: async function* () {
        return;
      },
      runMore: () => {
        runMore[kind]++;
        return Promise.resolve(queues[kind].shift() ?? drained);
      },
      drain: () => Promise.resolve(),
    };
  };
  const host = {
    mode: "standalone",
    agentId: "host" as AgentId,
    depth: 0,
    spawn,
    emit: vi.fn(),
    send: vi.fn(),
    inbox: async function* () {
      return;
    },
    task: {} as StandaloneHost["task"],
    events,
  } as unknown as StandaloneHost;
  return { host, spawns, runMore };
}

function member(id: string, prompt: string, role = "worker"): MemberSpec {
  return {
    id,
    role,
    prompt,
    branchPolicy: { kind: "none" },
    commitPolicy: { kind: "none" },
    escalationPolicy: { kind: "none" },
  };
}

function criticLoopSpec(
  members: readonly MemberSpec[],
  signal = "APPROVED",
): TeamSpec {
  return {
    name: "critic-loop-test",
    topology: "critic-loop",
    members,
    coordination: {
      completion: { kind: "until_signal", signal },
    },
  };
}

async function makeCtx(
  results: readonly AgentResult[],
  exec?: (cmd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
): Promise<{
  ctx: TopologyContext;
  harness: Harness;
  cleanup: () => Promise<void>;
}> {
  const harness = fakeHost(results);
  const pool = new WorkerPool(8);
  const tmp = await mkdtemp(join(tmpdir(), "critic-loop-"));
  const deadLetter = new DeadLetterWriter(join(tmp, "dl.jsonl"));
  const resultsOut = new PassThrough();
  resultsOut.resume();
  const ctx: TopologyContext = {
    host: harness.host,
    pool,
    resultsOut,
    deadLetter,
    permissionMode: "workspace-write",
    ...(exec !== undefined && { escalation: { exec } }),
  };
  return {
    ctx,
    harness,
    cleanup: async () => {
      await deadLetter.close();
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CriticLoopTopology", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  function s(output: string): AgentResult {
    return {
      status: "success",
      output,
      usage: { inputTokens: 1, outputTokens: 1 },
      wallClockMs: 1,
    };
  }
  function f(error = "boom"): AgentResult {
    return { status: "failure", error, wallClockMs: 1 };
  }

  it("rejects spec with !== 2 members", async () => {
    const { ctx, cleanup } = await makeCtx([]);
    cleanups.push(cleanup);
    await expect(
      new CriticLoopTopology().run(
        criticLoopSpec([member("only", "p")]),
        ctx,
      ),
    ).rejects.toThrow(/exactly 2/);
  });

  it("terminates after one round when critic emits APPROVED", async () => {
    const { ctx, harness, cleanup } = await makeCtx([
      s("draft v1"), // executor turn 1
      s("APPROVED"), // critic turn 1
    ]);
    cleanups.push(cleanup);
    const spec = criticLoopSpec([
      member("exec", "implement feature"),
      member("crit", "review"),
    ]);
    const result = await new CriticLoopTopology().run(spec, ctx);
    expect(harness.spawns).toHaveLength(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.aggregateOutput).toBe("draft v1");
  });

  it("loops with feedback context until critic approves", async () => {
    const { ctx, harness, cleanup } = await makeCtx([
      s("draft v1"), // executor turn 1
      s("needs handling for the empty-input case"), // critic turn 1 (no signal)
      s("draft v2"), // executor turn 2
      s("looks good — APPROVED"), // critic turn 2 (signal)
    ]);
    cleanups.push(cleanup);
    const spec = criticLoopSpec([
      member("exec", "implement feature"),
      member("crit", "review"),
    ]);
    const result = await new CriticLoopTopology().run(spec, ctx);
    expect(harness.spawns).toHaveLength(4);
    expect(result.succeeded).toBe(1);
    expect(result.aggregateOutput).toBe("draft v2");
    // The 2nd executor invocation should carry the critic's feedback in
    // its prompt as injected context.
    expect(harness.spawns[2]!.prompt).toContain(
      "needs handling for the empty-input case",
    );
  });

  it("criticMaxIterations caps the loop when the critic never approves", async () => {
    // Without the cap this would run the default 10 rounds (20 spawns). With
    // criticMaxIterations=2 it stops at 2 rounds = 4 spawns, unapproved → failed.
    // This is the `advisor` arm's cost bound (docs/50 §10.4).
    const { ctx, harness, cleanup } = await makeCtx([
      s("draft v1"), // exec 1
      s("still not quite right"), // critic 1 (no signal)
      s("draft v2"), // exec 2
      s("closer, but no"), // critic 2 (no signal)
    ]);
    cleanups.push(cleanup);
    const spec: TeamSpec = {
      name: "critic-loop-test",
      topology: "critic-loop",
      members: [member("exec", "implement feature"), member("crit", "review")],
      coordination: {
        completion: { kind: "until_signal", signal: "APPROVED" },
        criticMaxIterations: 2,
      },
    };
    const result = await new CriticLoopTopology().run(spec, ctx);
    expect(harness.spawns).toHaveLength(4); // 2 rounds, not the default 10
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.aggregateOutput).toBe("draft v2"); // last executor output retained
  });

  it('does not false-approve on a negated signal ("NOT APPROVED")', async () => {
    // Regression (docs/50 §10.4): plain .includes("APPROVED") would read the caps
    // rejection as approval and stop at round 1 with an unreviewed fix.
    const { ctx, harness, cleanup } = await makeCtx([
      s("draft v1"), // exec 1
      s("This is NOT APPROVED — fix the import."), // critic 1: caps negation
      s("draft v2"), // exec 2
      s("APPROVED"), // critic 2: real approval
    ]);
    cleanups.push(cleanup);
    const spec = criticLoopSpec([member("exec", "implement feature"), member("crit", "review")]);
    const result = await new CriticLoopTopology().run(spec, ctx);
    expect(harness.spawns).toHaveLength(4); // looped — did NOT stop at round 1
    expect(result.succeeded).toBe(1);
    expect(result.aggregateOutput).toBe("draft v2");
  });

  it("stop-on-green: approves and skips the critic when greenCommand passes", async () => {
    // docs/50 §10.4 step 1 — a passing visible check ends the loop before the critic can
    // regress a correct fix (the django-12708 failure). Only the executor should spawn.
    const { ctx, harness, cleanup } = await makeCtx(
      [s("draft v1 (correct)")],
      async () => ({ exitCode: 0, stdout: "1 passed", stderr: "" }),
    );
    cleanups.push(cleanup);
    const spec: TeamSpec = {
      name: "critic-loop-test",
      topology: "critic-loop",
      members: [member("exec", "implement feature"), member("crit", "review")],
      coordination: { completion: { kind: "until_signal", signal: "APPROVED" }, greenCommand: "pytest repro_test.py -q" },
    };
    const result = await new CriticLoopTopology().run(spec, ctx);
    expect(harness.spawns).toHaveLength(1); // executor only — the critic never ran
    expect(result.succeeded).toBe(1);
    expect(result.aggregateOutput).toBe("draft v1 (correct)");
  });

  it("stop-on-green: runs the critic while red, then stops once green", async () => {
    let greenChecks = 0;
    const { ctx, harness, cleanup } = await makeCtx(
      [s("draft v1"), s("fix the import"), s("draft v2")],
      async (cmd: string) => {
        // docs/52: the critic prompt also runs a `git diff` capture — distinguish it.
        if (cmd.includes("git")) return { exitCode: 0, stdout: "diff --git a/f b/f\n+fix", stderr: "" };
        greenChecks++;
        return greenChecks === 1
          ? { exitCode: 1, stdout: "1 failed", stderr: "" } // red after round 1 → critic runs
          : { exitCode: 0, stdout: "1 passed", stderr: "" }; // green after round 2 → stop
      },
    );
    cleanups.push(cleanup);
    const spec: TeamSpec = {
      name: "critic-loop-test",
      topology: "critic-loop",
      members: [member("exec", "implement feature"), member("crit", "review")],
      coordination: { completion: { kind: "until_signal", signal: "APPROVED" }, greenCommand: "pytest repro_test.py -q" },
    };
    const result = await new CriticLoopTopology().run(spec, ctx);
    expect(harness.spawns).toHaveLength(3); // exec, critic, exec — critic fired only while red
    expect(greenChecks).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.aggregateOutput).toBe("draft v2");
    // docs/52 Phase A — the critic reviews the ACTUAL diff + the failing check, not just prose.
    const criticPrompt = harness.spawns[1]!.prompt;
    expect(criticPrompt).toContain("The change under review");
    expect(criticPrompt).toContain("diff --git a/f b/f");
    expect(criticPrompt).toContain("Failing check output");
    expect(criticPrompt).toContain("1 failed");
  });

  it("resident dialogue: spawns each member once, drives later rounds via runMore", async () => {
    // docs/52 Phase B ①a — executor + critic stay resident; round 2 uses runMore, not re-spawn.
    const rh = residentFakeHost({
      executor: [s("draft v1"), s("draft v2")],
      critic: [s("needs the import fix"), s("APPROVED")],
    });
    const pool = new WorkerPool(8);
    const tmp = await mkdtemp(join(tmpdir(), "critic-loop-res-"));
    const deadLetter = new DeadLetterWriter(join(tmp, "dl.jsonl"));
    const resultsOut = new PassThrough();
    resultsOut.resume();
    cleanups.push(async () => {
      await deadLetter.close();
      await rm(tmp, { recursive: true, force: true });
    });
    const ctx: TopologyContext = {
      host: rh.host,
      pool,
      resultsOut,
      deadLetter,
      permissionMode: "workspace-write",
    };
    const spec: TeamSpec = {
      name: "critic-loop-test",
      topology: "critic-loop",
      members: [member("exec", "implement feature", "executor"), member("crit", "review", "reviewer")],
      coordination: { completion: { kind: "until_signal", signal: "APPROVED" }, residentDialogue: true },
    };
    const result = await new CriticLoopTopology().run(spec, ctx);
    expect(rh.spawns.filter((sp) => sp.longLived)).toHaveLength(2); // executor + critic spawned once each
    expect(rh.runMore.executor).toBe(1); // round-2 executor via runMore, not a re-spawn
    expect(rh.runMore.critic).toBe(1); // round-2 critic via runMore
    expect(result.succeeded).toBe(1);
    expect(result.aggregateOutput).toBe("draft v2");
  });

  it("executor failure halts the loop with failed=1", async () => {
    const { ctx, harness, cleanup } = await makeCtx([
      f("LLM call failed"), // executor turn 1 fails
    ]);
    cleanups.push(cleanup);
    const spec = criticLoopSpec([
      member("exec", "implement feature"),
      member("crit", "review"),
    ]);
    const result = await new CriticLoopTopology().run(spec, ctx);
    expect(harness.spawns).toHaveLength(1);
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
    // No executor output was produced — aggregate is undefined.
    expect(result.aggregateOutput).toBeUndefined();
  });

  it("critic failure takes executor's last output as the team result", async () => {
    const { ctx, harness, cleanup } = await makeCtx([
      s("draft v1"), // executor turn 1 OK
      f("critic crashed"), // critic turn 1 fails
    ]);
    cleanups.push(cleanup);
    const spec = criticLoopSpec([
      member("exec", "implement"),
      member("crit", "review"),
    ]);
    const result = await new CriticLoopTopology().run(spec, ctx);
    expect(harness.spawns).toHaveLength(2);
    expect(result.aggregateOutput).toBe("draft v1");
    // Not approved — failed=1.
    expect(result.failed).toBe(1);
  });

  it("custom signal string is honored", async () => {
    const { ctx, cleanup } = await makeCtx([
      s("draft"),
      s("LGTM ship it"), // contains "LGTM"
    ]);
    cleanups.push(cleanup);
    const spec = criticLoopSpec(
      [member("exec", "implement"), member("crit", "review")],
      "LGTM",
    );
    const result = await new CriticLoopTopology().run(spec, ctx);
    expect(result.succeeded).toBe(1);
    expect(result.aggregateOutput).toBe("draft");
  });

  it("pre-aborted spec returns cancelled count without spawning", async () => {
    const { ctx, harness, cleanup } = await makeCtx([]);
    cleanups.push(cleanup);
    const ac = new AbortController();
    ac.abort();
    const ctxAborted = { ...ctx, abort: ac.signal };
    const spec = criticLoopSpec([
      member("exec", "p"),
      member("crit", "p"),
    ]);
    const result = await new CriticLoopTopology().run(spec, ctxAborted);
    expect(result.cancelled).toBe(2);
    expect(harness.spawns).toHaveLength(0);
  });

  it("v0.7 stage 7J — defaults executor to {kind:'stream'}, critic stays unset", async () => {
    const captured: Array<{ role?: string; bp: unknown }> = [];
    let i = 0;
    // Two iterations: exec (success), critic (approves), then loop exits.
    const spawn = async (req: SpawnRequest): Promise<AgentHandle> => {
      captured.push({ role: req.role, bp: req.task.branchPolicy });
      i++;
      const result: AgentResult = req.role === "critic"
        ? { status: "success", output: "APPROVED", usage: { inputTokens: 1, outputTokens: 1 }, wallClockMs: 1 }
        : { status: "success", output: "draft", usage: { inputTokens: 1, outputTokens: 1 }, wallClockMs: 1 };
      return makeHandle(result, `agent-${i}` as AgentId, `session-${i}` as SessionId);
    };
    const host = {
      mode: "standalone",
      agentId: "topology-host" as AgentId,
      depth: 0,
      spawn,
      emit: vi.fn(),
      send: vi.fn(),
      inbox: async function* () { return; },
      task: {} as StandaloneHost["task"],
      supportsStreams: () => true,
    } as unknown as StandaloneHost;
    const pool = new WorkerPool(2);
    const tmp = await mkdtemp(join(tmpdir(), "critic-7j-"));
    const deadLetter = new DeadLetterWriter(join(tmp, "dl.jsonl"));
    const resultsOut = new PassThrough();
    resultsOut.resume();
    const ctx: TopologyContext = {
      host,
      pool,
      resultsOut,
      deadLetter,
      permissionMode: "workspace-write",
    };
    // Bare exec/critic — no branchPolicy — defaults apply.
    const spec: TeamSpec = {
      name: "cl-7j",
      topology: "critic-loop",
      members: [
        { id: "exec", role: "executor", prompt: "build" },
        { id: "crit", role: "critic", prompt: "review" },
      ],
      coordination: { completion: { kind: "until_signal", signal: "APPROVED" } },
    };
    await new CriticLoopTopology().run(spec, ctx);
    const exec = captured.find((c) => c.role === "executor");
    const crit = captured.find((c) => c.role === "critic");
    expect(exec?.bp).toEqual({ kind: "stream" });
    // Critic wasn't defaulted — TeamSession's fallback ({kind:"none"}) applies.
    expect(crit?.bp).toEqual({ kind: "none" });
    await deadLetter.close();
    await rm(tmp, { recursive: true, force: true });
  });
});

describe("hasApprovalSignal", () => {
  const S = "APPROVED";
  it("matches a standalone or trailing signal", () => {
    expect(hasApprovalSignal("APPROVED", S)).toBe(true);
    expect(hasApprovalSignal("looks good — APPROVED", S)).toBe(true);
    expect(hasApprovalSignal("APPROVED.", S)).toBe(true);
  });
  it("rejects negated signals (the real bug)", () => {
    expect(hasApprovalSignal("NOT APPROVED", S)).toBe(false);
    expect(hasApprovalSignal("This is not APPROVED yet", S)).toBe(false);
    expect(hasApprovalSignal("cannot be APPROVED", S)).toBe(false);
  });
  it("is case-sensitive to the literal signal (ignores lowercase prose)", () => {
    expect(hasApprovalSignal("I approved the earlier change", S)).toBe(false);
    expect(hasApprovalSignal("Not approved", S)).toBe(false);
  });
});
