import { describe, it, expect, beforeEach } from "vitest";
import {
  getFileCandidates,
  extractMentionPrefix,
  applyMention,
  _setCachedFiles,
  _resetCache,
} from "./file-mention.js";

beforeEach(() => {
  _resetCache();
});

describe("extractMentionPrefix", () => {
  it("extracts prefix after @ at start of input", () => {
    expect(extractMentionPrefix("@src/m", 6)).toBe("src/m");
  });

  it("extracts prefix after @ in middle of input", () => {
    expect(extractMentionPrefix("fix @src/m", 10)).toBe("src/m");
  });

  it("returns undefined when no @", () => {
    expect(extractMentionPrefix("hello world", 11)).toBeUndefined();
  });

  it("returns undefined when @ is not preceded by whitespace", () => {
    expect(extractMentionPrefix("email@example", 13)).toBeUndefined();
  });

  it("returns empty string for bare @", () => {
    expect(extractMentionPrefix("@", 1)).toBe("");
  });

  it("returns undefined when space after prefix (mention complete)", () => {
    expect(extractMentionPrefix("@file.ts rest", 13)).toBeUndefined();
  });
});

describe("applyMention", () => {
  it("replaces @prefix with full path", () => {
    const result = applyMention("@src/m", 6, "src/main.ts");
    expect(result.value).toBe("@src/main.ts ");
    expect(result.cursor).toBe(13);
  });

  it("preserves text before and after", () => {
    const result = applyMention("fix @src more", 8, "src/index.ts");
    expect(result.value).toBe("fix @src/index.ts  more");
  });

  it("handles @ at start", () => {
    const result = applyMention("@", 1, "README.md");
    expect(result.value).toBe("@README.md ");
    expect(result.cursor).toBe(11);
  });
});

describe("getFileCandidates", () => {
  it("returns matching files for prefix", () => {
    _setCachedFiles(["src/main.ts", "src/index.ts", "package.json"]);
    const results = getFileCandidates("src/m");
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("src/main.ts");
  });

  it("returns all files for empty prefix (up to limit)", () => {
    _setCachedFiles(["a.ts", "b.ts", "c.ts"]);
    const results = getFileCandidates("");
    expect(results).toHaveLength(3);
  });

  it("returns empty for no matches", () => {
    _setCachedFiles(["src/main.ts"]);
    const results = getFileCandidates("nonexistent");
    expect(results).toHaveLength(0);
  });

  it("respects maxResults", () => {
    _setCachedFiles(Array.from({ length: 50 }, (_, i) => `file${i}.ts`));
    const results = getFileCandidates("file", 5);
    expect(results).toHaveLength(5);
  });

  it("case-insensitive matching", () => {
    _setCachedFiles(["src/MyComponent.tsx"]);
    const results = getFileCandidates("mycomp");
    expect(results).toHaveLength(1);
  });
});
