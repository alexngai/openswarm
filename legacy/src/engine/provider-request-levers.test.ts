/**
 * Sampling + tool-choice levers must actually reach ProviderRequest.
 *
 * Every transport already read `temperature` / `topP` / `topK` / `toolChoice`
 * off the request; the gap (docs/63 F2/F3) was that no engine ever wrote them.
 * These tests pin the write side for both native engines.
 */

import { describe, it, expect } from "vitest";

import { NativeEngine } from "./native.js";
import { HardenedNativeEngine } from "./hardened-native.js";
import type { RunConfig, PermissionDecision } from "./index.js";
import type {
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderRequest,
} from "../providers/index.js";
import type { NormalizedEvent, Usage } from "../core/types.js";

const USAGE: Usage = { inputTokens: 1, outputTokens: 1 };

class CapturingProvider implements Provider {
  readonly id = "mock";
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    promptCache: false,
    parallelToolUse: true,
    vision: false,
    reasoning: false,
    maxContextTokens: 200_000,
    maxOutputTokens: 16_000,
  };
  readonly requests: ProviderRequest[] = [];

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(req);
    yield { type: "text-delta", text: "done" };
    yield { type: "finish", stopReason: "end_turn", usage: USAGE };
  }
}

function config(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    systemPrompt: "sys",
    prompt: "hi",
    model: "mock-model",
    auth: {
      kind: "api-key" as const,
      providerId: "mock",
      isAuthenticated: async () => true,
    },
    tools: [],
    canUseTool: async () => ({ allow: true }) as PermissionDecision,
    permissionMode: "workspace-write",
    maxTurns: 1,
    ...overrides,
  };
}

async function drain(it: AsyncIterable<NormalizedEvent>): Promise<void> {
  for await (const _ of it) void _;
}

for (const engineName of ["native", "hardened"] as const) {
  const build = (provider: Provider) =>
    engineName === "native"
      ? new NativeEngine({ provider })
      : new HardenedNativeEngine({ provider });

  describe(`${engineName} engine: provider-request levers`, () => {
    it("forwards sampling parameters", async () => {
      const provider = new CapturingProvider();
      await drain(
        build(provider).run(config({ temperature: 0.2, topP: 0.95, topK: 40 })),
      );
      expect(provider.requests[0]).toMatchObject({
        temperature: 0.2,
        topP: 0.95,
        topK: 40,
      });
    });

    it("forwards temperature 0 rather than dropping it as falsy", async () => {
      const provider = new CapturingProvider();
      await drain(build(provider).run(config({ temperature: 0 })));
      expect(provider.requests[0]!.temperature).toBe(0);
    });

    it("forwards toolChoice in both mode and named forms", async () => {
      const modeProvider = new CapturingProvider();
      await drain(build(modeProvider).run(config({ toolChoice: "required" })));
      expect(modeProvider.requests[0]!.toolChoice).toBe("required");

      const namedProvider = new CapturingProvider();
      await drain(build(namedProvider).run(config({ toolChoice: { name: "bash" } })));
      expect(namedProvider.requests[0]!.toolChoice).toEqual({ name: "bash" });
    });

    it("omits every lever when unset, so provider defaults survive", async () => {
      const provider = new CapturingProvider();
      await drain(build(provider).run(config()));
      const req = provider.requests[0]!;
      expect(req).not.toHaveProperty("temperature");
      expect(req).not.toHaveProperty("topP");
      expect(req).not.toHaveProperty("topK");
      expect(req).not.toHaveProperty("toolChoice");
    });
  });
}
