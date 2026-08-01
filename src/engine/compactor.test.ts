/**
 * Compactor test suite — originally derived from a reference implementation.
 * At least 15 tests covering all exported functions.
 */

import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  estimateSessionTokens,
  messageChars,
  calibrateTokensPerChar,
  DEFAULT_TOKENS_PER_CHAR,
  shouldCompact,
  compactSession,
  summarizeMessages,
  mergeCompactSummaries,
  extractExistingCompactedSummary,
  formatCompactSummary,
  getCompactContinuationMessage,
  compactedSummaryPrefixLen,
  extractLatestTodos,
  renderTodoProgressBlock,
  withTodoProgress,
  DEFAULT_COMPACTION,
  type Session,
  type CompactionConfig,
  defaultCompactionForProvider,
  autoCompactThreshold,
} from "./compactor.js";
import type { ProviderMessage } from "../providers/index.js";

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
  input: unknown
): ProviderMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input }],
  };
}

function toolResult(
  tool_use_id: string,
  content: string,
  is_error = false
): ProviderMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id, content, is_error }],
  };
}

function session(messages: ProviderMessage[]): Session {
  return { messages };
}

const TIGHT_CONFIG: CompactionConfig = {
  preserveRecentMessages: 4,
  maxEstimatedTokens: 1,
};

// ---------------------------------------------------------------------------
// 1. estimateTokens — 10 000-char message → ~2501
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("returns char.length / 4 + 1 for a text message", () => {
    const msg = userText("x".repeat(10_000));
    // 10000 / 4 + 1 = 2501
    expect(estimateTokens(msg)).toBe(2501);
  });

  it("handles multi-block messages by summing all blocks", () => {
    const msg: ProviderMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "a".repeat(400) }, // 400/4+1 = 101
        { type: "tool_use", id: "1", name: "bash", input: { cmd: "x".repeat(396) } },
        // name.len=4, JSON.stringify({cmd:"x"*396}).length ≈ 4+396+... let's just assert > 0
      ],
    };
    expect(estimateTokens(msg)).toBeGreaterThan(0);
  });

  it("counts a reasoning block by its signature length (not 0)", () => {
    const msg: ProviderMessage = {
      role: "assistant",
      content: [{ type: "reasoning", signature: "x".repeat(8000) }],
    };
    // Was a real undercount: a reasoning block used to contribute 0 tokens.
    expect(estimateTokens(msg)).toBe(Math.floor(8000 / 4) + 1);
  });

  it("default ratio is byte-for-byte the prior char/4 behavior (TE-24)", () => {
    const msg = userText("y".repeat(9_999));
    expect(estimateTokens(msg, DEFAULT_TOKENS_PER_CHAR)).toBe(estimateTokens(msg));
    expect(estimateTokens(msg, 0.25)).toBe(Math.floor(9_999 / 4) + 1);
  });

  it("scales with a calibrated ratio (denser tokenizer → more tokens)", () => {
    const msg = userText("z".repeat(4_000));
    // char/4 → 1001; a CJK-ish 1 token/char ratio → 4001.
    expect(estimateTokens(msg, 0.25)).toBe(1_001);
    expect(estimateTokens(msg, 1.0)).toBe(4_001);
  });
});

// ---------------------------------------------------------------------------
// 1b. tokens-per-char calibration (TE-24)
// ---------------------------------------------------------------------------

describe("messageChars", () => {
  it("counts the same fields estimateTokens divides", () => {
    expect(messageChars(userText("x".repeat(100)))).toBe(100);
    const tr = toolResult("tu-1", "y".repeat(50));
    // tool_use_id ("tu-1" = 4) + content (50) = 54
    expect(messageChars(tr)).toBe(54);
  });
});

describe("calibrateTokensPerChar", () => {
  const msgs = [userText("a".repeat(1_000)), userText("b".repeat(1_000))];

  it("derives tokens/char from real usage over covered message chars", () => {
    // 1000 tokens over 2000 covered chars → 0.5 tokens/char.
    expect(calibrateTokensPerChar(1_000, msgs, 2)).toBeCloseTo(0.5);
  });

  it("only counts messages up to the covered high-water mark", () => {
    // Covered=1 → 1000 chars; 800 tokens → 0.8.
    expect(calibrateTokensPerChar(800, msgs, 1)).toBeCloseTo(0.8);
  });

  it("falls back to the default with no usage signal or empty coverage", () => {
    expect(calibrateTokensPerChar(0, msgs, 2)).toBe(DEFAULT_TOKENS_PER_CHAR);
    expect(calibrateTokensPerChar(1_000, msgs, 0)).toBe(DEFAULT_TOKENS_PER_CHAR);
  });

  it("rejects absurd ratios (garbled usage report) and falls back", () => {
    // 5000 tokens / 2000 chars = 2.5 > max → default.
    expect(calibrateTokensPerChar(5_000, msgs, 2)).toBe(DEFAULT_TOKENS_PER_CHAR);
    // 50 tokens / 2000 chars = 0.025 < min → default.
    expect(calibrateTokensPerChar(50, msgs, 2)).toBe(DEFAULT_TOKENS_PER_CHAR);
  });

  it("clamps the covered count to the message array length", () => {
    // coveredCount beyond messages.length must not read past the end.
    expect(calibrateTokensPerChar(1_000, msgs, 99)).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// 2. estimateSessionTokens — sums across messages
// ---------------------------------------------------------------------------

describe("estimateSessionTokens", () => {
  it("sums token estimates across all messages", () => {
    const s = session([
      userText("a".repeat(400)), // 101
      assistantText("b".repeat(400)), // 101
    ]);
    expect(estimateSessionTokens(s)).toBe(202);
  });

  it("returns 0 for empty session", () => {
    expect(estimateSessionTokens(session([]))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. shouldCompact — empty session → false
// ---------------------------------------------------------------------------

describe("shouldCompact", () => {
  it("returns false for empty session", () => {
    expect(shouldCompact(session([]), DEFAULT_COMPACTION)).toBe(false);
  });

  it("returns false when below token threshold", () => {
    const s = session([
      userText("hello"),
      assistantText("world"),
      userText("foo"),
      assistantText("bar"),
      userText("baz"),
    ]);
    // tokens well below 10_000
    expect(shouldCompact(s, DEFAULT_COMPACTION)).toBe(false);
  });

  it("returns true when above token threshold", () => {
    const s = session([
      userText("x".repeat(10_000)), // 2501 tokens
      assistantText("y".repeat(10_000)),
      userText("z".repeat(10_000)),
      assistantText("w".repeat(10_000)),
      userText("last"),
    ]);
    expect(
      shouldCompact(s, { preserveRecentMessages: 4, maxEstimatedTokens: 1 })
    ).toBe(true);
  });

  it("returns false when exactly at preserve boundary (no compactable messages beyond recent)", () => {
    const s = session([
      userText("a"),
      assistantText("b"),
      userText("c"),
      assistantText("d"),
    ]);
    expect(
      shouldCompact(s, { preserveRecentMessages: 4, maxEstimatedTokens: 1 })
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. compactSession — clean boundary, boundaryWalkedBack: false
// ---------------------------------------------------------------------------

describe("compactSession — clean boundary", () => {
  it("preserves last N messages, emits summary, boundaryWalkedBack false", () => {
    const msgs: ProviderMessage[] = [
      userText("x".repeat(5_000)),
      assistantText("y".repeat(5_000)),
      userText("z".repeat(5_000)),
      assistantText("w".repeat(5_000)),
      userText("recent 1"),
      assistantText("recent 2"),
      userText("recent 3"),
      assistantText("recent 4"),
    ];
    const s = session(msgs);
    const config: CompactionConfig = {
      preserveRecentMessages: 4,
      maxEstimatedTokens: 1,
    };
    const result = compactSession(s, config);

    expect(result.removedMessageCount).toBeGreaterThan(0);
    expect(result.boundaryWalkedBack).toBe(false);
    expect(result.summary).not.toBe("");
    // compacted session: [user continuation (CC shape)] + last 4 messages
    expect(result.compactedSession.messages[0].role).toBe("user");
    expect(result.compactedSession.messages.length).toBe(5); // 1 system + 4 preserved
  });
});

// ---------------------------------------------------------------------------
// 7. compactSession — tool_use/tool_result pair at boundary → walk back
// ---------------------------------------------------------------------------

describe("compactSession — boundary walk-back (tool_use/tool_result pair)", () => {
  it("walks back boundary to include assistant tool_use when tool_result is first", () => {
    // messages: [user, assistant(tool_use), user(tool_result), assistant(final)]
    // With preserveRecentMessages=2, rawKeepFrom=2, which lands on tool_result → walk back
    const msgs: ProviderMessage[] = [
      userText("x".repeat(5_000)),
      assistantToolUse("call1", "bash", { cmd: "ls" }),
      toolResult("call1", "file.txt"),
      assistantText("done"),
    ];
    const s = session(msgs);
    const config: CompactionConfig = {
      preserveRecentMessages: 2,
      maxEstimatedTokens: 1,
    };
    const result = compactSession(s, config);

    expect(result.boundaryWalkedBack).toBe(true);
    // The tail should include assistant(tool_use) + tool_result + assistant(final) = 3 preserved
    // So compacted = [system] + 3 = 4 total messages
    const compacted = result.compactedSession.messages;
    // Verify no orphaned tool_result (every tool_result is preceded by assistant with tool_use)
    for (let i = 1; i < compacted.length; i++) {
      const curr = compacted[i];
      if (
        curr.role === "user" &&
        curr.content[0]?.type === "tool_result"
      ) {
        const prev = compacted[i - 1];
        expect(prev.role).toBe("assistant");
        expect(
          prev.content.some((b) => b.type === "tool_use")
        ).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 8. compactSession — orphan tool_result at boundary → walk back
// ---------------------------------------------------------------------------

describe("compactSession — orphan tool_result walk-back", () => {
  it("walks back when tool_result has no preceding assistant tool_use", () => {
    // Already broken state: tool_result with no matching tool_use before it.
    // With preserveRecentMessages=1, rawKeepFrom = 4-1 = 3 → messages[3] is
    // toolResult (orphan, no preceding assistant with tool_use) → walk back.
    const msgs: ProviderMessage[] = [
      userText("x".repeat(5_000)),
      userText("another big message " .repeat(200)),
      userText("yet another " .repeat(200)),
      toolResult("orphan", "some output"), // orphan — no preceding assistant with tool_use
      assistantText("final"),
    ];
    const s = session(msgs);
    const config: CompactionConfig = {
      preserveRecentMessages: 2,
      maxEstimatedTokens: 1,
    };
    // rawKeepFrom = 5 - 2 = 3 → messages[3] is toolResult → walk back (orphan)
    const result = compactSession(s, config);

    // Should still walk back (orphan path)
    expect(result.boundaryWalkedBack).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. extractExistingCompactedSummary
// ---------------------------------------------------------------------------

describe("extractExistingCompactedSummary", () => {
  it("finds a pre-existing summary in a compacted system message", () => {
    const rawSummary = "<summary>Conversation summary:\n- Scope: prior work.\n</summary>";
    const continuationMsg = getCompactContinuationMessage(rawSummary, true, true);
    const systemMsg: ProviderMessage = {
      role: "system",
      content: [{ type: "text", text: continuationMsg }],
    };
    const result = extractExistingCompactedSummary(systemMsg);
    expect(result).not.toBeNull();
    expect(result).toContain("Summary:");
  });

  it("returns null for a clean (non-compacted) message", () => {
    const systemMsg: ProviderMessage = {
      role: "system",
      content: [{ type: "text", text: "You are a helpful assistant." }],
    };
    expect(extractExistingCompactedSummary(systemMsg)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(extractExistingCompactedSummary(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 10. mergeCompactSummaries
// ---------------------------------------------------------------------------

describe("mergeCompactSummaries", () => {
  it("returns newSummary unchanged when no existing summary", () => {
    const newSummary =
      "<summary>Conversation summary:\n- Scope: 2 earlier messages compacted (user=1, assistant=1, tool=0).\n- Key timeline:\n  - user: hi\n  - assistant: hello\n</summary>";
    expect(mergeCompactSummaries(null, newSummary)).toBe(newSummary);
  });

  it("combines existing and new summaries into one block", () => {
    const existing =
      "<summary>Conversation summary:\n- Scope: 2 earlier messages compacted (user=1, assistant=1, tool=0).\n- Key timeline:\n  - user: first\n</summary>";
    const newSummary =
      "<summary>Conversation summary:\n- Scope: 2 earlier messages compacted (user=1, assistant=1, tool=0).\n- Key timeline:\n  - user: second\n</summary>";
    const merged = mergeCompactSummaries(existing, newSummary);
    expect(merged).toContain("Previously compacted context:");
    expect(merged).toContain("Newly compacted context:");
    expect(merged).toContain("<summary>");
    expect(merged).toContain("</summary>");
  });
});

// ---------------------------------------------------------------------------
// 11. formatCompactSummary
// ---------------------------------------------------------------------------

describe("formatCompactSummary", () => {
  it("strips analysis tags and converts summary tags to prose", () => {
    const summary = "<analysis>scratch</analysis>\n<summary>Kept work</summary>";
    expect(formatCompactSummary(summary)).toBe("Summary:\nKept work");
  });

  it("passes through plain text without tags", () => {
    expect(formatCompactSummary("plain text")).toBe("plain text");
  });
});

// ---------------------------------------------------------------------------
// 12. getCompactContinuationMessage
// ---------------------------------------------------------------------------

describe("getCompactContinuationMessage", () => {
  it("starts with the continuation preamble", () => {
    const msg = getCompactContinuationMessage("<summary>x</summary>", true, true);
    expect(msg.startsWith("This session is being continued")).toBe(true);
  });

  it("includes recent messages note when recentMessagesPreserved=true", () => {
    const msg = getCompactContinuationMessage("<summary>x</summary>", true, true);
    expect(msg).toContain("Recent messages are preserved verbatim.");
  });

  it("includes resume instruction when suppressFollowUpQuestions=true", () => {
    const msg = getCompactContinuationMessage("<summary>x</summary>", true, false);
    expect(msg).toContain(
      "Continue the conversation from where it left off"
    );
  });

  it("omits recent messages note when recentMessagesPreserved=false", () => {
    const msg = getCompactContinuationMessage("<summary>x</summary>", false, false);
    expect(msg).not.toContain("Recent messages are preserved verbatim.");
  });
});

// ---------------------------------------------------------------------------
// 13. compactedSummaryPrefixLen
// ---------------------------------------------------------------------------

describe("compactedSummaryPrefixLen", () => {
  it("returns 0 for a clean session", () => {
    const s = session([userText("hello"), assistantText("world")]);
    expect(compactedSummaryPrefixLen(s)).toBe(0);
  });

  it("returns 1 for a session starting with a compacted summary", () => {
    const rawSummary = "<summary>Conversation summary:\n- Scope: prior.\n- Key timeline:\n  - user: hi\n</summary>";
    const continuationMsg = getCompactContinuationMessage(rawSummary, true, true);
    const s = session([
      { role: "system", content: [{ type: "text", text: continuationMsg }] },
      userText("after compaction"),
    ]);
    expect(compactedSummaryPrefixLen(s)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 14. summarizeMessages — scope counters
// ---------------------------------------------------------------------------

describe("summarizeMessages", () => {
  it("produces correct scope counters", () => {
    const msgs: ProviderMessage[] = [
      userText("hello"),
      assistantText("hi"),
      assistantToolUse("t1", "bash", {}),
      toolResult("t1", "ok"),
    ];
    const summary = summarizeMessages(msgs);
    expect(summary).toContain("4 earlier messages compacted");
    expect(summary).toContain("user=2"); // userText + toolResult (both user role)
    expect(summary).toContain("assistant=2");
  });

  it("wraps output in <summary> tags", () => {
    const summary = summarizeMessages([userText("hi")]);
    expect(summary.startsWith("<summary>")).toBe(true);
    expect(summary.endsWith("</summary>")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 15. summarizeMessages — tool name dedup
// ---------------------------------------------------------------------------

describe("summarizeMessages — tool name dedup", () => {
  it("dedups tool names and lists them sorted", () => {
    const msgs: ProviderMessage[] = [
      assistantToolUse("1", "bash", {}),
      assistantToolUse("2", "bash", {}), // duplicate
      assistantToolUse("3", "search", {}),
      assistantToolUse("4", "apply_edit", {}),
    ];
    const summary = summarizeMessages(msgs);
    // After sort+dedup: apply_edit, bash, search
    expect(summary).toContain("- Tools mentioned: apply_edit, bash, search.");
  });
});

// ---------------------------------------------------------------------------
// 16. compactSession — leaves small sessions unchanged
// ---------------------------------------------------------------------------

describe("compactSession — no-op on small session", () => {
  it("returns original session when shouldCompact is false", () => {
    const s = session([userText("hello")]);
    const result = compactSession(s, DEFAULT_COMPACTION);
    expect(result.removedMessageCount).toBe(0);
    expect(result.summary).toBe("");
    expect(result.boundaryWalkedBack).toBe(false);
    expect(result.compactedSession).toBe(s);
  });
});

// ---------------------------------------------------------------------------
// 17. Todo-tree progress section
// ---------------------------------------------------------------------------

function todoWrite(
  todos: Array<{ id: string; content: string; status: string }>,
): ProviderMessage {
  return assistantToolUse("td", "todo_write", { todos });
}

describe("extractLatestTodos", () => {
  it("returns null when no todo_write is present", () => {
    expect(extractLatestTodos([userText("hi"), assistantText("yo")])).toBeNull();
  });

  it("returns the most recent snapshot (newest wins)", () => {
    const msgs = [
      todoWrite([{ id: "1", content: "old", status: "pending" }]),
      assistantText("work"),
      todoWrite([
        { id: "1", content: "step one", status: "completed" },
        { id: "2", content: "step two", status: "in_progress" },
      ]),
    ];
    const todos = extractLatestTodos(msgs);
    expect(todos).not.toBeNull();
    expect(todos!).toHaveLength(2);
    expect(todos![0]).toEqual({ content: "step one", status: "completed" });
    expect(todos![1]).toEqual({ content: "step two", status: "in_progress" });
  });

  it("ignores malformed todo entries but keeps valid ones", () => {
    const msgs = [
      todoWrite([
        { id: "1", content: "valid", status: "pending" },
        { id: "2", content: "bad-status", status: "banana" },
      ] as any),
    ];
    const todos = extractLatestTodos(msgs);
    expect(todos!).toHaveLength(1);
    expect(todos![0]!.content).toBe("valid");
  });

  it("returns null when todos array is empty or absent", () => {
    expect(extractLatestTodos([todoWrite([])])).toBeNull();
    expect(
      extractLatestTodos([assistantToolUse("x", "todo_write", {})]),
    ).toBeNull();
  });
});

describe("renderTodoProgressBlock", () => {
  it("renders a header with the done/total count and status icons", () => {
    const block = renderTodoProgressBlock([
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "pending" },
    ]);
    expect(block).toContain("## Todos / Progress (1/3 done)");
    expect(block).toContain("✓ completed: a");
    expect(block).toContain("▶ in_progress: b");
    expect(block).toContain("☐ pending: c");
  });
});

describe("withTodoProgress", () => {
  it("inserts the block before the closing </summary> tag", () => {
    const summary = "<summary>\nConversation summary:\n- x\n</summary>";
    const out = withTodoProgress(summary, [
      todoWrite([{ id: "1", content: "finish it", status: "in_progress" }]),
    ]);
    expect(out).toContain("## Todos / Progress");
    expect(out.indexOf("## Todos / Progress")).toBeLessThan(
      out.indexOf("</summary>"),
    );
  });

  it("is a no-op when there are no todos", () => {
    const summary = "<summary>\nx\n</summary>";
    expect(withTodoProgress(summary, [userText("hi")])).toBe(summary);
  });

  it("appends when the summary has no </summary> tag", () => {
    const out = withTodoProgress("plain summary", [
      todoWrite([{ id: "1", content: "do", status: "pending" }]),
    ]);
    expect(out.startsWith("plain summary")).toBe(true);
    expect(out).toContain("## Todos / Progress");
  });
});

describe("compactSession — carries todo progress across the boundary", () => {
  it("includes the latest todo snapshot in the compacted summary", () => {
    const msgs: ProviderMessage[] = [
      userText("start the plan"),
      todoWrite([
        { id: "1", content: "design", status: "completed" },
        { id: "2", content: "implement", status: "in_progress" },
      ]),
      ...Array.from({ length: 8 }, (_, i) =>
        i % 2 === 0 ? userText("u".repeat(400)) : assistantText("a".repeat(400)),
      ),
    ];
    const result = compactSession(session(msgs), {
      preserveRecentMessages: 2,
      maxEstimatedTokens: 100,
    });
    expect(result.removedMessageCount).toBeGreaterThan(0);
    const systemText = (
      result.compactedSession.messages[0]!.content[0] as {
        type: "text";
        text: string;
      }
    ).text;
    expect(systemText).toContain("## Todos / Progress");
    expect(systemText).toContain("implement");
  });
});

describe("defaultCompactionForProvider (rapid-refill-breaker regression)", () => {
  // An engine built without an explicit compactionConfig used to inherit
  // DEFAULT_COMPACTION's 10k maxEstimatedTokens regardless of the model's window. On a
  // 200k-window model that means compacting from ~10k tokens onward and re-compacting
  // nearly every turn, which trips the rapid-refill breaker and kills the run. The
  // failure was invisible at the call site: omitting the option looks harmless.
  it("sizes the estimator threshold to a large provider window, not the 10k floor", () => {
    const cfg = defaultCompactionForProvider({
      capabilities: { maxContextTokens: 200_000 },
    });
    expect(cfg.maxEstimatedTokens).toBe(autoCompactThreshold(200_000));
    expect(cfg.maxEstimatedTokens).toBeGreaterThan(
      DEFAULT_COMPACTION.maxEstimatedTokens * 10,
    );
  });

  it("keeps the 10k floor for genuinely tiny context windows", () => {
    const cfg = defaultCompactionForProvider({
      capabilities: { maxContextTokens: 8_000 },
    });
    expect(cfg.maxEstimatedTokens).toBe(DEFAULT_COMPACTION.maxEstimatedTokens);
  });

  it("a 200k-window agent does not compact at a context size the old default would", () => {
    // 40k tokens: comfortably under the real threshold, far over the 10k floor.
    const cfg = defaultCompactionForProvider({
      capabilities: { maxContextTokens: 200_000 },
    });
    expect(40_000 >= cfg.maxEstimatedTokens).toBe(false);
    expect(40_000 >= DEFAULT_COMPACTION.maxEstimatedTokens).toBe(true);
  });
});
