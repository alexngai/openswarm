import { describe, it, expect, afterEach } from "vitest";
import {
  cleanOutput,
  createPipeline,
  progressPlugin,
  ansiPlugin,
  redactPlugin,
  longLinePlugin,
  defaultPlugins,
} from "./output-cleanse.js";

const ENV_KEYS = [
  "OPENSWARM_BASH_RAW",
  "OPENSWARM_OUTPUT_NO_REDACT",
  "OPENSWARM_OUTPUT_MAX_LINE_CHARS",
  "OPENSWARM_OUTPUT_LINE_HEAD_KEEP",
  "OPENSWARM_OUTPUT_NEVER_WORSE_MARGIN",
];

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("progressPlugin", () => {
  it("keeps only the last frame of a \\r-redrawn line", () => {
    const p = progressPlugin();
    expect(p.apply("10%\r50%\r100%", {})).toBe("100%");
  });

  it("handles trailing \\r and is a no-op without \\r", () => {
    const p = progressPlugin();
    expect(p.apply("done\r", {})).toBe("done");
    expect(p.apply("a\nb\nc", {})).toBe("a\nb\nc");
  });
});

describe("ansiPlugin", () => {
  it("strips CSI color codes", () => {
    const p = ansiPlugin();
    expect(p.apply("\x1b[31mred\x1b[0m", {})).toBe("red");
  });

  it("strips OSC sequences and collapses backspace overstrike", () => {
    const p = ansiPlugin();
    expect(p.apply("\x1b]0;title\x07hello", {})).toBe("hello");
    expect(p.apply("ab\b\bcd", {})).toBe("cd");
  });

  it("removes stray control bytes but preserves newlines/tabs", () => {
    const p = ansiPlugin();
    expect(p.apply("a\x00b\nc\td", {})).toBe("ab\nc\td");
  });
});

describe("redactPlugin", () => {
  it("masks an AWS access key", () => {
    const p = redactPlugin();
    const out = p.apply("key=AKIAIOSFODNN7EXAMPLE done", {});
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain("[REDACTED:aws-access-key]");
  });

  it("is disabled when OPENSWARM_OUTPUT_NO_REDACT=1", () => {
    process.env.OPENSWARM_OUTPUT_NO_REDACT = "1";
    const p = redactPlugin();
    const input = "key=AKIAIOSFODNN7EXAMPLE";
    expect(p.apply(input, {})).toBe(input);
  });
});

describe("longLinePlugin", () => {
  it("elides lines beyond the threshold, preserving the head", () => {
    process.env.OPENSWARM_OUTPUT_MAX_LINE_CHARS = "20";
    process.env.OPENSWARM_OUTPUT_LINE_HEAD_KEEP = "5";
    const p = longLinePlugin();
    const out = p.apply("x".repeat(50), {});
    expect(out.startsWith("xxxxx…<elided 45 chars>")).toBe(true);
  });

  it("leaves short lines untouched", () => {
    const p = longLinePlugin();
    expect(p.apply("short line", {})).toBe("short line");
  });
});

describe("createPipeline / cleanOutput", () => {
  it("chains progress+ansi+longline to shrink noisy output", () => {
    process.env.OPENSWARM_OUTPUT_MAX_LINE_CHARS = "40";
    process.env.OPENSWARM_OUTPUT_LINE_HEAD_KEEP = "10";
    const noisy = "\x1b[32m" + "building... 10%\r20%\r100%" + "\x1b[0m\n" + "y".repeat(80);
    const result = cleanOutput(noisy);
    expect(result.degraded).toBe(false);
    expect(result.bytesOut).toBeLessThan(result.bytesIn);
    expect(result.text).toContain("100%");
    expect(result.text).not.toContain("\x1b[");
    expect(result.text).toContain("…<elided");
  });

  it("never-worse guard reverts when output would not shrink", () => {
    const clean = "already clean short output";
    const result = cleanOutput(clean);
    expect(result.text).toBe(clean);
    // A short secret expands to its marker (net-longer) → guard reverts.
    const tiny = "AKIAIOSFODNN7EXAMPLE";
    const r2 = cleanOutput(tiny);
    expect(r2.degraded).toBe(true);
    expect(r2.text).toBe(tiny);
    expect(r2.bytesOut).toBe(r2.bytesIn);
  });

  it("respects the never-worse margin", () => {
    // A 1-char reduction is not enough when margin demands more shrinkage.
    process.env.OPENSWARM_OUTPUT_NEVER_WORSE_MARGIN = "1000";
    const text = "\x1b[0m" + "hello world";
    const result = cleanOutput(text);
    expect(result.degraded).toBe(true);
    expect(result.text).toBe(text);
  });

  it("skips via # nofilter / # raw command markers", () => {
    const text = "\x1b[31mred\x1b[0m";
    expect(cleanOutput(text, { command: "ls # nofilter" }).text).toBe(text);
    expect(cleanOutput(text, { command: "ls # raw" }).text).toBe(text);
  });

  it("skips entirely when OPENSWARM_BASH_RAW=1", () => {
    process.env.OPENSWARM_BASH_RAW = "1";
    const text = "\x1b[31mred\x1b[0m";
    const result = cleanOutput(text);
    expect(result.text).toBe(text);
    expect(result.degraded).toBe(false);
  });

  it("empty input is returned unchanged", () => {
    const result = cleanOutput("");
    expect(result.text).toBe("");
    expect(result.bytesIn).toBe(0);
  });

  it("defaultPlugins returns a fresh array each call", () => {
    expect(defaultPlugins()).not.toBe(defaultPlugins());
    expect(createPipeline().plugins.map((p) => p.name)).toEqual([
      "progress",
      "ansi",
      "redact",
      "longline",
    ]);
  });
});
