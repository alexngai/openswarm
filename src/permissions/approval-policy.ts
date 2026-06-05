/**
 * Granular approval policy (E5).
 *
 * Controls WHEN to prompt the user for approval, layered on top of
 * PermissionMode (which controls WHAT is allowed at all).
 *
 * Codex has 5 modes: Never, OnFailure, OnRequest, UnlessTrusted, Granular.
 * We implement 5 equivalent modes:
 *   - "never"          — auto-allow everything (dangerous)
 *   - "always"         — always prompt before execution
 *   - "unless-allowed" — prompt unless exec-policy explicitly allows
 *   - "on-failure"     — auto-allow; prompt only on retry after failure
 *   - "on-request"     — auto-allow; prompt when agent explicitly requests
 *
 * The approval policy sits between PermissionEngine.check() (mode gate)
 * and actual execution. If the mode gate denies, approval policy doesn't
 * matter — the action is blocked. If the mode gate allows, the approval
 * policy decides whether to prompt.
 */

import type { ExecPolicy, PolicyDecision } from "../tools/tier0/exec-policy.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApprovalPolicyMode =
  | "never"
  | "always"
  | "unless-allowed"
  | "on-failure"
  | "on-request";

export interface ApprovalDecision {
  readonly requiresApproval: boolean;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// ApprovalPolicy
// ---------------------------------------------------------------------------

export class ApprovalPolicy {
  constructor(
    private readonly mode: ApprovalPolicyMode,
    private readonly execPolicy?: ExecPolicy,
  ) {}

  get policyMode(): ApprovalPolicyMode {
    return this.mode;
  }

  checkCommand(command: string, isRetry = false): ApprovalDecision {
    switch (this.mode) {
      case "never":
        return { requiresApproval: false, reason: "approval policy: never" };

      case "always":
        return { requiresApproval: true, reason: "approval policy: always" };

      case "unless-allowed": {
        if (!this.execPolicy) {
          return { requiresApproval: true, reason: "no exec-policy configured" };
        }
        const result = this.execPolicy.evaluate(command);
        if (result.decision === "allow") {
          return {
            requiresApproval: false,
            reason: result.justification ?? "allowed by exec-policy",
          };
        }
        if (result.decision === "forbidden") {
          return {
            requiresApproval: true,
            reason: result.justification ?? "forbidden by exec-policy",
          };
        }
        return {
          requiresApproval: true,
          reason: result.justification ?? "requires approval per exec-policy",
        };
      }

      case "on-failure":
        if (isRetry) {
          return { requiresApproval: true, reason: "retry after failure" };
        }
        return { requiresApproval: false, reason: "approval policy: on-failure (first attempt)" };

      case "on-request":
        return { requiresApproval: false, reason: "approval policy: on-request" };
    }
  }

  checkTool(toolName: string, _input?: unknown): ApprovalDecision {
    switch (this.mode) {
      case "never":
        return { requiresApproval: false, reason: "approval policy: never" };
      case "always":
        return { requiresApproval: true, reason: "approval policy: always" };
      case "unless-allowed":
        return { requiresApproval: true, reason: "tool calls require approval in unless-allowed mode" };
      case "on-failure":
        return { requiresApproval: false, reason: "approval policy: on-failure" };
      case "on-request":
        return { requiresApproval: false, reason: "approval policy: on-request" };
    }
  }

  static default(): ApprovalPolicy {
    return new ApprovalPolicy("unless-allowed");
  }
}
