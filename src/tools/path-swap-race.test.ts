/**
 * Swap-race containment (docs/63 WP-03).
 *
 * Containment is decided twice — once in `canUseTool` before the tool runs,
 * once in the tool through `resolveInWorkspace` — and the roadmap recorded
 * that this narrows the window without being shown to close it. Every check
 * resolves a path by name, and a name can mean something else by the next
 * syscall. An attacker who can swap a directory for a symlink between the last
 * check and the write does not have to defeat either check; it only has to
 * land in between them.
 *
 * Node exposes no `openat`, so the window cannot be removed by resolving
 * relative to a held directory descriptor the way `openat2(RESOLVE_BENEATH)`
 * would. What it can do is refuse to leave the result standing: verify where
 * the bytes actually landed, and undo the write when the answer is outside.
 *
 * The guarantee therefore differs by platform, and these tests assert the two
 * separately rather than asserting the stronger one everywhere. Where renames
 * anchor, nothing reaches the outside at all. Where they do not, the escape is
 * always detected and refused but repair is best effort, so what is claimed is
 * narrower: no content chosen here persists outside the workspace, though an
 * empty file may. Asserting zero files off Linux is what this suite used to do,
 * and it failed on macOS on most runs — reproducibly, with finished
 * attacker-named files carrying their full content, which is how the repair
 * came to be understood as unreliable in the first place. Prevention off Linux
 * is `WP-25`.
 *
 * These tests fail only on what is observable outside the workspace after the
 * fact, so a run that never wins the race cannot fail spuriously — it just
 * proves less. The swap counter is asserted so a harness that stopped racing
 * cannot pass by doing nothing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { resetWorkspaceAuthorities, anchoredRenamesAvailable } from "./workspace-path.js";
import { writeFileTool } from "./tier0/index.js";

const ATTEMPTS = 400;

let workspace: string;
let outside: string;

/**
 * Swaps a directory for a symlink pointing outside, over and over, on another
 * thread. Synchronous calls keep the swap itself as close to atomic as the
 * filesystem allows, so the writer sees one state or the other.
 */
const SWAPPER = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const { victim, outside, deadline } = workerData;

// Never follow the link when clearing: rm -r through a symlink to the outside
// directory would delete the very evidence this test collects.
function clear() {
  try {
    if (fs.lstatSync(victim).isSymbolicLink()) fs.unlinkSync(victim);
    else fs.rmSync(victim, { recursive: true, force: true });
  } catch {}
}

// Recreating the directory rather than stashing and restoring it keeps the
// loop stateless, so a writer that recreates the path mid-cycle cannot wedge
// the swapper into a state it never recovers from.
let swaps = 0;
while (Date.now() < deadline) {
  clear();
  try { fs.symlinkSync(outside, victim); swaps += 1; } catch { continue; }
  clear();
  try { fs.mkdirSync(victim); } catch {}
}
clear();
try { fs.mkdirSync(victim); } catch {}
parentPort.postMessage(swaps);
`;

beforeEach(() => {
  resetWorkspaceAuthorities();
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "swaprace-"));
  workspace = path.join(base, "workspace");
  outside = path.join(base, "outside");
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
});

afterEach(() => {
  resetWorkspaceAuthorities();
  fs.rmSync(path.dirname(workspace), { recursive: true, force: true });
});

interface RaceResult {
  readonly swaps: number;
  readonly errors: number;
  /** Exceptions escaping the tool, which are contract violations of their own. */
  readonly thrown: readonly string[];
}

async function race(durationMs: number): Promise<RaceResult> {
  const victim = path.join(workspace, "victim");
  fs.mkdirSync(victim);

  const worker = new Worker(SWAPPER, {
    eval: true,
    workerData: { victim, outside, deadline: Date.now() + durationMs },
  });
  const swapped = new Promise<number>((resolve) => {
    worker.once("message", resolve);
  });

  let errors = 0;
  const thrown: string[] = [];
  try {
    const deadline = Date.now() + durationMs;
    for (let i = 0; i < ATTEMPTS && Date.now() < deadline; i += 1) {
      try {
        const result = await writeFileTool.execute(
          { file_path: path.join(victim, `f${i}.txt`), content: `pwned-${i}` },
          { cwd: workspace },
        );
        if (result.status === "error") errors += 1;
      } catch (err) {
        thrown.push((err as Error).message);
      }
    }
    return { swaps: await swapped, errors, thrown };
  } finally {
    // The swapper outlives a failed assertion otherwise, and keeps rearranging
    // the tree while the next test's cleanup walks it.
    await worker.terminate();
  }
}

/** Every file anywhere under `root`, following nothing. */
function walk(root: string): string[] {
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else found.push(full);
    }
  }
  return found;
}

describe("directory swapped for an outward symlink mid-write", () => {
  it.runIf(process.platform === "linux")("anchors renames on this platform", async () => {
    // The zero-escape results below are only deterministic where the rename
    // resolves through a descriptor. If this ever reports false on Linux the
    // guarantee has silently weakened to detect-and-undo, and the assertions
    // that follow become statements about luck.
    expect(await anchoredRenamesAvailable()).toBe(true);
  });

  it.runIf(process.platform === "linux")(
    "leaves nothing at all outside the workspace",
    async () => {
      const { swaps } = await race(1500);

      // The harness must actually have raced, or the assertion below is empty.
      expect(swaps).toBeGreaterThan(50);

      expect(walk(outside)).toEqual([]);
    },
    30_000,
  );

  it.runIf(process.platform !== "linux")(
    "leaves no chosen content outside the workspace",
    async () => {
      const { swaps } = await race(1500);
      expect(swaps).toBeGreaterThan(50);

      // Files may persist here, since removing them races the same swap that
      // put them there. What must not persist is anything this process wrote:
      // an escape the harness cannot distinguish from a successful write is
      // the whole risk, and a zero-byte file cannot carry chosen content.
      const stranded = walk(outside).map((p) => ({
        path: path.relative(outside, p),
        bytes: fs.statSync(p).size,
      }));
      expect(stranded.filter((f) => f.bytes > 0)).toEqual([]);
    },
    30_000,
  );

  it("reports a swapped-away parent as a refusal rather than an exception", async () => {
    const { swaps, thrown } = await race(1500);
    expect(swaps).toBeGreaterThan(50);

    expect(thrown.slice(0, 5)).toEqual([]);
  }, 30_000);
});
