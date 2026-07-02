/**
 * fanout.test.ts — direct invocation of FanoutTopology via the
 * Topology interface. Mirrors a slim subset of orchestrator.test.ts
 * to confirm the Topology contract works without an Orchestrator shell.
 *
 * The shared orchestrator.test.ts continues to cover fanout exhaustively
 * via the legacy Orchestrator.run(tasks) entry point — these tests just
 * exercise the new direct-topology path that v0.4 stage 4D will use.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { FanoutTopology } from "./fanout.js";
import { WorkerPool } from "../worker-pool.js";
import { DeadLetterWriter } from "../dead-letter.js";
import { openTeamCheckpoint } from "../team-checkpoint.js";
import type { TeamSpec } from "../team-spec.js";
import type { TopologyContext } from "../topologies-types.js";
import type { StandaloneHost } from "../standalone-host.js";
import type { AgentHandle, AgentResult } from "../host.js";
import type { AgentId, SessionId } from "../../core/types.js";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHandle(
  result: AgentResult,
  agentId: AgentId = "agent-1" as AgentId,
  sessionId: SessionId = "session-1" as SessionId,
  delayMs = 0,
): AgentHandle {
  return {
    agentId,
    sessionId,
    wait: () =>
      delayMs > 0
        ? new Promise((resolve) => setTimeout(() => resolve(result), delayMs))
        : Promise.resolve(result),
    kill: vi.fn(() => Promise.resolve()),
    events: async function* () {
      return;
    },
    runMore: () =>
      Promise.reject(new Error("runMore not supported in fanout test fake")),
    drain: () => Promise.resolve(),
  };
}

function successResult(output = "done"): AgentResult {
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

function fakeHost(
  spawnImpl: (req: Parameters<StandaloneHost["spawn"]>[0]) => Promise<AgentHandle>,
  opts: { supportsStreams?: boolean } = {},
): StandaloneHost {
  return {
    mode: "standalone",
    agentId: "topology-host" as AgentId,
    depth: 0,
    spawn: spawnImpl,
    emit: vi.fn(),
    send: vi.fn(),
    inbox: async function* () {
      return;
    },
    task: {} as StandaloneHost["task"],
    // v0.7 stage 7G — fanout consults this before applying defaults; fake
    // returns false by default so existing tests don't get policies rewritten.
    supportsStreams: () => opts.supportsStreams ?? false,
  } as unknown as StandaloneHost;
}

async function collectJsonl(stream: PassThrough): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const lines = text
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
      resolve(lines);
    });
    stream.on("error", reject);
  });
}

function singleMemberSpec(prompt = "hello"): TeamSpec {
  return {
    name: "fanout-direct",
    topology: "fanout",
    members: [
      {
        id: "m1",
        role: "",
        prompt,
        branchPolicy: { kind: "none" },
        commitPolicy: { kind: "none" },
        escalationPolicy: { kind: "none" },
      },
    ],
    coordination: { completion: { kind: "all" } },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FanoutTopology (direct invocation)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs a single-member spec to completion", async () => {
    const host = fakeHost(async () => makeHandle(successResult("ok")));
    const pool = new WorkerPool(1);
    const tmp = await mkdtemp(join(tmpdir(), "fanout-"));
    const deadLetter = new DeadLetterWriter(join(tmp, "dl.jsonl"));
    const resultsOut = new PassThrough();
    const collect = collectJsonl(resultsOut);

    const ctx: TopologyContext = {
      host,
      pool,
      resultsOut,
      deadLetter,
      permissionMode: "workspace-write",
    };

    const topology = new FanoutTopology();
    expect(topology.name).toBe("fanout");
    const summary = await topology.run(singleMemberSpec(), ctx);
    resultsOut.end();
    const lines = (await collect) as Array<{ id: string; status: string }>;

    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.id).toBe("m1");
    expect(lines[0]!.status).toBe("succeeded");

    await deadLetter.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("v0.7 stage 7G — defaults member.branchPolicy to {kind:'stream'} when host supports streams", async () => {
    const captured: Array<unknown> = [];
    const host = fakeHost(
      async (req) => {
        captured.push(req.task.branchPolicy);
        return makeHandle(successResult("ok"));
      },
      { supportsStreams: true },
    );
    const pool = new WorkerPool(1);
    const tmp = await mkdtemp(join(tmpdir(), "fanout-7g-"));
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
    // Member with no branchPolicy set — relies on the default.
    const spec: TeamSpec = {
      name: "7g",
      topology: "fanout",
      members: [{ id: "m1", role: "", prompt: "p" }],
      coordination: { completion: { kind: "all" } },
    };
    await new FanoutTopology().run(spec, ctx);
    expect(captured[0]).toEqual({ kind: "stream" });
    await deadLetter.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("respects pool concurrency for parallel members", async () => {
    let active = 0;
    let maxActive = 0;
    const host = fakeHost(async () => {
      active++;
      if (active > maxActive) maxActive = active;
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return makeHandle(successResult());
    });
    const pool = new WorkerPool(2);
    const tmp = await mkdtemp(join(tmpdir(), "fanout-"));
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
      name: "concurrency-cap",
      topology: "fanout",
      members: Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        role: "",
        prompt: `p${i}`,
        branchPolicy: { kind: "none" },
        commitPolicy: { kind: "none" },
        escalationPolicy: { kind: "none" },
      })),
      coordination: { completion: { kind: "all" } },
    };

    const summary = await new FanoutTopology().run(spec, ctx);
    expect(summary.succeeded).toBe(5);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThanOrEqual(1);

    await deadLetter.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("dead-letters tasks that fail repeatedly with retry policy", async () => {
    const host = fakeHost(async () => makeHandle(failureResult("always fails")));
    const pool = new WorkerPool(1);
    const tmp = await mkdtemp(join(tmpdir(), "fanout-"));
    const dlPath = join(tmp, "dl.jsonl");
    const deadLetter = new DeadLetterWriter(dlPath);
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
      name: "retry-dl",
      topology: "fanout",
      members: [
        {
          id: "doomed",
          role: "",
          prompt: "fail",
          branchPolicy: { kind: "none" },
          commitPolicy: { kind: "none" },
          escalationPolicy: { kind: "retry", max: 1, backoff: "fixed" },
        },
      ],
      coordination: { completion: { kind: "all" } },
    };

    const summary = await new FanoutTopology().run(spec, ctx);
    await deadLetter.close();

    expect(summary.failed).toBe(1);
    expect(summary.deadLetterViolation).toBe(true);

    const dlContent = await readFile(dlPath, "utf8");
    const lines = dlContent
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { id: string; lastStatus: string });
    expect(lines.find((l) => l.id === "doomed")).toBeDefined();

    await rm(tmp, { recursive: true, force: true });
  });

  it("treats abort signal as 'cancel pending acquires'", async () => {
    // Pre-aborted signal: every member should be marked cancelled.
    const host = fakeHost(async () => makeHandle(successResult()));
    const pool = new WorkerPool(1);
    const tmp = await mkdtemp(join(tmpdir(), "fanout-"));
    const deadLetter = new DeadLetterWriter(join(tmp, "dl.jsonl"));
    const resultsOut = new PassThrough();
    resultsOut.resume();

    const abortController = new AbortController();
    abortController.abort();

    const ctx: TopologyContext = {
      host,
      pool,
      resultsOut,
      deadLetter,
      permissionMode: "workspace-write",
      abort: abortController.signal,
    };

    const summary = await new FanoutTopology().run(singleMemberSpec(), ctx);
    expect(summary.cancelled).toBe(1);

    await deadLetter.close();
    await rm(tmp, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // docs/28 — team crash-recovery (T1)
  // -----------------------------------------------------------------------

  function twoMemberSpec(): TeamSpec {
    return {
      name: "fanout-cp",
      topology: "fanout",
      members: [
        { id: "m1", role: "", prompt: "p1", branchPolicy: { kind: "none" }, commitPolicy: { kind: "none" }, escalationPolicy: { kind: "none" } },
        { id: "m2", role: "", prompt: "p2", branchPolicy: { kind: "none" }, commitPolicy: { kind: "none" }, escalationPolicy: { kind: "none" } },
      ],
      coordination: { completion: { kind: "all" } },
    };
  }

  it("records each task's terminal outcome into the checkpoint", async () => {
    const host = fakeHost(async () => makeHandle(successResult("ok")));
    const pool = new WorkerPool(2);
    const tmp = await mkdtemp(join(tmpdir(), "fanout-cp-"));
    const deadLetter = new DeadLetterWriter(join(tmp, "dl.jsonl"));
    const resultsOut = new PassThrough();
    resultsOut.resume();
    const cpPath = join(tmp, "checkpoint.json");
    const spec = twoMemberSpec();
    const store = await openTeamCheckpoint({ checkpointPath: cpPath, spec });

    const ctx: TopologyContext = {
      host,
      pool,
      resultsOut,
      deadLetter,
      permissionMode: "workspace-write",
      checkpoint: store,
    };
    await new FanoutTopology().run(spec, ctx);
    await store.close();

    expect(store.isDone("m1")).toBe(true);
    expect(store.isDone("m2")).toBe(true);

    await deadLetter.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("resumes: skips a checkpointed task (no re-spawn) and replays its result line", async () => {
    let spawnCount = 0;
    const spawnedIds: string[] = [];
    const host = fakeHost(async (req) => {
      spawnCount++;
      spawnedIds.push(req.task.id ?? "?");
      return makeHandle(successResult("fresh-m2"));
    });
    const pool = new WorkerPool(2);
    const tmp = await mkdtemp(join(tmpdir(), "fanout-resume-"));
    const deadLetter = new DeadLetterWriter(join(tmp, "dl.jsonl"));
    const resultsOut = new PassThrough();
    const collect = collectJsonl(resultsOut);
    const cpPath = join(tmp, "checkpoint.json");
    const spec = twoMemberSpec();

    // Pre-seed: m1 already succeeded in a prior run.
    const seed = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
    await seed.record({ id: "m1", status: "succeeded", output: "cached-m1", completedAt: 1 });
    await seed.close();

    const store = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
    expect(store.resumed).toBe(true);

    const ctx: TopologyContext = {
      host,
      pool,
      resultsOut,
      deadLetter,
      permissionMode: "workspace-write",
      checkpoint: store,
    };
    const summary = await new FanoutTopology().run(spec, ctx);
    await store.close();
    resultsOut.end();
    const lines = (await collect) as Array<{ id: string; status: string; output?: string }>;

    // m1 skipped → only m2 spawned; both counted succeeded.
    expect(spawnCount).toBe(1);
    expect(spawnedIds).toEqual(["m2"]);
    expect(summary.succeeded).toBe(2);

    const byId = new Map(lines.map((l) => [l.id, l]));
    expect(byId.get("m1")?.output).toBe("cached-m1"); // replayed from checkpoint
    expect(byId.get("m2")?.output).toBe("fresh-m2");

    await deadLetter.close();
    await rm(tmp, { recursive: true, force: true });
  });
});
