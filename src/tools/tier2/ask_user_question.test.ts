/**
 * Tests for ask_user_question tool — M3b Phase 6.
 */

import { describe, it, expect } from "vitest";
import { askUserQuestionTool } from "./ask_user_question.js";
import { makeFakeHost } from "./_fake-host.js";
import type { ToolExecutionContext } from "../types.js";

const CTX_CWD = process.cwd();

describe("ask_user_question tool", () => {
  it("happy path: host returns answered → tool emits JSON AskUserResponse", async () => {
    const { host, calls } = makeFakeHost({
      askUserResponse: { status: "answered", answer: "blue" },
    });
    const ctx: ToolExecutionContext = { cwd: CTX_CWD, host };
    const result = await askUserQuestionTool.execute(
      { question: "favorite color?", options: ["red", "blue"] },
      ctx,
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(JSON.parse(result.output)).toEqual({
        status: "answered",
        answer: "blue",
      });
    }
    expect(calls.askUser).toHaveLength(1);
    expect(calls.askUser[0]?.question).toBe("favorite color?");
    expect(calls.askUser[0]?.options).toEqual(["red", "blue"]);
  });

  it("timed-out: host returns timed-out → tool propagates status", async () => {
    const { host } = makeFakeHost({ askUserResponse: { status: "timed-out" } });
    const ctx: ToolExecutionContext = { cwd: CTX_CWD, host };
    const result = await askUserQuestionTool.execute(
      { question: "waiting?" },
      ctx,
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(JSON.parse(result.output)).toEqual({ status: "timed-out" });
    }
  });

  it("error: host returns error → tool propagates status + message", async () => {
    const { host } = makeFakeHost({
      askUserResponse: { status: "error", message: "no TTY" },
    });
    const ctx: ToolExecutionContext = { cwd: CTX_CWD, host };
    const result = await askUserQuestionTool.execute(
      { question: "anyone home?" },
      ctx,
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(JSON.parse(result.output)).toEqual({
        status: "error",
        message: "no TTY",
      });
    }
  });

  it("empty question → zod error", async () => {
    const { host } = makeFakeHost();
    const ctx: ToolExecutionContext = { cwd: CTX_CWD, host };
    const result = await askUserQuestionTool.execute({ question: "" }, ctx);
    expect(result.status).toBe("error");
  });

  it("throws when host is missing", async () => {
    await expect(
      askUserQuestionTool.execute({ question: "x" }, { cwd: CTX_CWD }),
    ).rejects.toThrow(/ask_user_question requires SwarmHost/);
  });

  it("translates host throw into tool error", async () => {
    const { host } = makeFakeHost();
    // Override askUser to throw.
    (host as unknown as { askUser: (...a: unknown[]) => Promise<unknown> }).askUser =
      () => Promise.reject(new Error("boom"));
    const ctx: ToolExecutionContext = { cwd: CTX_CWD, host };
    const result = await askUserQuestionTool.execute({ question: "x" }, ctx);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toMatch(/boom/);
    }
  });
});
