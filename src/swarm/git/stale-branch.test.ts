/**
 * stale-branch.test.ts — policy unit tests + mocked git-plumbing check() tests.
 *
 * Mocks `child_process.execFile` for `check()` so we don't need real
 * multi-commit git fixtures. `applyPolicy` tests are pure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as util from "node:util";
import { applyPolicy, type Freshness } from "./stale-branch.js";

// ---------------------------------------------------------------------------
// applyPolicy — pure mapping tests.
// ---------------------------------------------------------------------------

describe("applyPolicy", () => {
  it("fresh + any policy → Noop", () => {
    for (const p of ["AutoRebase", "AutoMergeForward", "WarnOnly", "Block"] as const) {
      expect(applyPolicy({ kind: "fresh" }, p)).toEqual({ kind: "Noop" });
    }
  });

  it("stale + AutoRebase → Rebase", () => {
    const f: Freshness = { kind: "stale", commitsBehind: 3, missingFixes: [] };
    expect(applyPolicy(f, "AutoRebase")).toEqual({ kind: "Rebase" });
  });

  it("stale + AutoMergeForward → MergeForward", () => {
    const f: Freshness = { kind: "stale", commitsBehind: 3, missingFixes: [] };
    expect(applyPolicy(f, "AutoMergeForward")).toEqual({ kind: "MergeForward" });
  });

  it("stale + WarnOnly → Warn with commits-behind message", () => {
    const f: Freshness = {
      kind: "stale",
      commitsBehind: 3,
      missingFixes: ["fix: timeout", "fix: null ptr"],
    };
    const r = applyPolicy(f, "WarnOnly");
    expect(r.kind).toBe("Warn");
    if (r.kind === "Warn") {
      expect(r.message).toContain("3 commit(s) behind");
      expect(r.message).toContain("fix: timeout");
    }
  });

  it("stale + Block → Block with reason", () => {
    const f: Freshness = { kind: "stale", commitsBehind: 1, missingFixes: [] };
    const r = applyPolicy(f, "Block");
    expect(r.kind).toBe("Block");
    if (r.kind === "Block") {
      expect(r.reason).toContain("1 commit(s) behind");
    }
  });

  it("diverged + WarnOnly → Warn mentioning ahead/behind", () => {
    const f: Freshness = {
      kind: "diverged",
      ahead: 3,
      behind: 1,
      missingFixes: ["main hotfix"],
    };
    const r = applyPolicy(f, "WarnOnly");
    expect(r.kind).toBe("Warn");
    if (r.kind === "Warn") {
      expect(r.message).toContain("diverged");
      expect(r.message).toContain("3 commit(s) ahead");
      expect(r.message).toContain("1 commit(s) behind");
      expect(r.message).toContain("main hotfix");
    }
  });

  it("diverged + Block → Block reason mentions ahead/behind", () => {
    const f: Freshness = {
      kind: "diverged",
      ahead: 2,
      behind: 4,
      missingFixes: [],
    };
    const r = applyPolicy(f, "Block");
    expect(r.kind).toBe("Block");
    if (r.kind === "Block") {
      expect(r.reason).toContain("2 ahead");
      expect(r.reason).toContain("4 behind");
    }
  });

  it("diverged + AutoRebase → Rebase; AutoMergeForward → MergeForward", () => {
    const f: Freshness = {
      kind: "diverged",
      ahead: 1,
      behind: 1,
      missingFixes: [],
    };
    expect(applyPolicy(f, "AutoRebase")).toEqual({ kind: "Rebase" });
    expect(applyPolicy(f, "AutoMergeForward")).toEqual({ kind: "MergeForward" });
  });
});

// ---------------------------------------------------------------------------
// check() + resolveMainRef — mock child_process.execFile.
// ---------------------------------------------------------------------------

// Mock the node:child_process.execFile to script the sequence of git calls.
// stale-branch.ts uses promisify(execFile), so the callback variant is what's
// invoked. Each queued response is consumed once per call.

type GitResp = { stdout: string; stderr?: string } | { error: NodeJS.ErrnoException };

// Globals — accessed through globalThis so the hoisted vi.mock factory
// (which runs in its own scope) can share state with the test body.
interface GitMockGlobals {
  queue: Array<{ match: (args: readonly string[]) => boolean; resp: GitResp }>;
}
const g = globalThis as typeof globalThis & { __gitMock?: GitMockGlobals };
if (g.__gitMock === undefined) {
  g.__gitMock = { queue: [] };
}
const gitMock = g.__gitMock;

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  // execFile signature: execFile(file[, args][, options], callback).
  // When promisified via node:util, the original callback-style function
  // is called internally with the callback as the last arg.
  const handle = (args: readonly string[]): Promise<{ stdout: string; stderr: string }> => {
    const globals = (globalThis as typeof globalThis & {
      __gitMock?: GitMockGlobals;
    }).__gitMock!;
    const idx = globals.queue.findIndex((q) => q.match(args));
    if (idx === -1) {
      return Promise.reject(
        new Error(`unexpected git call: ${args.join(" ")}`),
      );
    }
    const { resp } = globals.queue.splice(idx, 1)[0]!;
    if ("error" in resp) return Promise.reject(resp.error);
    return Promise.resolve({ stdout: resp.stdout, stderr: resp.stderr ?? "" });
  };
  // Callback-form: execFile(file, args?, opts?, cb)
  const execFileShim = (...allArgs: unknown[]) => {
    const cb = allArgs[allArgs.length - 1] as (
      err: Error | null,
      stdout: string,
      stderr: string,
    ) => void;
    let args: readonly string[] = [];
    if (Array.isArray(allArgs[1])) {
      args = allArgs[1] as readonly string[];
    }
    handle(args).then(
      ({ stdout, stderr }) => cb(null, stdout, stderr),
      (err) => cb(err, "", ""),
    );
  };
  // Promise-form used by `util.promisify(execFile)` — resolves to {stdout, stderr}.
  // The real child_process.execFile installs this under util.promisify.custom.
  (execFileShim as unknown as Record<symbol, unknown>)[util.promisify.custom] =
    (_file: string, args?: readonly string[]) => {
      return handle(args ?? []);
    };
  return {
    ...actual,
    execFile: execFileShim,
  };
});

beforeEach(() => {
  gitMock.queue.length = 0;
});

afterEach(() => {
  gitMock.queue.length = 0;
});

function enqueueMatch(
  match: (args: readonly string[]) => boolean,
  resp: GitResp,
): void {
  gitMock.queue.push({ match, resp });
}

// stale-branch.ts computes:
//   behind = revListCount(mainRef, branch)  ⇒ args contain "branch..mainRef"  (e.g. "topic..main")
//   ahead  = revListCount(branch, mainRef)  ⇒ args contain "mainRef..branch"  (e.g. "main..topic")
// Tests must match on the produced range string, not semantic names.

describe("check (with mocked git)", () => {
  it("returns 'fresh' when behind=0 and ahead=0", async () => {
    const { check } = await import("./stale-branch.js");
    // behind: topic..main
    enqueueMatch(
      (a) => a[0] === "rev-list" && a.includes("topic..main"),
      { stdout: "0\n" },
    );
    // ahead: main..topic
    enqueueMatch(
      (a) => a[0] === "rev-list" && a.includes("main..topic"),
      { stdout: "0\n" },
    );
    const r = await check("topic", "main", { cwd: "/tmp" });
    expect(r).toEqual({ kind: "fresh" });
  });

  it("returns 'stale' with commitsBehind and missingFixes", async () => {
    const { check } = await import("./stale-branch.js");
    // behind = rev-list topic..main = 3
    enqueueMatch(
      (a) => a[0] === "rev-list" && a.includes("topic..main"),
      { stdout: "3\n" },
    );
    // ahead = rev-list main..topic = 0
    enqueueMatch(
      (a) => a[0] === "rev-list" && a.includes("main..topic"),
      { stdout: "0\n" },
    );
    // missingFixes via git log topic..main
    enqueueMatch((a) => a[0] === "log", { stdout: "fix: A\nfix: B\n" });
    const r = await check("topic", "main", { cwd: "/tmp" });
    expect(r.kind).toBe("stale");
    if (r.kind === "stale") {
      expect(r.commitsBehind).toBe(3);
      expect(r.missingFixes).toEqual(["fix: A", "fix: B"]);
    }
  });

  it("returns 'stale' with empty missingFixes when log is empty", async () => {
    const { check } = await import("./stale-branch.js");
    enqueueMatch((a) => a[0] === "rev-list" && a.includes("topic..main"), {
      stdout: "2\n",
    });
    enqueueMatch((a) => a[0] === "rev-list" && a.includes("main..topic"), {
      stdout: "0\n",
    });
    enqueueMatch((a) => a[0] === "log", { stdout: "\n" });
    const r = await check("topic", "main", { cwd: "/tmp" });
    expect(r.kind).toBe("stale");
    if (r.kind === "stale") {
      expect(r.missingFixes).toEqual([]);
    }
  });

  it("returns 'diverged' when ahead>0 and behind>0", async () => {
    const { check } = await import("./stale-branch.js");
    // behind = 2 (topic..main)
    enqueueMatch((a) => a[0] === "rev-list" && a.includes("topic..main"), {
      stdout: "2\n",
    });
    // ahead = 3 (main..topic)
    enqueueMatch((a) => a[0] === "rev-list" && a.includes("main..topic"), {
      stdout: "3\n",
    });
    enqueueMatch((a) => a[0] === "log", { stdout: "upstream fix\n" });
    const r = await check("topic", "main", { cwd: "/tmp" });
    expect(r.kind).toBe("diverged");
    if (r.kind === "diverged") {
      expect(r.ahead).toBe(3);
      expect(r.behind).toBe(2);
      expect(r.missingFixes).toEqual(["upstream fix"]);
    }
  });

  it("returns 'fresh' when ahead>0 but behind=0", async () => {
    const { check } = await import("./stale-branch.js");
    // behind = 0 (topic..main)
    enqueueMatch((a) => a[0] === "rev-list" && a.includes("topic..main"), {
      stdout: "0\n",
    });
    // ahead = 4 (main..topic)
    enqueueMatch((a) => a[0] === "rev-list" && a.includes("main..topic"), {
      stdout: "4\n",
    });
    const r = await check("topic", "main", { cwd: "/tmp" });
    expect(r.kind).toBe("fresh");
  });

  it("resolves mainRef via fallback chain: skips origin/main, uses main", async () => {
    const { check } = await import("./stale-branch.js");
    // origin/main fails (rev-parse --verify)
    const enotfound: NodeJS.ErrnoException = Object.assign(
      new Error("not found"),
      { code: "ENOENT" },
    );
    enqueueMatch(
      (a) => a[0] === "rev-parse" && a.includes("origin/main"),
      { error: enotfound },
    );
    // main succeeds
    enqueueMatch(
      (a) => a[0] === "rev-parse" && a.includes("main") && !a.includes("origin/main"),
      { stdout: "abc123\n" },
    );
    // rev-list calls after fallback.
    enqueueMatch((a) => a[0] === "rev-list" && a.includes("topic..main"), {
      stdout: "0\n",
    });
    enqueueMatch((a) => a[0] === "rev-list" && a.includes("main..topic"), {
      stdout: "0\n",
    });
    const r = await check("topic", undefined, { cwd: "/tmp" });
    expect(r).toEqual({ kind: "fresh" });
  });
});
