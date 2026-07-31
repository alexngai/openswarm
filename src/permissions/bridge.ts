/**
 * PermissionBridge — async coordinator between the engine's `canUseTool`
 * callback and the REPL store / headless stdin reader.
 *
 * Phase 2 design lock (doc 17 "Phase 2 — design lock 2026-04-22"):
 *   - Strictly serial. At most one pending request at a time. The reference implementation's tool
 *     dispatch is a serial for-loop and the SDK's
 *     canUseTool is one-call-per-tool-use, so there's never concurrency.
 *   - The bridge knows nothing about the UI shape. The REPL attaches a
 *     dispatch function that routes `permission-request` / `permission-response`
 *     reducer events; headless callers attach no dispatcher and drive the
 *     decision from stdin.
 *   - On deny, the returned PermissionDecision carries a reason the engine
 *     feeds to the model as a tool_result error — matching the reference implementation's
 *     structured deny outcome.
 */

import type { PendingPermission, ReplEvent } from "../ui/repl/state.js";
import type { PermissionDecision } from "../engine/index.js";

type DispatchFn = (event: ReplEvent) => void;

/**
 * PermissionDecision plus the optional session-scope marker (Phase 3 B4).
 * When a surface approves with "always allow (this session)", it sets
 * `alwaysAllow: true`; the bash gate records a SessionAllowRules entry
 * (subject to the banned-prefix veto). Plain PermissionDecision values
 * remain valid everywhere — the marker is additive.
 */
export type BridgeDecision = PermissionDecision & {
  readonly alwaysAllow?: boolean;
};

export class PermissionBridge {
  private resolver: ((decision: BridgeDecision) => void) | null = null;
  private pending: PendingPermission | null = null;
  private dispatch: DispatchFn | null = null;

  /**
   * Wire the reducer dispatch. Called by the REPL when the store is
   * constructed. Headless callers leave this unset.
   */
  attachDispatch(dispatch: DispatchFn): void {
    this.dispatch = dispatch;
  }

  /**
   * Is a request currently awaiting a decision? Used by headless reader
   * and by consumers that want to peek.
   */
  hasPending(): boolean {
    return this.resolver !== null;
  }

  /**
   * Read the current pending payload, if any. Useful for headless callers
   * that emit a JSONL `permission_required` line from the payload.
   */
  peek(): PendingPermission | null {
    return this.pending;
  }

  /**
   * Request a decision. Emits `permission-request` to the attached store
   * (if any), then blocks on the returned Promise until `respond` is called.
   *
   * Concurrent calls (before the prior response arrives) immediately resolve
   * to deny — the design is strictly serial and a second overlapping request
   * indicates a bug.
   */
  async request(pending: PendingPermission): Promise<BridgeDecision> {
    if (this.resolver !== null) {
      return {
        allow: false,
        reason:
          "permission bridge: a prior request is still awaiting a decision",
      };
    }

    this.pending = pending;
    this.dispatch?.({ type: "permission-request", request: pending });

    return await new Promise<BridgeDecision>((resolve) => {
      this.resolver = resolve;
    });
  }

  /**
   * Resolve the pending request. Called by:
   *   - the REPL prompt component when the user presses y/Enter/Ctrl-C
   *   - the headless stdin reader when it reads a line or hits EOF
   *
   * Dispatches `permission-response` to the store (so the reducer leaves
   * `awaiting-permission`) before resolving the caller's Promise.
   *
   * No-op if nothing is pending.
   */
  /**
   * Withdraw the pending question, denying it.
   *
   * Called when the asker has stopped waiting — an expired approval, an
   * abandoned turn. It is a deny rather than a silent drop because the caller is
   * still holding a promise, and because the bridge is strictly serial: leaving
   * the slot occupied would refuse every later request with a reason about this
   * one (docs/63 WP-09).
   */
  cancel(reason: string): void {
    this.respond({ allow: false, reason });
  }

  respond(decision: BridgeDecision): void {
    if (this.resolver === null) return;
    const resolve = this.resolver;
    this.resolver = null;
    this.pending = null;

    this.dispatch?.({
      type: "permission-response",
      decision: decision.allow ? "approve" : "deny",
    });
    resolve(decision);
  }
}
