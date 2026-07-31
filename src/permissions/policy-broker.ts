/**
 * Adapts the existing approval surfaces to the kernel's `ApprovalBroker`.
 *
 * The prompt plumbing already works and is wired into three surfaces — the
 * REPL via `PermissionBridge`, headless via `readHeadlessApproval`, and ACP via
 * a `PermissionBridge` subclass. None of it needs replacing. What changes is
 * what an approval *binds to*: the old path returns a bare allow that applies
 * to nothing in particular, while the policy engine records a grant against an
 * exact operation class and resource.
 *
 * Scope mapping preserves the established UX. A plain "y" has always meant
 * "just this once", and "a"/"always" has meant "for the rest of the session",
 * so they map to `one-shot` and `session` respectively. The policy engine's own
 * default is `session`; passing the scope explicitly keeps the user's choice
 * authoritative rather than letting a default silently widen it.
 *
 * Note the resulting asymmetry with `SessionAllowRules`, which remembers bash
 * command prefixes. Grants here are keyed by canonical resource, so approving a
 * write to one file does not approve a write to another — which is the whole
 * point, and why the two cannot simply be merged.
 */

import type {
  ApprovalBroker,
  ApprovalRequest,
  ApprovalResponse,
} from "../kernel/policy-engine.js";
import type { BridgeDecision, PermissionBridge } from "./bridge.js";
import { readHeadlessApproval } from "./headless-prompt.js";
import type { PermissionMode } from "../core/types.js";

export interface BrokerDeps {
  readonly bridge: PermissionBridge;
  /** When true, prompts read from stdin instead of the bridge. */
  readonly useHeadless: boolean;
  readonly getCurrentMode: () => PermissionMode;
}

/**
 * Renders the resource into the prompt payload. The existing surfaces show
 * `input`, which for a file operation buries the path inside a tool-shaped
 * object; naming the resource explicitly is what lets a user tell which file
 * they are approving.
 */
function pendingFor(
  req: ApprovalRequest,
  currentMode: PermissionMode,
): Parameters<PermissionBridge["request"]>[0] {
  return {
    toolName: req.request.toolName,
    input: { operation: req.operationClass, resource: req.resource },
    currentMode,
    requiredPermission: req.operationClass === "file.read" ? "read" : "write",
    reason: `${req.request.toolName} requests ${req.operationClass} on ${req.resource}`,
  };
}

export function makeApprovalBroker(deps: BrokerDeps): ApprovalBroker {
  return {
    async request(req: ApprovalRequest): Promise<ApprovalResponse> {
      const pending = pendingFor(req, deps.getCurrentMode());
      // Release the surface if the engine stops waiting. The bridge is strictly
      // serial, so an abandoned prompt would otherwise hold its slot and refuse
      // every later ask; the headless reader would otherwise keep a stdin
      // listener that swallows a line meant for the next question.
      const onAbort = (): void => deps.bridge.cancel("approval request expired");
      if (!deps.useHeadless) {
        req.signal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        const decision = deps.useHeadless
          ? await readHeadlessApproval(pending, { signal: req.signal })
          : await deps.bridge.request(pending);
        return toResponse(req, decision);
      } finally {
        req.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

function toResponse(req: ApprovalRequest, decision: BridgeDecision): ApprovalResponse {

      // Echo the id so the engine can tell this apart from a stale decision, a
      // replay, or an answer to a question it never asked. In-process this is
      // bookkeeping; for the ACP and headless surfaces the response crosses a
      // boundary the engine does not control, and there it is the only thing
      // tying an answer to its question (docs/63 WP-09).
  if (!decision.allow) {
    return { approved: false, requestId: req.id, reason: decision.reason };
  }
  return {
    approved: true,
    requestId: req.id,
    scope: decision.alwaysAllow === true ? "session" : "one-shot",
  };
}
