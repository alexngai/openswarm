/**
 * FX-APPROVAL-001..012 — every way an approval can fail to arrive is a denial
 * (docs/67 `WP-09`, `DDP-SAFE-05`).
 *
 * An approval gate is only as good as its failure modes. "The user said yes" is
 * the easy path; what decides whether the gate is worth having is what happens
 * when nobody answers, when the answer is unintelligible, when it arrives for a
 * different question, or when it arrives after everyone stopped listening. Each
 * of those has to end in a denial, and each has to end in a *distinguishable*
 * denial, because "denied" with no reason is indistinguishable from a bug and
 * gets worked around rather than fixed.
 *
 * The six cases the threshold names are absent, invalid, expired, replayed,
 * disconnected, and late.
 */

import { describe, it, expect, vi } from "vitest";

import {
  PolicyEngine,
  READ_ONLY_RULES,
  type ApprovalBroker,
  type ApprovalRequest,
  type ApprovalResponse,
} from "../kernel/policy-engine.js";
import type { OperationRequest } from "../kernel/contracts.js";
import { AcpPermissionBridge } from "../acp/permission.js";
import { PermissionBridge } from "./bridge.js";
import { makeApprovalBroker } from "./policy-broker.js";
import type { PendingPermission } from "../ui/repl/state.js";

/** A `process.exec` request, which read-only rules send to the approver. */
function exec(command = "rm -rf /"): OperationRequest {
  return { kind: "process.exec", operationId: "op-1", command, cwd: "/w" };
}

/** A broker whose answer is supplied per test, recording what it was asked. */
function broker(
  answer: (req: ApprovalRequest) => Promise<ApprovalResponse> | ApprovalResponse,
): ApprovalBroker & { asked: ApprovalRequest[] } {
  const asked: ApprovalRequest[] = [];
  return {
    asked,
    async request(req) {
      asked.push(req);
      return answer(req);
    },
  };
}

/** Approve correctly: echo the id the engine issued. */
const approving = (): ApprovalBroker & { asked: ApprovalRequest[] } =>
  broker((req) => ({ approved: true, requestId: req.id, scope: "one-shot" }));

describe("absent", () => {
  it("FX-APPROVAL-001 denies when there is no approver to ask", async () => {
    const engine = new PolicyEngine(READ_ONLY_RULES);
    const decision = await engine.authorize(exec());

    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe("approval:unavailable");
  });

  it("FX-APPROVAL-002 denies when the approver never answers", async () => {
    // A broker that never settles is what an unattended headless run looks
    // like: a prompt written to a stream nobody is reading. Waiting forever is
    // not a safe default — it is an outage that looks like a hang, and the
    // operation stays pending rather than being refused.
    const engine = new PolicyEngine(READ_ONLY_RULES, broker(() => new Promise(() => {})), {
      approvalTimeoutMs: 20,
    });

    const decision = await engine.authorize(exec());
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe("approval:timeout");
  });
});

describe("invalid", () => {
  it("FX-APPROVAL-003 denies a response that does not say what it decided", async () => {
    const engine = new PolicyEngine(
      READ_ONLY_RULES,
      broker(() => ({ requestId: "whatever" }) as unknown as ApprovalResponse),
      { approvalTimeoutMs: 50 },
    );

    const decision = await engine.authorize(exec());
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe("approval:invalid");
  });

  it("FX-APPROVAL-004 denies a response that answers no question we asked", async () => {
    const engine = new PolicyEngine(
      READ_ONLY_RULES,
      broker(() => ({ approved: true, requestId: "not-an-id-we-issued" })),
      { approvalTimeoutMs: 50 },
    );

    const decision = await engine.authorize(exec());
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe("approval:invalid");
  });

  it("FX-APPROVAL-005 denies an ACP outcome it does not recognise", async () => {
    // The live fail-open: anything that was not literally `reject` or
    // `cancelled` fell through to allow, so a client on a newer protocol
    // revision, a typo, or a hostile response approved the operation. Approval
    // has to be named explicitly; everything else is not an approval.
    const conn = {
      requestPermission: vi.fn(async () => ({
        outcome: { outcome: "selected" as const, optionId: "some_future_option" },
      })),
    };
    const bridge = new AcpPermissionBridge(conn, "sess-1");

    const decision = await bridge.request(pending());
    expect(decision.allow).toBe(false);
  });

  it("FX-APPROVAL-006 still approves the ACP options it does offer", async () => {
    // The refusal has to be about unrecognised outcomes, not about ACP
    // approvals failing generally.
    for (const [optionId, alwaysAllow] of [
      ["allow", undefined],
      ["allow_always", true],
    ] as const) {
      const conn = {
        requestPermission: vi.fn(async () => ({
          outcome: { outcome: "selected" as const, optionId },
        })),
      };
      const decision = await new AcpPermissionBridge(conn, "s").request(pending());
      expect(decision.allow).toBe(true);
      expect(decision.alwaysAllow).toBe(alwaysAllow);
    }
  });
});

describe("expired and late", () => {
  it("FX-APPROVAL-007 denies a decision that arrives after its deadline", async () => {
    // Distinct from a timeout: the answer did come back, but it answers a
    // question that is no longer open. A human who walked away, came back, and
    // pressed yes has approved something whose context they no longer have.
    const engine = new PolicyEngine(
      READ_ONLY_RULES,
      broker(async (req) => {
        await new Promise((r) => setTimeout(r, 40));
        return { approved: true, requestId: req.id };
      }),
      { approvalTimeoutMs: 20 },
    );

    const decision = await engine.authorize(exec());
    expect(decision.allowed).toBe(false);
    expect(["approval:timeout", "approval:expired"]).toContain(decision.source);
  });

  it("FX-APPROVAL-008 a late decision grants nothing", async () => {
    // The denial must not leave a grant behind that the next call reuses —
    // otherwise the timeout only delays the approval rather than refusing it.
    const engine = new PolicyEngine(
      READ_ONLY_RULES,
      broker(async (req) => {
        await new Promise((r) => setTimeout(r, 40));
        return { approved: true, requestId: req.id, scope: "session" };
      }),
      { approvalTimeoutMs: 20 },
    );

    await engine.authorize(exec());
    await new Promise((r) => setTimeout(r, 60));
    expect(engine.grantCount()).toBe(0);

    const second = await engine.authorize(exec());
    expect(second.allowed).toBe(false);
  });
});

describe("replayed", () => {
  it("FX-APPROVAL-009 denies a decision reused from an earlier question", async () => {
    // Every ask is its own question. A response that echoes the id of a
    // previous one is a recording, not a decision — and replaying an old yes is
    // how one approval becomes standing consent nobody granted.
    let firstId: string | undefined;
    const engine = new PolicyEngine(
      READ_ONLY_RULES,
      broker((req) => {
        firstId ??= req.id;
        return { approved: true, requestId: firstId, scope: "one-shot" };
      }),
      { approvalTimeoutMs: 50 },
    );

    const first = await engine.authorize(exec("ls"));
    expect(first.allowed).toBe(true);

    const replayed = await engine.authorize(exec("rm -rf /"));
    expect(replayed.allowed).toBe(false);
    expect(replayed.source).toBe("approval:replayed");
  });
});

describe("disconnected", () => {
  it("FX-APPROVAL-010 denies when asking the approver throws", async () => {
    const engine = new PolicyEngine(
      READ_ONLY_RULES,
      broker(() => {
        throw new Error("transport closed");
      }),
      { approvalTimeoutMs: 50 },
    );

    const decision = await engine.authorize(exec());
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe("approval:unavailable");
    expect(decision.reason).toContain("transport closed");
  });
});

describe("giving up on an ask releases the approver", () => {
  it("does not leave the bridge wedged so every later ask is refused", async () => {
    // Failing closed once is correct. Failing closed forever is not: the bridge
    // is strictly serial, so an abandoned request keeps its slot and the next
    // ask is refused for the wrong reason — "a prior request is still awaiting a
    // decision" — with no prompt shown and no way back short of a restart. One
    // unanswered prompt would take the rest of the session with it.
    const bridge = new PermissionBridge();
    const engine = new PolicyEngine(
      READ_ONLY_RULES,
      makeApprovalBroker({ bridge, useHeadless: false, getCurrentMode: () => "read-only" }),
      { approvalTimeoutMs: 20 },
    );

    const first = await engine.authorize(exec("ls"));
    expect(first.source).toBe("approval:timeout");

    // Now a human is there and answers immediately.
    const second = engine.authorize(exec("pwd"));
    await vi.waitFor(() => expect(bridge.hasPending()).toBe(true));
    bridge.respond({ allow: true });

    const decision = await second;
    expect(decision.allowed).toBe(true);
  });
});

describe("the happy path still works", () => {
  it("FX-APPROVAL-011 approves and binds the grant to the exact resource", async () => {
    const b = approving();
    const engine = new PolicyEngine(READ_ONLY_RULES, b, { approvalTimeoutMs: 50 });

    const decision = await engine.authorize(exec("ls -la"));
    expect(decision.allowed).toBe(true);
    expect(decision.grant?.resource).toBe("ls -la");
    // One-shot: nothing retained, so the next identical call asks again.
    expect(engine.grantCount()).toBe(0);
    await engine.authorize(exec("ls -la"));
    expect(b.asked).toHaveLength(2);
  });

  it("FX-APPROVAL-012 issues a fresh question for every ask", async () => {
    const b = approving();
    const engine = new PolicyEngine(READ_ONLY_RULES, b, { approvalTimeoutMs: 50 });

    await engine.authorize(exec("a"));
    await engine.authorize(exec("b"));

    const ids = b.asked.map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
    for (const req of b.asked) {
      expect(req.expiresAt).toBeGreaterThan(Date.now() - 1000);
    }
  });
});

function pending(): PendingPermission {
  return {
    toolName: "bash",
    input: { command: "rm -rf /" },
    reason: "needs approval",
  } as PendingPermission;
}
