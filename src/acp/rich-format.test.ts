import { describe, it, expect } from "vitest";
import { formatRichView } from "./rich-format.js";
import type { RichView } from "./rich-view.js";

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
});
