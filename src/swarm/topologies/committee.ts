/**
 * CommitteeTopology — N parallel members with the same task; aggregate via
 * vote or judge.
 *
 * docs/25 §8.5: spawn N members in parallel (typically the same prompt to
 * each, but per-member prompts are honored), wait per CompletionRule, then
 * aggregate via the spec's Aggregator (default `judge` if a "judge" role
 * is registered in the team, otherwise `vote`).
 *
 * Difference from PeerTeamTopology:
 *  - No teammate-awareness injection. Committee members deliberate
 *    independently; cross-talk biases the vote/judge.
 *  - Default aggregator is judge/vote rather than concat — committee
 *    canonical use case is "synthesise N candidates into one verdict".
 */

import type { EventEmitter } from "node:events";
import type { AgentResult, AgentHandle } from "../host.js";
import type { LaneEvent } from "../events.js";
import type {
  TeamSpec,
  CompletionRule,
  Aggregator,
} from "../team-spec.js";
import { TeamSession } from "../team-session.js";
import type {
  Topology,
  TopologyContext,
  TeamResult,
} from "../topologies-types.js";

export class CommitteeTopology implements Topology {
  readonly name = "committee" as const;

  async run(spec: TeamSpec, ctx: TopologyContext): Promise<TeamResult> {
    if (spec.members.length === 0) {
      throw new Error("CommitteeTopology: spec.members is empty");
    }

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
        topology: "committee",
        memberCount: spec.members.length,
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
        cancelled: spec.members.length,
        resultWriteFailures: 0,
        deadLetterViolation: false,
        deadLetterWriteFailures: 0,
      };
    }

    let results: AgentResult[] = [];
    let aggregateOutput: string | undefined;

    try {
      // No teammate-awareness injection — committee members deliberate
      // independently. Spawn members verbatim.
      const handles = await team.spawnAll(spec.members);

      const completionRule = spec.coordination.completion;
      results = await awaitCompletion(team, handles, completionRule, ctx);

      // Default aggregator for committee differs from peer-team. Pick
      // `judge` when the spec has a member with role "judge" (so the same
      // role can run the deliberation as a normal member); otherwise fall
      // back to `vote`.
      const aggregator: Aggregator =
        spec.coordination.aggregator ?? this.defaultAggregator(spec);
      aggregateOutput = await this.aggregate(results, aggregator, team);

      ctx.host.emit({
        type: "team_completed",
        payload: {
          teamName: spec.name,
          scope: team.scope,
          completion: completionRule.kind,
          memberResults: results.length,
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

    const counts = tallyResults(results);
    return {
      ...counts,
      resultWriteFailures: 0,
      deadLetterViolation: false,
      deadLetterWriteFailures: 0,
      ...(aggregateOutput !== undefined && { aggregateOutput }),
    };
  }

  /**
   * Pick the default aggregator. If the spec has any member with role
   * "judge" we use the judge aggregator (delegating synthesis to that
   * role); otherwise vote — cheap deterministic majority on the output
   * strings.
   */
  private defaultAggregator(spec: TeamSpec): Aggregator {
    const judgeMember = spec.members.find((m) => m.role === "judge");
    if (judgeMember !== undefined) {
      return { kind: "judge", role: "judge" };
    }
    return { kind: "vote" };
  }

  private async aggregate(
    results: readonly AgentResult[],
    aggregator: Aggregator,
    team: TeamSession,
  ): Promise<string | undefined> {
    const successOutputs = results
      .filter(
        (r): r is Extract<AgentResult, { status: "success" }> =>
          r.status === "success",
      )
      .map((r) => r.output);

    switch (aggregator.kind) {
      case "concat": {
        const sep = aggregator.separator ?? "\n\n";
        return successOutputs.length === 0
          ? undefined
          : successOutputs.join(sep);
      }
      case "last": {
        return successOutputs.length === 0
          ? undefined
          : successOutputs[successOutputs.length - 1];
      }
      case "vote": {
        if (successOutputs.length === 0) return undefined;
        const counts = new Map<string, number>();
        for (const o of successOutputs) {
          counts.set(o, (counts.get(o) ?? 0) + 1);
        }
        let best: string = successOutputs[0]!;
        let bestCount = 0;
        for (const o of successOutputs) {
          const c = counts.get(o) ?? 0;
          if (c > bestCount) {
            best = o;
            bestCount = c;
          }
        }
        return best;
      }
      case "judge": {
        if (successOutputs.length === 0) return undefined;
        const judgePrompt = `You are the committee judge. Synthesize the best answer from these candidate outputs and emit it verbatim:\n\n${successOutputs
          .map((o, i) => `### Candidate ${i + 1}\n${o}`)
          .join("\n\n")}`;
        const judgeHandle = await team.spawnMember({
          role: aggregator.role,
          prompt: judgePrompt,
        });
        const judgeResult = await judgeHandle.wait();
        return judgeResult.status === "success"
          ? judgeResult.output
          : undefined;
      }
      case "custom": {
        // Schema doesn't carry `fn`; fall through to concat.
        return successOutputs.length === 0
          ? undefined
          : successOutputs.join("\n\n");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shared completion / tally helpers
//
// Mirrors the behaviour of PeerTeamTopology's private `awaitCompletion` +
// `tallyResults`. Kept in this file (rather than refactored to a shared
// module) so committee.ts is self-contained; if a third parallel topology
// lands later it'd be worth extracting.
// ---------------------------------------------------------------------------

async function awaitCompletion(
  team: TeamSession,
  handles: readonly AgentHandle[],
  rule: CompletionRule,
  ctx: TopologyContext,
): Promise<AgentResult[]> {
  void team;
  const N = handles.length;
  type Tracked = { readonly idx: number; readonly result: AgentResult };
  const tracked: Promise<Tracked>[] = handles.map((h, idx) =>
    h
      .wait()
      .then(
        (result) => ({ idx, result }) as Tracked,
        (err) =>
          ({
            idx,
            result: {
              status: "failure" as const,
              error: err instanceof Error ? err.message : String(err),
              wallClockMs: 0,
            },
          }) as Tracked,
      ),
  );
  const results: (AgentResult | undefined)[] = new Array(N).fill(undefined);

  switch (rule.kind) {
    case "all": {
      const settled = await Promise.allSettled(tracked);
      for (const s of settled) {
        if (s.status === "fulfilled") results[s.value.idx] = s.value.result;
      }
      return results.filter((r): r is AgentResult => r !== undefined);
    }
    case "any": {
      const winner = await Promise.race(tracked);
      results[winner.idx] = winner.result;
      await Promise.all(
        handles.map((h, i) =>
          i === winner.idx ? Promise.resolve() : h.kill().catch(() => {}),
        ),
      );
      return [winner.result];
    }
    case "majority": {
      const m = rule.m;
      if (m > N) {
        throw new Error(
          `CommitteeTopology: majority m=${m} exceeds member count ${N}`,
        );
      }
      await new Promise<void>((resolve) => {
        let completed = 0;
        let resolved = false;
        for (const t of tracked) {
          void t.then((res) => {
            results[res.idx] = res.result;
            completed++;
            if (!resolved && completed >= m) {
              resolved = true;
              resolve();
            }
          });
        }
      });
      await Promise.all(
        handles.map((h, i) =>
          results[i] === undefined
            ? h.kill().catch(() => {})
            : Promise.resolve(),
        ),
      );
      return results.filter((r): r is AgentResult => r !== undefined);
    }
    case "deadline": {
      const ms = rule.ms;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const deadlineP = new Promise<"deadline">((resolve) => {
        timeoutId = setTimeout(() => resolve("deadline"), ms);
      });
      const allP = Promise.allSettled(tracked).then(() => "all-done" as const);
      const winner = await Promise.race([allP, deadlineP]);
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (winner === "deadline") {
        await Promise.all(handles.map((h) => h.kill().catch(() => {})));
      }
      const settled = await Promise.allSettled(tracked);
      for (const s of settled) {
        if (s.status === "fulfilled") results[s.value.idx] = s.value.result;
      }
      return results.filter((r): r is AgentResult => r !== undefined);
    }
    case "until_signal": {
      const signal = rule.signal;
      const hostEvents = (
        ctx.host as unknown as { readonly events: EventEmitter }
      ).events;
      let handler: ((evt: LaneEvent) => void) | undefined;
      const signalP = new Promise<void>((resolve) => {
        handler = (event: LaneEvent) => {
          if (event.type !== "message_sent") return;
          const payload = event.payload as { content?: string } | undefined;
          if (
            payload !== undefined &&
            typeof payload.content === "string" &&
            payload.content.includes(signal)
          ) {
            resolve();
          }
        };
        hostEvents.on("lane_event", handler);
      });
      const allP = Promise.allSettled(tracked).then(() => "all-done" as const);
      await Promise.race([allP, signalP.then(() => "signal" as const)]);
      if (handler !== undefined) hostEvents.off("lane_event", handler);
      await Promise.all(handles.map((h) => h.kill().catch(() => {})));
      const settled = await Promise.allSettled(tracked);
      for (const s of settled) {
        if (s.status === "fulfilled") results[s.value.idx] = s.value.result;
      }
      return results.filter((r): r is AgentResult => r !== undefined);
    }
  }
}

function tallyResults(results: readonly AgentResult[]): {
  readonly succeeded: number;
  readonly failed: number;
  readonly timeout: number;
  readonly cancelled: number;
} {
  let succeeded = 0;
  let failed = 0;
  let timeout = 0;
  let cancelled = 0;
  for (const r of results) {
    switch (r.status) {
      case "success":
        succeeded++;
        break;
      case "failure":
        failed++;
        break;
      case "timeout":
        timeout++;
        break;
      case "killed":
        cancelled++;
        break;
    }
  }
  return { succeeded, failed, timeout, cancelled };
}
