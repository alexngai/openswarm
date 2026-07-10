/**
 * CascadeTopology — the parametric escalation cascade as a first-class topology
 * (docs/50 §6 G3).
 *
 * Members are ordered TIERS, cheapest first (each carries its own `model`, so the
 * cascade is heterogeneous by construction). The topology runs the cheapest tier,
 * reads a confidence signal from its output, and — via `runCascade` — escalates to
 * the next tier when the attempt hard-fails or its confidence is below the gate τ
 * (`coordination.escalationTau`, default 1 = escalate unless a tier signals a full
 * solve). The accepted tier's output is the team result; the escalation count is
 * emitted as a `team_note` for cost/ROI analysis (docs/50 §2).
 *
 * The confidence signal is a pluggable `EscalationEvaluator`
 * (src/swarm/escalation-evaluator.ts), resolved by name from `ctx.escalation.registry`
 * via `coordination.escalationEvaluator` and defaulting to the self-report evaluator
 * (sentinel `CASCADE_SOLVED` / `CASCADE_CONFIDENCE: n`). Benchmark-specific signals —
 * a SWE pytest pass-rate, a fixit checkpoint score, a TEX cross-validation verdict
 * (docs/50 §9.3) — register their own evaluator. A hard failure (non-success status)
 * reads as confidence 0 and always escalates. Prior (cheaper) attempts are threaded
 * into each escalated tier's prompt as an improvement preamble.
 *
 * Failure semantics mirror the other topologies: an accepted tier that hard-failed
 * counts as a team failure; escalations themselves are the cascade working, not
 * failures.
 */

import type { TeamSpec, MemberSpec } from "../team-spec.js";
import { TeamSession } from "../team-session.js";
import type { Topology, TopologyContext, TeamResult } from "../topologies-types.js";
import { runCascade, type CascadeTier } from "../escalation-gate.js";
import { SelfReportEvaluator } from "../escalation-evaluator.js";
import { captureWorkspaceDiff, captureCheckOutput, diffBlock, trajectoryBlock } from "../handoff.js";

/** Default τ: escalate unless a tier reports full confidence (`CASCADE_SOLVED`). */
const DEFAULT_TAU = 1;

const SIGNAL_INSTRUCTIONS =
  "When you have fully solved AND verified the task, end your reply with the line " +
  "`CASCADE_SOLVED`. If you could not fully solve it, instead end with " +
  "`CASCADE_CONFIDENCE: <0-1>` estimating how complete your solution is (lower = " +
  "please escalate to a stronger model).";

function zeroResult(cancelled: number): TeamResult {
  return {
    succeeded: 0,
    failed: 0,
    timeout: 0,
    cancelled,
    resultWriteFailures: 0,
    deadLetterViolation: false,
    deadLetterWriteFailures: 0,
  };
}

export class CascadeTopology implements Topology {
  readonly name = "cascade" as const;

  async run(spec: TeamSpec, ctx: TopologyContext): Promise<TeamResult> {
    if (spec.members.length === 0) {
      throw new Error("CascadeTopology: requires at least one member (tier)");
    }
    const tau = spec.coordination.escalationTau ?? DEFAULT_TAU;
    // The visible checks that gate escalation — re-run (compute-only) to quote the failing
    // output into the handoff reason (docs/52 Phase B ③), only when a tier escalates.
    const checkCommands =
      spec.coordination.escalationCommands ??
      (spec.coordination.escalationCommand !== undefined ? [spec.coordination.escalationCommand] : []);
    // Benchmark-specific confidence signal, resolved by name from the injected
    // registry; falls back to the self-report sentinel when none is wired.
    const evaluator =
      ctx.escalation?.registry?.select(spec.coordination.escalationEvaluator) ??
      new SelfReportEvaluator();

    const team = new TeamSession({
      name: spec.name,
      host: ctx.host,
      permissionMode: ctx.permissionMode,
    });

    ctx.host.emit({
      type: "team_started",
      payload: {
        teamName: spec.name,
        scope: team.scope,
        topology: "cascade",
        memberCount: spec.members.length,
      },
    });

    if (ctx.abort?.aborted) {
      ctx.host.emit({
        type: "team_aborted",
        payload: { teamName: spec.name, scope: team.scope, memberResults: 0 },
      });
      await team.dispose();
      return zeroResult(spec.members.length);
    }

    const tiers: CascadeTier<MemberSpec>[] = spec.members.map((m, i) => ({
      id: m.id ?? `tier-${i}`,
      payload: m,
    }));

    let spawnCount = 0;
    // docs/52 Phase A — per-tier handoff record ({diff, reason}) captured after each tier
    // runs, so the NEXT tier builds on the applied change instead of a prose summary.
    const handoff: Array<{ diff?: string; reason: string; trajectory?: string[] }> = [];
    try {
      const run = await runCascade<MemberSpec, string>(tiers, { tau }, async (tier, cctx) => {
        const prior = cctx.priorAttempts[cctx.priorAttempts.length - 1];
        const priorH = cctx.index > 0 ? handoff[cctx.index - 1] : undefined;
        const base = tier.payload.prompt;
        const prompt =
          prior === undefined
            ? `${base}\n\n${SIGNAL_INSTRUCTIONS}`
            : `${base}\n\n` +
              `## A cheaper tier attempted this and was rejected. Build on its work — do not restart from scratch; its changes are already applied to the workspace.\n\n` +
              `### Its applied changes (git diff)\n${diffBlock(priorH?.diff)}\n\n` +
              `### What it tried\n${trajectoryBlock(priorH?.trajectory)}\n\n` +
              `### Why it was rejected\n${priorH?.reason ?? "its confidence was below the escalation gate."}\n\n` +
              `### Its own summary\n${prior.outcome.value || "(none)"}\n\n` +
              `Fix what's missing and fully resolve the task.\n\n${SIGNAL_INSTRUCTIONS}`;
        const handle = await team.spawnMember({ ...tier.payload, prompt });
        spawnCount++;
        // docs/52 Phase B ② — collect this tier's tool sequence off the lane bus (what it TRIED),
        // for the next tier's handoff. Filtered to this agent; unsubscribed after the turn.
        const toolTrail: string[] = [];
        const unsub = ctx.host.onLaneEvent?.((e) => {
          if (e.agentId === handle.agentId && e.type === "tool_use_start") {
            const name = (e.payload as { name?: string }).name;
            if (name !== undefined) toolTrail.push(name);
          }
        });
        const result = await handle.wait();
        unsub?.();
        const failed = result.status !== "success";
        const output = failed ? "" : result.output ?? "";
        // Evaluators grade only a tier that terminated successfully; a crash is
        // confidence 0 + failed (always escalates if a higher tier remains).
        const confidence = failed
          ? 0
          : await evaluator.evaluate({
              result,
              index: cctx.index,
              ...(ctx.escalation?.exec !== undefined && { exec: ctx.escalation.exec }),
              ...(ctx.escalation?.task !== undefined && { task: ctx.escalation.task }),
            });
        // Capture the handoff for the NEXT tier — only when this tier will actually escalate
        // (below τ / hard-fail) and a stronger tier remains, so we never re-run checks needlessly
        // (docs/52 Phase A diff + B ③ failing-check output).
        if ((failed || confidence < tau) && cctx.index < tiers.length - 1) {
          handoff[cctx.index] = {
            diff: await captureWorkspaceDiff(ctx.escalation?.exec),
            trajectory: toolTrail,
            reason: failed
              ? `The tier hard-failed (status=${result.status}) — no usable solution.`
              : `Its confidence ${confidence.toFixed(2)} was below the escalation gate τ=${tau}.` +
                (await captureCheckOutput(ctx.escalation?.exec, checkCommands)),
          };
        }
        return { confidence, value: output, failed };
      });

      ctx.host.emit({
        type: "team_note",
        payload: {
          teamName: spec.name,
          scope: team.scope,
          note:
            `cascade: accepted tier "${run.acceptedTierId}" after ${run.escalations} escalation(s); ` +
            `${run.exhausted ? "exhausted (top tier below τ)" : "cleared gate"} at τ=${tau}`,
        },
      });
      ctx.host.emit({
        type: "team_completed",
        payload: {
          teamName: spec.name,
          scope: team.scope,
          completion: spec.coordination.completion.kind,
          memberResults: spawnCount,
        },
      });

      const acceptedFailed = run.attempts[run.acceptedIndex]?.outcome.failed === true;
      return {
        succeeded: acceptedFailed ? 0 : 1,
        failed: acceptedFailed ? 1 : 0,
        timeout: 0,
        cancelled: 0,
        resultWriteFailures: 0,
        deadLetterViolation: false,
        deadLetterWriteFailures: 0,
        ...(run.value !== "" && { aggregateOutput: run.value }),
      };
    } catch (err) {
      ctx.host.emit({
        type: "team_aborted",
        payload: {
          teamName: spec.name,
          scope: team.scope,
          reason: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    } finally {
      await team.dispose();
    }
  }
}
