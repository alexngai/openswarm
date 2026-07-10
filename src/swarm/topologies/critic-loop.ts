/**
 * CriticLoopTopology — executor + critic loop until critic emits an
 * approval signal.
 *
 * docs/25 §8.6: 2 peers — executor runs the task, critic reviews. If the
 * critic's reply contains the configured approval signal (default
 * "APPROVED"), the loop terminates and the executor's last output is the
 * team result. Otherwise the critic's reply becomes feedback context for
 * the next executor iteration. Loops up to MAX_ITERATIONS (default 10;
 * override via coordination.criticMaxIterations — the `advisor` arm ≈3).
 *
 * Failure semantics (docs/25 §9.5):
 *  - Executor failure → team fails immediately.
 *  - Critic failure → executor's last successful output is taken.
 */

import type { TeamSpec, MemberSpec } from "../team-spec.js";
import type { AgentHandle, AgentResult } from "../host.js";
import { TeamSession } from "../team-session.js";
import { parsePytestPassRate } from "../escalation-evaluator.js";
import { captureWorkspaceDiff, diffBlock } from "../handoff.js";
import type {
  Topology,
  TopologyContext,
  TeamResult,
} from "../topologies-types.js";

const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_SIGNAL = "APPROVED";

export class CriticLoopTopology implements Topology {
  readonly name = "critic-loop" as const;

  async run(spec: TeamSpec, ctx: TopologyContext): Promise<TeamResult> {
    if (spec.members.length !== 2) {
      throw new Error(
        `CriticLoopTopology: requires exactly 2 members (executor + critic); got ${spec.members.length}`,
      );
    }
    // v0.7 stage 7J — default the executor (member 0) to {kind:"stream"} when
    // the host has a stream-aware adapter. Critic stays on its own
    // branchPolicy (default {kind:"none"} — read-only review). Spec
    // overrides win.
    const applyExecDefault =
      (ctx.host.supportsStreams?.() ?? false) &&
      spec.coordination.defaultBranchPolicy === undefined &&
      spec.members[0]!.branchPolicy === undefined;
    const executorSpec = applyExecDefault
      ? { ...spec.members[0]!, branchPolicy: { kind: "stream" as const } }
      : spec.members[0]!;
    const criticSpec = spec.members[1]!;

    const team = new TeamSession({
      name: spec.name,
      host: ctx.host,
      permissionMode: ctx.permissionMode,
    });

    const signal =
      spec.coordination.completion.kind === "until_signal"
        ? spec.coordination.completion.signal
        : DEFAULT_SIGNAL;
    const maxIterations =
      spec.coordination.criticMaxIterations ?? DEFAULT_MAX_ITERATIONS;

    ctx.host.emit({
      type: "team_started",
      payload: {
        teamName: spec.name,
        scope: team.scope,
        topology: "critic-loop",
        memberCount: 2,
      },
    });

    if (ctx.abort?.aborted) {
      ctx.host.emit({
        type: "team_aborted",
        payload: {
          teamName: spec.name,
          scope: team.scope,
          memberResults: 0,
        },
      });
      await team.dispose();
      return {
        succeeded: 0,
        failed: 0,
        timeout: 0,
        cancelled: 2,
        resultWriteFailures: 0,
        deadLetterViolation: false,
        deadLetterWriteFailures: 0,
      };
    }

    let executorOutput: string | undefined;
    let approved = false;
    let lastFeedback: string | undefined;
    let executorFailed = false;
    let iterations = 0;
    let totalSucceeded = 0;
    let totalFailed = 0;

    // docs/52 Phase B ①a — resident mode keeps both members alive (`longLived`) and drives
    // their next turn via `runMore`, so context accumulates across rounds (the critic
    // remembers its prior feedback). Cold spawn (default) re-spawns fresh each round. Refs
    // hold the live handle; a `runMore` failure falls back to a cold spawn for that round.
    const resident = spec.coordination.residentDialogue === true;
    const execRef: { h: AgentHandle | undefined } = { h: undefined };
    const critRef: { h: AgentHandle | undefined } = { h: undefined };
    const runTurn = async (
      ref: { h: AgentHandle | undefined },
      member: MemberSpec,
      prompt: string,
    ): Promise<AgentResult> => {
      if (resident && ref.h !== undefined) {
        try {
          return await ref.h.runMore(prompt);
        } catch {
          ref.h = undefined; // worker died → cold-spawn fallback below
        }
      }
      ref.h = await team.spawnMember(
        resident ? { ...member, prompt, longLived: true } : { ...member, prompt },
      );
      return ref.h.wait();
    };

    try {
      while (iterations < maxIterations && !approved) {
        iterations++;

        // ---- Executor turn ----
        // Resident continuation gets just the new feedback (it remembers the task + its work);
        // a cold/first turn gets the full task (+ feedback appended).
        const executorPrompt =
          resident && execRef.h !== undefined
            ? `## Feedback from critic (iteration ${iterations - 1})\n\n${lastFeedback ?? ""}\n\nRevise your fix accordingly; verify before finishing.`
            : lastFeedback === undefined
              ? executorSpec.prompt
              : `${executorSpec.prompt}\n\n## Feedback from critic (iteration ${iterations - 1})\n\n${lastFeedback}`;
        const executorResult = await runTurn(execRef, executorSpec, executorPrompt);

        if (executorResult.status === "success") {
          executorOutput = executorResult.output;
          totalSucceeded++;
        } else {
          // Executor failure halts the loop (per §9.5).
          executorFailed = true;
          totalFailed++;
          break;
        }

        // ---- Stop-on-green (docs/50 §10.4) ----
        // If a visible-correctness command passes, APPROVE and stop before the critic can
        // push a passing fix into a regression (the django-12708 failure). The critic then
        // only runs when the fix is RED — advise-when-needed, which also cuts its cost.
        const greenCommand = spec.coordination.greenCommand;
        let redCheckOutput: string | undefined;
        if (greenCommand !== undefined && ctx.escalation?.exec !== undefined) {
          const gr = await ctx.escalation.exec(greenCommand).catch(() => undefined);
          const passRate = gr !== undefined ? parsePytestPassRate(gr) : 0;
          if (gr !== undefined && passRate >= (spec.coordination.greenThreshold ?? 1)) {
            approved = true;
            ctx.host.emit({
              type: "team_note",
              payload: {
                teamName: spec.name,
                scope: team.scope,
                note: `critic-loop approved on green (pass-rate ${passRate.toFixed(2)}) after iteration ${iterations}`,
              },
            });
            break; // skip the critic; no more rounds → the green state is final
          }
          // Red: keep the failing-check output for the critic (docs/52 — free, already run).
          if (gr !== undefined) redCheckOutput = `${gr.stdout}\n${gr.stderr}`.trim().slice(-1500);
        }

        // ---- Critic turn (docs/52 Phase A: review the real diff, not a prose summary) ----
        const diff = await captureWorkspaceDiff(ctx.escalation?.exec);
        const reviewContent =
          `## The change under review (git diff)\n${diffBlock(diff)}\n\n` +
          (redCheckOutput !== undefined ? `## Failing check output\n\`\`\`\n${redCheckOutput}\n\`\`\`\n\n` : "") +
          `## Executor's own summary (iteration ${iterations})\n${executorOutput}\n\n` +
          `Review the DIFF above against the repository. Reply with the literal text "${signal}" ` +
          `if the fix is correct and complete; otherwise give concrete, actionable feedback the executor can act on.`;
        // Resident continuation omits the role preamble (the critic already holds it +
        // its prior reviews in-context); a cold/first turn prepends the role instruction.
        const criticPrompt =
          resident && critRef.h !== undefined ? reviewContent : `${criticSpec.prompt}\n\n${reviewContent}`;
        const criticResult = await runTurn(critRef, criticSpec, criticPrompt);

        if (criticResult.status !== "success") {
          // Critic failure: take executor's last output (per §9.5).
          totalFailed++;
          break;
        }
        totalSucceeded++;

        if (hasApprovalSignal(criticResult.output, signal)) {
          approved = true;
          // team_signal_received doesn't exist as a typed event yet —
          // emit a team_note so the signal acknowledgement still surfaces
          // on the lane-event stream + events.jsonl.
          ctx.host.emit({
            type: "team_note",
            payload: {
              teamName: spec.name,
              scope: team.scope,
              note: `critic-loop signal "${signal}" received from ${critRef.h?.agentId ?? "critic"} after iteration ${iterations}`,
            },
          });
        } else {
          lastFeedback = criticResult.output;
        }
      }

      ctx.host.emit({
        type: "team_completed",
        payload: {
          teamName: spec.name,
          scope: team.scope,
          completion: spec.coordination.completion.kind,
          memberResults: totalSucceeded + totalFailed,
        },
      });
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

    // Outcome counts: succeeded = number of approved iterations (1 if
    // approved, else 0). failed reflects either executor failure or
    // exhaustion without approval.
    const succeeded = approved ? 1 : 0;
    const failed = approved ? 0 : 1;
    void executorFailed;

    return {
      succeeded,
      failed,
      timeout: 0,
      cancelled: 0,
      resultWriteFailures: 0,
      deadLetterViolation: false,
      deadLetterWriteFailures: 0,
      ...(executorOutput !== undefined && { aggregateOutput: executorOutput }),
    };
  }
}

const NEGATORS = new Set([
  "not", "no", "never", "cannot", "can't", "isn't", "aren't", "don't",
  "doesn't", "won't", "wouldn't", "without", "n't",
]);

/**
 * True iff `signal` appears in `output` as a standalone token that is NOT immediately
 * negated. Plain `output.includes(signal)` mis-reads a critic's "NOT APPROVED" as
 * approval (the signal is a substring), silently ending the loop on a rejected fix.
 * Case-sensitive: the critic is told to emit the literal signal (docs/50 §10.4).
 */
export function hasApprovalSignal(output: string, signal: string): boolean {
  const esc = signal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const m of output.matchAll(new RegExp(`\\b${esc}\\b`, "g"))) {
    // Scan only the clause leading up to this occurrence — bounded by the last sentence
    // or line break — so "cannot be APPROVED" is caught but "…could not read it. APPROVED"
    // (negator in a prior sentence) still approves.
    const before = output.slice(0, m.index).toLowerCase();
    const bound = Math.max(
      before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"),
      before.lastIndexOf("\n"), before.lastIndexOf(":"), before.lastIndexOf(";"),
    );
    const words = before.slice(bound + 1).match(/[a-z']+/g) ?? [];
    if (!words.some((w) => NEGATORS.has(w))) return true; // un-negated occurrence in its clause
  }
  return false;
}
