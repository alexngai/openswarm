/**
 * peer-team.test.ts — direct invocation of PeerTeamTopology.
 *
 * Mirrors the fake-spawn pattern from pipeline.test.ts. Each test stands up
 * a fake StandaloneHost that resolves spawn() with a synthetic AgentHandle
 * and a pre-canned AgentResult, then verifies peer-team-specific properties:
 * parallel spawn, teammate-prompt augmentation, completion rules, aggregator
 * modes, and failure semantics.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PeerTeamTopology } from "./peer-team.js";
import { WorkerPool } from "../worker-pool.js";
import { DeadLetterWriter } from "../dead-letter.js";
import { RecoveryRegistry } from "../recovery/registry.js";
import type {
  ConflictContext,
  ConflictResolution,
} from "../recovery/types.js";
import type { TeamSpec, MemberSpec } from "../team-spec.js";
import type { TopologyContext } from "../topologies-types.js";
import type { StandaloneHost } from "../standalone-host.js";
import type { AgentHandle, AgentResult, SpawnRequest } from "../host.js";
import type { LaneEvent } from "../events.js";
import type { AgentId, SessionId } from "../../core/types.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface MakeHandleOpts {
  readonly result?: AgentResult;
  readonly waitMs?: number;
  readonly resultPromise?: Promise<AgentResult>;
  readonly killable?: boolean;
}

interface FakeHandle extends AgentHandle {
  readonly killed: { value: boolean };
  readonly killSpy: ReturnType<typeof vi.fn>;
}

function makeHandle(
  opts: MakeHandleOpts,
  agentId: AgentId,
  sessionId: SessionId,
): FakeHandle {
  const killed = { value: false };
  let resolveKilled: ((r: AgentResult) => void) | undefined;
  const killedPromise = new Promise<AgentResult>((resolve) => {
    resolveKilled = resolve;
  });

  const baseResult: Promise<AgentResult> =
    opts.resultPromise !== undefined
      ? opts.resultPromise
      : opts.waitMs !== undefined
        ? new Promise<AgentResult>((resolve) =>
            setTimeout(
              () =>
                resolve(
                  opts.result ?? {
                    status: "success",
                    output: "ok",
                    usage: { inputTokens: 1, outputTokens: 1 },
                    wallClockMs: opts.waitMs ?? 0,
                  },
                ),
              opts.waitMs,
            ),
          )
        : Promise.resolve(
            opts.result ?? {
              status: "success",
              output: "ok",
              usage: { inputTokens: 1, outputTokens: 1 },
              wallClockMs: 0,
            },
          );

  // The handle's wait() races between the natural completion and a kill().
  // When kill() is called, wait() resolves with status: "killed".
  const wait = (): Promise<AgentResult> =>
    Promise.race([baseResult, killedPromise]);

  const killSpy = vi.fn(async () => {
    if (killed.value) return;
    killed.value = true;
    resolveKilled?.({ status: "killed", wallClockMs: 0 });
  });

  return {
    agentId,
    sessionId,
    wait,
    kill: killSpy,
    events: async function* () {
      return;
    },
    runMore: () =>
      Promise.reject(new Error("runMore not supported in peer-team test fake")),
    drain: () => Promise.resolve(),
    killed,
    killSpy,
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
  readonly role: string | undefined;
  readonly spawnedAt: number;
}

interface FakeHostHarness {
  readonly host: StandaloneHost;
  readonly events: EventEmitter;
  readonly spawns: SpawnLog[];
  readonly handles: FakeHandle[];
  emitLaneEvent(evt: Partial<LaneEvent> & Pick<LaneEvent, "type" | "payload">): void;
}

interface FakeHostExtras {
  /** v0.7 stage 7C — stub the host's streamIdFor lookup. */
  readonly streamIdFor?: (agentId: AgentId) => string | undefined;
  /** v0.7 stage 7C — stub the host's mergeStreamForAgent. */
  readonly mergeStreamForAgent?: (
    agentId: AgentId,
    opts: { readonly targetStream: string; readonly strategy?: string },
  ) => Promise<
    | import("../adapters/git-cascade-branch-policy.js").MergeStreamResult
    | null
  >;
  /** v0.7 stage 7D — stub the stream-aware-adapter check. */
  readonly supportsStreams?: () => boolean;
  /** v0.7 stage 7F — stub host.ensureIntegratorStream. */
  readonly ensureIntegratorStream?: (branch: string) => Promise<string | null>;
  /** v0.7 stage 7F — stub host.mergeStreamToBranchForAgent. */
  readonly mergeStreamToBranchForAgent?: (
    agentId: AgentId,
    opts: { readonly targetBranch: string; readonly strategy?: string },
  ) => Promise<
    | import("../adapters/git-cascade-branch-policy.js").MergeStreamResult
    | null
  >;
  /** docs/44 P3 — stub host.cascadeRebase. */
  readonly cascadeRebase?: (
    opts: import("../adapters/git-cascade-branch-policy.js").CascadeRebaseOptions,
  ) => Promise<
    | import("../adapters/git-cascade-branch-policy.js").CascadeRebaseResult
    | null
  >;
}

function fakeHost(
  handleOpts: readonly MakeHandleOpts[],
  extras: FakeHostExtras = {},
): FakeHostHarness {
  let i = 0;
  const spawns: SpawnLog[] = [];
  const handles: FakeHandle[] = [];
  const events = new EventEmitter();
  // Allow many subscribers without warnings (until_signal subscribes per-run).
  events.setMaxListeners(50);

  const spawn = async (req: SpawnRequest): Promise<AgentHandle> => {
    spawns.push({
      prompt: req.task.prompt,
      memberId: req.task.id,
      teamScope: req.teamScope,
      role: req.role,
      spawnedAt: Date.now(),
    });
    const opts = handleOpts[i] ?? { result: failureResult("no result configured") };
    const handle = makeHandle(
      opts,
      `agent-${i + 1}` as AgentId,
      `session-${i + 1}` as SessionId,
    );
    handles.push(handle);
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
    // PeerTeamTopology's `until_signal` path subscribes to host.events via a
    // cast through `any`. Expose a real EventEmitter so tests can drive it.
    events,
    // v0.7 stage 7C — auto-merge calls these. Default to "no streams" so
    // existing tests are unaffected.
    streamIdFor: vi.fn(extras.streamIdFor ?? (() => undefined)),
    mergeStreamForAgent: vi.fn(extras.mergeStreamForAgent ?? (async () => null)),
    // v0.7 stage 7D — default to false so existing tests don't get policies
    // rewritten under them. Tests that exercise defaults override via extras.
    supportsStreams: vi.fn(extras.supportsStreams ?? (() => false)),
    // v0.7 stage 7F — null by default (no integrator support).
    ensureIntegratorStream: vi.fn(extras.ensureIntegratorStream ?? (async () => null)),
    mergeStreamToBranchForAgent: vi.fn(
      extras.mergeStreamToBranchForAgent ?? (async () => null),
    ),
    // docs/44 P3 — present by default (real StandaloneHost always has it); the
    // cascade trigger's real discriminator is member.onParentAdvanced.
    cascadeRebase: vi.fn(extras.cascadeRebase ?? (async () => null)),
  } as unknown as StandaloneHost;

  return {
    host,
    events,
    spawns,
    handles,
    emitLaneEvent: (evt) => {
      const full: LaneEvent = {
        ts: Date.now(),
        agentId: ("agent-emitter" as AgentId),
        ...evt,
      } as LaneEvent;
      events.emit("lane_event", full);
    },
  };
}

function peerSpec(
  members: readonly MemberSpec[],
  coordination: TeamSpec["coordination"] = { completion: { kind: "all" } },
  name = "peer-test",
): TeamSpec {
  return { name, topology: "peer-team", members, coordination };
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

interface RigOpts {
  readonly handleOpts: readonly MakeHandleOpts[];
  readonly abort?: AbortSignal;
  readonly hostExtras?: FakeHostExtras;
}

async function makeCtx(opts: RigOpts): Promise<{
  ctx: TopologyContext;
  harness: FakeHostHarness;
  cleanup: () => Promise<void>;
}> {
  const harness = fakeHost(opts.handleOpts, opts.hostExtras ?? {});
  const pool = new WorkerPool(8);
  const tmp = await mkdtemp(join(tmpdir(), "peer-team-"));
  const deadLetter = new DeadLetterWriter(join(tmp, "dl.jsonl"));
  const resultsOut = new PassThrough();
  resultsOut.resume();

  const ctx: TopologyContext = {
    host: harness.host,
    pool,
    resultsOut,
    deadLetter,
    permissionMode: "workspace-write",
    ...(opts.abort !== undefined && { abort: opts.abort }),
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

describe("PeerTeamTopology (direct invocation)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("name is 'peer-team'", () => {
    expect(new PeerTeamTopology().name).toBe("peer-team");
  });

  it("spawns all members in parallel into the team scope and concats outputs", async () => {
    const { ctx, harness, cleanup } = await makeCtx({
      handleOpts: [
        { result: successResult("alpha") },
        { result: successResult("beta") },
        { result: successResult("gamma") },
      ],
    });
    const spec = peerSpec([
      member("m1", "first"),
      member("m2", "second"),
      member("m3", "third"),
    ]);

    const summary = await new PeerTeamTopology().run(spec, ctx);

    expect(summary.succeeded).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.aggregateOutput).toBe("alpha\n\nbeta\n\ngamma");
    expect(harness.spawns).toHaveLength(3);
    // All three members should land in the same team scope.
    for (const s of harness.spawns) {
      expect(s.teamScope).toBe("swarm:peer-test");
    }
    // Spawned roughly concurrently — start times within a small window
    // (parallel spawnAll). Generous bound so CI hiccups don't flake.
    const earliest = Math.min(...harness.spawns.map((s) => s.spawnedAt));
    const latest = Math.max(...harness.spawns.map((s) => s.spawnedAt));
    expect(latest - earliest).toBeLessThan(200);

    // team_started + team_completed events should have fired.
    const emit = ctx.host.emit as unknown as ReturnType<typeof vi.fn>;
    const startedCalls = emit.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === "team_started",
    );
    const completedCalls = emit.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === "team_completed",
    );
    expect(startedCalls.length).toBe(1);
    expect(completedCalls.length).toBe(1);
    expect(
      (startedCalls[0]![0] as { payload: { topology: string; memberCount: number } }).payload,
    ).toMatchObject({ topology: "peer-team", memberCount: 3 });

    await cleanup();
  });

  it("injects each member's prompt with a teammates list listing the others", async () => {
    const { ctx, harness, cleanup } = await makeCtx({
      handleOpts: [
        { result: successResult("a") },
        { result: successResult("b") },
        { result: successResult("c") },
      ],
    });
    const spec = peerSpec([
      member("m1", "first", "writer"),
      member("m2", "second", "reviewer"),
      member("m3", "third", "judge"),
    ]);

    await new PeerTeamTopology().run(spec, ctx);

    expect(harness.spawns).toHaveLength(3);
    // m1 should know about m2 and m3, but not itself.
    expect(harness.spawns[0]!.prompt).toContain("first");
    expect(harness.spawns[0]!.prompt).toContain("## Your teammates");
    expect(harness.spawns[0]!.prompt).toContain("reviewer");
    expect(harness.spawns[0]!.prompt).toContain("judge");
    // It mentions team_members() for runtime fresh state.
    expect(harness.spawns[0]!.prompt).toContain("team_members()");
    // m2 should reference m1 and m3 — including their ids.
    expect(harness.spawns[1]!.prompt).toContain("m1");
    expect(harness.spawns[1]!.prompt).toContain("m3");
    // Self-role shouldn't appear in teammates list (would always trip on its
    // own id but we just check the member's id isn't listed under teammates).
    const m3Section = harness.spawns[2]!.prompt;
    const teammatesPart = m3Section.split("## Your teammates")[1] ?? "";
    expect(teammatesPart).not.toContain("(id: m3)");

    await cleanup();
  });

  it("CompletionRule 'any': first finisher wins, others get killed", async () => {
    let resolveSlow1: ((r: AgentResult) => void) | undefined;
    let resolveSlow2: ((r: AgentResult) => void) | undefined;
    const slow1 = new Promise<AgentResult>((r) => {
      resolveSlow1 = r;
    });
    const slow2 = new Promise<AgentResult>((r) => {
      resolveSlow2 = r;
    });
    void resolveSlow1;
    void resolveSlow2;

    const { ctx, harness, cleanup } = await makeCtx({
      handleOpts: [
        { result: successResult("fast-winner") },
        { resultPromise: slow1 },
        { resultPromise: slow2 },
      ],
    });
    const spec = peerSpec(
      [member("fast", "p"), member("slow1", "p"), member("slow2", "p")],
      { completion: { kind: "any" } },
    );

    const summary = await new PeerTeamTopology().run(spec, ctx);

    expect(summary.succeeded).toBe(1);
    expect(summary.aggregateOutput).toBe("fast-winner");
    // Slow members should have had .kill() called on them.
    expect(harness.handles[1]!.killSpy).toHaveBeenCalled();
    expect(harness.handles[2]!.killSpy).toHaveBeenCalled();
    // Winner should not have been killed via the completion path. (dispose()
    // in finally will kill any survivors, but the winner already returned —
    // calling kill() on a finished handle is a no-op.)

    await cleanup();
  });

  it("CompletionRule 'majority' kills survivors once M complete", async () => {
    let resolveSlow1: ((r: AgentResult) => void) | undefined;
    let resolveSlow2: ((r: AgentResult) => void) | undefined;
    const slow1 = new Promise<AgentResult>((r) => {
      resolveSlow1 = r;
    });
    const slow2 = new Promise<AgentResult>((r) => {
      resolveSlow2 = r;
    });
    void resolveSlow1;
    void resolveSlow2;

    const { ctx, harness, cleanup } = await makeCtx({
      handleOpts: [
        { result: successResult("fast-1") },
        { result: successResult("fast-2") },
        { resultPromise: slow1 },
        { resultPromise: slow2 },
      ],
    });
    const spec = peerSpec(
      [
        member("a", "p"),
        member("b", "p"),
        member("c", "p"),
        member("d", "p"),
      ],
      { completion: { kind: "majority", m: 2 } },
    );

    const summary = await new PeerTeamTopology().run(spec, ctx);
    expect(summary.succeeded).toBe(2);
    // Slow members get killed.
    expect(harness.handles[2]!.killSpy).toHaveBeenCalled();
    expect(harness.handles[3]!.killSpy).toHaveBeenCalled();

    await cleanup();
  });

  it("CompletionRule 'majority' rejects m > N", async () => {
    const { ctx, cleanup } = await makeCtx({
      handleOpts: [
        { result: successResult("a") },
        { result: successResult("b") },
      ],
    });
    const spec = peerSpec(
      [member("a", "p"), member("b", "p")],
      { completion: { kind: "majority", m: 5 } },
    );
    await expect(new PeerTeamTopology().run(spec, ctx)).rejects.toThrow(
      /majority m=5 exceeds member count 2/,
    );
    await cleanup();
  });

  it("CompletionRule 'deadline': kills slow members when deadline elapses", async () => {
    let resolveSlow: ((r: AgentResult) => void) | undefined;
    const slow = new Promise<AgentResult>((r) => {
      resolveSlow = r;
    });
    void resolveSlow;

    const { ctx, harness, cleanup } = await makeCtx({
      handleOpts: [
        { result: successResult("fast-done") },
        { resultPromise: slow },
        { resultPromise: slow },
      ],
    });
    const spec = peerSpec(
      [member("a", "p"), member("b", "p"), member("c", "p")],
      { completion: { kind: "deadline", ms: 30 } },
    );

    const summary = await new PeerTeamTopology().run(spec, ctx);
    // The fast one succeeded; the two slow ones were killed by the deadline
    // (their wait() resolves to status: "killed" after kill() ran).
    expect(summary.succeeded).toBe(1);
    expect(summary.cancelled).toBe(2);
    expect(harness.handles[1]!.killSpy).toHaveBeenCalled();
    expect(harness.handles[2]!.killSpy).toHaveBeenCalled();

    await cleanup();
  });

  it("CompletionRule 'until_signal': drains team when signal seen", async () => {
    let resolveSlow1: ((r: AgentResult) => void) | undefined;
    let resolveSlow2: ((r: AgentResult) => void) | undefined;
    const slow1 = new Promise<AgentResult>((r) => {
      resolveSlow1 = r;
    });
    const slow2 = new Promise<AgentResult>((r) => {
      resolveSlow2 = r;
    });
    void resolveSlow1;
    void resolveSlow2;

    const { ctx, harness, cleanup } = await makeCtx({
      handleOpts: [
        { resultPromise: slow1 },
        { resultPromise: slow2 },
      ],
    });
    const spec = peerSpec(
      [member("a", "p"), member("b", "p")],
      { completion: { kind: "until_signal", signal: "APPROVED" } },
    );

    // Schedule a message_sent event mid-run that should trigger drain.
    setTimeout(() => {
      harness.emitLaneEvent({
        type: "message_sent",
        payload: { content: "team consensus: APPROVED — ship it" },
      });
    }, 20);

    const summary = await new PeerTeamTopology().run(spec, ctx);
    expect(summary.cancelled).toBe(2);
    expect(harness.handles[0]!.killSpy).toHaveBeenCalled();
    expect(harness.handles[1]!.killSpy).toHaveBeenCalled();

    await cleanup();
  });

  it("Aggregator 'last' returns last successful output", async () => {
    const { ctx, cleanup } = await makeCtx({
      handleOpts: [
        { result: successResult("alpha") },
        { result: successResult("beta") },
      ],
    });
    const spec = peerSpec(
      [member("a", "p"), member("b", "p")],
      { completion: { kind: "all" }, aggregator: { kind: "last" } },
    );
    const summary = await new PeerTeamTopology().run(spec, ctx);
    expect(summary.aggregateOutput).toBe("beta");
    await cleanup();
  });

  it("Aggregator 'vote': majority output wins; tie → first occurrence", async () => {
    // Three members; two return "yes", one returns "no" → "yes" wins.
    const { ctx: ctx1, cleanup: cleanup1 } = await makeCtx({
      handleOpts: [
        { result: successResult("yes") },
        { result: successResult("no") },
        { result: successResult("yes") },
      ],
    });
    const summary1 = await new PeerTeamTopology().run(
      peerSpec(
        [member("a", "p"), member("b", "p"), member("c", "p")],
        { completion: { kind: "all" }, aggregator: { kind: "vote" } },
      ),
      ctx1,
    );
    expect(summary1.aggregateOutput).toBe("yes");
    await cleanup1();

    // Three different outputs → tie at count 1; first occurrence wins.
    const { ctx: ctx2, cleanup: cleanup2 } = await makeCtx({
      handleOpts: [
        { result: successResult("first") },
        { result: successResult("second") },
        { result: successResult("third") },
      ],
    });
    const summary2 = await new PeerTeamTopology().run(
      peerSpec(
        [member("a", "p"), member("b", "p"), member("c", "p")],
        { completion: { kind: "all" }, aggregator: { kind: "vote" } },
      ),
      ctx2,
    );
    expect(summary2.aggregateOutput).toBe("first");
    await cleanup2();
  });

  it("Aggregator 'judge' spawns an extra member with the judge role", async () => {
    // Three candidate members + one judge member spawned afterward.
    const { ctx, harness, cleanup } = await makeCtx({
      handleOpts: [
        { result: successResult("candidate-1") },
        { result: successResult("candidate-2") },
        { result: successResult("candidate-3") },
        { result: successResult("judge-says-cand-2-wins") },
      ],
    });
    const spec = peerSpec(
      [member("a", "p"), member("b", "p"), member("c", "p")],
      {
        completion: { kind: "all" },
        aggregator: { kind: "judge", role: "verdict" },
      },
    );

    const summary = await new PeerTeamTopology().run(spec, ctx);
    expect(summary.aggregateOutput).toBe("judge-says-cand-2-wins");
    expect(harness.spawns).toHaveLength(4);
    // The 4th spawn is the judge — its role should be "verdict".
    expect(harness.spawns[3]!.role).toBe("verdict");
    // The judge prompt should reference all candidate outputs.
    expect(harness.spawns[3]!.prompt).toContain("candidate-1");
    expect(harness.spawns[3]!.prompt).toContain("candidate-2");
    expect(harness.spawns[3]!.prompt).toContain("candidate-3");
    await cleanup();
  });

  it("Aggregator 'custom' (no fn) falls through to concat with team_note", async () => {
    const { ctx, cleanup } = await makeCtx({
      handleOpts: [
        { result: successResult("x") },
        { result: successResult("y") },
      ],
    });
    const spec = peerSpec(
      [member("a", "p"), member("b", "p")],
      { completion: { kind: "all" }, aggregator: { kind: "custom" } },
    );

    const summary = await new PeerTeamTopology().run(spec, ctx);
    expect(summary.aggregateOutput).toBe("x\n\ny");

    const emit = ctx.host.emit as unknown as ReturnType<typeof vi.fn>;
    const noteCalls = emit.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === "team_note",
    );
    expect(noteCalls.length).toBeGreaterThanOrEqual(1);

    await cleanup();
  });

  it("failed member does NOT abort the team (peer-team semantics)", async () => {
    const { ctx, cleanup } = await makeCtx({
      handleOpts: [
        { result: successResult("a") },
        { result: failureResult("b-broke") },
        { result: successResult("c") },
      ],
    });
    const spec = peerSpec([
      member("a", "p"),
      member("b", "p"),
      member("c", "p"),
    ]);

    const summary = await new PeerTeamTopology().run(spec, ctx);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);
    // team_completed should still have fired (not team_aborted).
    const emit = ctx.host.emit as unknown as ReturnType<typeof vi.fn>;
    const completedCalls = emit.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === "team_completed",
    );
    const abortedCalls = emit.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === "team_aborted",
    );
    expect(completedCalls.length).toBe(1);
    expect(abortedCalls.length).toBe(0);
    // Aggregate over surviving outputs.
    expect(summary.aggregateOutput).toBe("a\n\nc");

    await cleanup();
  });

  it("rejects a spec with empty members array", async () => {
    const { ctx, cleanup } = await makeCtx({ handleOpts: [] });
    const spec = {
      name: "empty",
      topology: "peer-team" as const,
      members: [] as const,
      coordination: { completion: { kind: "all" as const } },
    } as unknown as TeamSpec;

    await expect(new PeerTeamTopology().run(spec, ctx)).rejects.toThrow(
      /members is empty/,
    );

    await cleanup();
  });

  it("treats a pre-aborted signal as 'cancel everyone' without spawning", async () => {
    const abortController = new AbortController();
    abortController.abort();

    const { ctx, harness, cleanup } = await makeCtx({
      handleOpts: [
        { result: successResult("nope-1") },
        { result: successResult("nope-2") },
      ],
      abort: abortController.signal,
    });
    const spec = peerSpec([member("a", "p"), member("b", "p")]);

    const summary = await new PeerTeamTopology().run(spec, ctx);
    expect(harness.spawns).toHaveLength(0);
    expect(summary.cancelled).toBe(2);
    expect(summary.succeeded).toBe(0);

    // team_aborted should have fired.
    const emit = ctx.host.emit as unknown as ReturnType<typeof vi.fn>;
    const abortedCalls = emit.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === "team_aborted",
    );
    expect(abortedCalls.length).toBe(1);

    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// v0.7 stage 7C — auto-merge member streams
// ---------------------------------------------------------------------------

describe("PeerTeamTopology — coordination.mergeStreams (v0.7 stage 7C)", () => {
  it("does nothing when spec.coordination.mergeStreams is unset (no calls)", async () => {
    const { ctx, harness, cleanup } = await makeCtx({
      handleOpts: [{ result: successResult("ok-a") }, { result: successResult("ok-b") }],
    });
    const spec = peerSpec([member("a", "p"), member("b", "p")]);
    await new PeerTeamTopology().run(spec, ctx);
    expect(harness.host.streamIdFor).not.toHaveBeenCalled();
    expect(harness.host.mergeStreamForAgent).not.toHaveBeenCalled();
    await cleanup();
  });

  it("calls mergeStreamForAgent for each member that has a stream", async () => {
    const streams = new Map<string, string>([
      ["agent-1", "s-1"],
      ["agent-2", "s-2"],
    ]);
    const merges: Array<{ agentId: string; targetStream: string }> = [];
    const { ctx, harness, cleanup } = await makeCtx({
      handleOpts: [{ result: successResult("ok-a") }, { result: successResult("ok-b") }],
      hostExtras: {
        streamIdFor: (id) => streams.get(id),
        mergeStreamForAgent: async (agentId, opts) => {
          merges.push({ agentId, targetStream: opts.targetStream });
          return { success: true, newHead: `merged-${agentId}` };
        },
      },
    });
    const spec = peerSpec(
      [member("a", "p"), member("b", "p")],
      {
        completion: { kind: "all" },
        mergeStreams: { targetStream: "main" },
      },
    );
    await new PeerTeamTopology().run(spec, ctx);
    expect(merges).toEqual([
      { agentId: "agent-1", targetStream: "main" },
      { agentId: "agent-2", targetStream: "main" },
    ]);
    void harness;
    await cleanup();
  });

  it("skips members with no recorded stream (streamIdFor returns undefined)", async () => {
    const merges: Array<string> = [];
    const { ctx, cleanup } = await makeCtx({
      handleOpts: [{ result: successResult("ok-a") }, { result: successResult("ok-b") }],
      hostExtras: {
        streamIdFor: (id) => (id === ("agent-1" as AgentId) ? "s-1" : undefined),
        mergeStreamForAgent: async (id) => {
          merges.push(id);
          return { success: true };
        },
      },
    });
    const spec = peerSpec(
      [member("a", "p"), member("b", "p")],
      { completion: { kind: "all" }, mergeStreams: { targetStream: "main" } },
    );
    await new PeerTeamTopology().run(spec, ctx);
    expect(merges).toEqual(["agent-1"]);
    await cleanup();
  });

  it("emits team_note on merge failure but does not throw by default", async () => {
    const { ctx, cleanup } = await makeCtx({
      handleOpts: [{ result: successResult("ok-a") }],
      hostExtras: {
        streamIdFor: () => "s-x",
        mergeStreamForAgent: async () => ({
          success: false,
          errorType: "conflict",
          conflicts: ["src/foo.ts"],
        }),
      },
    });
    const spec = peerSpec(
      [member("a", "p")],
      { completion: { kind: "all" }, mergeStreams: { targetStream: "main" } },
    );
    const summary = await new PeerTeamTopology().run(spec, ctx);
    const emit = ctx.host.emit as unknown as ReturnType<typeof vi.fn>;
    const notes = emit.mock.calls
      .map((c) => c[0] as { type: string; payload?: { note?: string } })
      .filter((e) => e.type === "team_note");
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes[0]?.payload?.note).toMatch(/conflict on src\/foo\.ts/);
    expect(summary.succeeded).toBe(1); // topology still succeeded
    await cleanup();
  });

  it("throws (team_aborted) when failOnConflict is true and merge fails", async () => {
    const { ctx, cleanup } = await makeCtx({
      handleOpts: [{ result: successResult("ok-a") }],
      hostExtras: {
        streamIdFor: () => "s-x",
        mergeStreamForAgent: async () => ({
          success: false,
          errorType: "conflict",
          conflicts: ["src/foo.ts"],
        }),
      },
    });
    const spec = peerSpec(
      [member("a", "p")],
      {
        completion: { kind: "all" },
        mergeStreams: { targetStream: "main", failOnConflict: true },
      },
    );
    await expect(new PeerTeamTopology().run(spec, ctx)).rejects.toThrow(
      /mergeStream failed/,
    );
    const emit = ctx.host.emit as unknown as ReturnType<typeof vi.fn>;
    const aborted = emit.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === "team_aborted",
    );
    expect(aborted).toHaveLength(1);
    await cleanup();
  });

  // ----- docs/44 P1 — conflict-recovery dispatch -------------------------

  function conflictCtx() {
    return makeCtx({
      handleOpts: [{ result: successResult("ok-a") }],
      hostExtras: {
        streamIdFor: () => "s-x",
        mergeStreamForAgent: async () => ({
          success: false,
          errorType: "conflict",
          conflicts: ["src/foo.ts"],
        }),
      },
    });
  }

  function teamNotes(ctx: { host: { emit: unknown } }): string[] {
    const emit = ctx.host.emit as unknown as ReturnType<typeof vi.fn>;
    return emit.mock.calls
      .map((c) => c[0] as { type: string; payload?: { note?: string } })
      .filter((e) => e.type === "team_note")
      .map((e) => e.payload?.note ?? "");
  }

  it("P1 — dispatches the team-default recovery strategy (escalate)", async () => {
    const { ctx, cleanup } = await conflictCtx();
    const spec = peerSpec([member("a", "p")], {
      completion: { kind: "all" },
      mergeStreams: { targetStream: "main" },
      conflictRecovery: { defaultStrategy: "escalate" },
    });
    const summary = await new PeerTeamTopology().run(spec, ctx);
    const notes = teamNotes(ctx);
    // Original failure note is still emitted first (behavior preserved).
    expect(notes[0]).toMatch(/conflict on src\/foo\.ts/);
    expect(notes.some((n) => /conflict recovery \[escalate\]/.test(n))).toBe(true);
    expect(notes.some((n) => /escalated to human/.test(n))).toBe(true);
    expect(summary.succeeded).toBe(1); // escalate is non-fatal without failOnConflict
    await cleanup();
  });

  it("P1 — member.onConflict overrides the team default", async () => {
    const { ctx, cleanup } = await conflictCtx();
    const spec = peerSpec(
      [{ ...member("a", "p"), onConflict: "abandon" }],
      {
        completion: { kind: "all" },
        mergeStreams: { targetStream: "main" },
        conflictRecovery: { defaultStrategy: "escalate" },
      },
    );
    await new PeerTeamTopology().run(spec, ctx);
    const notes = teamNotes(ctx);
    expect(notes.some((n) => /conflict recovery \[abandon\]/.test(n))).toBe(true);
    expect(notes.some((n) => /abandoned s-x/.test(n))).toBe(true);
    await cleanup();
  });

  it("P1 — failOnConflict still throws when recovery does not resolve", async () => {
    const { ctx, cleanup } = await conflictCtx();
    const spec = peerSpec([member("a", "p")], {
      completion: { kind: "all" },
      mergeStreams: { targetStream: "main", failOnConflict: true },
      conflictRecovery: { defaultStrategy: "escalate" },
    });
    await expect(new PeerTeamTopology().run(spec, ctx)).rejects.toThrow(
      /mergeStream failed/,
    );
    await cleanup();
  });

  // ----- Track-A hardening — recovery wiring regressions -----------------

  /** A recovery strategy that records each ConflictContext it sees. */
  function capturingRegistry(): {
    registry: RecoveryRegistry;
    seen: ConflictContext[];
  } {
    const seen: ConflictContext[] = [];
    const registry = new RecoveryRegistry();
    registry.register({
      name: "capture",
      mode: "sync",
      async recover(ctx: ConflictContext): Promise<ConflictResolution> {
        seen.push(ctx);
        return { kind: "deferred", reason: "captured" };
      },
    });
    return { registry, seen };
  }

  it("hardening — a per-member null land() skips that member, not the cohort", async () => {
    // Both members have streams, but the adapter can't merge (returns null).
    // The loop must `continue` (one skip note PER member), not `return` after
    // the first — otherwise later members are silently dropped.
    const { ctx, cleanup } = await makeCtx({
      handleOpts: [
        { result: successResult("a") },
        { result: successResult("b") },
      ],
      hostExtras: {
        streamIdFor: (id: string) => `stream-${id}`,
        mergeStreamForAgent: async () => null, // adapter declines every member
      },
    });
    const spec = peerSpec(
      [member("a", "pa"), member("b", "pb")],
      { completion: { kind: "all" }, mergeStreams: { targetStream: "main" } },
    );
    await new PeerTeamTopology().run(spec, ctx);
    const skipNotes = teamNotes(ctx).filter((n) =>
      /requires a stream-aware adapter; skipping merge/.test(n),
    );
    expect(skipNotes).toHaveLength(2); // one per member — proves no early return
    await cleanup();
  });

  it("hardening — each recovery invocation gets a UNIQUE conflictId", async () => {
    const { registry, seen } = capturingRegistry();
    const { ctx, cleanup } = await makeCtx({
      handleOpts: [
        { result: successResult("a") },
        { result: successResult("b") },
      ],
      hostExtras: {
        // Same streamId for both so the OLD `agentId:streamId` scheme would
        // still differ by agentId — use a constant stream to isolate the test
        // on the random suffix: distinct agentIds + constant stream.
        streamIdFor: () => "s-shared",
        mergeStreamForAgent: async () => ({
          success: false,
          errorType: "conflict",
          conflicts: ["src/foo.ts"],
        }),
      },
    });
    (ctx as { recoveryRegistry?: RecoveryRegistry }).recoveryRegistry = registry;
    const spec = peerSpec([member("a", "pa"), member("b", "pb")], {
      completion: { kind: "all" },
      mergeStreams: { targetStream: "main" },
      conflictRecovery: { defaultStrategy: "capture" },
    });
    await new PeerTeamTopology().run(spec, ctx);
    expect(seen).toHaveLength(2);
    const ids = seen.map((c) => c.conflictId);
    expect(new Set(ids).size).toBe(2); // unique despite shared streamId
    for (const id of ids) expect(id).toMatch(/-/); // carries a uuid suffix
    await cleanup();
  });

  it("hardening — conflictRecovery.maxRecoveryDepth folds into strategyConfig", async () => {
    const { registry, seen } = capturingRegistry();
    const { ctx, cleanup } = await makeCtx({
      handleOpts: [{ result: successResult("a") }],
      hostExtras: {
        streamIdFor: () => "s-x",
        mergeStreamForAgent: async () => ({
          success: false,
          errorType: "conflict",
          conflicts: ["src/foo.ts"],
        }),
      },
    });
    (ctx as { recoveryRegistry?: RecoveryRegistry }).recoveryRegistry = registry;
    const spec = peerSpec([member("a", "p")], {
      completion: { kind: "all" },
      mergeStreams: { targetStream: "main" },
      conflictRecovery: {
        defaultStrategy: "capture",
        defaultConfig: { foo: "bar" },
        maxRecoveryDepth: 7, // sibling key — must reach the strategy
      },
    });
    await new PeerTeamTopology().run(spec, ctx);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.strategyConfig).toMatchObject({
      foo: "bar",
      maxRecoveryDepth: 7,
    });
    await cleanup();
  });

  // ----- docs/44 P3 — cascade auto-rebase --------------------------------

  it("P3 — fires one coalesced cascade after stream merges into the target", async () => {
    const cascadeRebase = vi.fn(async () => ({
      success: true,
      rebased: [{ streamId: "dep" }],
    }));
    const { ctx, cleanup } = await makeCtx({
      handleOpts: [
        { result: successResult("a") },
        { result: successResult("b") },
      ],
      hostExtras: {
        streamIdFor: (id: string) => `stream-${id}`,
        mergeStreamForAgent: async () => ({ success: true, newHead: "h" }),
        cascadeRebase,
      },
    });
    const spec = peerSpec(
      [
        { ...member("a", "p"), onParentAdvanced: "sync" as const },
        { ...member("b", "p"), onParentAdvanced: "sync" as const },
      ],
      { completion: { kind: "all" }, mergeStreams: { targetStream: "team-root" } },
    );
    await new PeerTeamTopology().run(spec, ctx);
    // Both members merged into the same target → coalesced to ONE cascade.
    expect(cascadeRebase).toHaveBeenCalledTimes(1);
    expect(cascadeRebase).toHaveBeenCalledWith(
      expect.objectContaining({
        rootStream: "team-root",
        strategy: "defer_conflicts",
      }),
    );
    await cleanup();
  });

  it("P3 — no cascade when no member opts into onParentAdvanced", async () => {
    const cascadeRebase = vi.fn(async () => ({ success: true, rebased: [] }));
    const { ctx, cleanup } = await makeCtx({
      handleOpts: [{ result: successResult("a") }],
      hostExtras: {
        streamIdFor: (id: string) => `stream-${id}`,
        mergeStreamForAgent: async () => ({ success: true }),
        cascadeRebase,
      },
    });
    const spec = peerSpec([member("a", "p")], {
      completion: { kind: "all" },
      mergeStreams: { targetStream: "team-root" },
    });
    await new PeerTeamTopology().run(spec, ctx);
    expect(cascadeRebase).not.toHaveBeenCalled();
    await cleanup();
  });

  it("v0.7 stage 7D — applies default {kind:'stream'} when host supports streams and member has no policy", async () => {
    const captured: SpawnRequest[] = [];
    const harness = await makeCtx({
      handleOpts: [{ result: successResult("ok") }],
      hostExtras: { supportsStreams: () => true },
    });
    // Wrap the host's spawn to record the SpawnRequest's branchPolicy.
    const origSpawn = harness.harness.host.spawn.bind(harness.harness.host);
    (harness.harness.host as unknown as { spawn: typeof origSpawn }).spawn = (
      req: SpawnRequest,
    ) => {
      captured.push(req);
      return origSpawn(req);
    };

    // Member with NO branchPolicy at all (overrides the default `{kind: "none"}`
    // applied by the local `member()` helper).
    const m: MemberSpec = { id: "a", role: "worker", prompt: "p" };
    const s = peerSpec([m], { completion: { kind: "all" } });

    await new PeerTeamTopology().run(s, harness.ctx);
    expect(captured[0]?.task.branchPolicy).toEqual({ kind: "stream" });
    await harness.cleanup();
  });

  it("v0.7 stage 7D — does NOT rewrite when host doesn't support streams", async () => {
    const captured: SpawnRequest[] = [];
    const harness = await makeCtx({
      handleOpts: [{ result: successResult("ok") }],
      hostExtras: { supportsStreams: () => false },
    });
    const origSpawn = harness.harness.host.spawn.bind(harness.harness.host);
    (harness.harness.host as unknown as { spawn: typeof origSpawn }).spawn = (
      req: SpawnRequest,
    ) => {
      captured.push(req);
      return origSpawn(req);
    };
    const m: MemberSpec = { id: "a", role: "worker", prompt: "p" };
    const s = peerSpec([m], { completion: { kind: "all" } });
    await new PeerTeamTopology().run(s, harness.ctx);
    // member() helper applies {kind:"none"} — but here we used a bare m.
    // TeamSession's own default kicks in: {kind:"none"}.
    expect(captured[0]?.task.branchPolicy).toEqual({ kind: "none" });
    await harness.cleanup();
  });

  it("v0.7 stage 7F — targetBranch routes through mergeStreamToBranchForAgent", async () => {
    const calls: Array<{ agentId: string; targetBranch: string }> = [];
    const { ctx, cleanup } = await makeCtx({
      handleOpts: [{ result: successResult("ok") }],
      hostExtras: {
        streamIdFor: () => "s-A",
        mergeStreamToBranchForAgent: async (agentId, opts) => {
          calls.push({ agentId, targetBranch: opts.targetBranch });
          return { success: true };
        },
        // mergeStreamForAgent should NOT be called on this path
        mergeStreamForAgent: async () => {
          throw new Error("targetBranch path must not call mergeStreamForAgent");
        },
      },
    });
    const spec = peerSpec(
      [member("a", "p")],
      { completion: { kind: "all" }, mergeStreams: { targetBranch: "main" } },
    );
    await new PeerTeamTopology().run(spec, ctx);
    expect(calls).toEqual([{ agentId: "agent-1", targetBranch: "main" }]);
    await cleanup();
  });

  it("v0.7 stage 7F — emits team_note + skips merge when adapter has no targetBranch support", async () => {
    const { ctx, cleanup } = await makeCtx({
      handleOpts: [{ result: successResult("ok") }],
      hostExtras: {
        streamIdFor: () => "s-A",
        // mergeStreamToBranchForAgent defaults to async () => null
      },
    });
    const spec = peerSpec(
      [member("a", "p")],
      { completion: { kind: "all" }, mergeStreams: { targetBranch: "main" } },
    );
    await new PeerTeamTopology().run(spec, ctx);
    const emit = ctx.host.emit as unknown as ReturnType<typeof vi.fn>;
    const notes = emit.mock.calls
      .map((c) => c[0] as { type: string; payload?: { note?: string } })
      .filter((e) => e.type === "team_note");
    expect(notes.some((n) => n.payload?.note?.includes("targetBranch=main"))).toBe(true);
    await cleanup();
  });

  it("forwards strategy when configured", async () => {
    const captured: Array<{ targetStream: string; strategy?: string }> = [];
    const { ctx, cleanup } = await makeCtx({
      handleOpts: [{ result: successResult("ok-a") }],
      hostExtras: {
        streamIdFor: () => "s-x",
        mergeStreamForAgent: async (_id, opts) => {
          captured.push({ ...opts });
          return { success: true };
        },
      },
    });
    const spec = peerSpec(
      [member("a", "p")],
      {
        completion: { kind: "all" },
        mergeStreams: { targetStream: "main", strategy: "no-ff" },
      },
    );
    await new PeerTeamTopology().run(spec, ctx);
    expect(captured).toEqual([{ targetStream: "main", strategy: "no-ff" }]);
    await cleanup();
  });
});
