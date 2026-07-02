import { describe, it, expect, vi } from "vitest";
import {
  compactSessionRemote,
  isRemoteCompactionConfig,
  missingSummarySections,
  REMOTE_COMPACTION_SYSTEM_PROMPT,
  REQUIRED_SUMMARY_SECTIONS,
  type RemoteCompactionConfig,
} from "./compact-remote.js";
import type {
  Provider,
  ProviderMessage,
  ProviderEvent,
  ProviderRequest,
} from "../providers/index.js";
import type { Session } from "./compactor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userText(text: string): ProviderMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantText(text: string): ProviderMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function assistantToolUse(
  id: string,
  name: string,
  input: unknown,
): ProviderMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input }],
  };
}

function toolResult(
  tool_use_id: string,
  content: string,
  is_error = false,
): ProviderMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id, content, is_error }],
  };
}

function makeFiller(count: number): ProviderMessage[] {
  const msgs: ProviderMessage[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push(userText("x".repeat(500)));
    msgs.push(assistantText("y".repeat(500)));
  }
  return msgs;
}

function mockProvider(response: string): Provider {
  return {
    id: "test",
    model: {} as any,
    capabilities: {
      streaming: true,
      promptCache: false,
      parallelToolUse: false,
      vision: false,
      reasoning: false,
      maxContextTokens: 128_000,
      maxOutputTokens: 4096,
    },
    stream(_request: ProviderRequest): AsyncIterable<ProviderEvent> {
      const events: ProviderEvent[] = [
        { type: "text-delta", text: response },
        {
          type: "finish",
          stopReason: "end_turn",
          usage: { inputTokens: 100, outputTokens: 50 },
        },
      ];
      return {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            async next() {
              if (i < events.length) return { value: events[i++]!, done: false };
              return { value: undefined, done: true } as any;
            },
          };
        },
      };
    },
  };
}

function errorProvider(message: string): Provider {
  return {
    ...mockProvider(""),
    stream(): AsyncIterable<ProviderEvent> {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              throw new Error(message);
            },
          };
        },
      };
    },
  };
}

function slowProvider(delayMs: number, response: string): Provider {
  return {
    ...mockProvider(""),
    stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
      const events: ProviderEvent[] = [
        { type: "text-delta", text: response },
        {
          type: "finish",
          stopReason: "end_turn",
          usage: { inputTokens: 100, outputTokens: 50 },
        },
      ];
      return {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            async next() {
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, delayMs);
                if (request.abort?.aborted) {
                  clearTimeout(timer);
                  reject(new Error("aborted"));
                  return;
                }
                request.abort?.addEventListener("abort", () => {
                  clearTimeout(timer);
                  reject(new Error("aborted"));
                }, { once: true });
              });
              if (i < events.length) return { value: events[i++]!, done: false };
              return { value: undefined, done: true } as any;
            },
          };
        },
      };
    },
  };
}

/** A response containing every required `## …` section (passes validation). */
function conformingSummary(marker = "Work done."): string {
  const body = REQUIRED_SUMMARY_SECTIONS.map((s) => `## ${s}\n${marker}`).join(
    "\n\n",
  );
  return `<analysis>Some analysis notes.</analysis>\n<summary>\n${body}\n</summary>`;
}

/** Provider that returns a different response on each successive stream() call. */
function sequenceProvider(responses: string[]): Provider {
  let call = 0;
  return {
    ...mockProvider(""),
    stream(_request: ProviderRequest): AsyncIterable<ProviderEvent> {
      const response = responses[Math.min(call, responses.length - 1)]!;
      call++;
      const events: ProviderEvent[] = [
        { type: "text-delta", text: response },
        {
          type: "finish",
          stopReason: "end_turn",
          usage: { inputTokens: 100, outputTokens: 50 },
        },
      ];
      return {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            async next() {
              if (i < events.length) return { value: events[i++]!, done: false };
              return { value: undefined, done: true } as any;
            },
          };
        },
      };
    },
  };
}

function remoteConfig(
  provider: Provider,
  overrides?: Partial<RemoteCompactionConfig>,
): RemoteCompactionConfig {
  return {
    preserveRecentMessages: 4,
    maxEstimatedTokens: 1_000,
    provider,
    model: "test-model",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isRemoteCompactionConfig
// ---------------------------------------------------------------------------

describe("isRemoteCompactionConfig", () => {
  it("returns true for remote config", () => {
    const config = remoteConfig(mockProvider("summary"));
    expect(isRemoteCompactionConfig(config)).toBe(true);
  });

  it("returns false for mechanical config", () => {
    expect(
      isRemoteCompactionConfig({
        preserveRecentMessages: 4,
        maxEstimatedTokens: 10_000,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compactSessionRemote
// ---------------------------------------------------------------------------

describe("compactSessionRemote", () => {
  it("returns unchanged session when compaction not needed", async () => {
    const session: Session = {
      messages: [userText("short"), assistantText("reply")],
    };

    const result = await compactSessionRemote(
      session,
      remoteConfig(mockProvider("summary")),
    );

    expect(result.removedMessageCount).toBe(0);
    expect(result.compactedSession.messages).toEqual(session.messages);
  });

  it("calls provider and uses LLM summary", async () => {
    const messages = makeFiller(15);
    const session: Session = { messages };

    const llmResponse = conformingSummary("User was testing remote compaction.");

    const provider = mockProvider(llmResponse);
    const streamSpy = vi.spyOn(provider, "stream");

    const result = await compactSessionRemote(
      session,
      remoteConfig(provider),
    );

    expect(streamSpy).toHaveBeenCalledTimes(1);
    expect(result.removedMessageCount).toBeGreaterThan(0);
    expect(result.summary).toContain("Primary Request and Intent");
    expect(result.compactedSession.messages.length).toBeLessThan(
      messages.length,
    );
    // First message is the system continuation
    expect(result.compactedSession.messages[0]!.role).toBe("system");
  });

  it("preserves recent messages", async () => {
    const messages = makeFiller(15);
    const session: Session = { messages };

    const result = await compactSessionRemote(
      session,
      remoteConfig(mockProvider("<summary>ok</summary>")),
    );

    // Should preserve the last 4 messages + 1 system prefix
    expect(result.compactedSession.messages.length).toBe(5);
  });

  it("walks back boundary for tool pairs", async () => {
    const messages: ProviderMessage[] = [
      ...makeFiller(10),
      assistantToolUse("tu1", "bash", { command: "ls" }),
      toolResult("tu1", "file.txt"),
      userText("looks good"),
      assistantText("great"),
    ];
    const session: Session = { messages };

    const config = remoteConfig(
      mockProvider("<summary>ok</summary>"),
      { preserveRecentMessages: 3 },
    );

    const result = await compactSessionRemote(session, config);

    // Boundary should walk back to include the tool_use before tool_result
    const preserved = result.compactedSession.messages.slice(1);
    const hasOrphanToolResult = preserved.some(
      (m) => m.role === "user" && m.content[0]?.type === "tool_result",
    );
    if (hasOrphanToolResult) {
      // If tool_result is preserved, tool_use must also be preserved
      const hasToolUse = preserved.some(
        (m) =>
          m.role === "assistant" &&
          m.content.some((b) => b.type === "tool_use"),
      );
      expect(hasToolUse).toBe(true);
    }
    expect(result.boundaryWalkedBack).toBe(true);
  });

  it("falls back to mechanical on provider error", async () => {
    const messages = makeFiller(15);
    const session: Session = { messages };

    const result = await compactSessionRemote(
      session,
      remoteConfig(errorProvider("LLM down")),
    );

    // Should still compact successfully via fallback
    expect(result.removedMessageCount).toBeGreaterThan(0);
    expect(result.compactedSession.messages[0]!.role).toBe("system");
    // Mechanical summaries contain "Conversation summary:"
    const systemText = (
      result.compactedSession.messages[0]!.content[0] as {
        type: "text";
        text: string;
      }
    ).text;
    expect(systemText).toContain("Conversation summary:");
  });

  it("falls back to mechanical on timeout", async () => {
    const messages = makeFiller(15);
    const session: Session = { messages };

    const result = await compactSessionRemote(
      session,
      remoteConfig(slowProvider(5000, "<summary>late</summary>"), {
        timeoutMs: 50,
      }),
    );

    expect(result.removedMessageCount).toBeGreaterThan(0);
    const systemText = (
      result.compactedSession.messages[0]!.content[0] as {
        type: "text";
        text: string;
      }
    ).text;
    expect(systemText).toContain("Conversation summary:");
  });

  it("uses custom system prompt when provided", async () => {
    const messages = makeFiller(15);
    const session: Session = { messages };

    const provider = mockProvider("<summary>custom</summary>");
    const streamSpy = vi.spyOn(provider, "stream");

    const customPrompt = "You are a custom summarizer.";
    await compactSessionRemote(
      session,
      remoteConfig(provider, { systemPrompt: customPrompt }),
    );

    const callArgs = streamSpy.mock.calls[0]![0];
    expect(callArgs.systemPrompt).toBe(customPrompt);
  });

  it("passes model to provider", async () => {
    const messages = makeFiller(15);
    const session: Session = { messages };

    const provider = mockProvider("<summary>ok</summary>");
    const streamSpy = vi.spyOn(provider, "stream");

    await compactSessionRemote(
      session,
      remoteConfig(provider, { model: "gpt-4o-mini" }),
    );

    const callArgs = streamSpy.mock.calls[0]![0];
    expect(callArgs.model).toBe("gpt-4o-mini");
  });

  it("passes maxSummaryTokens as maxOutputTokens", async () => {
    const messages = makeFiller(15);
    const session: Session = { messages };

    const provider = mockProvider("<summary>ok</summary>");
    const streamSpy = vi.spyOn(provider, "stream");

    await compactSessionRemote(
      session,
      remoteConfig(provider, { maxSummaryTokens: 1024 }),
    );

    const callArgs = streamSpy.mock.calls[0]![0];
    expect(callArgs.maxOutputTokens).toBe(1024);
  });

  it("extracts summary tags from response", async () => {
    const llmResponse = conformingSummary("Testing the compactor.");

    const messages = makeFiller(15);
    const result = await compactSessionRemote(
      { messages },
      remoteConfig(mockProvider(llmResponse)),
    );

    expect(result.summary).toContain("Primary Request and Intent");
    expect(result.summary).toContain("Pending Tasks");
    // Analysis block should be stripped (only the <summary> slice is kept).
    expect(result.summary).not.toContain("analysis notes");
  });

  it("falls back to mechanical when the response lacks required sections after a retry", async () => {
    // Neither attempt conforms → validation fails twice → mechanical fallback.
    const provider = mockProvider("The user was working on a compaction feature.");
    const streamSpy = vi.spyOn(provider, "stream");

    const messages = makeFiller(15);
    const result = await compactSessionRemote(
      { messages },
      remoteConfig(provider),
    );

    // Initial attempt + exactly one corrective retry.
    expect(streamSpy).toHaveBeenCalledTimes(2);
    const systemText = (
      result.compactedSession.messages[0]!.content[0] as {
        type: "text";
        text: string;
      }
    ).text;
    expect(systemText).toContain("Conversation summary:");
  });

  it("merges with existing summary", async () => {
    const existingSummary =
      "<summary>\nConversation summary:\n- Scope: 10 earlier messages compacted.\n</summary>";
    const systemMsg: ProviderMessage = {
      role: "system",
      content: [
        {
          type: "text",
          text: `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${existingSummary}\n\nRecent messages are preserved verbatim.\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, and do not preface with continuation text.`,
        },
      ],
    };

    const messages: ProviderMessage[] = [
      systemMsg,
      ...makeFiller(15),
    ];

    const result = await compactSessionRemote(
      { messages },
      remoteConfig(mockProvider(conformingSummary("More work done."))),
    );

    expect(result.removedMessageCount).toBeGreaterThan(0);
    const text = (
      result.compactedSession.messages[0]!.content[0] as {
        type: "text";
        text: string;
      }
    ).text;
    expect(text).toContain("Previously compacted");
  });

  it("respects external abort signal", async () => {
    const messages = makeFiller(15);
    const session: Session = { messages };

    const controller = new AbortController();
    controller.abort();

    const result = await compactSessionRemote(
      session,
      remoteConfig(slowProvider(10_000, "never")),
      controller.signal,
    );

    // Should fall back to mechanical since abort fires immediately
    expect(result.removedMessageCount).toBeGreaterThan(0);
  });

  it("formats tool calls in conversation", async () => {
    const messages: ProviderMessage[] = [
      userText("read foo.ts"),
      assistantToolUse("t1", "read_file", { path: "/foo.ts" }),
      toolResult("t1", "file contents here"),
      assistantText("here is the file content"),
      ...makeFiller(10),
    ];

    const provider = mockProvider("<summary>Tools were used.</summary>");
    const streamSpy = vi.spyOn(provider, "stream");

    await compactSessionRemote(
      { messages },
      remoteConfig(provider),
    );

    const callArgs = streamSpy.mock.calls[0]![0];
    const userMsgText = (callArgs.messages[0]!.content[0] as { text: string }).text;
    expect(userMsgText).toContain("Tool call: read_file");
    expect(userMsgText).toContain("Tool result:");
  });
});

// ---------------------------------------------------------------------------
// Section validation + retry
// ---------------------------------------------------------------------------

describe("missingSummarySections", () => {
  it("reports no missing sections for a conforming summary", () => {
    expect(missingSummarySections(conformingSummary())).toEqual([]);
  });

  it("reports the sections absent from a partial summary", () => {
    const partial = "<summary>\n## Primary Request and Intent\nx\n</summary>";
    const missing = missingSummarySections(partial);
    expect(missing).toContain("Pending Tasks");
    expect(missing).toContain("Current Work");
    expect(missing).not.toContain("Primary Request and Intent");
  });

  it("matches section headers case-insensitively", () => {
    const body = REQUIRED_SUMMARY_SECTIONS.map(
      (s) => `## ${s.toUpperCase()}\nx`,
    ).join("\n\n");
    expect(missingSummarySections(`<summary>\n${body}\n</summary>`)).toEqual([]);
  });
});

describe("compactSessionRemote — section validation", () => {
  it("accepts a fully-conforming summary without retrying", async () => {
    const provider = mockProvider(conformingSummary());
    const streamSpy = vi.spyOn(provider, "stream");

    const result = await compactSessionRemote(
      { messages: makeFiller(15) },
      remoteConfig(provider),
    );

    expect(streamSpy).toHaveBeenCalledTimes(1);
    expect(result.summary).toContain("Current Work");
  });

  it("retries once with a corrective note, then uses the corrected summary", async () => {
    const provider = sequenceProvider([
      "<summary>\n## Primary Request and Intent\nonly one section\n</summary>",
      conformingSummary("corrected on retry"),
    ]);
    const streamSpy = vi.spyOn(provider, "stream");

    const result = await compactSessionRemote(
      { messages: makeFiller(15) },
      remoteConfig(provider),
    );

    expect(streamSpy).toHaveBeenCalledTimes(2);
    // The retry prompt must enumerate the missing sections.
    const retryText = (
      streamSpy.mock.calls[1]![0].messages[0]!.content[0] as { text: string }
    ).text;
    expect(retryText).toContain("Correction Required");
    expect(retryText).toContain("Pending Tasks");
    // Final summary is the corrected remote one, not a mechanical fallback.
    expect(result.summary).toContain("corrected on retry");
  });

  it("does not retry more than once (bounded)", async () => {
    const provider = mockProvider("<summary>never conforms</summary>");
    const streamSpy = vi.spyOn(provider, "stream");

    await compactSessionRemote(
      { messages: makeFiller(15) },
      remoteConfig(provider),
    );

    expect(streamSpy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

describe("REMOTE_COMPACTION_SYSTEM_PROMPT", () => {
  it("contains required sections", () => {
    expect(REMOTE_COMPACTION_SYSTEM_PROMPT).toContain("Primary Request");
    expect(REMOTE_COMPACTION_SYSTEM_PROMPT).toContain("Key Technical Concepts");
    expect(REMOTE_COMPACTION_SYSTEM_PROMPT).toContain("Files and Code Sections");
    expect(REMOTE_COMPACTION_SYSTEM_PROMPT).toContain("Pending Tasks");
    expect(REMOTE_COMPACTION_SYSTEM_PROMPT).toContain("<analysis>");
    expect(REMOTE_COMPACTION_SYSTEM_PROMPT).toContain("<summary>");
  });
});
