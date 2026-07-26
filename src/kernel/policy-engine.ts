/**
 * Discriminated operation policy (docs/63 §A2, WP-00).
 *
 * The existing gate is `(toolName, unknownInput) => decision`, which cannot
 * express a grant narrower than "this tool, any argument": there is no resource
 * identity in the request to bind to. This engine decides against a
 * discriminated `OperationRequest`, so a grant names an exact resource and
 * operation class and can be audited and revoked as such.
 *
 * Default grant scope is the session (docs/63 locked decisions). One-shot and
 * persistent grants exist but must be chosen explicitly by the approver; the
 * engine never upgrades a scope on its own.
 */

import type {
  GrantScope,
  OperationClass,
  OperationRequest,
  PolicyDecision,
} from "./contracts.js";

/** Standing allowance for a whole operation class, independent of resource. */
export type StandingRule = "allow" | "deny" | "ask";

export interface PolicyRules {
  readonly "file.read": StandingRule;
  readonly "file.write": StandingRule;
  readonly "process.exec": StandingRule;
  readonly "network.request": StandingRule;
}

/** Read-only preset: observation is free, everything else is asked for. */
export const READ_ONLY_RULES: PolicyRules = {
  "file.read": "allow",
  "file.write": "ask",
  "process.exec": "ask",
  "network.request": "ask",
};

/** Workspace-write preset: in-workspace mutation is allowed without asking. */
export const WORKSPACE_WRITE_RULES: PolicyRules = {
  "file.read": "allow",
  "file.write": "allow",
  "process.exec": "ask",
  "network.request": "ask",
};

export interface ApprovalRequest {
  readonly request: OperationRequest;
  readonly operationClass: OperationClass;
  /** The exact resource an approval would be bound to. */
  readonly resource: string;
}

export interface ApprovalResponse {
  readonly approved: boolean;
  /** Defaults to "session" when the approver does not choose. */
  readonly scope?: GrantScope;
  readonly reason?: string;
}

/**
 * Asks a human (TTY, ACP client, or authenticated headless endpoint). Absent
 * broker means nobody can be asked, which is a denial rather than an allowance
 * — headless runs must fail closed (docs/63 §DDP-SAFE-05).
 */
export interface ApprovalBroker {
  request(req: ApprovalRequest): Promise<ApprovalResponse>;
}

/** Identifies the resource a grant binds to, per operation class. */
export function resourceOf(request: OperationRequest): string {
  switch (request.kind) {
    case "file.read":
    case "file.write":
      return request.path.canonical;
    case "process.exec":
      return request.command;
    case "network.request":
      return new URL(request.url).host;
  }
}

export class PolicyEngine {
  /** Session-scoped grants, keyed by `class\0resource`. */
  private readonly sessionGrants = new Set<string>();
  private readonly rulesOf: () => PolicyRules;

  /**
   * `rules` may be a function so a caller whose policy changes mid-session —
   * the CLI's `/permissions` and `request_permissions` elevation both do — is
   * read fresh per call rather than frozen at construction. Grants outlive a
   * rule change on purpose: they were approved for an exact resource, and a
   * later widening of the standing rules does not invalidate that consent.
   */
  constructor(
    rules: PolicyRules | (() => PolicyRules),
    private readonly broker?: ApprovalBroker,
  ) {
    this.rulesOf = typeof rules === "function" ? rules : () => rules;
  }

  private static key(operationClass: OperationClass, resource: string): string {
    return `${operationClass}\0${resource}`;
  }

  async authorize(request: OperationRequest): Promise<PolicyDecision> {
    const operationClass = request.kind;
    const resource = resourceOf(request);
    const rule = this.rulesOf()[operationClass];

    if (rule === "allow") {
      return { allowed: true, source: `rule:${operationClass}=allow` };
    }
    if (rule === "deny") {
      return {
        allowed: false,
        reason: `${operationClass} is denied by policy`,
        source: `rule:${operationClass}=deny`,
      };
    }

    // rule === "ask": an existing session grant for this exact resource stands
    // in for the approver, but never widens to a different resource.
    const key = PolicyEngine.key(operationClass, resource);
    if (this.sessionGrants.has(key)) {
      return {
        allowed: true,
        source: "grant:session",
        grant: { scope: "session", operationClass, resource },
      };
    }

    if (!this.broker) {
      return {
        allowed: false,
        reason: `${operationClass} on ${resource} needs approval and no approver is connected`,
        source: "approval:unavailable",
      };
    }

    const response = await this.broker.request({ request, operationClass, resource });
    if (!response.approved) {
      return {
        allowed: false,
        reason: response.reason ?? `approval denied for ${operationClass} on ${resource}`,
        source: "approval:denied",
      };
    }

    const scope = response.scope ?? "session";
    if (scope === "session" || scope === "persistent") {
      this.sessionGrants.add(key);
    }

    return {
      allowed: true,
      source: `approval:${scope}`,
      grant: { scope, operationClass, resource },
    };
  }

  /** Test and diagnostics hook: which grants this session has accumulated. */
  grantCount(): number {
    return this.sessionGrants.size;
  }
}
