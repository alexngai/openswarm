/**
 * FX-RW-001..004 — what two agents sharing one working directory do to each
 * other's work (docs/67 `WP-11`).
 *
 * Shared mode is `branchPolicy: { kind: "none" }`: several worker processes in
 * one directory with no worktree between them. The read-before-edit contract
 * looks like it covers this, and does not. `read-state` records *that* a path
 * was read, as a path and a recency counter with no content hash, size, or
 * mtime — so `hasFileBeenRead` can answer "yes" for a file that has since been
 * replaced by somebody else, and no caller can tell the difference.
 *
 * These fixtures are written from the reader's point of view rather than the
 * lease's, because the damage is not that two writers ran at once; it is that
 * the loser is never told.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeFileTool } from "./write_file.js";
import { editFileTool } from "./edit_file.js";
import {
  checkFileCurrent,
  clearReadState,
  recordFileRead,
  hasFileBeenRead,
} from "./read-state.js";
import { STALE_FILE_ERROR } from "./edit_file.js";
import type { ToolExecutionContext } from "../types.js";

let dir: string;

beforeEach(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "sharedmode-")));
  clearReadState();
});

afterEach(async () => {
  clearReadState();
  await fsp.rm(dir, { recursive: true, force: true });
});

function ctx(): ToolExecutionContext {
  return { cwd: dir } as ToolExecutionContext;
}

/** Agent A reads the file, as a real read tool would record it. */
async function agentReads(file: string): Promise<string> {
  const content = await fsp.readFile(file, "utf8");
  recordFileRead(file, content);
  return content;
}

describe("two agents, one working directory", () => {
  it("FX-RW-001 a read remembers the content, so a replacement is detectable", async () => {
    const file = path.join(dir, "shared.txt");
    await fsp.writeFile(file, "original\n");
    await agentReads(file);

    expect(await checkFileCurrent(file)).toEqual({ kind: "current" });

    await fsp.writeFile(file, "somebody else's work\n");

    // Still read — the read-before-edit contract is unchanged — but no longer
    // current, which is the distinction the path-only record could not make.
    expect(hasFileBeenRead(file)).toBe(true);
    const verdict = await checkFileCurrent(file);
    expect(verdict.kind).toBe("stale");
  });

  it("FX-RW-002 write_file refuses to clobber a concurrent writer", async () => {
    const file = path.join(dir, "shared.txt");
    await fsp.writeFile(file, "original\n");

    // Agent A reads, and would now be entitled to write.
    await agentReads(file);

    // Agent B, in another process, replaces the file.
    await fsp.writeFile(file, "B's work\n");

    // Agent A writes what it believes is an update to what it read.
    const result = await writeFileTool.execute(
      { file_path: file, content: "A's work\n" },
      ctx(),
    );

    // Refused, in the words a trained model already knows how to act on, and
    // B's work is still on disk.
    expect(result.status).toBe("error");
    expect(result.message).toBe(STALE_FILE_ERROR);
    expect(await fsp.readFile(file, "utf8")).toBe("B's work\n");
  });

  it("FX-RW-003 edit_file refuses a stale edit whose anchor is gone", async () => {
    // Anchor matching already caught this one, with a different error. The
    // staleness check now answers first, so both halves of the rewrite case —
    // anchor gone, anchor kept — give the model the same recoverable message.
    const file = path.join(dir, "shared.txt");
    await fsp.writeFile(file, "keep this line\nanchor\n");
    await agentReads(file);

    await fsp.writeFile(file, "B replaced everything\n");

    const result = await editFileTool.execute(
      { file_path: file, old_string: "anchor", new_string: "edited" },
      ctx(),
    );
    expect(result.status).toBe("error");
    expect(result.message).toBe(STALE_FILE_ERROR);
  });

  it("FX-RW-004 ...and the anchor surviving a rewrite is no longer enough", async () => {
    // The case anchor matching cannot see: B's rewrite kept the anchor, so the
    // edit would apply cleanly to a file the agent never read.
    const file = path.join(dir, "shared.txt");
    await fsp.writeFile(file, "anchor\n");
    await agentReads(file);

    await fsp.writeFile(file, "B rewrote the file\nanchor\nB's trailing work\n");

    const result = await editFileTool.execute(
      { file_path: file, old_string: "anchor", new_string: "edited" },
      ctx(),
    );
    expect(result.status).toBe("error");
    expect(result.message).toBe(STALE_FILE_ERROR);
    expect(await fsp.readFile(file, "utf8")).toContain("B's trailing work");
  });

  it("FX-RW-005 a rewrite with identical bytes is not a conflict", async () => {
    // mtime moves on every atomic save, so judging staleness by timestamp alone
    // would refuse writes after a formatter that changed nothing.
    const file = path.join(dir, "shared.txt");
    await fsp.writeFile(file, "same bytes\n");
    await agentReads(file);

    await new Promise((r) => setTimeout(r, 10));
    await fsp.writeFile(file, "same bytes\n");

    expect(await checkFileCurrent(file)).toEqual({ kind: "current" });
    const result = await writeFileTool.execute(
      { file_path: file, content: "A's work\n" },
      ctx(),
    );
    expect(result.status).toBe("ok");
  });

  it("FX-RW-006 the agent's own successive writes are never stale", async () => {
    // Writing records what was written, so a second write in the same session
    // must not trip the check it just armed.
    const file = path.join(dir, "shared.txt");
    await fsp.writeFile(file, "original\n");
    await agentReads(file);

    const first = await writeFileTool.execute(
      { file_path: file, content: "first\n" },
      ctx(),
    );
    expect(first.status).toBe("ok");
    const second = await writeFileTool.execute(
      { file_path: file, content: "second\n" },
      ctx(),
    );
    expect(second.status).toBe("ok");
    expect(await fsp.readFile(file, "utf8")).toBe("second\n");
  });

  it("FX-RW-007 a read whose bytes were never captured is not judged stale", async () => {
    // recordFileRead without content is a legitimate state (compaction
    // re-injection, notebook writes). It has to keep permitting the write rather
    // than guess that the file changed.
    const file = path.join(dir, "shared.txt");
    await fsp.writeFile(file, "original\n");
    recordFileRead(file);

    expect(await checkFileCurrent(file)).toEqual({ kind: "unknown" });
    await fsp.writeFile(file, "changed by B\n");

    const result = await writeFileTool.execute(
      { file_path: file, content: "A's work\n" },
      ctx(),
    );
    expect(result.status).toBe("ok");
  });

  it("FX-RW-008 a file deleted after it was read is stale, not missing", async () => {
    const file = path.join(dir, "shared.txt");
    await fsp.writeFile(file, "original\n");
    await agentReads(file);
    await fsp.rm(file);

    const verdict = await checkFileCurrent(file);
    expect(verdict.kind).toBe("stale");

    // write_file recreates it: there is nothing to lose, and refusing would
    // block the agent from restoring a file somebody else removed.
    const result = await writeFileTool.execute(
      { file_path: file, content: "recreated\n" },
      ctx(),
    );
    expect(result.status).toBe("ok");
  });
});
