/**
 * CoordinatorTopology — cc-swarm-style root-with-dynamic-peers.
 *
 * Spawns ONE root member as long-lived. The root's prompt is augmented
 * with the topology, available roles, and spawn-rules guidance so the
 * model knows it can call `agent({team: "self", ...})` to spawn peers
 * into the same team scope. Spawned peers run in the team; root reads
 * their outputs via send_message / check_inbox / task_get / task_list.
 *
 * Team completes when the root finishes (emits its terminal task_result).
 * Any peer members spawned by the root are killed in dispose().
 *
 * IMPORTANT: the brief specifies "default for coordinator topology root →
 * `team: 'self'`". Stage 4E.4 achieves this at the **prompt level** — the
 * root model is told to pass `team: "self"` when calling `agent`. We do NOT
 * auto-inject `team: "self"` into the agent tool's input (that would
 * require per-topology tool wiring, which is out of scope here).
 *
 * Convention:
 *   - `spec.members[0]` is the ROOT.
 *   - `spec.members[1..]` describe candidate roles the root may spawn —
 *     they are NOT auto-spawned. They serve as "available roles to spawn"
 *     hints for the root's prompt.
 *
 * Long-lived plumbing: this topology relies on the `longLived?: boolean`
 * field added to MemberSpec in stage 4E.4 (Option A — schema extension).
 * TeamSession.spawnMember forwards it to SpawnRequest.longLived.
 */

import type { AgentResult } from "../host.js";
import type { TeamSpec, MemberSpec } from "../team-spec.js";
import { applyDefaultBranchPolicy } from "./branch-policy-defaults.js";
import { TeamSession } from "../team-session.js";
import type { Topology, TopologyContext, TeamResult } from "../topologies-types.js";

/**
 * Verified-completion sentinel. The root must emit this EXACT line on its own
 * once it has evidence the task is fully resolved. Seeing it ends the
 * verification loop early.
 */
const VERIFIED_SENTINEL = "TASK_VERIFIED_COMPLETE";

/**
 * Continuation prompt pushed to the long-lived root after it declares done, to
 * force it to actually verify the work before the team terminates.
 */
const VERIFICATION_PROMPT = [
  "You ended your turn, but completion has NOT yet been verified.",
  "Before the team terminates you MUST:",
  "  1. Run the project's relevant tests for your change.",
  "  2. Confirm, with evidence, that the reported issue is FULLY resolved and that no regressions were introduced.",
  "  3. If anything is incomplete or a test fails, keep working and fix it now using your tools.",
  "",
  `Only when you have verified evidence that the task is fully resolved should you end your final turn with the EXACT line \`${VERIFIED_SENTINEL}\` on its own.`,
  "If you cannot yet verify completion, do NOT emit that line — continue working instead.",
].join("\n");

export class CoordinatorTopology implements Topology {
  readonly name = "coordinator" as const;

  async run(specIn: TeamSpec, ctx: TopologyContext): Promise<TeamResult> {
    if (specIn.members.length === 0) {
      throw new Error("CoordinatorTopology: spec.members is empty");
    }
    // v0.7 stage 7G — default the root member to its own stream when the
    // host has a stream-aware adapter. Peers spawned dynamically via the
    // agent tool inherit no default; they pass branchPolicy explicitly.
    // Optional-chaining handles fakes that don't implement supportsStreams.
    const spec = ctx.host.supportsStreams?.() ?? false
      ? applyDefaultBranchPolicy(specIn, { kind: "stream" })
      : specIn;

    const rootSpec = spec.members[0]!;
    const candidateRoles = spec.members.slice(1);

    const team = new TeamSession({
      name: spec.name,
      host: ctx.host,
      permissionMode: ctx.permissionMode,
    });

    // v0.6 stage 5F / Stage B B0.5: surface the live team so persistent callers
    // (the ACP team agent) can steer the long-lived root via runMore().
    ctx.onTeamCreated?.(team);

    ctx.host.emit({
      type: "team_started",
      payload: {
        teamName: spec.name,
        scope: team.scope,
        topology: "coordinator",
        // Only the root counts at start; peers spawn dynamically via agent().
        memberCount: 1,
      },
    });

    // Pre-aborted signal — emit team_aborted, count root as cancelled, do
    // not spawn. Mirrors PeerTeamTopology / PipelineTopology pre-abort.
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
        cancelled: 0,
        resultWriteFailures: 0,
        deadLetterViolation: false,
        deadLetterWriteFailures: 0,
      };
    }

    let rootResult: AgentResult | undefined;

    try {
      const augmentedPrompt = this.buildRootPrompt(rootSpec, candidateRoles, spec);

      // Spawn root as long-lived so it can call `agent` across multiple
      // turns and observe peer outputs without exiting after the first
      // task_result. Stage 4E.4: longLived plumbed via MemberSpec.longLived
      // → TeamSession.spawnMember → SpawnRequest.longLived.
      const rootMember: MemberSpec = {
        ...rootSpec,
        prompt: augmentedPrompt,
        longLived: true,
      };
      const rootHandle = await team.spawnMember(rootMember);

      rootResult = await rootHandle.wait();

      // Verified-completion gate: after the root declares done, force it to
      // actually verify (run tests, confirm the issue is resolved) before the
      // team terminates, capped at maxRounds. Unset → byte-for-byte old path.
      const vc = spec.coordination?.verifiedCompletion;
      if (vc !== undefined) {
        for (let round = 0; round < vc.maxRounds; round++) {
          // Stop if the root failed/was cancelled, or it emitted the sentinel.
          if (rootResult.status !== "success") break;
          if (rootResult.output.includes(VERIFIED_SENTINEL)) break;
          ctx.host.emit({
            type: "team_note",
            payload: {
              teamName: spec.name,
              scope: team.scope,
              note: `verification round ${round + 1}/${vc.maxRounds}`,
            },
          });
          rootResult = await rootHandle.runMore(VERIFICATION_PROMPT);
        }
      }

      ctx.host.emit({
        type: "team_completed",
        payload: {
          teamName: spec.name,
          scope: team.scope,
          completion: "root_finished",
          memberResults: 1,
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
      // dispose() kills any peer members the root spawned (they're tracked
      // by TeamSession because `agent({team: "self"})` → host.spawn with
      // teamScope set → standalone-host registers them under team.scope).
      // Persistent callers (Stage B B0.5) keep the long-lived root alive to
      // steer it via runMore; they dispose the team when the session closes.
      if (ctx.persistent !== true) {
        await team.dispose();
      }
    }

    if (rootResult === undefined) {
      // Defensive: shouldn't happen because the catch above re-throws.
      return {
        succeeded: 0,
        failed: 0,
        timeout: 0,
        cancelled: 0,
        resultWriteFailures: 0,
        deadLetterViolation: false,
        deadLetterWriteFailures: 0,
      };
    }

    const counts = this.tallyResult(rootResult);
    const aggregateOutput =
      rootResult.status === "success" ? rootResult.output : undefined;

    return {
      ...counts,
      resultWriteFailures: 0,
      deadLetterViolation: false,
      deadLetterWriteFailures: 0,
      ...(aggregateOutput !== undefined && { aggregateOutput }),
    };
  }

  /**
   * Build the root's augmented prompt. Includes:
   *   - The original spec.prompt.
   *   - The list of candidate roles available to spawn.
   *   - Guidance on calling `agent({team: "self", role: "...", prompt: "..."})`
   *     to spawn peers into the team.
   *   - Pointer to send_message, check_inbox, team_members for coordination.
   *   - Communication-rule guidance (signals, channels) if present.
   */
  private buildRootPrompt(
    rootSpec: MemberSpec,
    candidateRoles: readonly MemberSpec[],
    spec: TeamSpec,
  ): string {
    const sections: string[] = [rootSpec.prompt];

    if (candidateRoles.length > 0) {
      const roleList = candidateRoles
        .map((m) => {
          const guidance = m.prompt ? ` — ${m.prompt}` : "";
          const id = m.id !== undefined ? ` (id: ${m.id})` : "";
          return `  - ${m.role}${id}${guidance}`;
        })
        .join("\n");
      sections.push(
        `## Available teammate roles you can spawn\n\n` +
          `You are the coordinator of team "${spec.name}". Use the agent tool to ` +
          `spawn peers into this same team scope:\n\n` +
          `\`\`\`\n` +
          `agent({\n` +
          `  team: "self",\n` +
          `  role: "<one of the roles below>",\n` +
          `  prompt: "<the task for that peer>",\n` +
          `  wait: true  // wait for their output, or false to spawn async\n` +
          `})\n` +
          `\`\`\`\n\n` +
          `Available roles:\n${roleList}`,
      );
    }

    sections.push(
      `## Coordination tools\n\n` +
        `- \`send_message(to, content)\` — message a peer or broadcast (\`*\` for everyone, \`role:<name>\` for all peers in a role).\n` +
        `- \`check_inbox()\` — drain any messages your peers have sent you.\n` +
        `- \`team_members()\` — list current peers in the team (refreshes after spawns).\n` +
        `- \`task_get(taskId)\` / \`task_list()\` — inspect peer task state.`,
    );

    if (spec.coordination.communication) {
      const c = spec.coordination.communication;
      const signalLines: string[] = [];
      if (c.channels) {
        for (const [channelName, ch] of Object.entries(c.channels)) {
          const sigs = (ch.signals ?? []).map((s) => `\`${s}\``).join(", ");
          signalLines.push(`  - channel "${channelName}": signals ${sigs}`);
        }
      }
      if (signalLines.length > 0) {
        sections.push(`## Communication signals\n\n${signalLines.join("\n")}`);
      }
    }

    return sections.join("\n\n");
  }

  private tallyResult(result: AgentResult): {
    readonly succeeded: number;
    readonly failed: number;
    readonly timeout: number;
    readonly cancelled: number;
  } {
    let succeeded = 0;
    let failed = 0;
    let timeout = 0;
    let cancelled = 0;
    switch (result.status) {
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
    return { succeeded, failed, timeout, cancelled };
  }
}
