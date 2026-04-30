import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadHooksConfig, countMatchers, countEvents } from "./config.js";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hooks-config-${prefix}-`));
}

function writeJson(dir: string, file: string, contents: unknown): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, file);
  fs.writeFileSync(p, JSON.stringify(contents, null, 2));
  return p;
}

describe("loadHooksConfig", () => {
  let tmp: string;
  let homeDir: string;
  let cwd: string;
  let envDir: string;

  beforeEach(() => {
    tmp = mkTmp("root");
    homeDir = path.join(tmp, "home");
    cwd = path.join(tmp, "cwd");
    envDir = path.join(tmp, "envdir");
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(envDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty config when no file present", async () => {
    const result = await loadHooksConfig({
      cwd,
      homedir: homeDir,
      envOverrides: {},
    });
    expect(result.config).toEqual({});
    expect(result.resolvedPath).toBeUndefined();
  });

  it("loads from $SWARM_CODER_CONFIG_DIR/hooks.json (highest priority)", async () => {
    const expected = writeJson(envDir, "hooks.json", {
      PreToolUse: [{ matcher: "bash", command: "./env.sh" }],
    });
    // Decoy at lower priorities — should be ignored.
    writeJson(path.join(cwd, ".swarm-coder"), "hooks.json", {
      PreToolUse: [{ matcher: "*", command: "./decoy.sh" }],
    });

    const result = await loadHooksConfig({
      cwd,
      homedir: homeDir,
      envOverrides: { SWARM_CODER_CONFIG_DIR: envDir },
    });
    expect(result.resolvedPath).toBe(expected);
    expect(result.config.PreToolUse).toEqual([
      { matcher: "bash", command: "./env.sh" },
    ]);
  });

  it("falls back to <cwd>/.swarm-coder/hooks.json when env not set", async () => {
    const expected = writeJson(path.join(cwd, ".swarm-coder"), "hooks.json", {
      PostToolUse: [{ matcher: "*", command: "./audit.sh", timeoutMs: 5000 }],
    });

    const result = await loadHooksConfig({
      cwd,
      homedir: homeDir,
      envOverrides: {},
    });
    expect(result.resolvedPath).toBe(expected);
    expect(result.config.PostToolUse).toHaveLength(1);
    expect(result.config.PostToolUse![0]!.timeoutMs).toBe(5000);
  });

  it("falls back to <cwd>/.claude/settings.json (Claude Code compat — extracts .hooks)", async () => {
    const expected = writeJson(path.join(cwd, ".claude"), "settings.json", {
      theme: "dark",
      hooks: {
        PreToolUse: [{ matcher: "Bash", command: "./cc.sh" }],
      },
    });

    const result = await loadHooksConfig({
      cwd,
      homedir: homeDir,
      envOverrides: {},
    });
    expect(result.resolvedPath).toBe(expected);
    expect(result.config.PreToolUse).toEqual([
      { matcher: "Bash", command: "./cc.sh" },
    ]);
  });

  it("falls back to $HOME/.claude/settings.json last", async () => {
    const expected = writeJson(path.join(homeDir, ".claude"), "settings.json", {
      hooks: {
        SessionStart: [{ matcher: "*", command: "./greet.sh" }],
      },
    });

    const result = await loadHooksConfig({
      cwd,
      homedir: homeDir,
      envOverrides: {},
    });
    expect(result.resolvedPath).toBe(expected);
    expect(result.config.SessionStart).toHaveLength(1);
  });

  it("returns empty config when $HOME/.claude/settings.json has no hooks field", async () => {
    writeJson(path.join(homeDir, ".claude"), "settings.json", {
      theme: "dark",
    });

    const result = await loadHooksConfig({
      cwd,
      homedir: homeDir,
      envOverrides: {},
    });
    expect(result.config).toEqual({});
    expect(result.resolvedPath).toBeDefined();
  });

  it("throws on malformed JSON", async () => {
    const p = path.join(cwd, ".swarm-coder", "hooks.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{not-json");

    await expect(
      loadHooksConfig({ cwd, homedir: homeDir, envOverrides: {} }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("throws on schema mismatch (missing required 'command' field)", async () => {
    writeJson(path.join(cwd, ".swarm-coder"), "hooks.json", {
      PreToolUse: [{ matcher: "bash" }],
    });

    await expect(
      loadHooksConfig({ cwd, homedir: homeDir, envOverrides: {} }),
    ).rejects.toThrow(/schema validation failed/);
  });
});

describe("countMatchers / countEvents", () => {
  it("counts matchers across events", () => {
    expect(
      countMatchers({
        PreToolUse: [
          { matcher: "a", command: "a.sh" },
          { matcher: "b", command: "b.sh" },
        ],
        PostToolUse: [{ matcher: "*", command: "c.sh" }],
      }),
    ).toBe(3);
  });

  it("counts only events with matchers", () => {
    expect(
      countEvents({
        PreToolUse: [{ matcher: "a", command: "a.sh" }],
        PostToolUse: [],
      }),
    ).toBe(1);
  });

  it("returns zero for empty config", () => {
    expect(countMatchers({})).toBe(0);
    expect(countEvents({})).toBe(0);
  });
});
