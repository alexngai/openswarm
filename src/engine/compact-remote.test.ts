import { describe, it, expect, vi } from "vitest";
import {
  compactSessionRemote,
  isRemoteCompactionConfig,
  missingSummarySections,
  REQUIRED_SUMMARY_SECTIONS,
  type RemoteCompactionConfig,
} from "./compact-remote.js";
import {
  buildCompactSummaryRequest,
  buildRecentCompactSummaryRequest,
  standingConstraintsEnabled,
} from "./compact-prompts.js";
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

/**
 * Captures the messages the summarizer receives so a test can assert what the
 * real compaction path actually sent (TE-25). Returns a conforming summary so
 * compaction succeeds.
 */
function capturingProvider(captured: ProviderRequest[]): Provider {
  const base = mockProvider(conformingSummary());
  return {
    ...base,
    stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
      captured.push(request);
      return base.stream(request);
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
    // Continuation is a user message (Claude Code shape).
    expect(result.compactedSession.messages[0]!.role).toBe("user");
  });

  it("keeps no verbatim tail on the full path (CC shape)", async () => {
    const messages = makeFiller(15);
    const session: Session = { messages };

    const result = await compactSessionRemote(
      session,
      remoteConfig(mockProvider(conformingSummary())),
    );

    // Everything summarized; only the continuation message remains.
    expect(result.compactedSession.messages.length).toBe(1);
    expect(result.compactedSession.messages[0]!.role).toBe("user");
    expect(result.removedMessageCount).toBe(messages.length);
  });

  it("holds out a trailing pending user prompt across the boundary", async () => {
    const messages: ProviderMessage[] = [
      ...makeFiller(15),
      userText("please do the next thing"),
    ];
    const session: Session = { messages };

    const result = await compactSessionRemote(
      session,
      remoteConfig(mockProvider(conformingSummary())),
    );

    const compacted = result.compactedSession.messages;
    const lastText = (
      compacted[compacted.length - 1]!.content[0] as { text: string }
    ).text;
    expect(lastText).toBe("please do the next thing");
    // The pending prompt was NOT part of what got summarized.
    expect(result.removedMessageCount).toBe(messages.length - 1);
  });

  it("never leaves an orphaned tool_result after full compaction", async () => {
    const messages: ProviderMessage[] = [
      ...makeFiller(10),
      assistantToolUse("tu1", "bash", { command: "ls" }),
      toolResult("tu1", "file.txt"),
      userText("looks good"),
      assistantText("great"),
    ];
    const session: Session = { messages };

    const result = await compactSessionRemote(
      session,
      remoteConfig(mockProvider(conformingSummary())),
    );

    // Full path removes everything — no tool_result can survive unpaired.
    const hasToolResult = result.compactedSession.messages.some(
      (m) => m.role === "user" && m.content[0]?.type === "tool_result",
    );
    expect(hasToolResult).toBe(false);
    expect(result.boundaryWalkedBack).toBe(false);
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
    expect(result.compactedSession.messages[0]!.role).toBe("user");
    expect(result.summarizerFailed).toBe(true);
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

  it("injects recontextualize() attachments right after the continuation (F1)", async () => {
    const messages = makeFiller(15);
    const attachment: ProviderMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: "<system-reminder>\nProject instruction files (re-attached after compaction — these still apply):\n<instructions path=\"/repo/AGENTS.md\">follow these</instructions>\n</system-reminder>",
        },
      ],
    };
    const recontextualize = vi.fn(() => [attachment]);

    const result = await compactSessionRemote(
      { messages },
      remoteConfig(mockProvider(conformingSummary("Work."))),
      undefined,
      { recontextualize },
    );

    expect(recontextualize).toHaveBeenCalledTimes(1);
    // Continuation is index 0; the re-attached instructions come immediately after.
    const second = result.compactedSession.messages[1]!;
    const text = (second.content[0] as { text: string }).text;
    expect(text).toContain("re-attached after compaction");
    expect(text).toContain("/repo/AGENTS.md");
  });

  it("survives a throwing recontextualize() hook (F1)", async () => {
    const messages = makeFiller(15);
    const recontextualize = vi.fn(() => {
      throw new Error("boom");
    });

    const result = await compactSessionRemote(
      { messages },
      remoteConfig(mockProvider(conformingSummary("Work."))),
      undefined,
      { recontextualize },
    );

    expect(recontextualize).toHaveBeenCalledTimes(1);
    // Compaction still succeeds; the continuation is present.
    expect(result.removedMessageCount).toBeGreaterThan(0);
    const first = (
      result.compactedSession.messages[0]!.content[0] as { text: string }
    ).text;
    expect(first).toContain("continued from a previous conversation");
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

  it("folds a prior continuation message into the fresh summary (no mechanical merge)", async () => {
    const existingSummary =
      "<summary>\nConversation summary:\n- Scope: 10 earlier messages compacted.\n</summary>";
    const priorContinuation: ProviderMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${existingSummary}\n\nRecent messages are preserved verbatim.\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, and do not preface with continuation text.`,
        },
      ],
    };

    const messages: ProviderMessage[] = [
      priorContinuation,
      ...makeFiller(15),
    ];

    const provider = mockProvider(conformingSummary("More work done."));
    const streamSpy = vi.spyOn(provider, "stream");

    const result = await compactSessionRemote(
      { messages },
      remoteConfig(provider),
    );

    // The prior continuation is part of what the summarizer sees…
    const callArgs = streamSpy.mock.calls[0]![0];
    const firstMsgText = (
      callArgs.messages[0]!.content[0] as { text: string }
    ).text;
    expect(firstMsgText).toContain("Scope: 10 earlier messages compacted");
    // …and the whole history (including it) gets removed.
    expect(result.removedMessageCount).toBe(messages.length);
    // The fresh model summary replaces it — no mechanical merge markers.
    expect(result.summary).toContain("More work done.");
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

  it("sends the raw history plus the summary request as the last message", async () => {
    const messages: ProviderMessage[] = [
      userText("read foo.ts"),
      assistantToolUse("t1", "read_file", { path: "/foo.ts" }),
      toolResult("t1", "file contents here"),
      assistantText("here is the file content"),
      ...makeFiller(10),
    ];

    const provider = mockProvider(conformingSummary("Tools were used."));
    const streamSpy = vi.spyOn(provider, "stream");

    await compactSessionRemote(
      { messages },
      remoteConfig(provider),
    );

    const callArgs = streamSpy.mock.calls[0]![0];
    // Full-fidelity history: raw tool_use/tool_result blocks, not re-serialized.
    expect(callArgs.messages.length).toBe(messages.length + 1);
    expect(callArgs.messages[1]!.content[0]!.type).toBe("tool_use");
    expect(callArgs.messages[2]!.content[0]!.type).toBe("tool_result");
    // Last message is the CC summary request (with the no-tools guard).
    const requestMsg = callArgs.messages[callArgs.messages.length - 1]!;
    expect(requestMsg.role).toBe("user");
    const requestText = (requestMsg.content[0] as { text: string }).text;
    expect(requestText).toContain("CRITICAL: Respond with TEXT ONLY.");
    expect(requestText).toContain(
      "Your task is to create a detailed summary of the conversation so far",
    );
    // No tools offered to the summarizer.
    expect(callArgs.tools).toEqual([]);
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
    // The retry prompt (last message = summary request) must enumerate the
    // missing sections.
    const retryMessages = streamSpy.mock.calls[1]![0].messages;
    const retryText = (
      retryMessages[retryMessages.length - 1]!.content[0] as { text: string }
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
// Summary request prompt
// ---------------------------------------------------------------------------

describe("buildCompactSummaryRequest", () => {
  it("contains the guard, self-exclusion, all required sections, and the reminder", () => {
    const request = buildCompactSummaryRequest();
    expect(request).toContain("CRITICAL: Respond with TEXT ONLY.");
    // Self-exclusion note: keeps non-Claude summarizers from treating this
    // request as part of the conversation being summarized.
    expect(request).toContain(
      "This summarization request itself is NOT part of the conversation",
    );
    for (const section of REQUIRED_SUMMARY_SECTIONS) {
      expect(request).toContain(section);
    }
    expect(request).toContain("<analysis>");
    expect(request).toContain("<summary>");
    expect(request).toContain("REMINDER: Do NOT call any tools.");
  });

  it("appends custom instructions between prompt and reminder", () => {
    const request = buildCompactSummaryRequest("focus on the test failures");
    const instrIdx = request.indexOf(
      "Additional Instructions:\nfocus on the test failures",
    );
    const reminderIdx = request.indexOf("REMINDER: Do NOT call any tools.");
    expect(instrIdx).toBeGreaterThan(-1);
    expect(reminderIdx).toBeGreaterThan(instrIdx);
  });

  // TE-25 (docs/55): standing-constraints section is an opt-in addendum.
  it("omits the standing-constraints section by default (byte-exact CC core)", () => {
    expect(buildCompactSummaryRequest()).not.toContain("Standing facts & constraints");
    expect(buildRecentCompactSummaryRequest()).not.toContain("Standing facts & constraints");
  });

  it("adds the standing-constraints section when enabled, before any custom instructions", () => {
    const request = buildCompactSummaryRequest("focus on tests", {
      standingConstraints: true,
    });
    const sectionIdx = request.indexOf("Standing facts & constraints");
    const instrIdx = request.indexOf("Additional Instructions:\nfocus on tests");
    const reminderIdx = request.indexOf("REMINDER: Do NOT call any tools.");
    expect(sectionIdx).toBeGreaterThan(-1);
    // core prompt … standing section … custom instructions … reminder
    expect(sectionIdx).toBeLessThan(instrIdx);
    expect(instrIdx).toBeLessThan(reminderIdx);
    // Preserves the byte-exact core.
    expect(request).toContain("CRITICAL: Respond with TEXT ONLY.");
    for (const section of REQUIRED_SUMMARY_SECTIONS) {
      expect(request).toContain(section);
    }
  });

  it("adds the section to the reactive (keep-recent) variant too", () => {
    const request = buildRecentCompactSummaryRequest(undefined, {
      standingConstraints: true,
    });
    expect(request).toContain("Standing facts & constraints");
  });
});

describe("standing-constraints wiring through compactSessionRemote (TE-25)", () => {
  const FLAG = "OPENSWARM_COMPACT_STANDING_CONSTRAINTS";

  async function capturedSummaryRequest(flag: string | undefined): Promise<string> {
    const saved = process.env[FLAG];
    if (flag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = flag;
    try {
      const captured: ProviderRequest[] = [];
      const session: Session = {
        messages: [
          userText("Never touch src/legacy/ — vendored."),
          assistantText("Understood."),
          ...makeFiller(8),
        ],
      };
      await compactSessionRemote(session, remoteConfig(capturingProvider(captured)), undefined, {
        force: true,
      });
      // The summarizer request is the last user message of the summarize call.
      const req = captured[0]!;
      const last = req.messages[req.messages.length - 1]!;
      return last.content.map((b) => ("text" in b ? b.text : "")).join("");
    } finally {
      if (saved === undefined) delete process.env[FLAG];
      else process.env[FLAG] = saved;
    }
  }

  it("sends the standing-constraints section when enabled (default)", async () => {
    const text = await capturedSummaryRequest(undefined);
    expect(text).toContain("Standing facts & constraints");
  });

  it("omits the section on the baseline arm (flag off)", async () => {
    const text = await capturedSummaryRequest("0");
    expect(text).not.toContain("Standing facts & constraints");
    // Byte-exact CC core still present.
    expect(text).toContain("CRITICAL: Respond with TEXT ONLY.");
  });
});

describe("standingConstraintsEnabled", () => {
  it("defaults on (the TE-25 improvement ships enabled)", () => {
    expect(standingConstraintsEnabled({})).toBe(true);
  });

  it("is disabled by falsy flag values (eval baseline arm)", () => {
    for (const v of ["0", "false", "off", "no", "OFF", "False"]) {
      expect(standingConstraintsEnabled({ OPENSWARM_COMPACT_STANDING_CONSTRAINTS: v })).toBe(false);
    }
  });

  it("stays on for any other value", () => {
    expect(standingConstraintsEnabled({ OPENSWARM_COMPACT_STANDING_CONSTRAINTS: "1" })).toBe(true);
  });
});
