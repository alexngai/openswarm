/**
 * M4a Phase 6 integration test — SWARM_CODER_FRAMEWORK env var propagation.
 *
 * Verifies that a worker subprocess launched with SWARM_CODER_FRAMEWORK=native
 * picks up the env var and uses the NativeEngine. Uses --dump-engine to avoid
 * any live API traffic.
 *
 * Prereq: `npm run build` — runs once via test/integration/global-setup.ts.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const REPO = process.cwd();
const CLI = path.resolve(REPO, "dist/cli.js");

describe("framework inheritance via SWARM_CODER_FRAMEWORK", () => {
  it("SWARM_CODER_FRAMEWORK=native --dump-engine --model gpt-4o → engineId:native", () => {
    const result = spawnSync(process.execPath, [CLI, "--model", "gpt-4o", "--dump-engine", "say hi"], {
      env: {
        ...process.env,
        SWARM_CODER_FRAMEWORK: "native",
        // Dummy Anthropic key to pass detectAuth() check (engine exits before API call).
        ANTHROPIC_API_KEY: "test-key-anthropic",
        // Dummy OpenAI key so OpenAIEnvAuth passes isAuthenticated.
        OPENAI_API_KEY: "test-key-openai",
      },
      encoding: "utf8",
      timeout: 10000,
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.engineId).toBe("native");
    expect(parsed.providerId).toBe("openai");
    // gpt-4o is aliased to gpt-4o-2024-11-20 via BUILTIN_ALIASES.
    expect(parsed.modelId).toBe("gpt-4o-2024-11-20");
  });

  it("SWARM_CODER_FRAMEWORK=auto --dump-engine --model claude-sonnet-4-6 → engineId:claude-agent-sdk", () => {
    const result = spawnSync(process.execPath, [CLI, "--model", "claude-sonnet-4-6", "--dump-engine", "say hi"], {
      env: {
        ...process.env,
        SWARM_CODER_FRAMEWORK: "auto",
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
