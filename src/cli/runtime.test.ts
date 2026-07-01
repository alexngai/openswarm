import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildAgentRuntime } from "./runtime.js";
import type { CommonOpts } from "./argv.js";

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
