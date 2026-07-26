import { describe, it, expect } from "vitest";
import {
  PolicyEngine,
  READ_ONLY_RULES,
  WORKSPACE_WRITE_RULES,
  resourceOf,
  type ApprovalBroker,
  type ApprovalRequest,
  type ApprovalResponse,
} from "./policy-engine.js";
import type { CanonicalPath, OperationRequest } from "./contracts.js";

function canonical(relative: string): CanonicalPath {
  return { canonical: `/ws/${relative}`, workspaceRoot: "/ws", relative };
}

function writeRequest(relative: string): OperationRequest {
  return {
    kind: "file.write",
    operationId: `op-${relative}`,
    idempotency: "mutating",
    toolName: "test",
    path: canonical(relative),
    expected: { path: canonical(relative), contentHash: null, sizeBytes: null, mtimeMs: null },
  };
}

function execRequest(command: string): OperationRequest {
  return {
    kind: "process.exec",
    operationId: `op-${command}`,
    idempotency: "mutating",
    toolName: "test",
    command,
    argv: [],
    cwd: canonical(""),
  };
}

/** Records what it was asked and answers with a fixed response. */
function broker(response: ApprovalResponse) {
  const seen: ApprovalRequest[] = [];
  const impl: ApprovalBroker = {
    request: async (req) => {
      seen.push(req);
      return response;
    },
  };
  return { impl, seen };
}

describe("PolicyEngine", () => {
  it("allows an operation class its rules permit", async () => {
    const decision = await new PolicyEngine(WORKSPACE_WRITE_RULES).authorize(
      writeRequest("a.txt"),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.source).toBe("rule:file.write=allow");
  });

  it("denies without an approver rather than allowing by default", async () => {
    // Headless with nobody to ask must fail closed.
    const decision = await new PolicyEngine(READ_ONLY_RULES).authorize(writeRequest("a.txt"));
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe("approval:unavailable");
    expect(decision.reason).toContain("no approver is connected");
  });

  it("records a denied approval without granting anything", async () => {
    const { impl } = broker({ approved: false, reason: "user said no" });
    const engine = new PolicyEngine(READ_ONLY_RULES, impl);

    const decision = await engine.authorize(writeRequest("a.txt"));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("user said no");
    expect(engine.grantCount()).toBe(0);
  });

  it("binds an approval to the exact resource and operation class", async () => {
    const { impl, seen } = broker({ approved: true });
    const decision = await new PolicyEngine(READ_ONLY_RULES, impl).authorize(
      writeRequest("a.txt"),
    );

    expect(decision.grant).toEqual({
      scope: "session",
      operationClass: "file.write",
      resource: "/ws/a.txt",
    });
    expect(seen[0]!.resource).toBe("/ws/a.txt");
  });

  it("defaults an approval to session scope", async () => {
    const { impl } = broker({ approved: true });
    const engine = new PolicyEngine(READ_ONLY_RULES, impl);

    expect((await engine.authorize(writeRequest("a.txt"))).grant?.scope).toBe("session");
  });

  it("reuses a session grant for the same resource without re-asking", async () => {
    const { impl, seen } = broker({ approved: true });
    const engine = new PolicyEngine(READ_ONLY_RULES, impl);

    await engine.authorize(writeRequest("a.txt"));
    const second = await engine.authorize(writeRequest("a.txt"));

    expect(seen).toHaveLength(1);
    expect(second.source).toBe("grant:session");
  });

  it("does not let a grant widen to a different resource", async () => {
    const { impl, seen } = broker({ approved: true });
    const engine = new PolicyEngine(READ_ONLY_RULES, impl);

    await engine.authorize(writeRequest("a.txt"));
    await engine.authorize(writeRequest("b.txt"));

    // The second resource is asked about separately rather than riding on the
    // first approval.
    expect(seen.map((s) => s.resource)).toEqual(["/ws/a.txt", "/ws/b.txt"]);
    expect(engine.grantCount()).toBe(2);
  });

  it("does not let a grant widen to a different operation class", async () => {
    const { impl, seen } = broker({ approved: true });
    const engine = new PolicyEngine(
      { ...READ_ONLY_RULES, "file.write": "ask", "process.exec": "ask" },
      impl,
    );

    await engine.authorize(writeRequest("a.txt"));
    await engine.authorize(execRequest("/ws/a.txt"));

    expect(seen.map((s) => s.operationClass)).toEqual(["file.write", "process.exec"]);
  });

  it("does not persist a one-shot approval", async () => {
    const { impl, seen } = broker({ approved: true, scope: "one-shot" });
    const engine = new PolicyEngine(READ_ONLY_RULES, impl);

    await engine.authorize(writeRequest("a.txt"));
    await engine.authorize(writeRequest("a.txt"));

    expect(seen).toHaveLength(2);
    expect(engine.grantCount()).toBe(0);
  });

  it("honours an explicit deny rule over any approval", async () => {
    const { impl, seen } = broker({ approved: true });
    const engine = new PolicyEngine({ ...READ_ONLY_RULES, "file.write": "deny" }, impl);

    const decision = await engine.authorize(writeRequest("a.txt"));
    expect(decision.allowed).toBe(false);
    // A denial is not negotiable, so the approver is never troubled.
    expect(seen).toHaveLength(0);
  });

  describe("resourceOf", () => {
    it("uses the canonical path for file operations", () => {
      expect(resourceOf(writeRequest("a.txt"))).toBe("/ws/a.txt");
    });

    it("uses the host for network requests", () => {
      expect(
        resourceOf({
          kind: "network.request",
          operationId: "op",
          idempotency: "idempotent",
          toolName: "test",
          method: "GET",
          url: "https://example.com/some/path?q=1",
        }),
      ).toBe("example.com");
    });
  });
});
