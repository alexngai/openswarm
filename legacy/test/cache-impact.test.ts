import { describe, it, expect } from "vitest";
import { isCacheSensitive, classifyChanges, GUARD_TESTS } from "../scripts/check-cache-impact.js";

describe("cache-impact detector (TE-27)", () => {
  it("flags paths whose bytes reshape the cacheable prefix", () => {
    for (const p of [
      "src/providers/azure-transport.ts",
      "src/providers/litellm-transport.ts",
      "src/providers/message-replay.ts",
      "src/providers/tool-translation.ts",
      "src/engine/compact-remote.ts",
      "src/engine/compactor.ts",
      "src/engine/microcompact.ts",
      "src/engine/default-system-prompt.ts",
      "src/engine/prompt-cache.ts",
      "src/tools/dispatcher.ts",
    ]) {
      expect(isCacheSensitive(p), p).toBe(true);
    }
  });

  it("ignores unrelated files and test files — except the byte-stability guard itself", () => {
    for (const p of [
      "src/ui/repl-solid/store.ts",
      "docs/55-cross-harness-cache-efficiency.md",
      "README.md",
      "src/providers/azure-transport.test.ts", // a transport's own test doesn't ship in the prefix
      "src/engine/compact-remote.test.ts",
    ]) {
      expect(isCacheSensitive(p), p).toBe(false);
    }
    // Touching the guard's definition IS flagged — weakening it is what the gate should surface.
    expect(isCacheSensitive("src/providers/prefix-stability.test.ts")).toBe(true);
  });

  it("classifyChanges keeps only the impacted files", () => {
    const { impacted } = classifyChanges([
      "README.md",
      "src/engine/compactor.ts",
      "src/ui/x.ts",
      "src/providers/openai-transport.ts",
    ]);
    expect(impacted).toEqual(["src/engine/compactor.ts", "src/providers/openai-transport.ts"]);
  });

  it("guards the byte-stability + cache-accounting invariants", () => {
    expect(GUARD_TESTS).toContain("src/providers/prefix-stability.test.ts");
    expect(GUARD_TESTS).toContain("src/core/efficiency-report.test.ts");
  });
});
