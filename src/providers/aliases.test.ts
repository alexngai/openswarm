import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { BUILTIN_ALIASES, loadAliases, resolveAlias, detectShadowing } from "./aliases.js";

describe("resolveAlias", () => {
  it('resolves "sonnet" → "claude-sonnet-4-6"', () => {
    expect(resolveAlias("sonnet", BUILTIN_ALIASES)).toBe("claude-sonnet-4-6");
  });

  it('resolves "gpt-4o" → "gpt-4o-2024-11-20"', () => {
    expect(resolveAlias("gpt-4o", BUILTIN_ALIASES)).toBe("gpt-4o-2024-11-20");
  });

  it("returns unknown-direct-id unchanged when not in aliases", () => {
    expect(resolveAlias("unknown-direct-id", BUILTIN_ALIASES)).toBe("unknown-direct-id");
  });

  it("throws cycle-detection error for a → b → c chain", () => {
    const aliases = { a: "b", b: "c" };
    expect(() => resolveAlias("a", aliases)).toThrow(/cycle detected/);
    expect(() => resolveAlias("a", aliases)).toThrow(/"a"/);
    expect(() => resolveAlias("a", aliases)).toThrow(/"b"/);
  });
});

describe("loadAliases", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-coder-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns copy of BUILTIN_ALIASES when file does not exist", async () => {
    const result = await loadAliases(path.join(tmpDir, "nonexistent.json"));
    expect(result).toEqual(BUILTIN_ALIASES);
  });

  it("merges user aliases with built-ins, user wins on collision", async () => {
    const settingsFile = path.join(tmpDir, "settings.json");
    await fs.writeFile(settingsFile, JSON.stringify({ aliases: { "my-fast": "gpt-4o-mini" } }), "utf8");
    const result = await loadAliases(settingsFile);
    // built-ins present
    expect(result["sonnet"]).toBe("claude-sonnet-4-6");
    // user alias present
    expect(result["my-fast"]).toBe("gpt-4o-mini");
  });

  it("throws with clear error on malformed JSON", async () => {
    const settingsFile = path.join(tmpDir, "settings.json");
    await fs.writeFile(settingsFile, "{ not valid json", "utf8");
    await expect(loadAliases(settingsFile)).rejects.toThrow(/Failed to load aliases/);
  });

  it("returns built-ins only when settings file has no aliases field", async () => {
    const settingsFile = path.join(tmpDir, "settings.json");
    await fs.writeFile(settingsFile, JSON.stringify({ theme: "dark" }), "utf8");
    const result = await loadAliases(settingsFile);
    expect(result).toEqual(BUILTIN_ALIASES);
  });
});

describe("detectShadowing", () => {
  it("returns one entry when user overrides a built-in with different target", () => {
    const shadows = detectShadowing({ sonnet: "claude-sonnet-5-0" });
    expect(shadows).toHaveLength(1);
    expect(shadows[0]).toEqual({
      alias: "sonnet",
      builtInTarget: "claude-sonnet-4-6",
      userTarget: "claude-sonnet-5-0",
    });
  });

  it("returns empty array when user sets same target as built-in", () => {
    const shadows = detectShadowing({ sonnet: "claude-sonnet-4-6" });
    expect(shadows).toHaveLength(0);
  });

  it("returns empty array when user alias has no built-in collision", () => {
    const shadows = detectShadowing({ "new-alias": "gpt-5" });
    expect(shadows).toHaveLength(0);
  });
});
