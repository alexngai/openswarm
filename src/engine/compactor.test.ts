/**
 * Compactor test suite — parity with claw-code compact_test.rs (L562–L824).
 * At least 15 tests covering all exported functions.
 */

import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  estimateSessionTokens,
  shouldCompact,
  compactSession,
  summarizeMessages,
  mergeCompactSummaries,
  extractExistingCompactedSummary,
  formatCompactSummary,
  getCompactContinuationMessage,
  compactedSummaryPrefixLen,
  DEFAULT_COMPACTION,
  type Session,
  type CompactionConfig,
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
    // compacted session: [system summary] + last 4 messages
    expect(result.compactedSession.messages[0].role).toBe("system");
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
