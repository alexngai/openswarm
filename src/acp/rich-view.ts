/**
 * Rich view (B2.1, docs/35 §2) — the reusable core of the swarm-aware client.
 *
 * Folds the collapsed `session/update` stream a client receives into per-member
 * **lanes** (member voices + lane-grouped tool calls) plus a **task board**,
 * keyed by `_meta.swarm.member.id`. Pure: no I/O, no terminal — a front-end
 * formats the returned `RichView`.
 *
 * Same emission surface, two fidelities (Q5): the renderer reads only standard
 * fields + `_meta.swarm`, so stripping `_meta` collapses everything into one
 * lane — the baseline view. It never depends on the agent's internals; it reads
 * `_meta.swarm` structurally, as any client would.
 */

import type { SessionUpdate } from "@agentclientprotocol/sdk";

/** The `_meta.swarm.member` a client reads off an update (structural). */
interface SwarmMemberRef {
  readonly id?: string;
  readonly name?: string;
  readonly role?: string;
}

export interface RichTool {
  readonly toolCallId: string;
  title: string;
  kind?: string;
  /** pending | in_progress | completed | failed */
  status: string;
}

export interface RichLane {
  /** `_meta.swarm.member.id`, or "" for the orchestrator / unattributed lane. */
  readonly memberId: string;
  name?: string;
  role?: string;
  text: string;
  readonly tools: RichTool[];
}

export interface RichBoardEntry {
  content: string;
  priority?: string;
  status: string;
  /** The member this entry is linked to (`entry._meta.swarm.member.id`). */
  memberId?: string;
}

export interface RichView {
  /** Lanes in first-seen order. */
  readonly lanes: readonly RichLane[];
  readonly board: readonly RichBoardEntry[];
}

function swarmMember(obj: unknown): SwarmMemberRef | undefined {
  const meta = (obj as { _meta?: { swarm?: { member?: SwarmMemberRef } } })._meta;
  return meta?.swarm?.member;
}

function chunkText(update: SessionUpdate): string {
  const c = (update as { content?: { type?: string; text?: string } }).content;
  return c?.type === "text" ? (c.text ?? "") : "";
}

/**
 * Accumulates a `RichView` from a stream of `session/update` notifications.
 * Drive it with `apply()` per update; read `view()` for the current model.
 */
export class RichRenderer {
  private readonly lanes = new Map<string, RichLane>();
  private readonly laneOrder: string[] = [];
  /** toolCallId -> tool, so tool_call_update mutates the existing entry in place. */
  private readonly tools = new Map<string, RichTool>();
  private board: RichBoardEntry[] = [];

  apply(update: SessionUpdate): void {
    const member = swarmMember(update);

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.lane(member?.id ?? "", member).text += chunkText(update);
        return;

      case "tool_call": {
        const u = update as {
          toolCallId?: string;
          title?: string;
          kind?: string;
          status?: string;
        };
        if (u.toolCallId === undefined) return;
        const tool: RichTool = {
          toolCallId: u.toolCallId,
          title: u.title ?? "",
          ...(u.kind !== undefined && { kind: u.kind }),
          status: u.status ?? "pending",
        };
        this.tools.set(tool.toolCallId, tool);
        this.lane(member?.id ?? "", member).tools.push(tool);
        return;
      }

      case "tool_call_update": {
        const u = update as {
          toolCallId?: string;
          title?: string;
          kind?: string;
          status?: string;
        };
        if (u.toolCallId === undefined) return;
        const existing = this.tools.get(u.toolCallId);
        if (existing !== undefined) {
          if (u.title !== undefined) existing.title = u.title;
          if (u.kind !== undefined) existing.kind = u.kind;
          if (u.status !== undefined) existing.status = u.status;
        } else {
          // An update with no prior tool_call — start one in this lane.
          const tool: RichTool = {
            toolCallId: u.toolCallId,
            title: u.title ?? "",
            ...(u.kind !== undefined && { kind: u.kind }),
            status: u.status ?? "in_progress",
          };
          this.tools.set(tool.toolCallId, tool);
          this.lane(member?.id ?? "", member).tools.push(tool);
        }
        return;
      }

      case "plan": {
        // A board update only — does not create a lane.
        const entries = (update as { entries?: unknown[] }).entries ?? [];
        this.board = entries.map((e) => {
          const entry = e as {
            content?: string;
            priority?: string;
            status?: string;
          };
          const m = swarmMember(e);
          return {
            content: entry.content ?? "",
            ...(entry.priority !== undefined && { priority: entry.priority }),
            status: entry.status ?? "pending",
            ...(m?.id !== undefined && { memberId: m.id }),
          };
        });
        return;
      }

      default:
        return;
    }
  }

  view(): RichView {
    return {
      lanes: this.laneOrder.map((k) => this.lanes.get(k)!),
      board: this.board,
    };
  }

  private lane(key: string, member?: SwarmMemberRef): RichLane {
    let lane = this.lanes.get(key);
    if (lane === undefined) {
      lane = { memberId: key, text: "", tools: [] };
      this.lanes.set(key, lane);
      this.laneOrder.push(key);
    }
    // Keep the freshest name/role (the first update may precede full meta).
    if (member?.name !== undefined) lane.name = member.name;
    if (member?.role !== undefined) lane.role = member.role;
    return lane;
  }
}
