/**
 * PipelineTopology — sequential coordination shape.
 *
 * Each member runs in order. The previous stage's output (when status is
 * "success") is appended to the next member's prompt under a fixed
 * "## Previous stage output" heading, threading context forward through the
 * pipeline. A failed stage halts the run immediately — remaining members
 * never spawn (per docs/25 §9.5; pipeline doesn't carry per-task retry/dead-
 * letter logic, that's fanout's job).
 *
 * Aggregation: `last` (default) returns the last successful stage's output.
 * `concat` joins all successful stage outputs with a separator. `vote`,
 * `judge`, and `custom` aren't meaningful for sequential pipelines, so they
 * fall through to `last` semantics with a `team_note` lane event recording
 * the override.
 */

import type { AgentResult } from "../host.js";
import type { LaneEvent } from "../events.js";
import type { TeamSpec, MemberSpec } from "../team-spec.js";
import { TeamSession } from "../team-session.js";
import type {
  Topology,
  TopologyContext,
  TeamResult,
} from "../topologies-types.js";
import type { ResultLine } from "../orchestrator.js";

const PREV_OUTPUT_HEADER = "## Previous stage output";

export class PipelineTopology implements Topology {
  readonly name = "pipeline" as const;

  async run(spec: TeamSpec, ctx: TopologyContext): Promise<TeamResult> {
    if (spec.members.length === 0) {
      throw new Error("PipelineTopology: spec.members is empty");
    }

    const counts = { succeeded: 0, failed: 0, timeout: 0, cancelled: 0 };
    let resultWriteFailures = 0;
    let firstResultWriteError: unknown;

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
        topology: "pipeline",
        memberCount: spec.members.length,
      },
    });

    const stageResults: AgentResult[] = [];
    let prevOutput: string | undefined;
    let aborted = false;
    let halted = false;
    // v0.7 stage 7I — per-stage default branch policy. Stage 0 gets a fresh
    // stream; later stages fork from the previous stage's stream so they
    // pick up its commits. Only applied when the host adapter is stream-
    // aware AND neither member.branchPolicy nor coordination.defaultBranch
    // Policy is set (spec wins).
    const applyStageDefaults =
      (ctx.host.supportsStreams?.() ?? false) &&
      spec.coordination.defaultBranchPolicy === undefined;
    let prevAgentId: import("../../core/types.js").AgentId | undefined;

    try {
      for (let i = 0; i < spec.members.length; i++) {
        if (ctx.abort?.aborted) {
          aborted = true;
          break;
        }

        const member = spec.members[i]!;
        const stageId = member.id ?? `stage-${i + 1}`;

        // Team crash-recovery (T1): if this stage already succeeded in a prior
        // (crashed) run, replay its stored output — thread it forward and write
        // its result line — without re-spawning. A non-success prior outcome
        // never reaches here (the pipeline halts on failure, so only preceding
        // succeeded stages are checkpointed), so this cleanly resumes at the
        // first not-yet-succeeded stage.
        const priorUnit = ctx.checkpoint?.get(stageId);
        if (priorUnit?.status === "succeeded") {
          const resumedResult: AgentResult = {
            status: "success",
            output: priorUnit.output ?? "",
            usage: { inputTokens: 0, outputTokens: 0 },
            wallClockMs: 0,
          };
          stageResults.push(resumedResult);
          counts.succeeded++;
          prevOutput = priorUnit.output ?? prevOutput;
          const writeP = writeStageResult(
            ctx,
            member,
            resumedResult,
            priorUnit.agentId,
            priorUnit.sessionId,
            i,
          );
          await writeP.catch((e) => {
            firstResultWriteError ??= e;
            resultWriteFailures++;
          });
          ctx.host.emit({
            type: "team_note",
            payload: {
              teamName: spec.name,
              scope: team.scope,
              note: `stage ${stageId} skipped (resumed from checkpoint)`,
            },
          });
          continue;
        }

        // Acquire a pool slot — pipeline is sequential so only one member is
        // ever in flight. Mirrors FanoutTopology's pool acquire pattern; if
        // the pool closes mid-run (SIGINT) we treat remaining stages as
        // cancelled.
        let token;
        try {
          token = await ctx.pool.acquire();
        } catch {
          aborted = true;
          break;
        }

        if (ctx.abort?.aborted) {
          token.release();
          aborted = true;
          break;
        }

        // Build the augmented MemberSpec for this stage.
        const augmentedPrompt =
          prevOutput !== undefined
            ? `${member.prompt}\n\n${PREV_OUTPUT_HEADER}\n\n${prevOutput}`
            : member.prompt;
        let stageBranchPolicy = member.branchPolicy;
        if (applyStageDefaults && stageBranchPolicy === undefined) {
          const prevStreamId =
            prevAgentId !== undefined
              ? ctx.host.streamIdFor(prevAgentId)
              : undefined;
          stageBranchPolicy =
            prevStreamId !== undefined
              ? { kind: "fork", parentStreamId: prevStreamId }
              : { kind: "stream" };
        }
        const stageSpec: MemberSpec = {
          ...member,
          prompt: augmentedPrompt,
          ...(stageBranchPolicy !== undefined && {
            branchPolicy: stageBranchPolicy,
          }),
        };

        let handle;
        let result: AgentResult;
        const startedAt = Date.now();
        try {
          handle = await team.spawnMember(stageSpec);
          // Capture for the next stage's fork-from-prev resolution.
          prevAgentId = handle.agentId;
          result = await handle.wait();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result = {
            status: "failure",
            error: msg,
            wallClockMs: Date.now() - startedAt,
          };
        } finally {
          token.release();
        }

        stageResults.push(result);
        const writeP = writeStageResult(
          ctx,
          member,
          result,
          handle?.agentId,
          handle?.sessionId,
          i,
        );
        await writeP.catch((e) => {
          firstResultWriteError ??= e;
          resultWriteFailures++;
        });

        // Team crash-recovery (T1): record this stage's terminal outcome so a
        // restart resumes at the next stage. Best-effort; never fails the run.
        await ctx.checkpoint
          ?.record({
            id: stageId,
            status: result.status === "success" ? "succeeded" : "failed",
            agentId: handle?.agentId,
            sessionId: handle?.sessionId,
            completedAt: Date.now(),
            ...(result.status === "success" && { output: result.output }),
          })
          .catch(() => {});

        if (result.status === "success") {
          counts.succeeded++;
          prevOutput = result.output;
          continue;
        }

        // Non-success — halt pipeline (§9.5).
        switch (result.status) {
          case "failure":
            counts.failed++;
            break;
          case "timeout":
            counts.timeout++;
            break;
          case "killed":
            counts.cancelled++;
            break;
        }
        halted = true;
        break;
      }
    } finally {
      await team.dispose();
    }

    if (firstResultWriteError) {
      process.stderr.write(
        `[openswarm] ${resultWriteFailures} pipeline stage result(s) failed to persist; first error: ${String(firstResultWriteError)}\n`,
      );
    }

    if (aborted) {
      ctx.host.emit({
        type: "team_aborted",
        payload: {
          teamName: spec.name,
          scope: team.scope,
          memberResults: stageResults.length,
        },
      });
      // Remaining stages that never spawned count as cancelled.
      const remaining = spec.members.length - stageResults.length;
      counts.cancelled += remaining;
      return {
        ...counts,
        resultWriteFailures,
        deadLetterViolation: false,
        deadLetterWriteFailures: 0,
      };
    }

    // Compute aggregate output. `last` is the default; vote/judge/custom
    // aren't meaningful for a sequential pipeline so we fall through with
    // a team_note for observability.
    const aggregator = spec.coordination.aggregator ?? { kind: "last" as const };
    let aggregateOutput: string | undefined;
    switch (aggregator.kind) {
      case "last":
        aggregateOutput = prevOutput;
        break;
      case "concat": {
        const sep = aggregator.separator ?? "\n\n";
        aggregateOutput = stageResults
          .filter(
            (r): r is Extract<AgentResult, { status: "success" }> =>
              r.status === "success",
          )
          .map((r) => r.output)
          .filter((s) => s.length > 0)
          .join(sep);
        if (aggregateOutput.length === 0) aggregateOutput = undefined;
        break;
      }
      default:
        ctx.host.emit({
          type: "team_note",
          payload: {
            teamName: spec.name,
            scope: team.scope,
            note: `aggregator "${aggregator.kind}" not meaningful for pipeline; using last`,
          },
        });
        aggregateOutput = prevOutput;
        break;
    }

    ctx.host.emit({
      type: "team_completed",
      payload: {
        teamName: spec.name,
        scope: team.scope,
        completion: halted ? "halted" : "all",
        memberResults: stageResults.length,
      },
    });

    return {
      ...counts,
      resultWriteFailures,
      deadLetterViolation: false,
      deadLetterWriteFailures: 0,
      ...(aggregateOutput !== undefined && { aggregateOutput }),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write one ResultLine per pipeline stage to ctx.resultsOut. Mirrors the
 * shape of FanoutTopology.buildResultLine + writeResult so downstream
 * consumers (CLI tail, integration tests) see a uniform stream regardless
 * of topology.
 *
 * `_stageIndex` is unused today but kept in the signature so future
 * enhancements (e.g. embedding stage index in the line) don't change call
 * sites in the orchestration loop.
 */
async function writeStageResult(
  ctx: TopologyContext,
  member: MemberSpec,
  result: AgentResult,
  agentId: string | undefined,
  sessionId: string | undefined,
  _stageIndex: number,
): Promise<void> {
  const id = member.id ?? `stage-${_stageIndex + 1}`;
  const line = buildPipelineResultLine(id, result, agentId, sessionId);
  return new Promise<void>((resolve, reject) => {
    const payload = JSON.stringify(line) + "\n";
    ctx.resultsOut.write(payload, (err) => {
      if (err) {
        if (ctx.eventsOut) {
          const event: LaneEvent = {
            ts: Date.now(),
            agentId: ctx.host.agentId,
            type: "error",
            payload: {
              class: "transport",
              message: `results.jsonl write failed for pipeline stage ${id}: ${err.message}`,
              retryable: false,
            },
          };
          ctx.eventsOut.write(JSON.stringify(event) + "\n", () => {
            // Best-effort diagnostic; swallow eventsOut errors.
          });
        }
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function buildPipelineResultLine(
  id: string,
  result: AgentResult,
  agentId: string | undefined,
  sessionId: string | undefined,
): ResultLine {
  const base = {
    id,
    agentId: agentId ?? "unknown",
    sessionId: sessionId ?? "unknown",
    completedAt: Date.now(),
  };
  switch (result.status) {
    case "success":
      return {
        ...base,
        status: "succeeded",
        output: result.output,
        usage: result.usage,
        wallClockMs: result.wallClockMs,
      };
    case "failure":
      return {
        ...base,
        status: "failed",
        error: result.error,
        ...(result.partialOutput !== undefined && {
          output: result.partialOutput,
        }),
        ...(result.usage !== undefined && { usage: result.usage }),
        wallClockMs: result.wallClockMs,
      };
    case "timeout":
      return {
        ...base,
        status: "timeout",
        error: "task exceeded wall-clock budget",
        ...(result.partialOutput !== undefined && {
          output: result.partialOutput,
        }),
        ...(result.usage !== undefined && { usage: result.usage }),
        wallClockMs: result.wallClockMs,
      };
    case "killed":
      return {
        ...base,
        status: "cancelled",
        wallClockMs: result.wallClockMs,
      };
  }
}

