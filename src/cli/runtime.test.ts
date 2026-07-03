import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildAgentRuntime, defaultCompactionConfig } from "./runtime.js";
import { isRemoteCompactionConfig } from "../engine/compact-remote.js";
import type { Provider } from "../providers/index.js";
import type { CommonOpts } from "./argv.js";

const fakeProvider = {
  id: "fake",
  capabilities: { maxContextTokens: 200_000 },
} as unknown as Provider;

// Keep buildAgentRuntime light (no plugins/skills/mcp/hooks). Scripted mode
// skips the auth gate; the codex-native branch is selected before the scripted
// branch, so the codex engine is still what gets built.
function codexOpts(overrides: Partial<CommonOpts> = {}): CommonOpts {
  return {
    permissionMode: "read-only",
    outputFormat: "json",
    headless: true,
    plugins: false,
    skills: false,
    mcp: false,
    hooks: false,
    dumpTools: false,
    enableWebSearch: false,
    framework: "codex-native",
    ...overrides,
  } as CommonOpts;
}

describe("buildAgentRuntime — codex-native branch", () => {
  const prev = process.env.OPENSWARM_TEST_SCRIPT;
  beforeEach(() => {
    process.env.OPENSWARM_TEST_SCRIPT = "1"; // skip the auth gate for the unit test
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.OPENSWARM_TEST_SCRIPT;
    else process.env.OPENSWARM_TEST_SCRIPT = prev;
  });

  it("defaults a non-gpt model to gpt-5.5 and builds a HardenedNativeEngine via openai-codex", async () => {
    const built = await buildAgentRuntime(codexOpts());
    expect(built.kind).toBe("runtime");
    if (built.kind !== "runtime") return;
    // B3: the effective model is reflected on the runtime (drives budget/cost).
    expect(built.runtime.resolvedModelId).toBe("gpt-5.5");
    const { engine, providerId } = await built.runtime.makeEngine("sess-1");
    expect(providerId).toBe("openai-codex");
    expect(engine.id).toBe("hardened-native"); // not the plain NativeEngine
  });

  it("passes an explicit gpt model through unchanged", async () => {
    const built = await buildAgentRuntime(codexOpts({ model: "gpt-5.5" }));
    if (built.kind !== "runtime") throw new Error(`build failed (exit ${built.code})`);
    expect(built.runtime.resolvedModelId).toBe("gpt-5.5");
    const { providerId } = await built.runtime.makeEngine("s");
    expect(providerId).toBe("openai-codex");
  });
});

describe("defaultCompactionConfig", () => {
  const prevFlag = process.env.OPENSWARM_REMOTE_COMPACTION;
  const prevModel = process.env.OPENSWARM_COMPACTION_MODEL;
  afterEach(() => {
    restore("OPENSWARM_REMOTE_COMPACTION", prevFlag);
    restore("OPENSWARM_COMPACTION_MODEL", prevModel);
  });
  function restore(key: string, val: string | undefined): void {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }

  it("returns a remote config (reusing the session model) by default", () => {
    delete process.env.OPENSWARM_REMOTE_COMPACTION;
    delete process.env.OPENSWARM_COMPACTION_MODEL;
    const config = defaultCompactionConfig(fakeProvider, "gpt-5.5");
    expect(isRemoteCompactionConfig(config)).toBe(true);
    expect((config as unknown as { model: string }).model).toBe("gpt-5.5");
    // Estimator-fallback threshold is CC's absolute reserve (window − 13k),
    // not the flat 10k DEFAULT_COMPACTION floor or the old 0.8 ratio.
    expect(config.maxEstimatedTokens).toBe(200_000 - 13_000);
  });

  it("honors OPENSWARM_COMPACTION_MODEL as the summarization model", () => {
    delete process.env.OPENSWARM_REMOTE_COMPACTION;
    process.env.OPENSWARM_COMPACTION_MODEL = "gpt-5-mini";
    const config = defaultCompactionConfig(fakeProvider, "gpt-5.5");
    expect((config as unknown as { model: string }).model).toBe("gpt-5-mini");
  });

  it("falls back to mechanical when OPENSWARM_REMOTE_COMPACTION is off", () => {
    for (const off of ["0", "false", "off", "no"]) {
      process.env.OPENSWARM_REMOTE_COMPACTION = off;
      const config = defaultCompactionConfig(fakeProvider, "gpt-5.5");
      expect(isRemoteCompactionConfig(config)).toBe(false);
    }
  });
});
