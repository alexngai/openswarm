/**
 * Discriminated operation policy (docs/67 §A2, WP-00).
 *
 * The existing gate is `(toolName, unknownInput) => decision`, which cannot
 * express a grant narrower than "this tool, any argument": there is no resource
 * identity in the request to bind to. This engine decides against a
 * discriminated `OperationRequest`, so a grant names an exact resource and
 * operation class and can be audited and revoked as such.
 *
 * Default grant scope is the session (docs/67 locked decisions). One-shot and
 * persistent grants exist but must be chosen explicitly by the approver; the
 * engine never upgrades a scope on its own.
 */

import { randomUUID } from "node:crypto";

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
  /**
   * Unique per ask. A response that does not echo it is not an answer to this
   * question, whether because it is malformed, because it is a replay of an
   * earlier decision, or because two asks crossed on the wire.
   */
  readonly id: string;
  /**
   * Wall-clock ms after which a decision is no longer accepted. Approvals are
   * decided in a context — this file, this command, this moment — and an answer
   * that arrives long after the question does not carry that context with it.
   */
  readonly expiresAt: number;
  /**
   * Aborted when the engine stops accepting a decision for this ask, so the
   * surface holding the prompt can let it go.
   *
   * Without this, giving up leaks: the engine moves on while the approver still
   * believes a question is outstanding, and because the bridge is strictly
   * serial that stale question refuses every later ask for the rest of the
   * session. Failing closed once is correct; failing closed forever, for a
   * reason that mentions an unrelated earlier request, is an outage.
   */
  readonly signal: AbortSignal;
}

export interface ApprovalResponse {
  readonly approved: boolean;
  /** The `id` of the request being answered. Required: see `ApprovalRequest.id`. */
  readonly requestId: string;
  /** Defaults to "session" when the approver does not choose. */
  readonly scope?: GrantScope;
  readonly reason?: string;
}

/**
 * Asks a human (TTY, ACP client, or authenticated headless endpoint). Absent
 * broker means nobody can be asked, which is a denial rather than an allowance
 * — headless runs must fail closed (docs/67 §DDP-SAFE-05).
 */
export interface ApprovalBroker {
  request(req: ApprovalRequest): Promise<ApprovalResponse>;
}

export interface PolicyEngineOptions {
  /**
   * How long an ask stays open. A human deciding whether to let an agent run
   * `rm -rf` should not be rushed, so this is generous by default; what it
   * bounds is the case where nobody is there at all.
   */
  readonly approvalTimeoutMs?: number;
  /**
   * How long a session or persistent grant is honoured for. Unset means "as long
   * as this session lasts", which is the established behaviour; setting it bounds
   * consent in time for a run long enough that the operator's original decision
   * has gone stale.
   */
  readonly grantTtlMs?: number;
  /**
   * The identity of the workspace the operator vouched for, read fresh whenever
   * a grant is used. A grant is consent given about a particular repository in a
   * particular state; if that identity changes, the consent does not carry over.
   *
   * Checking rather than subscribing is deliberate. A revocation event has to be
   * delivered to be honoured, and the failure mode of a missed event is a grant
   * that outlives the trust it rested on — silently, and in the direction of
   * permitting more. Re-reading the identity cannot be missed.
   */
  readonly trustBinding?: () => string | undefined;
  /** Injectable clock, for tests and for anything that needs a monotonic source. */
  readonly now?: () => number;
  /** Receives every decision that involved an approver, for audit. */
  readonly onDecision?: (entry: ApprovalAudit) => void;
}

/** What was asked, what came back, and what the engine concluded. */
export interface ApprovalAudit {
  readonly requestId: string;
  readonly operationClass: OperationClass;
  readonly resource: string;
  readonly askedAt: number;
  readonly decidedAt: number;
  readonly allowed: boolean;
  readonly source: string;
  readonly reason?: string;
}

/** Twenty minutes: long enough to think, short enough to notice an outage. */
const DEFAULT_APPROVAL_TIMEOUT_MS = 20 * 60 * 1000;

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

/** A grant the engine is holding, with whatever bounds it was given. */
interface HeldGrant {
  readonly scope: GrantScope;
  readonly operationClass: OperationClass;
  readonly resource: string;
  /** Wall-clock ms, or undefined for "as long as the session lasts". */
  readonly expiresAt?: number;
  /** Remaining uses, or undefined for unlimited within its lifetime. */
  remainingUses?: number;
  /** The workspace identity in force when this was granted, if any. */
  readonly trustBinding?: string;
}

export class PolicyEngine {
  /** Grants keyed by `class\0resource`. */
  private readonly grants = new Map<string, HeldGrant>();
  private readonly rulesOf: () => PolicyRules;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly onDecision?: (entry: ApprovalAudit) => void;
  private readonly grantTtlMs?: number;
  private readonly trustBinding?: () => string | undefined;
  /**
   * Ids of asks already answered. Kept so a response echoing one of them is
   * reported as the replay it is, rather than as a generic malformed response —
   * the two call for different investigations.
   */
  private readonly answered = new Set<string>();

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
    opts: PolicyEngineOptions = {},
  ) {
    this.rulesOf = typeof rules === "function" ? rules : () => rules;
    this.timeoutMs = opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.now = opts.now ?? (() => Date.now());
    this.onDecision = opts.onDecision;
    this.grantTtlMs = opts.grantTtlMs;
    this.trustBinding = opts.trustBinding;
  }

  private static key(operationClass: OperationClass, resource: string): string {
    return `${operationClass}\0${resource}`;
  }

  /**
   * Drop grants, so consent can be withdrawn without restarting the process.
   *
   * With no predicate this revokes everything, which is what a workspace whose
   * trust was invalidated needs: the grants were given on the understanding
   * that this was the repository the operator vouched for, and that
   * understanding no longer holds. Revocation is deliberately blunt for that
   * reason — re-asking is cheap, and guessing which grants are still justified
   * is how a revocation quietly keeps something alive.
   */
  revokeGrants(predicate?: (grant: HeldGrant) => boolean): number {
    let removed = 0;
    for (const [key, grant] of this.grants) {
      if (predicate !== undefined && !predicate(grant)) continue;
      this.grants.delete(key);
      removed += 1;
    }
    return removed;
  }

  /**
   * The grant standing in for the approver, or undefined. Expired and exhausted
   * grants are dropped here rather than merely skipped, so a stale grant cannot
   * come back if the clock or the caller changes.
   */
  private liveGrant(key: string): HeldGrant | undefined {
    const grant = this.grants.get(key);
    if (grant === undefined) return undefined;
    if (grant.expiresAt !== undefined && this.now() >= grant.expiresAt) {
      this.grants.delete(key);
      return undefined;
    }
    if (grant.trustBinding !== undefined && grant.trustBinding !== this.trustBinding?.()) {
      this.grants.delete(key);
      return undefined;
    }
    if (grant.remainingUses !== undefined) {
      if (grant.remainingUses <= 0) {
        this.grants.delete(key);
        return undefined;
      }
      grant.remainingUses -= 1;
    }
    return grant;
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

    // rule === "ask": an existing grant for this exact resource stands in for
    // the approver, but never widens to a different resource.
    const key = PolicyEngine.key(operationClass, resource);
    const held = this.liveGrant(key);
    if (held !== undefined) {
      return {
        allowed: true,
        source: `grant:${held.scope}`,
        grant: { scope: held.scope, operationClass, resource },
      };
    }

    if (!this.broker) {
      return {
        allowed: false,
        reason: `${operationClass} on ${resource} needs approval and no approver is connected`,
        source: "approval:unavailable",
      };
    }

    return this.ask(request, operationClass, resource, key);
  }

  /**
   * Put the question to the approver and decide what the answer was worth.
   *
   * Everything here is a denial except one narrow path: a well-formed approval
   * that answers this question, and arrives while the question is still open.
   * The denials are kept distinct because they call for different responses — a
   * timeout is an operational problem, a replay is a security one, and reporting
   * both as "denied" means neither gets looked at.
   */
  private async ask(
    request: OperationRequest,
    operationClass: OperationClass,
    resource: string,
    key: string,
  ): Promise<PolicyDecision> {
    const askedAt = this.now();
    const abort = new AbortController();
    const ask: ApprovalRequest = {
      request,
      operationClass,
      resource,
      id: randomUUID(),
      expiresAt: askedAt + this.timeoutMs,
      signal: abort.signal,
    };

    const settle = (decision: PolicyDecision): PolicyDecision => {
      this.onDecision?.({
        requestId: ask.id,
        operationClass,
        resource,
        askedAt,
        decidedAt: this.now(),
        allowed: decision.allowed,
        source: decision.source,
        ...(decision.allowed ? {} : { reason: decision.reason }),
      });
      return decision;
    };

    let response: ApprovalResponse | typeof TIMED_OUT;
    try {
      response = await withDeadline(this.broker!.request(ask), this.timeoutMs);
    } catch (err) {
      // Asking failed rather than being answered — a closed transport, a crashed
      // approver. Nobody said yes, so nobody said yes.
      return settle({
        allowed: false,
        reason: `could not ask for approval of ${operationClass} on ${resource}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        source: "approval:unavailable",
      });
    }

    if (response === TIMED_OUT) {
      abort.abort(new Error("approval request expired"));
      return settle({
        allowed: false,
        reason: `approval for ${operationClass} on ${resource} was not answered in time`,
        source: "approval:timeout",
      });
    }

    if (typeof response?.approved !== "boolean" || typeof response.requestId !== "string") {
      return settle({
        allowed: false,
        reason: `approval response for ${operationClass} on ${resource} was not a decision`,
        source: "approval:invalid",
      });
    }

    if (response.requestId !== ask.id) {
      const replay = this.answered.has(response.requestId);
      return settle({
        allowed: false,
        reason: replay
          ? `approval response replayed a decision from an earlier request`
          : `approval response answered a request that was never issued`,
        source: replay ? "approval:replayed" : "approval:invalid",
      });
    }

    this.answered.add(ask.id);

    if (this.now() >= ask.expiresAt) {
      // Raced the deadline from the inside: the answer is here, but the question
      // closed while it was in flight.
      return settle({
        allowed: false,
        reason: `approval for ${operationClass} on ${resource} arrived after it expired`,
        source: "approval:expired",
      });
    }

    if (!response.approved) {
      return settle({
        allowed: false,
        reason: response.reason ?? `approval denied for ${operationClass} on ${resource}`,
        source: "approval:denied",
      });
    }

    const scope = response.scope ?? "session";
    if (scope === "session" || scope === "persistent") {
      const binding = this.trustBinding?.();
      this.grants.set(key, {
        scope,
        operationClass,
        resource,
        ...(this.grantTtlMs !== undefined && {
          expiresAt: this.now() + this.grantTtlMs,
        }),
        ...(binding !== undefined && { trustBinding: binding }),
      });
    }

    return settle({
      allowed: true,
      source: `approval:${scope}`,
      grant: { scope, operationClass, resource },
    });
  }

  /** Test and diagnostics hook: which grants this session has accumulated. */
  grantCount(): number {
    // Counted through the live check so an expired grant is not reported as one
    // the engine would honour.
    let live = 0;
    for (const key of [...this.grants.keys()]) {
      const grant = this.grants.get(key);
      if (grant === undefined) continue;
      if (grant.expiresAt !== undefined && this.now() >= grant.expiresAt) {
        this.grants.delete(key);
        continue;
      }
      live += 1;
    }
    return live;
  }
}

const TIMED_OUT = Symbol("approval timed out");

/**
 * Resolve with the promise's value, or with `TIMED_OUT` once `ms` has passed.
 *
 * The losing promise is not cancelled, because an approver cannot be un-asked;
 * what changes is that the engine stops treating the answer as binding. The
 * timer is unref'd so a pending ask never holds the process open.
 */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
