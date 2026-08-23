import { describe, it, expect } from "vitest";
import { ApprovalPolicy } from "./approval-policy.js";
import { ExecPolicy, type ExecPolicyConfig } from "../tools/tier0/exec-policy.js";

const policyConfig: ExecPolicyConfig = {
  rules: [
    { pattern: ["ls"], decision: "allow" },
    { pattern: ["git", "log"], decision: "allow" },
    { pattern: ["git", "push"], decision: "prompt", justification: "modifies remote" },
    { pattern: ["rm", "-rf"], decision: "forbidden", justification: "dangerous" },
  ],
};

describe("ApprovalPolicy", () => {
  describe("never mode", () => {
    it("never requires approval", () => {
      const ap = new ApprovalPolicy("never");
      expect(ap.checkCommand("rm -rf /").requiresApproval).toBe(false);
      expect(ap.checkCommand("ls").requiresApproval).toBe(false);
      expect(ap.checkTool("bash").requiresApproval).toBe(false);
    });

    it("reports mode correctly", () => {
      const ap = new ApprovalPolicy("never");
      expect(ap.policyMode).toBe("never");
    });
  });

  describe("always mode", () => {
    it("always requires approval", () => {
      const ap = new ApprovalPolicy("always");
      expect(ap.checkCommand("ls").requiresApproval).toBe(true);
      expect(ap.checkCommand("echo hello").requiresApproval).toBe(true);
      expect(ap.checkTool("bash").requiresApproval).toBe(true);
    });
  });

  describe("unless-allowed mode", () => {
    it("skips approval for allowed commands", () => {
      const execPolicy = new ExecPolicy(policyConfig);
      const ap = new ApprovalPolicy("unless-allowed", execPolicy);
      expect(ap.checkCommand("ls -la").requiresApproval).toBe(false);
      expect(ap.checkCommand("git log --oneline").requiresApproval).toBe(false);
    });

    it("requires approval for prompt commands", () => {
      const execPolicy = new ExecPolicy(policyConfig);
      const ap = new ApprovalPolicy("unless-allowed", execPolicy);
      const result = ap.checkCommand("git push origin main");
      expect(result.requiresApproval).toBe(true);
    });

    it("requires approval for forbidden commands", () => {
      const execPolicy = new ExecPolicy(policyConfig);
      const ap = new ApprovalPolicy("unless-allowed", execPolicy);
      const result = ap.checkCommand("rm -rf /");
      expect(result.requiresApproval).toBe(true);
    });

    it("requires approval for unknown commands", () => {
      const execPolicy = new ExecPolicy(policyConfig);
      const ap = new ApprovalPolicy("unless-allowed", execPolicy);
      const result = ap.checkCommand("wget https://evil.com");
      expect(result.requiresApproval).toBe(true);
    });

    it("requires approval when no exec-policy configured", () => {
      const ap = new ApprovalPolicy("unless-allowed");
      expect(ap.checkCommand("ls").requiresApproval).toBe(true);
    });

    it("always requires approval for tool calls", () => {
      const execPolicy = new ExecPolicy(policyConfig);
      const ap = new ApprovalPolicy("unless-allowed", execPolicy);
      expect(ap.checkTool("bash").requiresApproval).toBe(true);
    });
  });

  describe("on-failure mode", () => {
    it("does not require approval on first attempt", () => {
      const ap = new ApprovalPolicy("on-failure");
      expect(ap.checkCommand("git push origin main").requiresApproval).toBe(false);
    });

    it("requires approval on retry", () => {
      const ap = new ApprovalPolicy("on-failure");
      expect(ap.checkCommand("git push origin main", true).requiresApproval).toBe(true);
    });

    it("does not require approval for tools", () => {
      const ap = new ApprovalPolicy("on-failure");
      expect(ap.checkTool("bash").requiresApproval).toBe(false);
    });
  });

  describe("on-request mode", () => {
    it("does not require approval", () => {
      const ap = new ApprovalPolicy("on-request");
      expect(ap.checkCommand("rm -rf /").requiresApproval).toBe(false);
      expect(ap.checkTool("bash").requiresApproval).toBe(false);
    });
  });

  describe("default factory", () => {
    it("creates unless-allowed policy", () => {
      const ap = ApprovalPolicy.default();
      expect(ap.policyMode).toBe("unless-allowed");
    });
  });
});
