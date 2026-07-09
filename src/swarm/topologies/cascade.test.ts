/**
 * cascade.test.ts — direct invocation of CascadeTopology (docs/50 G3).
 *
 * Fake-host harness (mirrors critic-loop.test.ts): pre-programmed AgentResults per
 * spawn drive the confidence signal. Verifies accept-on-cheap-tier, escalate-below-τ,
 * the τ-sweep, hard-failure escalation, exhaustion, the escalation preamble threading,
 * and abort/empty guards.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CascadeTopology } from "./cascade.js";
import { EvaluatorRegistry } from "../escalation-evaluator.js";
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

function makeHandle(result: AgentResult, agentId: AgentId, sessionId: SessionId): AgentHandle {
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
    const result = results[i] ?? { status: "failure", error: "no result configured", wallClockMs: 0 };
    const handle = makeHandle(result, `agent-${i + 1}` as AgentId, `session-${i + 1}` as SessionId);
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

function member(id: string, prompt: string, model?: string): MemberSpec {
  return {
    id,
    role: "worker",
    prompt,
    branchPolicy: { kind: "none" },
    commitPolicy: { kind: "none" },
    escalationPolicy: { kind: "none" },
    ...(model !== undefined && { model }),
  };
}

function cascadeSpec(
  members: readonly MemberSpec[],
  escalationTau?: number,
  escalationEvaluator?: string,
): TeamSpec {
  return {
    name: "cascade-test",
    topology: "cascade",
    members,
    coordination: {
      completion: { kind: "until_signal", signal: "DONE" },
      ...(escalationTau !== undefined && { escalationTau }),
      ...(escalationEvaluator !== undefined && { escalationEvaluator }),
    },
  };
}

async function makeCtx(
  results: readonly AgentResult[],
  opts: { aborted?: boolean; escalation?: TopologyContext["escalation"] } = {},
): Promise<{ ctx: TopologyContext; harness: Harness; cleanup: () => Promise<void> }> {
  const harness = fakeHost(results);
  const pool = new WorkerPool(8);
  const tmp = await mkdtemp(join(tmpdir(), "cascade-"));
  const deadLetter = new DeadLetterWriter(join(tmp, "dl.jsonl"));
  const resultsOut = new PassThrough();
  resultsOut.resume();
  const ctx: TopologyContext = {
    host: harness.host,
    pool,
    resultsOut,
    deadLetter,
    permissionMode: "workspace-write",
    ...(opts.aborted === true && { abort: AbortSignal.abort() }),
    ...(opts.escalation !== undefined && { escalation: opts.escalation }),
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

function ok(output: string): AgentResult {
  return { status: "success", output, usage: { inputTokens: 1, outputTokens: 1 }, wallClockMs: 1 };
}
function fail(error = "boom"): AgentResult {
  return { status: "failure", error, wallClockMs: 1 };
}

describe("CascadeTopology", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  it("accepts the cheap tier when it solves (no escalation, one spawn)", async () => {
    const { ctx, harness, cleanup } = await makeCtx([ok("fixed it\nCASCADE_SOLVED")]);
    cleanups.push(cleanup);
    const spec = cascadeSpec([member("8b", "solve", "qwen3-8b"), member("30b", "solve", "qwen3-30b")]);
    const result = await new CascadeTopology().run(spec, ctx);
    expect(harness.spawns).toHaveLength(1); // never escalated
    expect(result.succeeded).toBe(1);
    expect(result.aggregateOutput).toBe("fixed it\nCASCADE_SOLVED");
  });

  it("escalates when the cheap tier is below τ, threading the prior attempt", async () => {
    const { ctx, harness, cleanup } = await makeCtx([
      ok("partial\nCASCADE_CONFIDENCE: 0.3"),
      ok("done\nCASCADE_SOLVED"),
    ]);
    cleanups.push(cleanup);
    const spec = cascadeSpec([member("8b", "solve the bug"), member("30b", "solve the bug")]);
    const result = await new CascadeTopology().run(spec, ctx);
    expect(harness.spawns).toHaveLength(2);
    expect(result.succeeded).toBe(1);
    expect(result.aggregateOutput).toBe("done\nCASCADE_SOLVED");
    // escalated tier's prompt carries the improvement preamble + the cheap attempt's output
    expect(harness.spawns[1]!.prompt).toContain("A cheaper tier attempted");
    expect(harness.spawns[1]!.prompt).toContain("partial");
  });

  it("docs/52 Phase A: escalation prompt carries the cheap tier's applied diff + reason", async () => {
    const exec = async (cmd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> => ({
      exitCode: 0,
      stdout: cmd.includes("git") ? "diff --git a/src.py b/src.py\n+    return sqrt(5)" : "",
      stderr: "",
    });
    const { ctx, harness, cleanup } = await makeCtx(
      [ok("partial\nCASCADE_CONFIDENCE: 0.3"), ok("done\nCASCADE_SOLVED")],
      { escalation: { exec } },
    );
    cleanups.push(cleanup);
    const spec = cascadeSpec([member("8b", "solve the bug"), member("30b", "solve the bug")]);
    const result = await new CascadeTopology().run(spec, ctx);
    expect(harness.spawns).toHaveLength(2);
    expect(result.succeeded).toBe(1);
    const escPrompt = harness.spawns[1]!.prompt;
    expect(escPrompt).toContain("Its applied changes (git diff)");
    expect(escPrompt).toContain("diff --git a/src.py b/src.py"); // the real patch, not prose
    expect(escPrompt).toContain("Build on its work");
    expect(escPrompt).toContain("below the escalation gate"); // the reason block
  });

  it("τ-sweep: identical outputs, escalation count moves with τ", async () => {
    const results = [ok("CASCADE_CONFIDENCE: 0.5"), ok("CASCADE_SOLVED")];
    const lo = await makeCtx(results);
    cleanups.push(lo.cleanup);
    await new CascadeTopology().run(cascadeSpec([member("8b", "x"), member("30b", "x")], 0.4), lo.ctx);
    expect(lo.harness.spawns).toHaveLength(1); // 0.5 ≥ 0.4 → keep cheap

    const hi = await makeCtx(results);
    cleanups.push(hi.cleanup);
    await new CascadeTopology().run(cascadeSpec([member("8b", "x"), member("30b", "x")], 0.6), hi.ctx);
    expect(hi.harness.spawns).toHaveLength(2); // 0.5 < 0.6 → escalate
  });

  it("a hard failure escalates even at τ=0", async () => {
    const { ctx, harness, cleanup } = await makeCtx([fail("crash"), ok("recovered\nCASCADE_SOLVED")]);
    cleanups.push(cleanup);
    const result = await new CascadeTopology().run(
      cascadeSpec([member("8b", "x"), member("30b", "x")], 0),
      ctx,
    );
    expect(harness.spawns).toHaveLength(2);
    expect(result.succeeded).toBe(1);
    expect(result.aggregateOutput).toBe("recovered\nCASCADE_SOLVED");
  });

  it("exhausts to the top tier when none clear the gate", async () => {
    const { ctx, harness, cleanup } = await makeCtx([
      ok("CASCADE_CONFIDENCE: 0.2"),
      ok("best effort\nCASCADE_CONFIDENCE: 0.3"),
    ]);
    cleanups.push(cleanup);
    const result = await new CascadeTopology().run(cascadeSpec([member("8b", "x"), member("30b", "x")]), ctx);
    expect(harness.spawns).toHaveLength(2);
    expect(result.succeeded).toBe(1); // top tier ran successfully, just below τ
    expect(result.aggregateOutput).toBe("best effort\nCASCADE_CONFIDENCE: 0.3");
  });

  it("short-circuits when already aborted (no spawns)", async () => {
    const { ctx, harness, cleanup } = await makeCtx([ok("CASCADE_SOLVED")], { aborted: true });
    cleanups.push(cleanup);
    const result = await new CascadeTopology().run(cascadeSpec([member("8b", "x"), member("30b", "x")]), ctx);
    expect(harness.spawns).toHaveLength(0);
    expect(result.cancelled).toBe(2);
    expect(result.succeeded).toBe(0);
  });

  it("uses an injected benchmark evaluator's graded confidence (not the sentinel)", async () => {
    // outputs carry NO sentinel — proving the evaluator, not parseSelfReport, drives the gate
    const reg = new EvaluatorRegistry().register({ name: "graded", evaluate: () => Promise.resolve(0.5) });

    const hi = await makeCtx([ok("attempt one"), ok("attempt two")], { escalation: { registry: reg } });
    cleanups.push(hi.cleanup);
    await new CascadeTopology().run(
      cascadeSpec([member("8b", "x"), member("30b", "x")], 0.6, "graded"),
      hi.ctx,
    );
    expect(hi.harness.spawns).toHaveLength(2); // 0.5 < 0.6 → escalated

    const lo = await makeCtx([ok("attempt one"), ok("attempt two")], { escalation: { registry: reg } });
    cleanups.push(lo.cleanup);
    await new CascadeTopology().run(
      cascadeSpec([member("8b", "x"), member("30b", "x")], 0.4, "graded"),
      lo.ctx,
    );
    expect(lo.harness.spawns).toHaveLength(1); // 0.5 ≥ 0.4 → kept the cheap tier
  });

  it("rejects an empty tier list", async () => {
    const { ctx, cleanup } = await makeCtx([]);
    cleanups.push(cleanup);
    await expect(new CascadeTopology().run(cascadeSpec([]), ctx)).rejects.toThrow(/at least one member/);
  });
});
