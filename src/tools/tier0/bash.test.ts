import { describe, it, expect, beforeEach } from "vitest";
import { bashTool } from "./bash.js";
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

  it("stderr is included after separator", async () => {
    const result = await bashTool.execute(
      { command: "echo out && echo err >&2" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("out");
      expect(result.output).toContain("STDERR:");
      expect(result.output).toContain("err");
    }
  });

  it("non-zero exit code appends [exit N] marker", async () => {
    const result = await bashTool.execute({ command: "exit 42" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("[exit 42]");
    }
  });

  it("timeout kills process and adds [interrupted: timeout] marker", async () => {
    const result = await bashTool.execute(
      { command: "sleep 10", timeout: 200 },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("[interrupted: timeout]");
    }
  }, 3000);

  it("background mode returns pid-shaped output immediately", async () => {
    const result = await bashTool.execute(
      { command: "sleep 60", background: true },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toMatch(/\[backgroundTaskId: \d+\]/);
    }
  });

  it("head+tail truncation preserves UTF-8 boundaries", async () => {
    // '€' is 3 bytes (e2 82 ac). Use many short lines (each well under the
    // output-cleanse long-line threshold, so elision does not pre-empt this)
    // whose total exceeds the head+tail byte budget (40 KiB default).
    const euro = "€"; // 3 bytes
    const line = euro.repeat(100) + "\n"; // 300 bytes + newline, under maxLineChars
    const count = Math.ceil((50 * 1024) / line.length); // ~50 KiB total
    const bigStr = line.repeat(count);
    const tmpFile = path.join(os.tmpdir(), `trunctest-${Date.now()}.txt`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(tmpFile, bigStr, "utf8");

    const result = await bashTool.execute({ command: `cat "${tmpFile}"` }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("[... truncated");
      expect(result.output).toContain("bytes ...]");
      expect(result.output).not.toContain("�");
    }

    const { unlinkSync } = await import("node:fs");
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }, 5000);

  it("abort signal kills the process", async () => {
    const ac = new AbortController();
    const promise = bashTool.execute(
      { command: "sleep 30" },
      ctx({ abort: ac.signal }),
    );
    // Give it a moment to start, then abort.
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    const result = await promise;
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toMatch(/\[interrupted: (aborted|timeout)\]/);
    }
  }, 5000);

  it("invalid input returns error", async () => {
    const result = await bashTool.execute({ command: 123 }, ctx());
    expect(result.status).toBe("error");
  });
});
