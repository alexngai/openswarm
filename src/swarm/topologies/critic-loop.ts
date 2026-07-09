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

import type { TeamSpec } from "../team-spec.js";
import { TeamSession } from "../team-session.js";
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

    try {
      while (iterations < maxIterations && !approved) {
        iterations++;

        // ---- Executor turn ----
        const executorPrompt =
          lastFeedback === undefined
            ? executorSpec.prompt
            : `${executorSpec.prompt}\n\n## Feedback from critic (iteration ${iterations - 1})\n\n${lastFeedback}`;
        const executorHandle = await team.spawnMember({
          ...executorSpec,
          prompt: executorPrompt,
        });
        const executorResult = await executorHandle.wait();

        if (executorResult.status === "success") {
          executorOutput = executorResult.output;
          totalSucceeded++;
        } else {
          // Executor failure halts the loop (per §9.5).
          executorFailed = true;
          totalFailed++;
          break;
        }

        // ---- Critic turn ----
        const criticPrompt =
          `${criticSpec.prompt}\n\n## Executor output (iteration ${iterations})\n\n${executorOutput}\n\n` +
          `Reply with the literal text "${signal}" if you approve. Otherwise provide concrete feedback the executor can act on.`;
        const criticHandle = await team.spawnMember({
          ...criticSpec,
          prompt: criticPrompt,
        });
        const criticResult = await criticHandle.wait();

        if (criticResult.status !== "success") {
          // Critic failure: take executor's last output (per §9.5).
          totalFailed++;
          break;
        }
        totalSucceeded++;

        if (criticResult.output.includes(signal)) {
          approved = true;
          // team_signal_received doesn't exist as a typed event yet —
          // emit a team_note so the signal acknowledgement still surfaces
          // on the lane-event stream + events.jsonl.
          ctx.host.emit({
            type: "team_note",
            payload: {
              teamName: spec.name,
              scope: team.scope,
              note: `critic-loop signal "${signal}" received from ${criticHandle.agentId} after iteration ${iterations}`,
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
