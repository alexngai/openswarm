import { describe, it, expect } from "vitest";
import { historyChunks } from "./history.js";

describe("historyChunks", () => {
  it("maps user/assistant history to ordered chunk notifications", () => {
    const notes = historyChunks(
      [
        { role: "user", text: "hi" },
        { role: "assistant", text: "hello" },
        { role: "user", text: "thanks" },
      ],
      "s1",
    );
    expect(notes).toEqual([
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "hi" },
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      },
      {
        sessionId: "s1",
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "thanks" },
        },
      },
    ]);
  });

  it("returns [] for empty history", () => {
    expect(historyChunks([], "s1")).toEqual([]);
  });
});
