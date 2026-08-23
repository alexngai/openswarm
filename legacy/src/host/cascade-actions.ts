/**
 * cascade-actions.ts — docs/44 P8 (H5). OpenHive's cascade-action command
 * channel: the hub sends `x-cascade/request.*` JSON-RPC notifications to the
 * swarm's MAP server; the runtime executes the corresponding Track-A primitive
 * and emits an `x-cascade/stream.*` result event back on the MAP bus.
 *
 * Fire-and-forget (notifications, no response) — mirrors macro-agent's
 * `src/map/cascade-action-handler.ts` and OpenHive's `sendCascadeAction`.
 *
 * Action → primitive mapping (all streamId-keyed via the host/adapter; each
 * degrades to an `unsupported` event when the host has no git-cascade adapter):
 *   merge   → host.mergeStreamIdIntoBranch(stream_id, target)
 *   resolve → host.resolveConflict(conflict_id)   (P2 coordinator signal)
 *   abandon → host.abandonStream(stream_id)       (git-cascade)
 *   pause   → host.pauseStream(stream_id)          (git-cascade)
 *   resume  → host.resumeStream(stream_id)         (git-cascade)
 *   commit  → host.commitStream(stream_id, msg)    (Change-Id tracked)
 *   push    → host.pushStream(stream_id, remote)   (raw git)
 */

import type { StandaloneHost } from "../swarm/standalone-host.js";

/** Minimal per-connection router surface we need (matches MAP SDK's). */
export interface CascadeRouter {
  onNotification(handler: (method: string, params: unknown) => void): void;
}

/** Emit a result event onto the MAP bus (id/timestamp added by the server). */
export type CascadeEmit = (event: {
  type: string;
  data: unknown;
}) => void;

export interface CascadeActionsDeps {
  readonly host: StandaloneHost;
  readonly emit: CascadeEmit;
  readonly log?: (msg: string) => void;
}

const ACTION_PREFIX = "x-cascade/request.";

interface CascadeParams {
  stream_id?: string;
  target_stream_id?: string;
  reason?: string;
  conflict_id?: string;
  strategy?: string;
  message?: string;
  remote?: string;
  target_ref?: string;
}

/**
 * Wire cascade-action handling onto a per-connection router. Returns nothing;
 * the router lives for the connection's lifetime.
 */
export function registerCascadeActions(
  router: CascadeRouter,
  deps: CascadeActionsDeps,
): void {
  const log = deps.log ?? (() => {});

  router.onNotification((method, rawParams) => {
    if (!method.startsWith(ACTION_PREFIX)) return;
    const action = method.slice(ACTION_PREFIX.length);
    const p = (rawParams ?? {}) as CascadeParams;
    const streamId = p.stream_id;
    if (streamId === undefined || streamId === "") {
      deps.emit({
        type: "x-cascade/stream.error",
        data: { action, error: "stream_id is required" },
      });
      return;
    }
    // Each branch handles its own async + emission; errors never throw out of
    // the notification handler (fire-and-forget).
    void dispatch(action, streamId, p).catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      deps.emit({ type: "x-cascade/stream.error", data: { action, streamId, error } });
      log(`[cascade] ${action}(${streamId}) failed: ${error}`);
    });
  });

  async function dispatch(
    action: string,
    streamId: string,
    p: CascadeParams,
  ): Promise<void> {
    switch (action) {
      case "merge": {
        const target = p.target_stream_id ?? "main";
        const result = await deps.host.mergeStreamIdIntoBranch(streamId, target);
        if (result === null) {
          unsupported(action, streamId, "adapter does not support branch merges");
          return;
        }
        if (result.success) {
          deps.emit({
            type: "x-cascade/stream.merged",
            data: { stream_id: streamId, target, newHead: result.newHead },
          });
          log(`[cascade] merged ${streamId} → ${target}`);
        } else {
          deps.emit({
            type: "x-cascade/stream.conflict",
            data: {
              stream_id: streamId,
              target,
              errorType: result.errorType,
              conflicts: result.conflicts,
              error: result.error,
            },
          });
          log(`[cascade] merge ${streamId} → ${target}: ${result.errorType}`);
        }
        return;
      }
      case "resolve": {
        // OpenHive completes an escalated conflict — signal the P2 coordinator
        // so a pending `waitForConflictResolution` wakes and the merge retries.
        const conflictId = p.conflict_id ?? streamId;
        deps.host.resolveConflict(conflictId);
        deps.emit({
          type: "x-cascade/stream.resolved",
          data: { stream_id: streamId, conflict_id: conflictId, strategy: p.strategy },
        });
        log(`[cascade] resolved ${conflictId}`);
        return;
      }
      case "abandon": {
        const r = await deps.host.abandonStream(streamId, p.reason);
        if (r === null) {
          unsupported(action, streamId, "adapter does not support abandon");
          return;
        }
        deps.emit({
          type: r.success ? "x-cascade/stream.abandoned" : "x-cascade/stream.error",
          data: { stream_id: streamId, reason: p.reason ?? "hub-request", ...(r.error !== undefined && { error: r.error }) },
        });
        log(`[cascade] abandon ${streamId}: ${r.success ? "ok" : r.error}`);
        return;
      }
      case "pause": {
        const r = await deps.host.pauseStream(streamId, p.reason);
        if (r === null) {
          unsupported(action, streamId, "adapter does not support pause");
          return;
        }
        emitOp("paused", streamId, r);
        return;
      }
      case "resume": {
        const r = await deps.host.resumeStream(streamId);
        if (r === null) {
          unsupported(action, streamId, "adapter does not support resume");
          return;
        }
        emitOp("resumed", streamId, r);
        return;
      }
      case "commit": {
        const r = await deps.host.commitStream(
          streamId,
          p.message ?? "Commit via cascade action",
        );
        if (r === null) {
          unsupported(action, streamId, "adapter does not support commit");
          return;
        }
        deps.emit({
          type: r.success ? "x-cascade/stream.committed" : "x-cascade/stream.error",
          data: {
            stream_id: streamId,
            ...(r.commit !== undefined && { commit: r.commit }),
            ...(r.changeId !== undefined && { changeId: r.changeId }),
            ...(r.error !== undefined && { error: r.error }),
          },
        });
        log(`[cascade] commit ${streamId}: ${r.success ? r.commit : r.error}`);
        return;
      }
      case "push": {
        const r = await deps.host.pushStream(streamId, p.remote, p.target_ref);
        if (r === null) {
          unsupported(action, streamId, "adapter does not support push");
          return;
        }
        deps.emit({
          type: r.success ? "x-cascade/stream.pushed" : "x-cascade/stream.error",
          data: {
            stream_id: streamId,
            ...(r.pushedCommit !== undefined && { pushedCommit: r.pushedCommit }),
            ...(r.error !== undefined && { error: r.error }),
          },
        });
        log(`[cascade] push ${streamId}: ${r.success ? "ok" : r.error}`);
        return;
      }
      default:
        unsupported(action, streamId, "unknown cascade action");
        return;
    }
  }

  /** Emit a paused/resumed result + log. */
  function emitOp(
    kind: "paused" | "resumed",
    streamId: string,
    r: { success: boolean; error?: string },
  ): void {
    deps.emit({
      type: r.success ? `x-cascade/stream.${kind}` : "x-cascade/stream.error",
      data: { stream_id: streamId, ...(r.error !== undefined && { error: r.error }) },
    });
    log(`[cascade] ${kind} ${streamId}: ${r.success ? "ok" : r.error}`);
  }

  function unsupported(action: string, streamId: string, why: string): void {
    deps.emit({
      type: "x-cascade/stream.unsupported",
      data: { action, stream_id: streamId, reason: why },
    });
    log(`[cascade] ${action}(${streamId}) unsupported: ${why}`);
  }
}
