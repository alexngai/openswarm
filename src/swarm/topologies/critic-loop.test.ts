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

import { CriticLoopTopology } from "./critic-loop.js";
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

async function makeCtx(results: readonly AgentResult[]): Promise<{
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
