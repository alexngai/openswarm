/**
 * Rich view (B2.1) — the reusable core of the swarm-aware client.
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

/**
 * One inline edit-diff carried on a tool call (edit/write family), lifted from
 * the ACP `ToolCallContent` of `type: "diff"` an edit tool emits on its
 * `tool_call_update`. `oldText === null` marks a whole-file write (no prior
 * content). A renderer summarises this as file + ± line counts + a bounded
 * unified snippet.
 */
export interface RichDiff {
  readonly path: string;
  readonly oldText: string | null;
  readonly newText: string;
}

export interface RichTool {
  readonly toolCallId: string;
  title: string;
  kind?: string;
  /** pending | in_progress | completed | failed */
  status: string;
  /** Inline edit diffs (edit/write family), when the call carried `type:"diff"` content. */
  diffs?: RichDiff[];
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
 * Lift inline edit diffs off a tool_call(_update)'s `content` array (the ACP
 * `type: "diff"` entries an edit tool emits, see acp/tool-kind.ts `diffContent`).
 * Returns undefined when the update carries no diff content — a `tool_result`
 * update's `content` is `type:"content"` (text), so it never clobbers diffs.
 */
function diffsFromUpdate(update: SessionUpdate): RichDiff[] | undefined {
  const content = (update as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const diffs: RichDiff[] = [];
  for (const c of content) {
    const d = c as {
      type?: string;
      path?: unknown;
      oldText?: unknown;
      newText?: unknown;
    };
    if (d?.type !== "diff" || typeof d.path !== "string") continue;
    diffs.push({
      path: d.path,
      oldText: typeof d.oldText === "string" ? d.oldText : null,
      newText: typeof d.newText === "string" ? d.newText : "",
    });
  }
  return diffs.length > 0 ? diffs : undefined;
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
        const diffs = diffsFromUpdate(update);
        const tool: RichTool = {
          toolCallId: u.toolCallId,
          title: u.title ?? "",
          ...(u.kind !== undefined && { kind: u.kind }),
          status: u.status ?? "pending",
          ...(diffs !== undefined && { diffs }),
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
        const diffs = diffsFromUpdate(update);
        const existing = this.tools.get(u.toolCallId);
        if (existing !== undefined) {
          if (u.title !== undefined) existing.title = u.title;
          if (u.kind !== undefined) existing.kind = u.kind;
          if (u.status !== undefined) existing.status = u.status;
          // Only overwrite diffs when this update actually carried them, so a
          // later tool_result (text content) can't wipe the edit's diff.
          if (diffs !== undefined) existing.diffs = diffs;
        } else {
          // An update with no prior tool_call — start one in this lane.
          const tool: RichTool = {
            toolCallId: u.toolCallId,
            title: u.title ?? "",
            ...(u.kind !== undefined && { kind: u.kind }),
            status: u.status ?? "in_progress",
            ...(diffs !== undefined && { diffs }),
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
