/**
 * PeerTeamTopology — N parallel members with live peer messaging.
 *
 * The Claude Code teams shape: spawn all members in parallel into a shared
 * team scope (`swarm:<spec.name>`); members coordinate via `send_message` /
 * `check_inbox` / `role:<x>` resolved within the team. Awaiting completion
 * follows the spec's CompletionRule (all / any / majority / deadline /
 * until_signal); aggregation follows Aggregator (concat / last / vote /
 * judge / custom).
 *
 * Failure semantics (docs/25 §9.5): individual member crashes do NOT abort
 * the team — failed members go into the count and aggregate runs over the
 * surviving outputs. This differs from pipeline (where any failure halts).
 *
 * Member-prompt augmentation (V0.4.Q2): at spawn time, every member's prompt
 * gets a "## Your teammates" section listing the other members' roles + ids
 * for static awareness; runtime fresh state is the `team_members()` tool's
 * job, which the augmentation explicitly mentions.
 */
import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { AgentId } from "../../core/types.js";
import type { AgentResult, AgentHandle } from "../host.js";
import type { LaneEvent } from "../events.js";
import type {
  TeamSpec,
  MemberSpec,
  CompletionRule,
  Aggregator,
} from "../team-spec.js";
import { TeamSession } from "../team-session.js";
import {
  makeResolvedHandle,
  planParallelDispatch,
  recordTerminal,
} from "./parallel-recovery.js";
import { applyDefaultBranchPolicy } from "./branch-policy-defaults.js";
import {
  createDefaultLandingRegistry,
  DEFAULT_LANDING_STRATEGY,
} from "../landing/index.js";
import {
  createDefaultRecoveryRegistry,
  describeResolution,
  type ConflictResolution,
} from "../recovery/index.js";
import { buildResolverSpawner } from "../recovery/resolver-spawner.js";
import { CascadeScheduler } from "../cascade-scheduler.js";
import type {
  Topology,
  TopologyContext,
  TeamResult,
} from "../topologies-types.js";

/**
 * docs/44 P0 — default landing registry used when the TopologyContext doesn't
 * inject one. Constructed once; holds the built-in `merge-to-parent` strategy.
 */
const DEFAULT_LANDING_REGISTRY = createDefaultLandingRegistry();

/**
 * docs/44 P1 — default conflict-recovery registry (defer / abandon / escalate).
 * Used when the TopologyContext doesn't inject one.
 */
const DEFAULT_RECOVERY_REGISTRY = createDefaultRecoveryRegistry();

/** docs/44 P2b — default resolver wait before escalating (30 min). */
const DEFAULT_RESOLVER_TIMEOUT_MS = 1_800_000;

export class PeerTeamTopology implements Topology {
  readonly name = "peer-team" as const;

  async run(specIn: TeamSpec, ctx: TopologyContext): Promise<TeamResult> {
    if (specIn.members.length === 0) {
      throw new Error("PeerTeamTopology: spec.members is empty");
    }
    // v0.7 stage 7D — when the host has a stream-aware adapter, default each
    // member to its own stream/worktree per docs/25 §10.4. Spec overrides win.
    // Optional-chaining handles fakes that don't implement supportsStreams.
    const spec = ctx.host.supportsStreams?.() ?? false
      ? applyDefaultBranchPolicy(specIn, { kind: "stream" })
      : specIn;

    const team = new TeamSession({
      name: spec.name,
      host: ctx.host,
      permissionMode: ctx.permissionMode,
    });

    // v0.6 stage 5F: surface the live session so the Orchestrator (and
    // through it the team daemon) can route subsequent send_prompt RPCs.
    if (ctx.onTeamCreated !== undefined) {
      ctx.onTeamCreated(team);
    }

    ctx.host.emit({
      type: "team_started",
      payload: {
        teamName: spec.name,
        scope: team.scope,
        topology: "peer-team",
        memberCount: spec.members.length,
      },
    });

    // Pre-aborted signal — emit team_aborted, count everyone as cancelled,
    // and never spawn. Mirrors PipelineTopology's pre-abort handling so
    // SIGINT-after-runTeam-call short-circuits cleanly.
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

    let aborted = false;
    let results: AgentResult[] = [];
    let aggregateOutput: string | undefined;
    let memberHandles: readonly AgentHandle[] = [];

    try {
      // Inject teammate awareness into each member's prompt (V0.4.Q2).
      const augmented = spec.members.map((m, idx) => ({
        ...m,
        prompt: this.augmentWithTeammates(m, spec.members, idx),
      }));

      // Crash-recovery T3b: plan per-member dispatch against the checkpoint
      // (over the teammate-augmented specs — the resume preamble layers on
      // top). Already-succeeded members are represented by a synthetic
      // resolved handle so the CompletionRule counts them without change;
      // in-flight members are re-dispatched with a verify-then-continue
      // preamble + per-unit session sidecar (resuming their engine session).
      // Pure pass-through when ctx.checkpoint is absent.
      const plans = await planParallelDispatch(
        augmented,
        ctx,
        spec.name,
        team.scope,
      );
      const spawned = await team.spawnAll(
        plans.filter((p) => !p.skip).map((p) => p.spawnSpec!),
      );
      let spawnIdx = 0;
      const handles: readonly AgentHandle[] = plans.map((p) =>
        p.skip
          ? makeResolvedHandle(p.unitId, p.skippedResult!)
          : spawned[spawnIdx++]!,
      );
      memberHandles = handles;

      // Wait per CompletionRule.
      const completionRule = spec.coordination.completion;
      results = await this.awaitCompletion(team, handles, completionRule, ctx);

      // Record each (re)spawned member's terminal outcome for the next
      // restart. The CompletionRule has resolved (every spawned handle's
      // wait() has settled, killed losers included); await records so they
      // flush before a persistent team's daemon closes the checkpoint.
      spawnIdx = 0;
      await Promise.all(
        plans.map(async (p) => {
          if (p.skip) return;
          const h = spawned[spawnIdx++]!;
          await recordTerminal(ctx, p.unitId, h.agentId, await h.wait());
        }),
      );

      // Aggregate per Aggregator (default concat for peer-team).
      const aggregator = spec.coordination.aggregator ?? { kind: "concat" as const };
      aggregateOutput = await this.aggregate(results, aggregator, team, ctx);

      // v0.7 stage 7C — auto-merge each member's stream into the configured
      // target. Only fires when (a) spec opted in and (b) the host's branch
      // policy adapter actually tracks streams. Conflicts are non-fatal by
      // default; opt into failOnConflict to surface them as topology errors.
      await this.maybeMergeStreams(spec, memberHandles, ctx, team);

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
      // Surface unexpected failures as team_aborted; rethrow so the caller
      // can see them. dispose() in finally still runs.
      aborted = true;
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
      // v0.6 stage 5F: persistent teams skip dispose so the team daemon
      // can spawn ad-hoc members via send_prompt after the initial spec
      // members complete. Caller (typically the daemon) is responsible
      // for disposing the team when the daemon exits.
      if (ctx.persistent !== true) {
        await team.dispose();
      }
    }

    void aborted;

    const counts = this.tallyResults(results);
    return {
      ...counts,
      resultWriteFailures: 0,
      deadLetterViolation: false,
      deadLetterWriteFailures: 0,
      ...(aggregateOutput !== undefined && { aggregateOutput }),
    };
  }

  /**
   * Inject a teammates list into a member's prompt (static awareness — V0.4.Q2).
   * Format documented inline so the model knows it's a static snapshot and
   * that `team_members()` returns runtime-fresh state.
   */
  private augmentWithTeammates(
    member: MemberSpec,
    allMembers: readonly MemberSpec[],
    selfIdx: number,
  ): string {
    const others = allMembers.filter((_, i) => i !== selfIdx);
    if (others.length === 0) return member.prompt;
    const list = others
      .map((m) => `  - ${m.role}${m.id !== undefined ? ` (id: ${m.id})` : ""}`)
      .join("\n");
    return `${member.prompt}\n\n## Your teammates\n\n${list}\n\nUse send_message and check_inbox to coordinate. Use team_members() to refresh this list at runtime.`;
  }

  /**
   * Wait per CompletionRule. Returns one AgentResult per member that
   * completed; uncompleted/killed members are excluded from the array (they
   * still appear in the tally as `cancelled` if their final wait() resolves
   * to "killed", which it should after handle.kill()).
   */
  private async awaitCompletion(
    team: TeamSession,
    handles: readonly AgentHandle[],
    rule: CompletionRule,
    ctx: TopologyContext,
  ): Promise<AgentResult[]> {
    const N = handles.length;

    // Track each completion with its member index so we know who finished.
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
        // Cancel the rest. Best-effort — kill() may resolve to a "killed"
        // result on the still-pending tracked promise, but we don't await
        // those (they'd just append to results we discard).
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
            `PeerTeamTopology: majority m=${m} exceeds member count ${N}`,
          );
        }
        // Wait until M members have completed. Each tracked promise records
        // its result into the slot indexed by member position.
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
        // Kill remaining members that haven't completed yet.
        await Promise.all(
          handles.map((h, i) =>
            results[i] === undefined ? h.kill().catch(() => {}) : Promise.resolve(),
          ),
        );
        return results.filter((r): r is AgentResult => r !== undefined);
      }
      case "deadline": {
        const ms = rule.ms;
        // Capture the timer id so we can clear it if all members finish before
        // the deadline — otherwise the dangling timeout keeps the event loop
        // alive for up to `ms` after the topology returns.
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const deadlineP = new Promise<"deadline">((resolve) => {
          timeoutId = setTimeout(() => resolve("deadline"), ms);
        });
        const allP = Promise.allSettled(tracked).then(() => "all-done" as const);
        const winner = await Promise.race([allP, deadlineP]);
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        if (winner === "deadline") {
          // Kill everyone who hasn't finished. allSettled below collects all
          // settled tracked promises (kill resolves to "killed" via wait()).
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
        // Subscribe to host event bus for `message_sent` events whose payload
        // content includes the signal string. The host's events emitter is
        // private; cast through `any` mirrors the agreed plan.
        const hostEvents = (ctx.host as unknown as { readonly events: EventEmitter }).events;
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
        // Always remove the listener to avoid leaks across runs.
        if (handler !== undefined) hostEvents.off("lane_event", handler);
        // Drain everyone — peer-team `until_signal` semantics call for the
        // signal to terminate the cohort. Best-effort kill on any survivors.
        await Promise.all(handles.map((h) => h.kill().catch(() => {})));
        const settled = await Promise.allSettled(tracked);
        for (const s of settled) {
          if (s.status === "fulfilled") results[s.value.idx] = s.value.result;
        }
        return results.filter((r): r is AgentResult => r !== undefined);
      }
    }
  }

  /**
   * Aggregate per Aggregator. Default for peer-team is `concat`.
   *
   * - concat: join successful outputs with separator (default "\n\n")
   * - last:   last successful output
   * - vote:   most common output string wins; tie → first occurrence
   * - judge:  spawns an extra member with role from spec; that member's
   *           output is the aggregate
   * - custom: schema admits no `fn`; runtime constructors may pass one but
   *           4E.3 falls through to concat with a `team_note`
   */
  private async aggregate(
    results: readonly AgentResult[],
    aggregator: Aggregator,
    team: TeamSession,
    ctx: TopologyContext,
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
        if (successOutputs.length === 0) return undefined;
        return successOutputs.join(sep);
      }
      case "last": {
        if (successOutputs.length === 0) return undefined;
        return successOutputs[successOutputs.length - 1];
      }
      case "vote": {
        if (successOutputs.length === 0) return undefined;
        const counts = new Map<string, number>();
        for (const o of successOutputs) {
          counts.set(o, (counts.get(o) ?? 0) + 1);
        }
        let best: string = successOutputs[0]!;
        let bestCount = 0;
        // Iterate successOutputs (stable insertion order) so the first-seen
        // tie wins, matching the documented contract.
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
        const judgePrompt = `You are the team judge. Evaluate these candidate outputs and emit the best one verbatim:\n\n${successOutputs
          .map((o, i) => `### Candidate ${i + 1}\n${o}`)
          .join("\n\n")}`;
        const judgeHandle = await team.spawnMember({
          role: aggregator.role,
          prompt: judgePrompt,
        });
        const judgeResult = await judgeHandle.wait();
        return judgeResult.status === "success" ? judgeResult.output : undefined;
      }
      case "custom": {
        // 4E.3 schema doesn't admit a `fn` — fall through to concat with a
        // team_note for observability. Runtime constructors that pass `fn`
        // would override at the type level; that path lands later.
        ctx.host.emit({
          type: "team_note",
          payload: {
            teamName: team.name,
            scope: team.scope,
            note: "aggregator: custom without fn falls through to concat",
          },
        });
        if (successOutputs.length === 0) return undefined;
        return successOutputs.join("\n\n");
      }
    }
  }

  /**
   * v0.7 stage 7C — when spec.coordination.mergeStreams is set, merge each
   * member's stream into the target via the host's branch-policy adapter.
   * Skipped silently when:
   *   - spec didn't opt in, or
   *   - host adapter doesn't track streams (identity adapter), or
   *   - a member has no recorded streamId (branchPolicy was none/reuse/create).
   * Conflicts emit a `team_note` lane event; with failOnConflict:true the
   * first failure throws, surfacing as a `team_aborted` upstream.
   */
  private async maybeMergeStreams(
    spec: TeamSpec,
    handles: readonly AgentHandle[],
    ctx: TopologyContext,
    team: TeamSession,
  ): Promise<void> {
    const cfg = spec.coordination.mergeStreams;
    if (cfg === undefined) return;
    // v0.7 stage 7F — branch path uses adapter.mergeStreamToBranch (plain
    // git in a tmp worktree) because git-cascade's mergeStream hardcodes
    // synthetic stream/<id> branch names and can't merge into main.
    const usingBranch = cfg.targetBranch !== undefined;
    const targetStream = cfg.targetStream;
    if (!usingBranch && targetStream === undefined) return;
    // docs/44 P0 — landing delegates to a LandingStrategy. Phase 3 B3: the
    // strategy is selected per member via `MemberSpec.landing` (default
    // merge-to-parent); `queue-to-branch` members are enqueued and the queue
    // is drained once after the cohort lands (the integrator action).
    const landingRegistry = ctx.landingRegistry ?? DEFAULT_LANDING_REGISTRY;
    const recovery = ctx.recoveryRegistry ?? DEFAULT_RECOVERY_REGISTRY;
    // docs/44 P2b — when landing to a branch and the host implements the
    // conflict primitives (a real StandaloneHost with a git-cascade adapter),
    // build the spawn-resolver coordinator and inject it so the `spawn-resolver`
    // strategy can run a real resolver agent. Fakes that lack these methods at
    // runtime → no coordinator → spawn-resolver escalates.
    const host = ctx.host;
    const recoveryCfg = spec.coordination.conflictRecovery;
    const cfgTimeout = recoveryCfg?.defaultConfig?.timeoutMs;
    const timeoutMs =
      typeof cfgTimeout === "number" ? cfgTimeout : DEFAULT_RESOLVER_TIMEOUT_MS;
    // Fold the sibling `conflictRecovery.maxRecoveryDepth` into strategyConfig
    // so the spawn-resolver strategy (which reads strategyConfig.maxRecoveryDepth)
    // actually honors it. Without this, the top-level key was silently dropped
    // and resolver recursion always used the built-in default depth.
    const mergedConfig: Record<string, unknown> = {
      ...(recoveryCfg?.defaultConfig ?? {}),
      ...(recoveryCfg?.maxRecoveryDepth !== undefined && {
        maxRecoveryDepth: recoveryCfg.maxRecoveryDepth,
      }),
    };
    const strategyConfig =
      Object.keys(mergedConfig).length > 0 ? mergedConfig : undefined;
    const spawnResolver =
      usingBranch &&
      typeof host.finalizeConflictResolution === "function" &&
      typeof host.waitForConflictResolution === "function"
        ? buildResolverSpawner({
            spawnResolver: async (s) => {
              const h = await team.spawnMember({
                role: s.role,
                prompt: s.prompt,
                branchPolicy: s.branchPolicy,
                cwd: s.cwd,
              });
              return { agentId: h.agentId, kill: () => h.kill() };
            },
            mergeWithRetain: (agentId, tb) =>
              host.mergeStreamToBranchForAgent(agentId as AgentId, {
                targetBranch: tb,
                retainOnConflict: true,
              }),
            waitForResolution: (cid, t) =>
              host.waitForConflictResolution(cid, t),
            finalize: (o) => host.finalizeConflictResolution(o),
            ...(typeof host.discardConflictWorktree === "function" && {
              cleanupWorktree: (wt) => host.discardConflictWorktree!(wt),
            }),
            timeoutMs,
          })
        : undefined;
    // review MEDIUM: spawn-resolver needs `exec` (the resolver must `git commit`
    // and call `resolve_conflict`), which only `danger-full-access` grants.
    // Under a more restrictive team mode the resolver silently degrades to
    // escalate — emit a one-time diagnostic so operators understand WHY
    // resolution never fires (vs. a timeout), instead of debugging blind.
    if (
      usingBranch &&
      ctx.permissionMode !== "danger-full-access" &&
      spec.members.some((m) => recovery.select(m.role, spec) === "spawn-resolver")
    ) {
      ctx.host.emit({
        type: "team_note",
        payload: {
          teamName: spec.name,
          scope: `swarm:${spec.name}`,
          note: `spawn-resolver selected but team permissionMode="${ctx.permissionMode}" is below danger-full-access; the resolver cannot commit or call resolve_conflict and will escalate instead of resolving`,
        },
      });
    }
    // docs/44 P3 — when a member opts into `onParentAdvanced: "sync"` and we're
    // merging into a target STREAM (cascade roots are streams, not branches),
    // schedule a debounced cascade rebase of the target's dependents. Repeated
    // member merges into the same target coalesce into one cascade.
    const cascadeEnabled =
      !usingBranch &&
      targetStream !== undefined &&
      typeof host.cascadeRebase === "function" &&
      spec.members.some((m) => m.onParentAdvanced === "sync");
    const cascade = cascadeEnabled
      ? new CascadeScheduler({
          run: (root) =>
            host.cascadeRebase({
              rootStream: root,
              agentId: "cascade-driver",
              strategy: "defer_conflicts",
            }),
        })
      : undefined;
    // handles[i] is index-aligned with spec.members[i] (team.spawnAll preserves
    // order), so spec.members[i] drives per-member recovery + landing selection.
    let queuedToBranch = false;
    for (let i = 0; i < handles.length; i++) {
      const handle = handles[i]!;
      const streamId = ctx.host.streamIdFor(handle.agentId);
      if (streamId === undefined) continue;
      const landingName = spec.members[i]?.landing ?? DEFAULT_LANDING_STRATEGY;
      const landing = landingRegistry.get(landingName);
      const result =
        landing === undefined
          ? null
          : await landing.land({
              host: ctx.host,
              agentId: handle.agentId,
              streamId,
              ...(usingBranch
                ? { targetBranch: cfg.targetBranch! }
                : { targetStream: targetStream! }),
              ...(cfg.strategy !== undefined && { strategy: cfg.strategy }),
            });
      if (result === null) {
        // This landing strategy can't merge this member (e.g. adapter lacks
        // the capability, or queue-to-branch was selected without a branch
        // target) — emit a note and SKIP THIS MEMBER. Must `continue`, not
        // `return`: a per-member null must not abort the rest of the cohort
        // (a custom strategy may decline one member yet land others).
        ctx.host.emit({
          type: "team_note",
          payload: {
            teamName: spec.name,
            scope: `swarm:${spec.name}`,
            note: usingBranch
              ? `landing "${landingName}" for ${handle.agentId} requires an adapter that supports it (targetBranch=${cfg.targetBranch}); skipping merge`
              : `landing "${landingName}" for ${handle.agentId} requires a stream-aware adapter (targetStream=${targetStream}); skipping merge`,
          },
        });
        continue;
      }
      if (landingName === "queue-to-branch" && result.success) {
        // "Success" from queue-to-branch means *enqueued* — the actual merge
        // happens in the drain below, after every member has landed.
        queuedToBranch = true;
        continue;
      }
      const target = usingBranch ? cfg.targetBranch : targetStream;
      if (!result.success) {
        const isConflict = result.errorType === "conflict";
        const reason = isConflict
          ? `conflict on ${result.conflicts?.join(", ") ?? "<unknown>"}`
          : (result.error ?? "unknown merge error");
        ctx.host.emit({
          type: "team_note",
          payload: {
            teamName: spec.name,
            scope: `swarm:${spec.name}`,
            note: `mergeStream(${streamId} → ${target}) failed: ${reason}`,
          },
        });

        // docs/44 P1 — dispatch conflict recovery per role/team config. The
        // default strategy is `defer` (a no-op), so a team that hasn't opted
        // into recovery behaves exactly as before: the note above is emitted
        // and `failOnConflict` still decides whether to throw.
        let resolved = false;
        if (isConflict) {
          const role = spec.members[i]?.role;
          const strategyName = recovery.select(role, spec);
          const resolution: ConflictResolution = recovery.has(strategyName)
            ? await recovery.recover(strategyName, {
                // Unique per recovery invocation: the conflictId keys the host's
                // waiter map and resolve-before-wait buffer, so a deterministic
                // agentId:streamId would let a stale buffered resolution satisfy
                // a later distinct conflict (and collide concurrent resolvers).
                conflictId: `${handle.agentId}:${streamId}:${randomUUID()}`,
                sourceAgentId: handle.agentId,
                streamId,
                paths: result.conflicts ?? [],
                operation: "merge",
                ...(usingBranch
                  ? { targetBranch: cfg.targetBranch! }
                  : { targetStream: targetStream! }),
                recoveryDepth: 0,
                ...(strategyConfig !== undefined && { strategyConfig }),
                ...(spawnResolver !== undefined && { spawnResolver }),
              })
            : {
                kind: "deferred",
                reason: `strategy "${strategyName}" not registered`,
              };
          resolved = resolution.kind === "resolved";
          ctx.host.emit({
            type: "team_note",
            payload: {
              teamName: spec.name,
              scope: `swarm:${spec.name}`,
              note: `conflict recovery [${strategyName}] for ${handle.agentId}: ${describeResolution(resolution)}`,
            },
          });
        }

        // Throw only when the conflict was NOT resolved. `failOnConflict`
        // preserves its contract: an unresolved conflict (or a non-conflict
        // merge error) fails the topology.
        if (!resolved && cfg.failOnConflict === true) {
          throw new Error(
            `PeerTeamTopology: mergeStream failed for ${handle.agentId}: ${reason}`,
          );
        }
      } else if (cascade !== undefined) {
        // Successful stream merge advanced the target — request a (coalesced)
        // cascade rebase of its dependents.
        cascade.request(targetStream!);
      }
    }

    // docs/44 P3 — run the coalesced cascade(s) now and surface the outcome.
    if (cascade !== undefined) {
      const results = await cascade.flush();
      for (const [root, r] of results) {
        if (r === null) continue;
        const unrebased =
          r.conflicts !== undefined && r.conflicts.length > 0
            ? r.conflicts.map((c) => c.streamId).join(", ")
            : undefined;
        ctx.host.emit({
          type: "team_note",
          payload: {
            teamName: spec.name,
            scope: `swarm:${spec.name}`,
            note:
              !r.success || unrebased !== undefined
                ? `cascade rebase of ${root} left unrebased streams: ${unrebased ?? r.error ?? "unknown"}`
                : `cascade rebase of ${root}: ${r.rebased?.length ?? 0} dependent(s) rebased`,
          },
        });
      }
    }

    // docs/44 P4 / Phase 3 B3 — the integrator action: once every member has
    // landed, drain the merge queue in order for queue-to-branch members.
    // Failures don't throw (entries stay queued for a manual/later drain);
    // the outcome is surfaced as a team_note either way.
    if (queuedToBranch && usingBranch) {
      // Feature-detect like cascadeRebase above: partial hosts (test fakes,
      // future host impls) may not carry the queue surface.
      const drained =
        typeof host.drainMergeQueue === "function"
          ? await host.drainMergeQueue({
              targetBranch: cfg.targetBranch!,
              ...(cfg.strategy !== undefined && { strategy: cfg.strategy }),
            })
          : null;
      ctx.host.emit({
        type: "team_note",
        payload: {
          teamName: spec.name,
          scope: `swarm:${spec.name}`,
          note:
            drained === null
              ? `merge queue for ${cfg.targetBranch} could not be drained (adapter lacks drainMergeQueue); entries remain queued`
              : `merge queue drained into ${cfg.targetBranch}: ${drained.merged.length} merged, ${drained.failed.length} failed${
                  drained.failed.length > 0
                    ? ` (${drained.failed.map((f) => `${f.streamId}: ${f.error}`).join("; ")})`
                    : ""
                }`,
        },
      });
      if (drained !== null && drained.failed.length > 0 && cfg.failOnConflict === true) {
        throw new Error(
          `PeerTeamTopology: merge-queue drain into ${cfg.targetBranch} failed for ${drained.failed.length} entr${drained.failed.length === 1 ? "y" : "ies"}`,
        );
      }
    }
  }

  private tallyResults(results: readonly AgentResult[]): {
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
}
