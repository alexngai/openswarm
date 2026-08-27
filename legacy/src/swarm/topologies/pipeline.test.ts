/**
 * pipeline.test.ts — direct invocation of PipelineTopology.
 *
 * Mirrors the fake-spawn pattern from fanout.test.ts. Each test stands up a
 * fake StandaloneHost that resolves spawn() with a synthetic AgentHandle
 * and a pre-canned AgentResult, then verifies pipeline-specific properties:
 * sequential ordering, prompt threading, halt-on-failure, aggregation modes,
 * and abort handling.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PipelineTopology } from "./pipeline.js";
import { WorkerPool } from "../worker-pool.js";
import { DeadLetterWriter } from "../dead-letter.js";
import {
  openTeamCheckpoint,
  type TeamCheckpointStore,
} from "../team-checkpoint.js";
import type { TeamSpec, MemberSpec } from "../team-spec.js";
import type { TopologyContext } from "../topologies-types.js";
import type { StandaloneHost } from "../standalone-host.js";
import type {
  AgentHandle,
  AgentResult,
  SpawnRequest,
} from "../host.js";
import type { AgentId, SessionId } from "../../core/types.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeHandle(
  result: AgentResult,
  agentId: AgentId = "agent-1" as AgentId,
  sessionId: SessionId = "session-1" as SessionId,
): AgentHandle {
  return {
    agentId,
    sessionId,
    wait: () => Promise.resolve(result),
    kill: vi.fn(() => Promise.resolve()),
    events: async function* () {
      return;
    },
    runMore: () =>
      Promise.reject(new Error("runMore not supported in pipeline test fake")),
    drain: () => Promise.resolve(),
  };
}

function successResult(output: string): AgentResult {
  return {
    status: "success",
    output,
    usage: { inputTokens: 1, outputTokens: 2 },
    wallClockMs: 5,
  };
}

function failureResult(error = "boom"): AgentResult {
  return { status: "failure", error, wallClockMs: 5 };
}

interface SpawnLog {
  readonly prompt: string;
  readonly memberId: string | undefined;
  readonly teamScope: string | undefined;
}

function fakeHost(
  results: readonly AgentResult[],
  capturedSpawns: SpawnLog[],
): StandaloneHost {
  let i = 0;
  const spawn = async (req: SpawnRequest): Promise<AgentHandle> => {
    capturedSpawns.push({
      prompt: req.task.prompt,
      memberId: req.task.id,
      teamScope: req.teamScope,
    });
    const r = results[i] ?? failureResult("no result configured");
    i++;
    return makeHandle(
      r,
      `agent-${i}` as AgentId,
      `session-${i}` as SessionId,
    );
  };
  return {
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
  } as unknown as StandaloneHost;
}

function pipelineSpec(
  members: readonly MemberSpec[],
  coordination: TeamSpec["coordination"] = { completion: { kind: "all" } },
): TeamSpec {
  return {
    name: "pipeline-test",
    topology: "pipeline",
    members,
    coordination,
  };
}

function member(id: string, prompt: string): MemberSpec {
  return {
    id,
    role: "",
    prompt,
    branchPolicy: { kind: "none" },
    commitPolicy: { kind: "none" },
    escalationPolicy: { kind: "none" },
  };
}

interface RigOpts {
  readonly results: readonly AgentResult[];
  readonly abort?: AbortSignal;
  readonly checkpoint?: TeamCheckpointStore;
}

async function makeCtx(opts: RigOpts): Promise<{
  ctx: TopologyContext;
  spawns: SpawnLog[];
  cleanup: () => Promise<void>;
}> {
  const spawns: SpawnLog[] = [];
  const host = fakeHost(opts.results, spawns);
  const pool = new WorkerPool(1);
  const tmp = await mkdtemp(join(tmpdir(), "pipeline-"));
  const deadLetter = new DeadLetterWriter(join(tmp, "dl.jsonl"));
  const resultsOut = new PassThrough();
  resultsOut.resume();

  const ctx: TopologyContext = {
    host,
    pool,
    resultsOut,
    deadLetter,
    permissionMode: "workspace-write",
    ...(opts.abort !== undefined && { abort: opts.abort }),
    ...(opts.checkpoint !== undefined && { checkpoint: opts.checkpoint }),
  };
  return {
    ctx,
    spawns,
    cleanup: async () => {
      await deadLetter.close();
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PipelineTopology (direct invocation)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("threads each stage's output into the next stage's prompt", async () => {
    const { ctx, spawns, cleanup } = await makeCtx({
      results: [
        successResult("stage-1-output"),
        successResult("stage-2-output"),
        successResult("stage-3-output"),
      ],
    });

    const spec = pipelineSpec([
      member("m1", "first"),
      member("m2", "second"),
      member("m3", "third"),
    ]);

    const topology = new PipelineTopology();
    expect(topology.name).toBe("pipeline");
    const summary = await topology.run(spec, ctx);

    expect(summary.succeeded).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.aggregateOutput).toBe("stage-3-output");

    expect(spawns).toHaveLength(3);
    // Stage 1: original prompt only.
    expect(spawns[0]!.prompt).toBe("first");
    // Stage 2: prior output threaded in.
    expect(spawns[1]!.prompt).toContain("second");
    expect(spawns[1]!.prompt).toContain("## Previous stage output");
    expect(spawns[1]!.prompt).toContain("stage-1-output");
    // Stage 3 sees stage 2's output (not stage 1's).
    expect(spawns[2]!.prompt).toContain("third");
    expect(spawns[2]!.prompt).toContain("stage-2-output");
    expect(spawns[2]!.prompt).not.toContain("stage-1-output");

    // All members should have spawned in the same team scope.
    expect(spawns[0]!.teamScope).toBe("swarm:pipeline-test");
    expect(spawns[1]!.teamScope).toBe("swarm:pipeline-test");
    expect(spawns[2]!.teamScope).toBe("swarm:pipeline-test");

    await cleanup();
  });

  it("halts pipeline when a stage fails — remaining members never spawn", async () => {
    const { ctx, spawns, cleanup } = await makeCtx({
      results: [
        successResult("stage-1-output"),
        failureResult("stage-2-broke"),
        // Stage 3's result is never consumed because stage 2 halts the run.
        successResult("never-spawned"),
      ],
    });

    const spec = pipelineSpec([
      member("m1", "first"),
      member("m2", "second"),
      member("m3", "third"),
    ]);

    const summary = await new PipelineTopology().run(spec, ctx);

    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.timeout).toBe(0);
    expect(spawns).toHaveLength(2);
    // Partial-pipeline aggregate: surfaces the last *successful* stage's
    // output so callers can inspect what made it through before the halt.
    // The non-zero `failed` count is the authoritative failure signal.
    expect(summary.aggregateOutput).toBe("stage-1-output");

    await cleanup();
  });

  it("aggregator 'concat' joins all successful stage outputs with separator", async () => {
    const { ctx, cleanup } = await makeCtx({
      results: [
        successResult("alpha"),
        successResult("beta"),
        successResult("gamma"),
      ],
    });

    const spec = pipelineSpec(
      [member("m1", "p1"), member("m2", "p2"), member("m3", "p3")],
      {
        completion: { kind: "all" },
        aggregator: { kind: "concat" },
      },
    );

    const summary = await new PipelineTopology().run(spec, ctx);
    expect(summary.aggregateOutput).toBe("alpha\n\nbeta\n\ngamma");

    await cleanup();
  });

  it("aggregator 'concat' honors a custom separator", async () => {
    const { ctx, cleanup } = await makeCtx({
      results: [successResult("alpha"), successResult("beta")],
    });

    const spec = pipelineSpec(
      [member("m1", "p1"), member("m2", "p2")],
      {
        completion: { kind: "all" },
        aggregator: { kind: "concat", separator: " | " },
      },
    );

    const summary = await new PipelineTopology().run(spec, ctx);
    expect(summary.aggregateOutput).toBe("alpha | beta");

    await cleanup();
  });

  it("aggregator 'vote' falls through to 'last' for sequential pipelines", async () => {
    const { ctx, cleanup } = await makeCtx({
      results: [successResult("alpha"), successResult("beta")],
    });

    const spec = pipelineSpec(
      [member("m1", "p1"), member("m2", "p2")],
      {
        completion: { kind: "all" },
        aggregator: { kind: "vote" },
      },
    );

    const summary = await new PipelineTopology().run(spec, ctx);
    // vote isn't meaningful for pipeline → should behave like last.
    expect(summary.aggregateOutput).toBe("beta");

    // The host should have received a team_note about the override.
    const emit = ctx.host.emit as unknown as ReturnType<typeof vi.fn>;
    const noteCalls = emit.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === "team_note",
    );
    expect(noteCalls.length).toBeGreaterThanOrEqual(1);

    await cleanup();
  });

  it("rejects a spec with empty members array", async () => {
    const { ctx, cleanup } = await makeCtx({ results: [] });
    // Bypass TeamSpec schema validation (which requires members.min(1)) by
    // constructing the object directly. The topology must still defend itself.
    const spec = {
      name: "empty",
      topology: "pipeline" as const,
      members: [] as const,
      coordination: { completion: { kind: "all" as const } },
    } as unknown as TeamSpec;

    await expect(new PipelineTopology().run(spec, ctx)).rejects.toThrow(
      /members is empty/,
    );

    await cleanup();
  });

  it("runs a single-member pipeline", async () => {
    const { ctx, spawns, cleanup } = await makeCtx({
      results: [successResult("only-stage")],
    });

    const spec = pipelineSpec([member("solo", "just me")]);
    const summary = await new PipelineTopology().run(spec, ctx);

    expect(summary.succeeded).toBe(1);
    expect(summary.aggregateOutput).toBe("only-stage");
    expect(spawns).toHaveLength(1);
    // Single-stage pipeline should not contain any threaded-output preamble.
    expect(spawns[0]!.prompt).toBe("just me");
    expect(spawns[0]!.prompt).not.toContain("## Previous stage output");

    await cleanup();
  });

  it("treats a pre-aborted signal as 'cancel pending stages'", async () => {
    const abortController = new AbortController();
    abortController.abort();

    const { ctx, spawns, cleanup } = await makeCtx({
      // Should never be consumed.
      results: [successResult("nope-1"), successResult("nope-2")],
      abort: abortController.signal,
    });

    const spec = pipelineSpec([
      member("m1", "first"),
      member("m2", "second"),
    ]);

    const summary = await new PipelineTopology().run(spec, ctx);
    expect(spawns).toHaveLength(0);
    // Both stages should be counted as cancelled (none ran).
    expect(summary.cancelled).toBe(2);
    expect(summary.succeeded).toBe(0);

    await cleanup();
  });

  // -----------------------------------------------------------------------
  // v0.7 stage 7I — fork-from-prev defaults
  // -----------------------------------------------------------------------

  it("v0.7 stage 7I — stage 0 → kind:'stream', stage N>0 → kind:'fork' parent=prev streamId", async () => {
    const captured: Array<unknown> = [];
    // streamId table: agent-1 → s-1, agent-2 → s-2, ...
    const streamFor = (agentId: AgentId) =>
      agentId.startsWith("agent-")
        ? `s-${agentId.slice("agent-".length)}`
        : undefined;
    let i = 0;
    const spawn = async (req: SpawnRequest): Promise<AgentHandle> => {
      captured.push(req.task.branchPolicy);
      i++;
      return makeHandle(
        successResult(`out-${i}`),
        `agent-${i}` as AgentId,
        `session-${i}` as SessionId,
      );
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
      // 7I depends on these probes.
      supportsStreams: () => true,
      streamIdFor: streamFor,
    } as unknown as StandaloneHost;
    const pool = new WorkerPool(1);
    const tmp = await mkdtemp(join(tmpdir(), "pipeline-7i-"));
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
    // Bare members — no branchPolicy — so defaults apply.
    const spec: TeamSpec = {
      name: "p-7i",
      topology: "pipeline",
      members: [
        { id: "s0", role: "", prompt: "p0" },
        { id: "s1", role: "", prompt: "p1" },
        { id: "s2", role: "", prompt: "p2" },
      ],
      coordination: { completion: { kind: "all" } },
    };
    await new PipelineTopology().run(spec, ctx);
    expect(captured).toEqual([
      { kind: "stream" },
      { kind: "fork", parentStreamId: "s-1" },
      { kind: "fork", parentStreamId: "s-2" },
    ]);
    await deadLetter.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("v0.7 stage 7I — explicit member.branchPolicy wins over defaults", async () => {
    const captured: Array<unknown> = [];
    let i = 0;
    const spawn = async (req: SpawnRequest): Promise<AgentHandle> => {
      captured.push(req.task.branchPolicy);
      i++;
      return makeHandle(successResult("ok"), `agent-${i}` as AgentId);
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
      streamIdFor: () => "s-fixed",
    } as unknown as StandaloneHost;
    const pool = new WorkerPool(1);
    const tmp = await mkdtemp(join(tmpdir(), "pipeline-7i-explicit-"));
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
    const spec: TeamSpec = {
      name: "p-7i-explicit",
      topology: "pipeline",
      members: [
        { id: "s0", role: "", prompt: "p0", branchPolicy: { kind: "none" } },
        { id: "s1", role: "", prompt: "p1" }, // gets default
      ],
      coordination: { completion: { kind: "all" } },
    };
    await new PipelineTopology().run(spec, ctx);
    expect(captured[0]).toEqual({ kind: "none" });
    expect(captured[1]).toEqual({ kind: "fork", parentStreamId: "s-fixed" });
    await deadLetter.close();
    await rm(tmp, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // docs/28 — team crash-recovery (T1)
  // -----------------------------------------------------------------------

  it("records each stage completion into the checkpoint", async () => {
    const cpDir = await mkdtemp(join(tmpdir(), "pipeline-cp-"));
    const cpPath = join(cpDir, "checkpoint.json");
    const spec = pipelineSpec([member("m1", "first"), member("m2", "second")]);
    const store = await openTeamCheckpoint({ checkpointPath: cpPath, spec });

    const { ctx, cleanup } = await makeCtx({
      results: [successResult("out-1"), successResult("out-2")],
      checkpoint: store,
    });
    await new PipelineTopology().run(spec, ctx);
    await store.close();

    expect(store.isDone("m1")).toBe(true);
    expect(store.isDone("m2")).toBe(true);
    expect(store.get("m1")?.output).toBe("out-1");

    await cleanup();
    await rm(cpDir, { recursive: true, force: true });
  });

  it("resumes: skips a checkpointed stage and threads its stored output forward", async () => {
    const cpDir = await mkdtemp(join(tmpdir(), "pipeline-resume-"));
    const cpPath = join(cpDir, "checkpoint.json");
    const spec = pipelineSpec([
      member("m1", "first"),
      member("m2", "second"),
      member("m3", "third"),
    ]);

    // Pre-seed a prior run where stage m1 already succeeded.
    const seed = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
    await seed.record({
      id: "m1",
      status: "succeeded",
      output: "stage-1-output",
      completedAt: Date.now(),
    });
    await seed.close();

    // Reopen for the resuming run.
    const store = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
    expect(store.resumed).toBe(true);

    // Only m2 and m3 actually spawn this run.
    const { ctx, spawns, cleanup } = await makeCtx({
      results: [successResult("stage-2-output"), successResult("stage-3-output")],
      checkpoint: store,
    });
    const summary = await new PipelineTopology().run(spec, ctx);
    await store.close();

    // m1 skipped → only 2 spawns; overall 3 succeeded.
    expect(spawns).toHaveLength(2);
    expect(summary.succeeded).toBe(3);
    expect(summary.aggregateOutput).toBe("stage-3-output");

    // m2 (first actual spawn) sees m1's checkpointed output threaded in.
    expect(spawns[0]!.prompt).toContain("second");
    expect(spawns[0]!.prompt).toContain("## Previous stage output");
    expect(spawns[0]!.prompt).toContain("stage-1-output");

    await cleanup();
    await rm(cpDir, { recursive: true, force: true });
  });
});
