import { describe, it, expect } from "vitest";
import { computeDiff, compactDiff, toUnifiedDiff } from "./compute.js";

describe("computeDiff", () => {
  it("identical texts produce only context lines", () => {
    const result = computeDiff("a\nb\nc", "a\nb\nc");
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.lines.every((l) => l.kind === "context")).toBe(true);
    expect(result.lines).toHaveLength(3);
  });

  it("additions only", () => {
    const result = computeDiff("a\nb", "a\nx\nb");
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    const addLines = result.lines.filter((l) => l.kind === "add");
    expect(addLines).toHaveLength(1);
    expect(addLines[0]!.text).toBe("x");
  });

  it("deletions only", () => {
    const result = computeDiff("a\nx\nb", "a\nb");
    expect(result.added).toBe(0);
    expect(result.removed).toBe(1);
    const delLines = result.lines.filter((l) => l.kind === "delete");
    expect(delLines).toHaveLength(1);
    expect(delLines[0]!.text).toBe("x");
  });

  it("mixed additions and deletions", () => {
    const result = computeDiff("a\nb\nc", "a\nx\nc");
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
  });

  it("empty old text (all additions)", () => {
    const result = computeDiff("", "a\nb");
    expect(result.added).toBe(2);
    expect(result.removed).toBe(0);
  });

  it("empty new text (all deletions)", () => {
    const result = computeDiff("a\nb", "");
    expect(result.added).toBe(0);
    expect(result.removed).toBe(2);
  });

  it("both empty", () => {
    const result = computeDiff("", "");
    expect(result.lines).toHaveLength(0);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });

  it("single line change", () => {
    const result = computeDiff("old line", "new line");
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    const del = result.lines.find((l) => l.kind === "delete");
    const add = result.lines.find((l) => l.kind === "add");
    expect(del!.text).toBe("old line");
    expect(add!.text).toBe("new line");
  });

  it("preserves line ordering", () => {
    const result = computeDiff("a\nb\nc\nd", "a\nx\nc\nd");
    const texts = result.lines.map((l) => `${l.kind[0]}:${l.text}`);
    expect(texts).toEqual(["c:a", "d:b", "a:x", "c:c", "c:d"]);
  });

  it("handles Unicode content", () => {
    const result = computeDiff("hello 🌍", "hello 🌎");
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.lines.find((l) => l.kind === "add")!.text).toBe("hello 🌎");
  });

  describe("streaming-aware (isIncomplete)", () => {
    it("suppresses trailing deletes when isIncomplete is true", () => {
      const result = computeDiff("a\nb\nc\nd", "a\nb", { isIncomplete: true });
      const delLines = result.lines.filter((l) => l.kind === "delete");
      expect(delLines).toHaveLength(0);
    });

    it("shows trailing deletes when isIncomplete is false", () => {
      const result = computeDiff("a\nb\nc\nd", "a\nb", { isIncomplete: false });
      const delLines = result.lines.filter((l) => l.kind === "delete");
      expect(delLines).toHaveLength(2);
    });

    it("preserves non-trailing deletes when isIncomplete", () => {
      const result = computeDiff("x\na\nb", "a\nb", { isIncomplete: true });
      const delLines = result.lines.filter((l) => l.kind === "delete");
      expect(delLines).toHaveLength(1);
      expect(delLines[0]!.text).toBe("x");
    });
  });
});

describe("compactDiff", () => {
  it("returns empty for no-change diff", () => {
    const diff = computeDiff("a\nb\nc", "a\nb\nc");
    const { lines, hiddenChanges } = compactDiff(diff);
    expect(lines).toHaveLength(0);
    expect(hiddenChanges).toBe(0);
  });

  it("includes context around changes", () => {
    const oldText = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const newLines = oldText.split("\n");
    newLines[10] = "CHANGED LINE";
    const diff = computeDiff(oldText, newLines.join("\n"));
    const { lines } = compactDiff(diff, { contextLines: 2 });
    // Should include the change (delete+add = 2 lines) plus 2 context on each side = 6.
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines.some((l) => l.kind !== "context")).toBe(true);
  });

  it("hides changes beyond maxChanges", () => {
    const old = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl";
    const nw = "A\nB\nC\nD\nE\nF\nG\nH\nI\nJ\nK\nL";
    const diff = computeDiff(old, nw);
    const { hiddenChanges } = compactDiff(diff, { maxChanges: 4 });
    expect(hiddenChanges).toBeGreaterThan(0);
  });
});

describe("toUnifiedDiff", () => {
  it("returns empty string when there is no content", () => {
    expect(toUnifiedDiff("", "")).toBe("");
  });

  it("emits file headers and a hunk header", () => {
    const out = toUnifiedDiff("a\nb\nc", "a\nx\nc", "src/foo.ts");
    expect(out).toContain("--- a/src/foo.ts");
    expect(out).toContain("+++ b/src/foo.ts");
    expect(out).toMatch(/@@ -1,\d+ \+1,\d+ @@/);
    expect(out).toContain("-b");
    expect(out).toContain("+x");
    expect(out).toContain(" a");
    expect(out).toContain(" c");
  });

  it("uses 0 old-start for a pure addition (new file)", () => {
    const out = toUnifiedDiff("", "line1\nline2", "new.txt");
    expect(out).toMatch(/@@ -0,0 \+1,2 @@/);
    expect(out).toContain("+line1");
    expect(out).toContain("+line2");
  });

  it("falls back to a placeholder path when none given", () => {
    const out = toUnifiedDiff("a", "b");
    expect(out).toContain("--- a/file");
    expect(out).toContain("+++ b/file");
  });

  it("hunk counts match the number of prefixed lines", () => {
    const out = toUnifiedDiff("a\nb", "a\nb\nc", "f.txt");
    const m = out.match(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
    expect(m).not.toBeNull();
    const [, , oldCount, , newCount] = m!.map(Number) as unknown as number[];
    const bodyLines = out.trimEnd().split("\n").slice(3);
    const olds = bodyLines.filter((l) => l.startsWith("-") || l.startsWith(" ")).length;
    const news = bodyLines.filter((l) => l.startsWith("+") || l.startsWith(" ")).length;
    expect(olds).toBe(oldCount);
    expect(news).toBe(newCount);
  });
});
