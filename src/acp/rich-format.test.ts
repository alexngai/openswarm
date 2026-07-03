import { describe, it, expect } from "vitest";
import { formatRichView } from "./rich-format.js";
import type { RichView } from "./rich-view.js";
import type { TeamUsagePayload } from "../swarm/events.js";

describe("formatRichView", () => {
  it("renders per-member lanes (header + text + tools) then the board", () => {
    const view: RichView = {
      lanes: [
        { memberId: "m-L", role: "lead", name: "lead", text: "on it.", tools: [] },
        {
          memberId: "m-A",
          role: "architect",
          name: "architect",
          text: "",
          tools: [
            { toolCallId: "A:t1", title: "[architect] Read file", status: "completed" },
            { toolCallId: "A:t2", title: "[architect] Edit file", status: "in_progress" },
          ],
        },
      ],
      board: [
        { content: "lead", status: "in_progress", memberId: "m-L" },
        { content: "architect", status: "completed", memberId: "m-A" },
      ],
    };
    const out = formatRichView(view).join("\n");

    // Lane headers carry the role + member id.
    expect(out).toContain("[lead] (m-L)");
    expect(out).toContain("[architect] (m-A)");
    // Lead narration + the architect's tools with status glyphs.
    expect(out).toContain("  on it.");
    expect(out).toContain("● [architect] Read file");
    expect(out).toContain("◐ [architect] Edit file");
    // Board section linking entries to members.
    expect(out).toContain("── board");
    expect(out).toContain("architect (m-A)");
  });

  it("omits the board when empty and labels an unattributed lane", () => {
    const view: RichView = {
      lanes: [{ memberId: "", text: "hello", tools: [] }],
      board: [],
    };
    const out = formatRichView(view).join("\n");
    expect(out).toContain("[orchestrator]");
    expect(out).not.toContain("board");
  });

  it("renders a bounded inline diff under an edit tool call", () => {
    const view: RichView = {
      lanes: [
        {
          memberId: "impl-04",
          role: "implementer",
          text: "",
          tools: [
            {
              toolCallId: "impl-04:t3",
              title: "[implementer] Edit src/auth/session.ts",
              status: "completed",
              diffs: [
                {
                  path: "src/auth/session.ts",
                  oldText: "const SESSION_TTL = 3600",
                  newText: "const SESSION_TTL = 900 // tighten session lifetime",
                },
              ],
            },
          ],
        },
      ],
      board: [],
    };
    const out = formatRichView(view).join("\n");
    expect(out).toContain("[implementer] Edit src/auth/session.ts");
    // ± summary line with +/- line counts.
    expect(out).toContain("± src/auth/session.ts  +1 -1");
    // Unified snippet: removed then added.
    expect(out).toContain("- const SESSION_TTL = 3600");
    expect(out).toContain("+ const SESSION_TTL = 900 // tighten session lifetime");
  });

  it("truncates a large diff snippet with an ellipsis", () => {
    const newText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const view: RichView = {
      lanes: [
        {
          memberId: "impl-04",
          role: "implementer",
          text: "",
          tools: [
            {
              toolCallId: "impl-04:t9",
              title: "[implementer] Write big.ts",
              status: "completed",
              diffs: [{ path: "big.ts", oldText: null, newText }],
            },
          ],
        },
      ],
      board: [],
    };
    const out = formatRichView(view);
    expect(out.some((l) => l.includes("± big.ts  +20 -0"))).toBe(true);
    expect(out.some((l) => l.trim() === "…")).toBe(true);
    // Snippet body is capped (summary + 6 lines + ellipsis), not all 20 lines.
    const plusLines = out.filter((l) => l.trim().startsWith("+ line"));
    expect(plusLines.length).toBe(6);
  });

  it("renders per-member cost in lane headers plus a team-usage ledger", () => {
    const view: RichView = {
      lanes: [
        { memberId: "arch-02", role: "architect", text: "", tools: [] },
        { memberId: "impl-04", role: "implementer", text: "", tools: [] },
      ],
      board: [],
    };
    const usage: TeamUsagePayload = {
      members: [
        {
          agentId: "arch-02",
          memberId: "arch-02",
          role: "architect",
          inputTokens: 4200,
          outputTokens: 1800,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          totalTokens: 6000,
          costUsd: 0.021,
        },
        {
          agentId: "impl-04",
          memberId: "impl-04",
          role: "implementer",
          inputTokens: 5100,
          outputTokens: 2600,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          totalTokens: 7700,
          costUsd: 0.028,
        },
      ],
      team: {
        inputTokens: 9300,
        outputTokens: 4400,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
        totalTokens: 17600,
        costUsd: 0.063,
      },
    };
    const out = formatRichView(view, usage).join("\n");
    // Per-member cost suffix on the lane header.
    expect(out).toMatch(/\[architect\].*6\.0k tok · \$0\.021/);
    // Dedicated usage pane with per-member rows and a team total.
    expect(out).toContain("── usage");
    expect(out).toContain("[implementer] (impl-04)  7.7k tok · $0.028");
    expect(out).toContain("Σ team  17.6k tok · $0.063");
  });
});
