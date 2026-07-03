import { describe, it, expect } from "vitest";
import { bashTool, formatDuration, truncateOutput } from "./bash.js";
import type { ToolExecutionContext } from "../types.js";
import * as os from "node:os";
import * as path from "node:path";

function ctx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return { cwd: os.tmpdir(), ...overrides };
}

describe("bashTool", () => {
  it("basic echo returns stdout", async () => {
    const result = await bashTool.execute({ command: "echo hello" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("hello");
    }
  });

  it("stderr follows stdout in the result (Claude Code shape)", async () => {
    const result = await bashTool.execute(
      { command: "echo out && echo err >&2" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      // stdout first, then stderr, joined by a newline — not interleaved.
      expect(result.output).toBe("out\nerr");
    }
  });

  it("non-zero exit returns error with 'Exit code N' first, then output", async () => {
    const result = await bashTool.execute(
      { command: "echo failing && echo oops >&2 && exit 42" },
      ctx(),
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      // Claude Code order: Exit code line, stderr, stdout.
      expect(result.message).toBe("Exit code 42\noops\nfailing");
    }
  });

  it("non-zero exit with no output uses the Claude Code fallback line", async () => {
    const result = await bashTool.execute({ command: "exit 3" }, ctx());
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBe("Exit code 3");
    }
  });

  it("timeout kills process and returns a humanized timeout error", async () => {
    const result = await bashTool.execute(
      { command: "sleep 10", timeout: 200 },
      ctx(),
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("Command timed out after 0.2s");
    }
  }, 3000);

  it("workdir parameter runs the command in another directory", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const sub = fs.mkdtempSync(path.join(os.tmpdir(), "bash-workdir-"));
    const result = await bashTool.execute({ command: "pwd", workdir: sub }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      // macOS tmpdir is symlinked (/var → /private/var); compare basenames.
      expect(result.output.trim().endsWith(path.basename(sub))).toBe(true);
    }
    fs.rmSync(sub, { recursive: true, force: true });
  });

  it("background mode returns the Claude Code-style message with an output file", async () => {
    const result = await bashTool.execute(
      { command: "sleep 60", run_in_background: true },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toMatch(/^Command running in background with ID: \d+\./);
      expect(result.output).toContain("Output is being written to:");
    }
  });

  it("background output file captures command output", async () => {
    const result = await bashTool.execute(
      { command: "echo bg-output", run_in_background: true },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const match = result.output.match(/Output is being written to: (\S+)\./);
    expect(match).not.toBeNull();
    const outFile = match![1]!;
    // Give the detached child a moment to run.
    await new Promise((r) => setTimeout(r, 500));
    const fs = await import("node:fs");
    expect(fs.readFileSync(outFile, "utf8")).toContain("bg-output");
    try { fs.unlinkSync(outFile); } catch { /* ignore */ }
  }, 5000);

  it("accepts legacy `background` alias for run_in_background", async () => {
    const result = await bashTool.execute(
      { command: "sleep 60", background: true },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toMatch(/^Command running in background with ID: \d+\./);
    }
  });

  it("long stdout is head-truncated with a lines-truncated marker", async () => {
    // 2000 lines x ~30 chars ≈ 60k chars > 30k cap.
    const result = await bashTool.execute(
      { command: `seq 1 2000 | sed 's/^/line-with-some-padding-here-/'` },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output.length).toBeLessThan(31_000);
      expect(result.output).toContain("line-with-some-padding-here-1");
      expect(result.output).toMatch(/\.\.\. \[\d+ lines truncated\] \.\.\./);
      // Head truncation: the tail of the stream must be gone.
      expect(result.output).not.toContain("line-with-some-padding-here-2000");
    }
  }, 10_000);

  it("abort signal kills the process and reports an aborted error", async () => {
    const ac = new AbortController();
    const promise = bashTool.execute(
      { command: "sleep 30" },
      ctx({ abort: ac.signal }),
    );
    // Give it a moment to start, then abort.
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    const result = await promise;
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain(
        "<error>Command was aborted before completion</error>",
      );
    }
  }, 5000);

  it("invalid input returns error", async () => {
    const result = await bashTool.execute({ command: 123 }, ctx());
    expect(result.status).toBe("error");
  });
});

describe("formatDuration", () => {
  it("formats sub-minute durations as seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(200)).toBe("0.2s");
    expect(formatDuration(45_000)).toBe("45s");
  });

  it("formats minutes and hours Claude Code-style", () => {
    expect(formatDuration(120_000)).toBe("2m 0s");
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(3_723_000)).toBe("1h 2m 3s");
  });
});

describe("truncateOutput", () => {
  it("passes short text through unchanged", () => {
    expect(truncateOutput("hello", 30_000)).toBe("hello");
  });

  it("head-truncates and counts remaining lines", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
    const out = truncateOutput(text, 50);
    expect(out.startsWith(text.slice(0, 50))).toBe(true);
    expect(out).toMatch(/\.\.\. \[\d+ lines truncated\] \.\.\.$/);
  });
});
