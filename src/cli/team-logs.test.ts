/**
 * Tests for src/cli/team-logs.ts — v0.5 stage 5E.5.
 *
 * Covers the non-follow read path and minimal follow-tail behaviour. The
 * fs.watch + polling loop is exercised via a short follow + manual stop.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runTeamLogs } from "./team-logs.js";

describe("runTeamLogs", () => {
  let tmpRoot: string;
  let prevXdg: string | undefined;
  let prevTmp: string | undefined;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "team-logs-test-"));
    prevXdg = process.env.XDG_RUNTIME_DIR;
    prevTmp = process.env.TMPDIR;
    process.env.XDG_RUNTIME_DIR = tmpRoot;
    process.env.TMPDIR = tmpRoot;
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = prevXdg;
    if (prevTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prevTmp;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  function stdoutText(): string {
    return (stdoutSpy.mock.calls as readonly unknown[][])
      .map((c: readonly unknown[]) => String(c[0]))
      .join("");
  }
  function stderrText(): string {
    return (stderrSpy.mock.calls as readonly unknown[][])
      .map((c: readonly unknown[]) => String(c[0]))
      .join("");
  }

  async function writeEvents(name: string, content: string): Promise<string> {
    const dir = path.join(tmpRoot, "openswarm", "teams", name);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "events.jsonl");
    await fs.writeFile(filePath, content);
    return filePath;
  }

  it("prints existing events.jsonl content and exits 0", async () => {
    await writeEvents(
      "alpha",
      '{"ts":1,"type":"x"}\n{"ts":2,"type":"y"}\n',
    );
    const code = await runTeamLogs("alpha", { follow: false });
    expect(code).toBe(0);
    expect(stdoutText()).toMatch(/"type":"x"/);
    expect(stdoutText()).toMatch(/"type":"y"/);
  });

  it("returns 2 with an error when events.jsonl is missing in non-follow mode", async () => {
    const code = await runTeamLogs("nonexistent", { follow: false });
    expect(code).toBe(2);
    expect(stderrText()).toMatch(/not found/);
  });

  it("--follow reads existing content then tails appended writes", async () => {
    const filePath = await writeEvents("beta", '{"ts":1,"type":"first"}\n');

    // Run team logs --follow in the background; SIGTERM to stop.
    const followPromise = runTeamLogs("beta", { follow: true });

    // Give the watcher a moment to attach + drain.
    await new Promise((r) => setTimeout(r, 350));

    // Append a new event line.
    await fs.appendFile(filePath, '{"ts":2,"type":"second"}\n');

    // Wait for the polling loop / watcher to pick it up.
    await new Promise((r) => setTimeout(r, 600));

    // Stop the follow loop by emitting SIGTERM at the listener registered
    // inside runTeamLogs.
    process.emit("SIGTERM" as NodeJS.Signals);

    const code = await followPromise;
    expect(code).toBe(0);

    const all = stdoutText();
    expect(all).toMatch(/"type":"first"/);
    expect(all).toMatch(/"type":"second"/);
  });
});
