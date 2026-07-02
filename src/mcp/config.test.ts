import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadMcpConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mcp-config-${prefix}-`));
}

function writeJson(dir: string, file: string, contents: unknown): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, file);
  fs.writeFileSync(p, JSON.stringify(contents, null, 2));
  return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadMcpConfig", () => {
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

  it("returns empty configs when no file present", async () => {
    const result = await loadMcpConfig({
      cwd,
      homedir: homeDir,
      envOverrides: {},
    });
    expect(result.configs).toEqual([]);
    expect(result.resolvedPath).toBeUndefined();
  });

  it("loads from $OPENSWARM_CONFIG_DIR/mcp.json when present (highest priority)", async () => {
    const expected = writeJson(envDir, "mcp.json", {
      mcpServers: {
        foo: { command: "node", args: ["a.js"] },
      },
    });
    // Decoy at lower priorities — should be ignored.
    writeJson(path.join(cwd, ".openswarm"), "mcp.json", {
      mcpServers: { decoy: { command: "decoy" } },
    });

    const result = await loadMcpConfig({
      cwd,
      homedir: homeDir,
      envOverrides: { OPENSWARM_CONFIG_DIR: envDir },
    });
    expect(result.resolvedPath).toBe(expected);
    expect(result.configs.length).toBe(1);
    expect(result.configs[0]!.name).toBe("foo");
    expect(result.configs[0]!.command).toBe("node");
    expect(result.configs[0]!.args).toEqual(["a.js"]);
  });

  it("falls back to <cwd>/.openswarm/mcp.json when env not set", async () => {
    const expected = writeJson(path.join(cwd, ".openswarm"), "mcp.json", {
      mcpServers: { bar: { command: "bar" } },
    });

    const result = await loadMcpConfig({
      cwd,
      homedir: homeDir,
      envOverrides: {},
    });
    expect(result.resolvedPath).toBe(expected);
    expect(result.configs.map((c) => c.name)).toEqual(["bar"]);
  });

  it("falls back to <cwd>/.claude/mcp_servers.json next", async () => {
    const expected = writeJson(path.join(cwd, ".claude"), "mcp_servers.json", {
      mcpServers: { baz: { command: "baz" } },
    });

    const result = await loadMcpConfig({
      cwd,
      homedir: homeDir,
      envOverrides: {},
    });
    expect(result.resolvedPath).toBe(expected);
    expect(result.configs.map((c) => c.name)).toEqual(["baz"]);
  });

  it("falls back to $HOME/.claude/mcp_servers.json last", async () => {
    const expected = writeJson(path.join(homeDir, ".claude"), "mcp_servers.json", {
      mcpServers: {
        qux: { command: "qux", args: ["--flag"], env: { A: "1" }, cwd: "/tmp" },
      },
    });

    const result = await loadMcpConfig({
      cwd,
      homedir: homeDir,
      envOverrides: {},
    });
    expect(result.resolvedPath).toBe(expected);
    expect(result.configs[0]).toEqual({
      name: "qux",
      command: "qux",
      args: ["--flag"],
      env: { A: "1" },
      cwd: "/tmp",
    });
  });

  it("preserves priority order: env > cwd/.openswarm > cwd/.claude > home/.claude", async () => {
    writeJson(envDir, "mcp.json", { mcpServers: { winner: { command: "env" } } });
    writeJson(path.join(cwd, ".openswarm"), "mcp.json", {
      mcpServers: { winner: { command: "cwd-sc" } },
    });
    writeJson(path.join(cwd, ".claude"), "mcp_servers.json", {
      mcpServers: { winner: { command: "cwd-claude" } },
    });
    writeJson(path.join(homeDir, ".claude"), "mcp_servers.json", {
      mcpServers: { winner: { command: "home" } },
    });

    const result = await loadMcpConfig({
      cwd,
      homedir: homeDir,
      envOverrides: { OPENSWARM_CONFIG_DIR: envDir },
    });
    expect(result.configs[0]!.command).toBe("env");
  });

  it("throws on malformed JSON", async () => {
    const p = path.join(cwd, ".openswarm", "mcp.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{not-json");

    await expect(
      loadMcpConfig({ cwd, homedir: homeDir, envOverrides: {} }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("returns empty configs when mcpServers key is absent", async () => {
    writeJson(path.join(cwd, ".openswarm"), "mcp.json", {
      otherKey: "whatever",
    });

    const result = await loadMcpConfig({
      cwd,
      homedir: homeDir,
      envOverrides: {},
    });
    expect(result.configs).toEqual([]);
    expect(result.resolvedPath).toBeDefined();
  });
});
