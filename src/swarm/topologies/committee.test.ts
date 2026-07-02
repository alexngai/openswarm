/**
 * committee.test.ts — direct invocation of CommitteeTopology (v0.5 stage 5A).
 *
 * Mirrors the fake-spawn pattern from peer-team.test.ts. Verifies the
 * committee-specific properties: parallel spawn without teammate
 * augmentation, default aggregator selection (judge when a "judge" role is
 * present, else vote), and pre-abort handling.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CommitteeTopology } from "./committee.js";
import { WorkerPool } from "../worker-pool.js";
import { DeadLetterWriter } from "../dead-letter.js";
import {
  openTeamCheckpoint,
  type TeamCheckpointStore,
} from "../team-checkpoint.js";
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
  readonly sidecar: string | undefined;
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
    spawns.push({
      prompt: req.task.prompt,
      role: req.role,
      sidecar: (req as { sessionSidecarPath?: string }).sessionSidecarPath,
    });
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

function committeeSpec(
  members: readonly MemberSpec[],
  coordination: TeamSpec["coordination"] = { completion: { kind: "all" } },
): TeamSpec {
  return {
    name: "committee-test",
    topology: "committee",
    members,
    coordination,
  };
}

async function makeCtx(
  results: readonly AgentResult[],
  checkpoint?: TeamCheckpointStore,
): Promise<{
  ctx: TopologyContext;
  harness: Harness;
  cleanup: () => Promise<void>;
}> {
  const harness = fakeHost(results);
  const pool = new WorkerPool(8);
  const tmp = await mkdtemp(join(tmpdir(), "committee-"));
  const deadLetter = new DeadLetterWriter(join(tmp, "dl.jsonl"));
  const resultsOut = new PassThrough();
  resultsOut.resume();
  const ctx: TopologyContext = {
    host: harness.host,
    pool,
    resultsOut,
    deadLetter,
    permissionMode: "workspace-write",
    ...(checkpoint !== undefined && { checkpoint }),
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

describe("CommitteeTopology", () => {
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

  it("rejects empty members", async () => {
    const { ctx, cleanup } = await makeCtx([]);
    cleanups.push(cleanup);
    await expect(
      new CommitteeTopology().run(committeeSpec([]), ctx),
    ).rejects.toThrow(/empty/);
  });

  it("spawns N members in parallel without teammate augmentation", async () => {
    const { ctx, harness, cleanup } = await makeCtx([s("a"), s("b"), s("c")]);
    cleanups.push(cleanup);
    const spec = committeeSpec([
      member("m1", "rate this idea"),
      member("m2", "rate this idea"),
      member("m3", "rate this idea"),
    ]);
    await new CommitteeTopology().run(spec, ctx);

    expect(harness.spawns).toHaveLength(3);
    // No teammate injection — prompt is verbatim.
    for (const sp of harness.spawns) {
      expect(sp.prompt).toBe("rate this idea");
    }
  });

  it("default aggregator: vote when no judge role is present", async () => {
    const { ctx, harness, cleanup } = await makeCtx([s("yes"), s("yes"), s("no")]);
    cleanups.push(cleanup);
    const spec = committeeSpec([
      member("m1", "vote"),
      member("m2", "vote"),
      member("m3", "vote"),
    ]);
    const result = await new CommitteeTopology().run(spec, ctx);
    expect(result.aggregateOutput).toBe("yes");
    // Three real spawns — no judge invoked.
    expect(harness.spawns).toHaveLength(3);
  });

  it("default aggregator: judge when a member has role 'judge'", async () => {
    const { ctx, harness, cleanup } = await makeCtx([
      s("candidate A"), // member m1
      s("candidate B"), // member m2
      s("draft verdict"), // member judge1 (its own member turn)
      s("final verdict from judge aggregator"), // EXTRA spawn for the judge aggregator
    ]);
    cleanups.push(cleanup);
    const spec = committeeSpec([
      member("m1", "draft", "drafter"),
      member("m2", "draft", "drafter"),
      member("judge1", "judge", "judge"),
    ]);
    const result = await new CommitteeTopology().run(spec, ctx);
    // judge aggregator spawns an EXTRA member with role "judge" after all
    // members complete — total 4 spawns (3 members + 1 aggregator judge).
    expect(harness.spawns).toHaveLength(4);
    expect(result.aggregateOutput).toBe("final verdict from judge aggregator");
  });

  it("respects an explicit aggregator override (vote)", async () => {
    const { ctx, cleanup } = await makeCtx([s("x"), s("y"), s("y")]);
    cleanups.push(cleanup);
    const spec = committeeSpec(
      [member("m1", "p"), member("m2", "p"), member("m3", "p")],
      {
        completion: { kind: "all" },
        aggregator: { kind: "vote" },
      },
    );
    const result = await new CommitteeTopology().run(spec, ctx);
    expect(result.aggregateOutput).toBe("y");
  });

  it("pre-aborted spec returns cancelled count without spawning", async () => {
    const { ctx, harness, cleanup } = await makeCtx([]);
    cleanups.push(cleanup);
    const ac = new AbortController();
    ac.abort();
    const ctxAborted = { ...ctx, abort: ac.signal };
    const spec = committeeSpec([
      member("m1", "p"),
      member("m2", "p"),
    ]);
    const result = await new CommitteeTopology().run(spec, ctxAborted);
    expect(result.cancelled).toBe(2);
    expect(result.succeeded).toBe(0);
    expect(harness.spawns).toHaveLength(0);
  });

  it("v0.7 stage 7J — defaults non-judge candidates to {kind:'stream'}; judge stays unset", async () => {
    const captured: Array<{ role?: string; bp: unknown }> = [];
    let i = 0;
    const spawn = async (req: SpawnRequest): Promise<AgentHandle> => {
      captured.push({ role: req.role, bp: req.task.branchPolicy });
      i++;
      return makeHandle(
        { status: "success", output: `out-${i}`, usage: { inputTokens: 1, outputTokens: 1 }, wallClockMs: 1 },
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
      supportsStreams: () => true,
    } as unknown as StandaloneHost;
    const pool = new WorkerPool(4);
    const tmp = await mkdtemp(join(tmpdir(), "committee-7j-"));
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
    // Two bare candidates + one judge — verify only candidates get the default.
    const spec: TeamSpec = {
      name: "c-7j",
      topology: "committee",
      members: [
        { id: "c1", role: "candidate", prompt: "p1" },
        { id: "c2", role: "candidate", prompt: "p2" },
        { id: "j", role: "judge", prompt: "score them" },
      ],
      coordination: { completion: { kind: "all" } },
    };
    await new CommitteeTopology().run(spec, ctx);
    const candidateBPs = captured
      .filter((c) => c.role === "candidate")
      .map((c) => c.bp);
    const judgeBPs = captured.filter((c) => c.role === "judge").map((c) => c.bp);
    expect(candidateBPs.every((b) => JSON.stringify(b) === JSON.stringify({ kind: "stream" }))).toBe(true);
    // Judge wasn't defaulted — TeamSession's own fallback ({kind:"none"}) kicks in.
    expect(judgeBPs[0]).toEqual({ kind: "none" });
    await deadLetter.close();
    await rm(tmp, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Crash-recovery T3b — checkpoint skip + in-flight re-dispatch
  // -------------------------------------------------------------------------

  it("resume: skips a member that already succeeded (no re-spawn) and reuses its output", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "committee-cp-"));
    cleanups.push(async () => rm(tmp, { recursive: true, force: true }));
    const cpPath = join(tmp, "checkpoint.json");
    const spec = committeeSpec(
      [member("m1", "p1"), member("m2", "p2")],
      { completion: { kind: "all" }, aggregator: { kind: "concat" } },
    );

    // Pre-seed: m1 already succeeded in a prior (crashed) run.
    const seed = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
    await seed.record({
      id: "m1",
      status: "succeeded",
      output: "cached-m1",
      completedAt: 1,
    });
    await seed.close();

    const store = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
    expect(store.resumed).toBe(true);
    // Only m2 will be spawned this run.
    const { ctx, harness, cleanup } = await makeCtx([s("fresh-m2")], store);
    cleanups.push(cleanup);

    const result = await new CommitteeTopology().run(spec, ctx);
    await store.close();

    expect(harness.spawns).toHaveLength(1);
    expect(harness.spawns[0]!.prompt).toBe("p2"); // m2 only, no preamble
    expect(result.succeeded).toBe(2); // m1 (cached) + m2 (fresh)
    expect(result.aggregateOutput).toContain("cached-m1");
    expect(result.aggregateOutput).toContain("fresh-m2");

    // m2's terminal outcome was recorded for the next restart.
    const after = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
    expect(after.isDone("m2")).toBe(true);
    await after.close();
  });

  it("resume: re-dispatches an in-flight member with preamble + per-unit sidecar", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "committee-cp-"));
    cleanups.push(async () => rm(tmp, { recursive: true, force: true }));
    const cpPath = join(tmp, "checkpoint.json");
    const spec = committeeSpec([member("m1", "p1"), member("m2", "p2")]);

    // Pre-seed: m1 was dispatched but never reached terminal (crash mid-flight);
    // m2 never started.
    const seed = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
    await seed.markDispatched({
      id: "m1",
      sidecarPath: seed.sidecarPathFor("m1"),
      dispatchedAt: 1,
    });
    await seed.close();

    const store = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
    expect(store.resumed).toBe(true);
    expect(store.resumedInFlightCount).toBe(1);
    const { ctx, harness, cleanup } = await makeCtx([s("o1"), s("o2")], store);
    cleanups.push(cleanup);

    await new CommitteeTopology().run(spec, ctx);
    await store.close();

    expect(harness.spawns).toHaveLength(2);
    const m1 = harness.spawns.find((sp) => sp.sidecar?.includes("m1"))!;
    const m2 = harness.spawns.find((sp) => sp.sidecar?.includes("m2"))!;
    // m1 re-dispatched WITH preamble; m2 fresh WITHOUT.
    expect(m1.prompt).toContain("[Resumed after interruption]");
    expect(m1.prompt).toContain("p1");
    expect(m2.prompt).toBe("p2");
    // Both carry a per-unit sidecar so a future crash is resumable too.
    expect(m1.sidecar).toBeDefined();
    expect(m2.sidecar).toBeDefined();
  });
});
