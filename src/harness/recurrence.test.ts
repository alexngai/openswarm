import { describe, expect, it } from "vitest";
import {
  FailureRecurrenceTracker,
  failureSignature,
  recurrenceNudge,
} from "./recurrence.js";

describe("failureSignature", () => {
  it("clusters failures that differ only by path", () => {
    const a = failureSignature("edit_file", "File does not exist: /home/u/src/a.ts");
    const b = failureSignature("edit_file", "File does not exist: /home/u/src/b.ts");
    expect(a).toBe(b);
  });

  it("clusters failures that differ only by number", () => {
    const a = failureSignature("edit_file", "Found 3 matches of the string to replace");
    const b = failureSignature("edit_file", "Found 17 matches of the string to replace");
    expect(a).toBe(b);
  });

  it("clusters failures that differ only by quoted content", () => {
    const a = failureSignature("bash", "command 'npm run foo' failed");
    const b = failureSignature("bash", "command 'npm run bar' failed");
    expect(a).toBe(b);
  });

  it("separates different tools", () => {
    expect(failureSignature("edit_file", "boom")).not.toBe(failureSignature("bash", "boom"));
  });

  it("separates genuinely different failures", () => {
    expect(failureSignature("edit_file", "File does not exist")).not.toBe(
      failureSignature("edit_file", "File has not been read yet"),
    );
  });

  it("is case- and whitespace-insensitive", () => {
    expect(failureSignature("t", "A  B")).toBe(failureSignature("t", "a b"));
  });

  it("normalises hex blobs", () => {
    expect(failureSignature("git", "bad object deadbeef1234")).toBe(
      failureSignature("git", "bad object cafebabe5678"),
    );
  });
});

describe("FailureRecurrenceTracker", () => {
  it("does not prompt on a first failure", () => {
    const t = new FailureRecurrenceTracker();
    const obs = t.observe("edit_file", "File does not exist: /a.ts");
    expect(obs.count).toBe(1);
    expect(obs.shouldPrompt).toBe(false);
  });

  it("prompts on the second occurrence of the same signature", () => {
    const t = new FailureRecurrenceTracker();
    t.observe("edit_file", "File does not exist: /a.ts");
    const obs = t.observe("edit_file", "File does not exist: /b.ts");
    expect(obs.count).toBe(2);
    expect(obs.shouldPrompt).toBe(true);
  });

  it("prompts at most once per signature — no nagging", () => {
    const t = new FailureRecurrenceTracker();
    t.observe("edit_file", "boom /a.ts");
    expect(t.observe("edit_file", "boom /b.ts").shouldPrompt).toBe(true);
    expect(t.observe("edit_file", "boom /c.ts").shouldPrompt).toBe(false);
    expect(t.observe("edit_file", "boom /d.ts").shouldPrompt).toBe(false);
  });

  it("tracks distinct signatures independently", () => {
    const t = new FailureRecurrenceTracker();
    t.observe("edit_file", "File does not exist");
    t.observe("edit_file", "File has not been read yet");
    expect(t.observe("edit_file", "File does not exist").shouldPrompt).toBe(true);
    expect(t.list()).toHaveLength(2);
  });

  it("honours a custom threshold", () => {
    const t = new FailureRecurrenceTracker({ threshold: 3 });
    t.observe("bash", "boom");
    expect(t.observe("bash", "boom").shouldPrompt).toBe(false);
    expect(t.observe("bash", "boom").shouldPrompt).toBe(true);
  });

  it("floors the threshold at 2 — a first failure is never a pattern", () => {
    const t = new FailureRecurrenceTracker({ threshold: 1 });
    expect(t.observe("bash", "boom").shouldPrompt).toBe(false);
    expect(t.observe("bash", "boom").shouldPrompt).toBe(true);
  });

  it("summarises the session for the LH1 control observation", () => {
    const t = new FailureRecurrenceTracker();
    t.observe("edit_file", "boom /a.ts");
    t.observe("edit_file", "boom /b.ts"); // repeat → prompted
    t.observe("bash", "one-off failure");

    const s = t.summary();
    expect(s.distinctFailures).toBe(2);
    expect(s.repeatedFailures).toBe(1);
    expect(s.totalFailures).toBe(3);
    expect(s.prompted).toBe(1);
  });

  it("lists most frequent first", () => {
    const t = new FailureRecurrenceTracker();
    t.observe("bash", "rare");
    t.observe("edit_file", "common");
    t.observe("edit_file", "common");
    expect(t.list()[0]?.count).toBe(2);
  });
});

describe("recurrenceNudge", () => {
  it("names the tool, the count, and the tool to reach for", () => {
    const n = recurrenceNudge("edit_file", 2);
    expect(n).toContain("edit_file");
    expect(n).toContain("2 times");
    expect(n).toContain("define_guard");
    expect(n).toContain("<system-reminder>");
  });

  it("offers rather than instructs, so a wrong guard is not encouraged", () => {
    const n = recurrenceNudge("bash", 3);
    expect(n).toContain("consider");
    expect(n).toContain("Skip this");
  });
});
