/**
 * opentasks-task-registry.ts — TaskAPI wrapper that mirrors create / update /
 * stop into a running opentasks daemon for cross-system task graph
 * visibility.
 *
 * v0.5 stage 5B. Wraps an inner TaskAPI (typically the in-memory one
 * StandaloneHost owns). Local operations remain authoritative; the
 * opentasks mirror is best-effort — RPC failures never block the swarm
 * runtime, they just log and skip the mirror call.
 *
 * Design rationale (docs/25 §10.3): swarm-harness needs the local
 * TaskRegistry for runtime-critical state (output streaming, ownership,
 * stop attribution) which the opentasks graph model doesn't directly
 * support. The mirror gives external consumers (cc-swarm, MAP observers,
 * Beads etc.) a federated view without coupling the runtime to the
 * daemon's availability.
 */

import type { AgentId } from "../../core/types.js";
import type { TaskAPI, TaskFilter, TaskPacket, TaskRecord } from "../host.js";
import type { OpenTasksClient } from "./opentasks-client.js";

/** Map a swarm-harness TaskRecord status to an opentasks node status. */
function mapStatus(swarmStatus: TaskRecord["status"]): string {
  switch (swarmStatus) {
    case "pending":
      return "pending";
    case "running":
      return "in_progress";
    case "succeeded":
      return "complete";
    case "failed":
      return "failed";
    case "stopped":
      return "cancelled";
    case "timeout":
      return "failed";
  }
}

export interface OpenTasksTaskRegistryOptions {
  /**
   * Maximum length to truncate a task's prompt for the opentasks node title.
   * Default 80 chars; the full prompt is sent in `content`.
   */
  readonly titleMaxLength?: number;
}

export class OpenTasksTaskRegistry implements TaskAPI {
  private readonly idMap = new Map<string, string>();
  private readonly titleMaxLength: number;

  constructor(
    private readonly inner: TaskAPI,
    private readonly client: OpenTasksClient,
    opts: OpenTasksTaskRegistryOptions = {},
  ) {
    this.titleMaxLength = opts.titleMaxLength ?? 80;
  }

  async create(packet: Omit<TaskPacket, "id">): Promise<TaskRecord> {
    // Local first — never block on the mirror.
    const local = await this.inner.create(packet);

    // Mirror to opentasks (best-effort, fire-and-forget).
    const title = local.prompt.slice(0, this.titleMaxLength);
    void this.client
      .create({
        type: "task",
        title: title.length > 0 ? title : "(empty prompt)",
        status: "pending",
        content: local.prompt,
        metadata: {
          swarmTaskId: local.id,
          scope: local.scope,
        },
      })
      .then((remote) => {
        if (remote !== null) {
          this.idMap.set(local.id, remote.id);
        }
      });

    return local;
  }

  async update(
    id: string,
    patch: Partial<Pick<TaskRecord, "status" | "owner" | "output" | "error">>,
  ): Promise<void> {
    await this.inner.update(id, patch);

    const remoteId = this.idMap.get(id);
    if (remoteId === undefined) return;

    // Mirror status / assignee changes; output deltas stay local (the graph
    // model isn't a stream).
    const updates: { status?: string; assignee?: string } = {};
    if (patch.status !== undefined) updates.status = mapStatus(patch.status);
    if (patch.owner !== undefined) updates.assignee = patch.owner;
    if (Object.keys(updates).length === 0) return;

    void this.client.update(remoteId, updates);
  }

  async stop(id: string, by?: AgentId | "orchestrator"): Promise<void> {
    await this.inner.stop(id, by);
    const remoteId = this.idMap.get(id);
    if (remoteId === undefined) return;
    void this.client.update(remoteId, {
      status: "cancelled",
      ...(by !== undefined && { metadata: { stoppedBy: by } }),
    });
  }

  // ---- Read-only / streaming ops delegate to the inner registry only. ----

  async get(id: string): Promise<TaskRecord | undefined> {
    return await this.inner.get(id);
  }

  async list(filter?: TaskFilter): Promise<readonly TaskRecord[]> {
    return await this.inner.list(filter);
  }

  async ownerOf(taskId: string): Promise<AgentId | undefined> {
    return await this.inner.ownerOf(taskId);
  }

  appendOutput(id: string, chunk: string): void {
    this.inner.appendOutput(id, chunk);
  }

  output(id: string): AsyncIterable<string> {
    return this.inner.output(id);
  }

  /**
   * v0.5 stage 5C: pull-next delegates to the inner registry. The opentasks
   * graph mirror is updated to reflect the claim (status → in_progress,
   * assignee → claimerId) — same shape as the regular update() path.
   */
  async pullNext(
    scope: string,
    claimerId: AgentId,
  ): Promise<TaskRecord | null> {
    const claimed = await this.inner.pullNext(scope, claimerId);
    if (claimed === null) return null;
    const remoteId = this.idMap.get(claimed.id);
    if (remoteId !== undefined) {
      void this.client.update(remoteId, {
        status: "in_progress",
        assignee: claimerId,
      });
    }
    return claimed;
  }

  // ---- Public for tests ----

  /**
   * Returns the opentasks node id for a given local task id, if mirrored.
   * Useful for tests that assert the mirror happened.
   */
  remoteIdOf(localId: string): string | undefined {
    return this.idMap.get(localId);
  }
}
