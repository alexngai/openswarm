/**
 * cascade-actions.ts — docs/44 P8 (H5). OpenHive's cascade-action command
 * channel: the hub sends `x-cascade/request.*` JSON-RPC notifications to the
 * swarm's MAP server; the runtime executes the corresponding Track-A primitive
 * and emits an `x-cascade/stream.*` result event back on the MAP bus.
 *
 * Fire-and-forget (notifications, no response) — mirrors macro-agent's
 * `src/map/cascade-action-handler.ts` and OpenHive's `sendCascadeAction`.
 *
 * Action → primitive mapping (swarm-harness has a leaner BranchPolicyAdapter
 * than macro's GitCascadeAdapter, so some macro actions are best-effort):
 *   merge   → host.mergeStreamIdIntoBranch(stream_id, target)
 *   resolve → host.resolveConflict(conflict_id)  (P2 coordinator signal)
 *   abandon → no merge performed; emit abandoned (stream stays on its branch)
 *   commit  → not stream-keyed in swarm-harness → unsupported note
 *   pause   → no stream pause yet → unsupported note
 *   resume  → no stream pause yet → unsupported note
 *   push    → not supported here  → unsupported note
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
        // swarm-harness abandon is a landing decision — the stream stays on its
        // own branch, unmerged. Surface it so the hub stops tracking it.
        deps.emit({
          type: "x-cascade/stream.abandoned",
          data: { stream_id: streamId, reason: p.reason ?? "hub-request" },
        });
        log(`[cascade] abandoned ${streamId}`);
        return;
      }
      case "commit":
      case "pause":
      case "resume":
      case "push":
        unsupported(action, streamId, "not supported by the swarm-harness host");
        return;
      default:
        unsupported(action, streamId, "unknown cascade action");
        return;
    }
  }

  function unsupported(action: string, streamId: string, why: string): void {
    deps.emit({
      type: "x-cascade/stream.unsupported",
      data: { action, stream_id: streamId, reason: why },
    });
    log(`[cascade] ${action}(${streamId}) unsupported: ${why}`);
  }
}
