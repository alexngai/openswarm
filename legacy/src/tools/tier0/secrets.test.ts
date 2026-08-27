import { describe, it, expect } from "vitest";
import {
  detectSecrets,
  containsSecrets,
  redactSecrets,
  shannonEntropy,
} from "./secrets.js";

describe("detectSecrets", () => {
  it("detects AWS access key", () => {
    const text = "export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
    const findings = detectSecrets(text);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((f) => f.type === "aws-access-key")).toBe(true);
  });

  it("detects GitHub PAT (ghp_)", () => {
    const text = `token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij1234`;
    const findings = detectSecrets(text);
    expect(findings.some((f) => f.type === "github-token")).toBe(true);
  });

  it("detects GitHub fine-grained token", () => {
    const text = `github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890`;
    const findings = detectSecrets(text);
    expect(findings.some((f) => f.type === "github-fine-grained-token")).toBe(true);
  });

  it("detects Slack token", () => {
    const text = "xoxb-1234567890-abcdefghij";
    const findings = detectSecrets(text);
    expect(findings.some((f) => f.type === "slack-token")).toBe(true);
  });

  it("detects Stripe live key", () => {
    const text = "sk_live_ABCDEFGHIJKLMNOPQRSTUVWXyz";
    const findings = detectSecrets(text);
    expect(findings.some((f) => f.type === "stripe-key")).toBe(true);
  });

  it("detects private key header", () => {
    const text = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAK...";
    const findings = detectSecrets(text);
    expect(findings.some((f) => f.type === "private-key")).toBe(true);
  });

  it("detects OPENSSH private key header", () => {
    const text = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnN...";
    const findings = detectSecrets(text);
    expect(findings.some((f) => f.type === "private-key")).toBe(true);
  });

  it("detects JWT", () => {
    const text = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6Ikpv.SflKxwRJSMeKKF2QT4fwp";
    const findings = detectSecrets(text);
    expect(findings.some((f) => f.type === "jwt")).toBe(true);
  });

  it("detects GCP service account", () => {
    const text = `{"type": "service_account", "project_id": "my-project"}`;
    const findings = detectSecrets(text);
    expect(findings.some((f) => f.type === "gcp-service-account")).toBe(true);
  });

  it("detects generic api key assignment", () => {
    const text = 'api_key = "sk_test_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef"';
    const findings = detectSecrets(text);
    expect(findings.some((f) => f.type === "generic-api-key")).toBe(true);
  });

  it("detects password in URL", () => {
    const text = "postgres://admin:SuperSecret123@db.example.com:5432/mydb";
    const findings = detectSecrets(text);
    expect(findings.some((f) => f.type === "password-in-url")).toBe(true);
  });

  it("detects Anthropic key", () => {
    const text = "sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXyz";
    const findings = detectSecrets(text);
    expect(findings.some((f) => f.type === "anthropic-key")).toBe(true);
  });

  it("detects npm token", () => {
    const text = "npm_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const findings = detectSecrets(text);
    expect(findings.some((f) => f.type === "npm-token")).toBe(true);
  });

  it("returns empty for clean text", () => {
    const text = "Hello world, this is a normal log line with no secrets.";
    const findings = detectSecrets(text);
    expect(findings).toHaveLength(0);
  });

  it("returns empty for short text", () => {
    expect(detectSecrets("")).toHaveLength(0);
    expect(detectSecrets("x")).toHaveLength(0);
  });

  it("detects multiple secrets in one string", () => {
    const text = [
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij1234",
      "-----BEGIN RSA PRIVATE KEY-----",
    ].join("\n");
    const findings = detectSecrets(text);
    const types = new Set(findings.map((f) => f.type));
    expect(types.has("aws-access-key")).toBe(true);
    expect(types.has("github-token")).toBe(true);
    expect(types.has("private-key")).toBe(true);
  });

  it("includes offset for each finding", () => {
    const text = "prefix AKIAIOSFODNN7EXAMPLE suffix";
    const findings = detectSecrets(text);
    const akFinding = findings.find((f) => f.type === "aws-access-key");
    expect(akFinding).toBeDefined();
    expect(akFinding!.offset).toBe(7);
  });

  it("includes redacted preview", () => {
    const text = "AKIAIOSFODNN7EXAMPLE";
    const findings = detectSecrets(text);
    const akFinding = findings.find((f) => f.type === "aws-access-key");
    expect(akFinding).toBeDefined();
    expect(akFinding!.redacted).toMatch(/^AKIA\*\*\*MPLE$/);
  });
});

describe("containsSecrets", () => {
  it("returns true when secrets present", () => {
    expect(containsSecrets("AKIAIOSFODNN7EXAMPLE")).toBe(true);
  });

  it("returns false for clean text", () => {
    expect(containsSecrets("just normal text here")).toBe(false);
  });
});

describe("redactSecrets", () => {
  it("replaces secrets with [REDACTED:type] markers", () => {
    const text = "key: AKIAIOSFODNN7EXAMPLE";
    const { redacted, findings } = redactSecrets(text);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(redacted).toContain("[REDACTED:aws-access-key]");
    expect(redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("returns original text when no secrets", () => {
    const text = "clean text";
    const { redacted, findings } = redactSecrets(text);
    expect(redacted).toBe(text);
    expect(findings).toHaveLength(0);
  });

  it("handles multiple secrets", () => {
    const text = "aws: AKIAIOSFODNN7EXAMPLE\nslack: xoxb-1234567890-abcdefghij";
    const { redacted } = redactSecrets(text);
    expect(redacted).toContain("[REDACTED:aws-access-key]");
    expect(redacted).toContain("[REDACTED:slack-token]");
  });
});

describe("shannonEntropy", () => {
  it("returns 0 for single-char string", () => {
    expect(shannonEntropy("aaaa")).toBe(0);
  });

  it("returns 1 for two equally distributed chars", () => {
    expect(shannonEntropy("ab")).toBeCloseTo(1.0, 5);
  });

  it("returns high entropy for random-looking string", () => {
    expect(shannonEntropy("aB3$xZ9!mK2@nF7&")).toBeGreaterThan(3.5);
  });
});
