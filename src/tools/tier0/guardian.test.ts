import { describe, it, expect } from "vitest";
import {
  Guardian,
  type GuardianAction,
  type GuardianContext,
  type GuardianReviewFn,
} from "./guardian.js";

// ---------------------------------------------------------------------------
// Mock review functions
// ---------------------------------------------------------------------------

function mockApprover(): GuardianReviewFn {
  return async () =>
    JSON.stringify({
      decision: "approved",
      riskLevel: "low",
      rationale: "Safe operation",
      reasons: ["within_scope"],
    });
}

function mockDenier(): GuardianReviewFn {
  return async () =>
    JSON.stringify({
      decision: "denied",
      riskLevel: "high",
      rationale: "Dangerous operation",
      reasons: ["destructive"],
    });
}

function mockSlowReviewer(delayMs: number): GuardianReviewFn {
  return async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    return JSON.stringify({
      decision: "approved",
      riskLevel: "low",
      rationale: "Slow but safe",
      reasons: [],
    });
  };
}

function mockErrorReviewer(): GuardianReviewFn {
  return async () => {
    throw new Error("LLM service unavailable");
  };
}

function mockMalformedReviewer(): GuardianReviewFn {
  return async () => "This is not JSON at all, just random text.";
}

const simpleAction: GuardianAction = {
  type: "shell_command",
  description: "List files",
  command: "ls -la",
};

const dangerousAction: GuardianAction = {
  type: "shell_command",
  description: "Delete everything",
  command: "rm -rf /",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Guardian", () => {
  describe("basic review", () => {
    it("returns approved for safe actions", async () => {
      const guardian = new Guardian({ reviewFn: mockApprover() });
      const result = await guardian.review(simpleAction);
      expect(result.decision).toBe("approved");
      expect(result.riskLevel).toBe("low");
    });

    it("returns denied for dangerous actions", async () => {
      const guardian = new Guardian({ reviewFn: mockDenier() });
      const result = await guardian.review(dangerousAction);
      expect(result.decision).toBe("denied");
      expect(result.riskLevel).toBe("high");
    });

    it("includes context in review", async () => {
      let capturedPrompt = "";
      const reviewFn: GuardianReviewFn = async (_sys, user) => {
        capturedPrompt = user;
        return JSON.stringify({
          decision: "approved",
          riskLevel: "low",
          rationale: "ok",
          reasons: [],
        });
      };

      const guardian = new Guardian({ reviewFn });
      const context: GuardianContext = {
        userGoal: "Build the project",
        permissionMode: "workspace-write",
        sandboxMode: "bwrap",
        recentActions: ["npm install", "npm test"],
      };

      await guardian.review(simpleAction, context);
      expect(capturedPrompt).toContain("Build the project");
      expect(capturedPrompt).toContain("workspace-write");
      expect(capturedPrompt).toContain("bwrap");
      expect(capturedPrompt).toContain("npm install");
    });

    it("uses system prompt from policy", async () => {
      let capturedSystem = "";
      const reviewFn: GuardianReviewFn = async (sys) => {
        capturedSystem = sys;
        return JSON.stringify({
          decision: "approved",
          riskLevel: "low",
          rationale: "ok",
          reasons: [],
        });
      };

      const guardian = new Guardian({
        reviewFn,
        policy: "CUSTOM POLICY: be strict",
      });
      await guardian.review(simpleAction);
      expect(capturedSystem).toBe("CUSTOM POLICY: be strict");
    });
  });

  describe("timeout handling", () => {
    it("returns timed_out when review exceeds timeout", async () => {
      const guardian = new Guardian({
        reviewFn: mockSlowReviewer(500),
        timeoutMs: 50,
      });
      const result = await guardian.review(simpleAction);
      expect(result.decision).toBe("timed_out");
      expect(result.reasons).toContain("timeout");
    });

    it("succeeds when review completes within timeout", async () => {
      const guardian = new Guardian({
        reviewFn: mockSlowReviewer(10),
        timeoutMs: 5_000,
      });
      const result = await guardian.review(simpleAction);
      expect(result.decision).toBe("approved");
    });
  });

  describe("error handling", () => {
    it("returns error on review failure", async () => {
      const guardian = new Guardian({ reviewFn: mockErrorReviewer() });
      const result = await guardian.review(simpleAction);
      expect(result.decision).toBe("error");
      expect(result.rationale).toContain("LLM service unavailable");
    });

    it("returns denied on malformed response (fail-closed)", async () => {
      const guardian = new Guardian({ reviewFn: mockMalformedReviewer() });
      const result = await guardian.review(simpleAction);
      expect(result.decision).toBe("denied");
      expect(result.reasons).toContain("parse_error");
    });

    it("handles JSON embedded in text", async () => {
      const reviewFn: GuardianReviewFn = async () =>
        'Here is my assessment:\n{"decision":"approved","riskLevel":"medium","rationale":"fine","reasons":["ok"]}\nEnd.';
      const guardian = new Guardian({ reviewFn });
      const result = await guardian.review(simpleAction);
      expect(result.decision).toBe("approved");
      expect(result.riskLevel).toBe("medium");
    });
  });

  describe("circuit breaker", () => {
    it("opens after N consecutive denials", async () => {
      const guardian = new Guardian({
        reviewFn: mockDenier(),
        circuitBreakerConsecutive: 3,
      });

      expect(guardian.circuitBreakerOpen).toBe(false);

      await guardian.review(dangerousAction);
      await guardian.review(dangerousAction);
      expect(guardian.circuitBreakerOpen).toBe(false);

      await guardian.review(dangerousAction);
      expect(guardian.circuitBreakerOpen).toBe(true);
    });

    it("resets consecutive count on approval", async () => {
      let shouldApprove = false;
      const reviewFn: GuardianReviewFn = async () =>
        JSON.stringify({
          decision: shouldApprove ? "approved" : "denied",
          riskLevel: "medium",
          rationale: "test",
          reasons: [],
        });

      const guardian = new Guardian({
        reviewFn,
        circuitBreakerConsecutive: 3,
      });

      await guardian.review(dangerousAction);
      await guardian.review(dangerousAction);
      shouldApprove = true;
      await guardian.review(simpleAction);
      shouldApprove = false;
      await guardian.review(dangerousAction);
      await guardian.review(dangerousAction);
      expect(guardian.circuitBreakerOpen).toBe(false);
    });

    it("returns denied immediately when circuit is open", async () => {
      let reviewCount = 0;
      const countingDenier: GuardianReviewFn = async () => {
        reviewCount++;
        return JSON.stringify({
          decision: "denied",
          riskLevel: "high",
          rationale: "bad",
          reasons: [],
        });
      };

      const guardian = new Guardian({
        reviewFn: countingDenier,
        circuitBreakerConsecutive: 2,
      });

      await guardian.review(dangerousAction);
      await guardian.review(dangerousAction);
      expect(guardian.circuitBreakerOpen).toBe(true);
      expect(reviewCount).toBe(2);

      const result = await guardian.review(simpleAction);
      expect(result.decision).toBe("denied");
      expect(result.reasons).toContain("circuit_breaker_open");
      expect(reviewCount).toBe(2);
    });

    it("can be manually reset", async () => {
      const guardian = new Guardian({
        reviewFn: mockDenier(),
        circuitBreakerConsecutive: 2,
      });

      await guardian.review(dangerousAction);
      await guardian.review(dangerousAction);
      expect(guardian.circuitBreakerOpen).toBe(true);

      guardian.resetCircuitBreaker();
      expect(guardian.circuitBreakerOpen).toBe(false);
    });

    it("reports stats", async () => {
      const guardian = new Guardian({
        reviewFn: mockDenier(),
        circuitBreakerConsecutive: 5,
      });

      await guardian.review(dangerousAction);
      await guardian.review(dangerousAction);

      const stats = guardian.circuitBreakerStats;
      expect(stats.total).toBe(2);
      expect(stats.denials).toBe(2);
      expect(stats.consecutive).toBe(2);
      expect(stats.open).toBe(false);
    });

    it("opens on window threshold (10/50)", async () => {
      let count = 0;
      const reviewFn: GuardianReviewFn = async () => {
        count++;
        const approve = count % 5 !== 0;
        return JSON.stringify({
          decision: approve ? "approved" : "denied",
          riskLevel: "medium",
          rationale: "test",
          reasons: [],
        });
      };

      const guardian = new Guardian({
        reviewFn,
        circuitBreakerConsecutive: 100,
        circuitBreakerWindow: 50,
        circuitBreakerThreshold: 10,
      });

      for (let i = 0; i < 50; i++) {
        await guardian.review(simpleAction);
      }

      expect(guardian.circuitBreakerStats.denials).toBe(10);
      expect(guardian.circuitBreakerOpen).toBe(true);
    });
  });

  describe("action types", () => {
    it("handles file_write actions", async () => {
      let capturedPrompt = "";
      const reviewFn: GuardianReviewFn = async (_sys, user) => {
        capturedPrompt = user;
        return JSON.stringify({
          decision: "approved",
          riskLevel: "low",
          rationale: "ok",
          reasons: [],
        });
      };

      const guardian = new Guardian({ reviewFn });
      const action: GuardianAction = {
        type: "file_write",
        description: "Write config file",
        filePath: "/home/user/project/.env",
      };
      await guardian.review(action);
      expect(capturedPrompt).toContain("file_write");
      expect(capturedPrompt).toContain("/home/user/project/.env");
    });

    it("handles network_request actions", async () => {
      let capturedPrompt = "";
      const reviewFn: GuardianReviewFn = async (_sys, user) => {
        capturedPrompt = user;
        return JSON.stringify({
          decision: "denied",
          riskLevel: "high",
          rationale: "suspicious",
          reasons: [],
        });
      };

      const guardian = new Guardian({ reviewFn });
      const action: GuardianAction = {
        type: "network_request",
        description: "Fetch from external URL",
        url: "https://evil.com/payload",
      };
      const result = await guardian.review(action);
      expect(result.decision).toBe("denied");
      expect(capturedPrompt).toContain("https://evil.com/payload");
    });
  });
});
