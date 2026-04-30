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

  it("16 KiB truncation preserves UTF-8 boundaries", async () => {
    // '€' is 3 bytes (e2 82 ac). Generate enough to push past 16 KiB.
    // 16384 / 3 = 5461.33, so 5462 '€' = 16386 bytes — just over the cap.
    const euro = "€"; // 3 bytes
    const count = Math.ceil((16 * 1024 + 2) / 3);
    const bigStr = euro.repeat(count);
    // Write to a temp file and cat it so bash produces the output.
    const tmpFile = path.join(os.tmpdir(), `trunctest-${Date.now()}.txt`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(tmpFile, bigStr, "utf8");

    const result = await bashTool.execute({ command: `cat "${tmpFile}"` }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      // Should be truncated and not contain a broken multi-byte sequence.
      expect(result.output).toContain("[truncated]");
      // The string before [truncated] should be valid UTF-8 (no replacement chars from bad decode).
      const before = result.output.split("[truncated]")[0]!;
      expect(before).not.toContain("\uFFFD");
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
