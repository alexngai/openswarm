/**
 * End-to-end tool-call recovery through both native engines.
 *
 * These are the tests that matter for the open-weight path: they assert that a
 * turn which previously terminated silently now dispatches a real tool call,
 * and that the recovered call is represented on the assistant message so the
 * subsequent tool_result has a partner (message-replay throws otherwise).
 */

import { describe, it, expect } from "vitest";

import { NativeEngine } from "./native.js";
import { HardenedNativeEngine } from "./hardened-native.js";
import type { RunConfig, PermissionDecision } from "./index.js";
import type {
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderMessage,
  ProviderRequest,
} from "../providers/index.js";
import type { NormalizedEvent, ToolSpec, Usage } from "../core/types.js";
import type { ToolImpl, ToolResult } from "../tools/types.js";
import type { ToolRequest } from "../tools/dispatcher.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USAGE: Usage = { inputTokens: 10, outputTokens: 5 };

function toolImpl(name: string): ToolImpl {
  const spec: ToolSpec = {
    name,
    description: `${name} test double`,
    inputSchema: { type: "object" },
    requiredPermission: "none",
    tier: 0,
  };
  return { spec, execute: async () => ({ status: "ok", output: "ok" }) };
}

const TOOLS: readonly ToolImpl[] = [
  toolImpl("bash"),
  toolImpl("read_file"),
  toolImpl("grep"),
];

class ScriptedProvider implements Provider {
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
  private index = 0;

  constructor(private readonly scripts: readonly (readonly ProviderEvent[])[]) {}

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push({
      ...req,
      messages: req.messages.map((m) => ({ ...m, content: [...m.content] })) as
        ProviderRequest["messages"],
    });
    const script = this.scripts[this.index++];
    if (script === undefined) throw new Error(`no script for stream #${this.index - 1}`);
    for (const ev of script) yield ev;
  }
}

class RecordingDispatcher {
  readonly dispatched: Array<{ name: string; input: unknown }> = [];

  get(name: string): ToolImpl | undefined {
    return TOOLS.find((t) => t.spec.name === name);
  }

  async dispatch(name: string, input: unknown): Promise<ToolResult> {
    this.dispatched.push({ name, input });
    return { status: "ok", output: "done" };
  }

  async dispatchBatch(requests: readonly ToolRequest[]): Promise<readonly ToolResult[]> {
    const out: ToolResult[] = [];
    for (const req of requests) out.push(await this.dispatch(req.name, req.input));
    return out;
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
    tools: TOOLS,
    canUseTool: async () => ({ allow: true }) as PermissionDecision,
    permissionMode: "workspace-write",
    maxTurns: 3,
    ...overrides,
  };
}

async function collect(it: AsyncIterable<NormalizedEvent>): Promise<NormalizedEvent[]> {
  const out: NormalizedEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

/** A turn whose tool call arrived only as Hermes-format assistant text. */
const TEXT_FORMAT_TURN: readonly ProviderEvent[] = [
  { type: "text-delta", text: "Let me list the files.\n" },
  {
    type: "text-delta",
    text: '<tool_call>{"name": "bash", "arguments": {"command": "ls"}}</tool_call>',
  },
  { type: "finish", stopReason: "end_turn", usage: USAGE },
];

const FINAL_TURN: readonly ProviderEvent[] = [
  { type: "text-delta", text: "All done." },
  { type: "finish", stopReason: "end_turn", usage: USAGE },
];

// ---------------------------------------------------------------------------
// Engine matrix — both engines must behave identically here.
// ---------------------------------------------------------------------------

type EngineName = "native" | "hardened";

function makeEngine(name: EngineName, provider: Provider): NativeEngine | HardenedNativeEngine {
  return name === "native"
    ? new NativeEngine({ provider })
    : new HardenedNativeEngine({ provider });
}

for (const engineName of ["native", "hardened"] as const) {
  describe(`${engineName} engine: text-format tool-call recovery`, () => {
    it("dispatches a call the server failed to convert, instead of stopping", async () => {
      const provider = new ScriptedProvider([TEXT_FORMAT_TURN, FINAL_TURN]);
      const dispatcher = new RecordingDispatcher();
      const events = await collect(
        makeEngine(engineName, provider).run(
          config({
            dispatcher: dispatcher as unknown as RunConfig["dispatcher"],
            toolCallRepair: "standard",
          }),
        ),
      );

      expect(dispatcher.dispatched).toEqual([
        { name: "bash", input: { command: "ls" } },
      ]);

      const repaired = events.find((e) => e.type === "tool_call_repaired");
      expect(repaired).toMatchObject({
        stage: "recovered_text",
        toolName: "bash",
        format: "hermes",
      });

      // The run continued to a second turn rather than terminating on turn 1.
      expect(provider.requests.length).toBe(2);
      const stop = events.find((e) => e.type === "message_stop");
      expect(stop).toMatchObject({ stopReason: "end_turn" });
    });

    it("pairs the recovered call with a tool_use block on the assistant message", async () => {
      const provider = new ScriptedProvider([TEXT_FORMAT_TURN, FINAL_TURN]);
      const dispatcher = new RecordingDispatcher();
      await collect(
        makeEngine(engineName, provider).run(
          config({ dispatcher: dispatcher as unknown as RunConfig["dispatcher"] }),
        ),
      );

      // Second request carries the first turn's history.
      const history = provider.requests[1]!.messages;
      const assistant = history.find(
        (m): m is Extract<ProviderMessage, { role: "assistant" }> =>
          m.role === "assistant",
      );
      expect(assistant).toBeDefined();
      const toolUse = assistant!.content.find((c) => c.type === "tool_use");
      expect(toolUse).toMatchObject({ name: "bash", input: { command: "ls" } });

      // Every tool_result must have a matching tool_use — providerMessagesToVercel
      // throws otherwise, which is exactly the regression this guards.
      const toolResults = history.flatMap((m) =>
        m.role === "user" ? m.content.filter((c) => c.type === "tool_result") : [],
      );
      expect(toolResults.length).toBe(1);
      expect((toolResults[0] as { tool_use_id: string }).tool_use_id).toBe(
        (toolUse as { id: string }).id,
      );
    });

    it("replays the prose without the malformed syntax", async () => {
      const provider = new ScriptedProvider([TEXT_FORMAT_TURN, FINAL_TURN]);
      const dispatcher = new RecordingDispatcher();
      await collect(
        makeEngine(engineName, provider).run(
          config({ dispatcher: dispatcher as unknown as RunConfig["dispatcher"] }),
        ),
      );

      const assistant = provider.requests[1]!.messages.find(
        (m): m is Extract<ProviderMessage, { role: "assistant" }> =>
          m.role === "assistant",
      )!;
      const text = assistant.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      expect(text).toBe("Let me list the files.");
      expect(text).not.toContain("<tool_call>");
    });

    it("terminates as before when repair is off", async () => {
      const provider = new ScriptedProvider([TEXT_FORMAT_TURN]);
      const dispatcher = new RecordingDispatcher();
      const events = await collect(
        makeEngine(engineName, provider).run(
          config({
            dispatcher: dispatcher as unknown as RunConfig["dispatcher"],
            toolCallRepair: "off",
          }),
        ),
      );
      expect(dispatcher.dispatched).toEqual([]);
      expect(provider.requests.length).toBe(1);
      expect(events.some((e) => e.type === "message_stop")).toBe(true);
    });
  });

  describe(`${engineName} engine: delivered-call repair`, () => {
    it("routes an aliased tool name to the real tool", async () => {
      const provider = new ScriptedProvider([
        [
          { type: "tool-input-start", id: "c1", name: "shell" },
          { type: "tool-call", id: "c1", name: "shell", input: { command: "ls" } },
          { type: "finish", stopReason: "tool_use", usage: USAGE },
        ],
        FINAL_TURN,
      ]);
      const dispatcher = new RecordingDispatcher();
      const events = await collect(
        makeEngine(engineName, provider).run(
          config({ dispatcher: dispatcher as unknown as RunConfig["dispatcher"] }),
        ),
      );

      expect(dispatcher.dispatched).toEqual([
        { name: "bash", input: { command: "ls" } },
      ]);
      expect(events.find((e) => e.type === "tool_call_repaired")).toMatchObject({
        stage: "delivered",
        toolName: "bash",
        originalName: "shell",
      });
    });

    it("unwraps an argument envelope before dispatch", async () => {
      const provider = new ScriptedProvider([
        [
          { type: "tool-input-start", id: "c1", name: "bash" },
          {
            type: "tool-call",
            id: "c1",
            name: "bash",
            input: { arguments: { command: "pwd" } },
          },
          { type: "finish", stopReason: "tool_use", usage: USAGE },
        ],
        FINAL_TURN,
      ]);
      const dispatcher = new RecordingDispatcher();
      await collect(
        makeEngine(engineName, provider).run(
          config({ dispatcher: dispatcher as unknown as RunConfig["dispatcher"] }),
        ),
      );
      expect(dispatcher.dispatched).toEqual([
        { name: "bash", input: { command: "pwd" } },
      ]);
    });

    it("leaves a well-formed call completely untouched", async () => {
      const provider = new ScriptedProvider([
        [
          { type: "tool-input-start", id: "c1", name: "bash" },
          { type: "tool-call", id: "c1", name: "bash", input: { command: "ls" } },
          { type: "finish", stopReason: "tool_use", usage: USAGE },
        ],
        FINAL_TURN,
      ]);
      const dispatcher = new RecordingDispatcher();
      const events = await collect(
        makeEngine(engineName, provider).run(
          config({ dispatcher: dispatcher as unknown as RunConfig["dispatcher"] }),
        ),
      );
      expect(dispatcher.dispatched).toEqual([
        { name: "bash", input: { command: "ls" } },
      ]);
      expect(events.some((e) => e.type === "tool_call_repaired")).toBe(false);
    });
  });

  describe(`${engineName} engine: dropped-stream recovery`, () => {
    it("rebuilds a call whose arguments streamed but never landed", async () => {
      // tool-input deltas arrive, then the turn finishes with no tool-call —
      // exactly what a provider-side JSON.parse failure looks like downstream.
      const provider = new ScriptedProvider([
        [
          { type: "tool-input-start", id: "c1", name: "bash" },
          { type: "tool-input-delta", id: "c1", delta: '{"command":' },
          { type: "tool-input-delta", id: "c1", delta: '"npm test"' },
          { type: "finish", stopReason: "end_turn", usage: USAGE },
        ],
        FINAL_TURN,
      ]);
      const dispatcher = new RecordingDispatcher();
      const events = await collect(
        makeEngine(engineName, provider).run(
          config({ dispatcher: dispatcher as unknown as RunConfig["dispatcher"] }),
        ),
      );

      expect(dispatcher.dispatched).toEqual([
        { name: "bash", input: { command: "npm test" } },
      ]);
      expect(events.find((e) => e.type === "tool_call_repaired")).toMatchObject({
        stage: "recovered_stream",
        toolName: "bash",
      });
    });
  });

  /** A turn whose tool-call syntax names a tool that does not exist. */
  const UNRECOVERABLE_TURN: readonly ProviderEvent[] = [
    {
      type: "text-delta",
      text: '<tool_call>{"name": "summon_unicorn", "arguments": {}}</tool_call>',
    },
    { type: "finish", stopReason: "end_turn", usage: USAGE },
  ];

  describe(`${engineName} engine: toolChoice escalation (F5)`, () => {
    it("re-runs the turn with tool use forced", async () => {
      const provider = new ScriptedProvider([UNRECOVERABLE_TURN, FINAL_TURN]);
      const dispatcher = new RecordingDispatcher();
      const events = await collect(
        makeEngine(engineName, provider).run(
          config({ dispatcher: dispatcher as unknown as RunConfig["dispatcher"] }),
        ),
      );

      expect(events.find((e) => e.type === "info")).toMatchObject({
        source: "tool-call-repair",
        method: "tool_choice_escalation",
      });
      // Second request carries the forced choice…
      expect(provider.requests.length).toBe(2);
      expect(provider.requests[0]!.toolChoice).toBeUndefined();
      expect(provider.requests[1]!.toolChoice).toBe("required");
      // …and the un-committed assistant turn is not replayed as history.
      const assistants = provider.requests[1]!.messages.filter(
        (m) => m.role === "assistant",
      );
      expect(assistants).toEqual([]);
    });

    it("escalates at most once, then falls back to the diagnosis", async () => {
      // Both turns fail the same way; the budget is 1, so the run must stop.
      const provider = new ScriptedProvider([
        UNRECOVERABLE_TURN,
        UNRECOVERABLE_TURN,
      ]);
      const dispatcher = new RecordingDispatcher();
      const events = await collect(
        makeEngine(engineName, provider).run(
          config({ dispatcher: dispatcher as unknown as RunConfig["dispatcher"] }),
        ),
      );
      expect(provider.requests.length).toBe(2);
      const methods = events
        .filter((e) => e.type === "info")
        .map((e) => (e as { method: string }).method);
      expect(methods).toEqual(["tool_choice_escalation", "unrecovered_text_tool_call"]);
      expect(events.some((e) => e.type === "message_stop")).toBe(true);
      expect(dispatcher.dispatched).toEqual([]);
    });

    it("recovers on the forced retry when the model then emits a real call", async () => {
      const provider = new ScriptedProvider([
        UNRECOVERABLE_TURN,
        [
          { type: "tool-input-start", id: "c1", name: "bash" },
          { type: "tool-call", id: "c1", name: "bash", input: { command: "ls" } },
          { type: "finish", stopReason: "tool_use", usage: USAGE },
        ],
        FINAL_TURN,
      ]);
      const dispatcher = new RecordingDispatcher();
      await collect(
        makeEngine(engineName, provider).run(
          config({
            maxTurns: 5,
            dispatcher: dispatcher as unknown as RunConfig["dispatcher"],
          }),
        ),
      );
      expect(dispatcher.dispatched).toEqual([
        { name: "bash", input: { command: "ls" } },
      ]);
    });

    it("never overrides a toolChoice the caller pinned", async () => {
      const provider = new ScriptedProvider([UNRECOVERABLE_TURN]);
      const dispatcher = new RecordingDispatcher();
      const events = await collect(
        makeEngine(engineName, provider).run(
          config({
            toolChoice: "auto",
            dispatcher: dispatcher as unknown as RunConfig["dispatcher"],
          }),
        ),
      );
      expect(provider.requests.length).toBe(1);
      expect(provider.requests[0]!.toolChoice).toBe("auto");
      expect(events.find((e) => e.type === "info")).toMatchObject({
        method: "unrecovered_text_tool_call",
      });
    });
  });

  describe(`${engineName} engine: diagnostics`, () => {
    it("surfaces an info event when escalation is unavailable", async () => {
      const provider = new ScriptedProvider([UNRECOVERABLE_TURN]);
      const dispatcher = new RecordingDispatcher();
      const events = await collect(
        makeEngine(engineName, provider).run(
          // Pinning toolChoice disables escalation, isolating the diagnosis.
          config({
            toolChoice: "auto",
            dispatcher: dispatcher as unknown as RunConfig["dispatcher"],
          }),
        ),
      );
      const info = events.find((e) => e.type === "info");
      expect(info).toMatchObject({
        source: "tool-call-repair",
        method: "unrecovered_text_tool_call",
      });
      expect(dispatcher.dispatched).toEqual([]);
    });

    it("stays silent on a genuine final answer", async () => {
      const provider = new ScriptedProvider([FINAL_TURN]);
      const dispatcher = new RecordingDispatcher();
      const events = await collect(
        makeEngine(engineName, provider).run(
          config({ dispatcher: dispatcher as unknown as RunConfig["dispatcher"] }),
        ),
      );
      expect(events.some((e) => e.type === "info")).toBe(false);
      expect(events.some((e) => e.type === "tool_call_repaired")).toBe(false);
    });
  });
}

// ---------------------------------------------------------------------------
// Hardened-only: recovered calls must join the eager in-flight map.
// ---------------------------------------------------------------------------

describe("hardened engine: eager dispatch of recovered calls", () => {
  it("dispatches a text-recovered call when eager dispatch is on", async () => {
    const provider = new ScriptedProvider([TEXT_FORMAT_TURN, FINAL_TURN]);
    const dispatcher = new RecordingDispatcher();
    const engine = new HardenedNativeEngine({ provider, eagerToolDispatch: true });
    await collect(
      engine.run(
        config({ dispatcher: dispatcher as unknown as RunConfig["dispatcher"] }),
      ),
    );
    // Regression guard: the eager drain iterates inFlight, so a recovered call
    // that never entered it would be silently skipped.
    expect(dispatcher.dispatched).toEqual([
      { name: "bash", input: { command: "ls" } },
    ]);
  });

  it("still dispatches a mix of streamed and recovered calls", async () => {
    const provider = new ScriptedProvider([
      [
        { type: "tool-input-start", id: "c1", name: "grep" },
        { type: "tool-call", id: "c1", name: "grep", input: { pattern: "x" } },
        { type: "tool-input-start", id: "c2", name: "bash" },
        { type: "tool-input-delta", id: "c2", delta: '{"command":"ls"' },
        { type: "finish", stopReason: "tool_use", usage: USAGE },
      ],
      FINAL_TURN,
    ]);
    const dispatcher = new RecordingDispatcher();
    const engine = new HardenedNativeEngine({ provider, eagerToolDispatch: true });
    await collect(
      engine.run(
        config({ dispatcher: dispatcher as unknown as RunConfig["dispatcher"] }),
      ),
    );
    expect(dispatcher.dispatched).toEqual([
      { name: "grep", input: { pattern: "x" } },
      { name: "bash", input: { command: "ls" } },
    ]);
  });
});
