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

  it("never-worse guard reverts cosmetic passes when output would not shrink", () => {
    const clean = "already clean short output";
    const result = cleanOutput(clean);
    expect(result.text).toBe(clean);
  });

  it("never-worse guard does NOT un-redact a secret to save bytes", () => {
    // A short secret expands to its marker (net-longer), so the guard trips.
    // It must still fall back to REDACTED text, not the raw input: on a short
    // output there is nothing else to reclaim the bytes, so a naive revert
    // hands the credential back in the clear. Regression — this leaked through
    // the shell tool's STDERR on any host where bash echoes the command back
    // (CI runners without job control), while stdout looked correctly masked.
    const tiny = "AKIAIOSFODNN7EXAMPLE";
    const r2 = cleanOutput(tiny);
    expect(r2.degraded).toBe(true);
    expect(r2.text).not.toContain(tiny);
    expect(r2.text).toContain("[REDACTED:");
  });

  it("redacts a stderr stream with nothing else to strip", () => {
    // Real shape from a shell with no controlling TTY: bash warns about job
    // control and echoes the command back, and there are no ANSI escapes to
    // remove. Redaction is then the only transform, so it grows the text and
    // trips the guard. This leaked an AWS key into model-facing output.
    const command = "printf 'red key=AKIAIOSFODNN7EXAMPLE\\n'";
    const stderr = [
      "bash: cannot set terminal process group (7): Inappropriate ioctl for device",
      "bash: no job control in this shell",
      command,
    ].join("\n");
    const result = cleanOutput(stderr, { command });
    expect(result.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.text).toContain("[REDACTED:");
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
