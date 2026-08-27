/**
 * M4a Phase 6 integration test — CLI engine selection via --dump-engine.
 *
 * The single-agent CLI reads the framework from argv (`--framework`), not from
 * OPENSWARM_FRAMEWORK — that env var is consumed by spawned *workers*
 * (worker-entry.ts). These cases assert the CLI's own selection through the
 * shared resolver (src/cli/select-engine.ts, Phase 2.1): explicit `native`
 * builds NativeEngine, explicit `hardened-native` and the `auto` default for a
 * non-Claude model build HardenedNativeEngine. Uses --dump-engine to avoid any
 * live API traffic.
 *
 * Prereq: `npm run build` — runs once via test/integration/global-setup.ts.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const REPO = process.cwd();
const CLI = path.resolve(REPO, "dist/cli.js");

const OPENAI_ENV = {
  // Dummy Anthropic key to pass detectAuth() check (engine exits before API call).
  ANTHROPIC_API_KEY: "test-key-anthropic",
  // Dummy OpenAI key so OpenAIEnvAuth passes isAuthenticated.
  OPENAI_API_KEY: "test-key-openai",
} as const;

describe("CLI engine selection via --dump-engine", () => {
  it("--framework native --model gpt-4o → engineId:native", () => {
    const result = spawnSync(
      process.execPath,
      [CLI, "--model", "gpt-4o", "--framework", "native", "--dump-engine", "say hi"],
      { env: { ...process.env, ...OPENAI_ENV }, encoding: "utf8", timeout: 10000 },
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.engineId).toBe("native");
    expect(parsed.providerId).toBe("openai");
    // gpt-4o is aliased to gpt-4o-2024-11-20 via BUILTIN_ALIASES.
    expect(parsed.modelId).toBe("gpt-4o-2024-11-20");
  });

  it("--framework auto --model gpt-4o → engineId:hardened-native (Phase 2.1 default)", () => {
    const result = spawnSync(
      process.execPath,
      [CLI, "--model", "gpt-4o", "--framework", "auto", "--dump-engine", "say hi"],
      { env: { ...process.env, ...OPENAI_ENV }, encoding: "utf8", timeout: 10000 },
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.engineId).toBe("hardened-native");
    expect(parsed.providerId).toBe("openai");
    expect(parsed.modelId).toBe("gpt-4o-2024-11-20");
  });

  it("--framework auto --model claude-sonnet-4-6 → engineId:claude-agent-sdk", () => {
    const result = spawnSync(process.execPath, [CLI, "--model", "claude-sonnet-4-6", "--dump-engine", "say hi"], {
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "test-key",
      },
      encoding: "utf8",
      timeout: 10000,
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.engineId).toBe("claude-agent-sdk");
    expect(parsed.modelId).toBe("claude-sonnet-4-6");
  });
});
