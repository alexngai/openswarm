/**
 * Grants end (docs/63 `WP-09`).
 *
 * A grant used to last until the process did. For a short interactive session
 * that is roughly the same as "for now", which is why it went unnoticed; for a
 * long-running agent it is not. The operator who approved a write to one file an
 * hour ago is not necessarily still at the keyboard, still in the same
 * repository, or still of the same opinion, and a grant that cannot end is
 * consent that cannot be withdrawn.
 *
 * Four ways one ends: it expires, it runs out of uses, it is revoked, or the
 * workspace it was given about stops being the workspace it was given about.
 */

import { describe, it, expect } from "vitest";

import {
  PolicyEngine,
  READ_ONLY_RULES,
  type ApprovalBroker,
  type ApprovalAudit,
  type ApprovalRequest,
} from "../kernel/policy-engine.js";
import type { OperationRequest } from "../kernel/contracts.js";

function exec(command = "ls"): OperationRequest {
  return { kind: "process.exec", operationId: "op", command, cwd: "/w" };
}

/** Approves everything with the given scope, counting how often it was asked. */
function approver(scope: "session" | "one-shot" = "session"): ApprovalBroker & {
  asked: ApprovalRequest[];
} {
  const asked: ApprovalRequest[] = [];
  return {
    asked,
    async request(req) {
      asked.push(req);
      return { approved: true, requestId: req.id, scope };
    },
  };
}

describe("a grant expires", () => {
  it("stops standing in for the approver once its lifetime is up", async () => {
    let clock = 1_000;
    const b = approver();
    const engine = new PolicyEngine(READ_ONLY_RULES, b, {
      grantTtlMs: 500,
      now: () => clock,
      approvalTimeoutMs: 60_000,
    });

    expect((await engine.authorize(exec())).source).toBe("approval:session");
    clock += 100;
    expect((await engine.authorize(exec())).source).toBe("grant:session");
    expect(b.asked).toHaveLength(1);

    clock += 500;
    expect((await engine.authorize(exec())).source).toBe("approval:session");
    expect(b.asked).toHaveLength(2);
  });

  it("does not report an expired grant as one it would honour", async () => {
    let clock = 0;
    const engine = new PolicyEngine(READ_ONLY_RULES, approver(), {
      grantTtlMs: 100,
      now: () => clock,
    });

    await engine.authorize(exec());
    expect(engine.grantCount()).toBe(1);
    clock += 200;
    expect(engine.grantCount()).toBe(0);
  });

  it("lasts the whole session when no lifetime is configured", async () => {
    // The established behaviour, kept as the default: bounding consent in time
    // is available, not imposed, because a grant that expires mid-task turns
    // into a prompt the operator did not expect.
    const b = approver();
    const engine = new PolicyEngine(READ_ONLY_RULES, b);

    await engine.authorize(exec());
    await engine.authorize(exec());
    expect(b.asked).toHaveLength(1);
  });
});

describe("a grant is revoked", () => {
  it("asks again after everything is revoked", async () => {
    const b = approver();
    const engine = new PolicyEngine(READ_ONLY_RULES, b);

    await engine.authorize(exec("ls"));
    await engine.authorize(exec("pwd"));
    expect(engine.grantCount()).toBe(2);

    expect(engine.revokeGrants()).toBe(2);
    expect(engine.grantCount()).toBe(0);

    await engine.authorize(exec("ls"));
    expect(b.asked).toHaveLength(3);
  });

  it("can revoke one resource without touching the others", async () => {
    const engine = new PolicyEngine(READ_ONLY_RULES, approver());

    await engine.authorize(exec("ls"));
    await engine.authorize(exec("pwd"));

    expect(engine.revokeGrants((g) => g.resource === "ls")).toBe(1);
    expect(engine.grantCount()).toBe(1);
  });
});

describe("a grant is bound to the workspace it was given about", () => {
  it("stops applying when the workspace identity changes", async () => {
    // The case this is for: a repository whose trusted configuration changed
    // under the session. The operator approved an operation in a workspace they
    // had inspected, and it is no longer that workspace — so the approval does
    // not carry over, and there is no event that has to be delivered for that to
    // hold.
    let trust: string | undefined = "digest-a";
    const b = approver();
    const engine = new PolicyEngine(READ_ONLY_RULES, b, {
      trustBinding: () => trust,
    });

    await engine.authorize(exec());
    expect((await engine.authorize(exec())).source).toBe("grant:session");

    trust = "digest-b";
    expect((await engine.authorize(exec())).source).toBe("approval:session");
    expect(b.asked).toHaveLength(2);
  });

  it("stops applying when the workspace stops being trusted at all", async () => {
    let trust: string | undefined = "digest-a";
    const engine = new PolicyEngine(READ_ONLY_RULES, approver(), {
      trustBinding: () => trust,
    });

    await engine.authorize(exec());
    trust = undefined;
    expect((await engine.authorize(exec())).source).toBe("approval:session");
  });
});

describe("every decision that involved an approver is auditable", () => {
  it("records what was asked, what was decided, and why", async () => {
    const seen: ApprovalAudit[] = [];
    const engine = new PolicyEngine(
      READ_ONLY_RULES,
      {
        async request(req) {
          return { approved: false, requestId: req.id, reason: "user said no" };
        },
      },
      { onDecision: (e) => seen.push(e) },
    );

    await engine.authorize(exec("rm -rf /"));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      operationClass: "process.exec",
      resource: "rm -rf /",
      allowed: false,
      source: "approval:denied",
      reason: "user said no",
    });
    // The id ties the audit entry to the question that was put, which is what
    // makes a replay or a stale answer investigable after the fact.
    expect(seen[0]!.requestId).toEqual(expect.any(String));
    expect(seen[0]!.decidedAt).toBeGreaterThanOrEqual(seen[0]!.askedAt);
  });

  it("records the refusals too, not only the human's answers", async () => {
    // A denial the human never saw — a timeout, a replay, a malformed response
    // — is the kind that needs a record most, because nothing else in the
    // system will mention it.
    const seen: ApprovalAudit[] = [];
    const engine = new PolicyEngine(
      READ_ONLY_RULES,
      { request: () => new Promise(() => {}) },
      { approvalTimeoutMs: 15, onDecision: (e) => seen.push(e) },
    );

    await engine.authorize(exec());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.source).toBe("approval:timeout");
  });

  it("says nothing when no approver was involved", async () => {
    // A standing rule is not a decision anybody made about this operation, and
    // logging it as one would bury the approvals in noise.
    const seen: ApprovalAudit[] = [];
    const engine = new PolicyEngine(
      { ...READ_ONLY_RULES, "process.exec": "allow" },
      approver(),
      { onDecision: (e) => seen.push(e) },
    );

    await engine.authorize(exec());
    expect(seen).toHaveLength(0);
  });
});
