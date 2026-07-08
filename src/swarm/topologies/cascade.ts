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
 * Confidence (v1) is SELF-REPORTED via a sentinel the tier is asked to emit:
 * `CASCADE_SOLVED` (⇒ 1) or `CASCADE_CONFIDENCE: <0..1>`. A hard failure (non-success
 * status) reads as confidence 0 and always escalates. The principled graded signal —
 * an in-loop test pass-rate / cross-validation verdict (docs/50 §9.3) — is a future
 * evaluator that replaces `parseConfidence`; the self-report keeps this runnable and
 * unit-testable today. Prior (cheaper) attempts are threaded into each escalated
 * tier's prompt as an improvement preamble.
 *
 * Failure semantics mirror the other topologies: an accepted tier that hard-failed
 * counts as a team failure; escalations themselves are the cascade working, not
 * failures.
 */

import type { TeamSpec, MemberSpec } from "../team-spec.js";
import { TeamSession } from "../team-session.js";
import type { Topology, TopologyContext, TeamResult } from "../topologies-types.js";
import { runCascade, type CascadeTier } from "../escalation-gate.js";

/** Default τ: escalate unless a tier reports full confidence (`CASCADE_SOLVED`). */
const DEFAULT_TAU = 1;

const SIGNAL_INSTRUCTIONS =
  "When you have fully solved AND verified the task, end your reply with the line " +
  "`CASCADE_SOLVED`. If you could not fully solve it, instead end with " +
  "`CASCADE_CONFIDENCE: <0-1>` estimating how complete your solution is (lower = " +
  "please escalate to a stronger model).";

/** Derive a confidence in [0,1] and a hard-failure flag from a tier's result. */
export function parseConfidence(
  output: string,
  status: string,
): { confidence: number; failed: boolean } {
  if (status !== "success") return { confidence: 0, failed: true };
  const m = /CASCADE_CONFIDENCE:\s*([0-9]*\.?[0-9]+)/i.exec(output);
  if (m !== null) {
    const v = Number(m[1]);
    const confidence = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
    return { confidence, failed: false };
  }
  if (/CASCADE_SOLVED/i.test(output)) return { confidence: 1, failed: false };
  // No clear signal ⇒ treat as low confidence so an ungated attempt escalates.
  return { confidence: 0, failed: false };
}

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
    try {
      const run = await runCascade<MemberSpec, string>(tiers, { tau }, async (tier, cctx) => {
        const prior = cctx.priorAttempts[cctx.priorAttempts.length - 1];
        const base = tier.payload.prompt;
        const prompt =
          prior === undefined
            ? `${base}\n\n${SIGNAL_INSTRUCTIONS}`
            : `${base}\n\n## A cheaper tier attempted this and was not accepted:\n\n` +
              `${prior.outcome.value}\n\nImprove on it and fully resolve the task.\n\n${SIGNAL_INSTRUCTIONS}`;
        const handle = await team.spawnMember({ ...tier.payload, prompt });
        spawnCount++;
        const result = await handle.wait();
        const output = result.status === "success" ? result.output ?? "" : "";
        const { confidence, failed } = parseConfidence(output, result.status);
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
