/**
 * Contract tests for resource-access declarations.
 *
 * `ToolAccesses` has two consumers with opposite failure modes. The scheduler
 * reads it to decide what may run in parallel; the permission gate reads it to
 * learn which resources a call will touch, so a grant can bind to a path or a
 * host instead of to a tool name.
 *
 * `ToolImpl.accesses` is required, so "declares nothing" is now a compile
 * error rather than a silent optimistic default. What the type cannot check is
 * whether the declaration is *true*, which is what the rest of this file is
 * for: a tool that runs commands must say `all()`, and a tool that touches a
 * path must name the resolved path. Both are wrong in ways nothing fails on
 * until two calls race or an approval turns out to be broader than the user
 * thought.
 *
 * Adding a tool that reads or writes files, or that runs a command, means
 * adding it to one of the lists below.
 */

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { buildTier0Tools } from "./tier0/index.js";
import { buildTier1Tools } from "./tier1/index.js";
import { buildTier2Tools } from "./tier2/index.js";
import type { ToolImpl, ToolExecutionContext } from "./types.js";
import type { ToolAccesses as ToolAccessesType } from "./access.js";

const CWD = "/workspace";
const ctx: ToolExecutionContext = { cwd: CWD };

function allTools(): readonly ToolImpl[] {
  return [...buildTier0Tools(), ...buildTier1Tools({}), ...buildTier2Tools()];
}

function byName(name: string): ToolImpl {
  const tool = allTools().find((t) => t.spec.name === name);
  if (tool === undefined) throw new Error(`no such tool: ${name}`);
  return tool;
}

function declared(name: string, input: unknown): ToolAccessesType {
  const tool = byName(name);
  if (tool.accesses === undefined) {
    throw new Error(`${name} declares no accesses`);
  }
  return tool.accesses(input, ctx);
}

/**
 * Tools whose side effects cannot be named as files: they run commands. The
 * scheduler must treat each as a global barrier.
 */
const OPAQUE_SIDE_EFFECT_TOOLS = ["bash", "shell_exec", "shell_write"];

/** Tools that read or write a path derivable from their input. */
const FILE_TOOLS: ReadonlyArray<{
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly writes: boolean;
}> = [
  { name: "read_file", input: { file_path: "a.txt" }, writes: false },
  { name: "write_file", input: { file_path: "a.txt", content: "x" }, writes: true },
  {
    name: "edit_file",
    input: { file_path: "a.txt", old_string: "a", new_string: "b" },
    writes: true,
  },
  {
    name: "multi_edit",
    input: { file_path: "a.txt", edits: [{ old_string: "a", new_string: "b" }] },
    writes: true,
  },
  { name: "notebook_edit", input: { notebook_path: "a.ipynb" }, writes: true },
  { name: "view_image", input: { path: "a.png" }, writes: false },
];

describe("every registered tool declares its accesses", () => {
  // The type makes this unrepresentable in TypeScript. It is still worth
  // asserting at runtime, because tools also arrive from places the compiler
  // does not see them constructed — the MCP bridge, the plugin registry, and
  // anything registered from plain JS.
  it("no tool reaches the registry undeclared", () => {
    const undeclared = allTools()
      .filter((t) => t.accesses === undefined)
      .map((t) => t.spec.name);
    expect(undeclared).toEqual([]);
  });

  it("no declaration throws on empty input", () => {
    // A declaration that throws is treated as `all()`, which is safe but
    // silently serializes the tool forever. Better to catch it here.
    for (const tool of allTools()) {
      expect(() => tool.accesses?.({}, ctx), `${tool.spec.name} threw`).not.toThrow();
    }
  });
});

describe("tools that run commands declare a global barrier", () => {
  for (const name of OPAQUE_SIDE_EFFECT_TOOLS) {
    it(`${name} declares all()`, () => {
      const accesses = declared(name, {});
      expect(accesses).toEqual([{ kind: "all" }]);
    });
  }
});

describe("tools that reach the network name the host a grant binds to", () => {
  it("web_fetch names the requested URL, not the tool", () => {
    const accesses = declared("web_fetch", { url: "https://example.com/a/b" });
    expect(accesses).toEqual([
      { kind: "network", method: "GET", url: "https://example.com/a/b" },
    ]);
  });

  it("web_fetch degrades to all() on unparseable input", () => {
    expect(declared("web_fetch", { nonsense: true })).toEqual([{ kind: "all" }]);
  });

  it("web_search names the search endpoint", () => {
    const accesses = declared("web_search", { query: "anything" });
    expect(accesses).toHaveLength(1);
    const access = accesses[0]!;
    expect(access.kind).toBe("network");
    if (access.kind !== "network") return;
    expect(new URL(access.url).host).toBe("html.duckduckgo.com");
  });
});

describe("file tools name the path they touch", () => {
  for (const { name, input, writes } of FILE_TOOLS) {
    it(`${name} declares its resolved path`, () => {
      const accesses = declared(name, input);
      expect(accesses).toHaveLength(1);
      const access = accesses[0]!;
      expect(access.kind).toBe("file");
      if (access.kind !== "file") return;
      expect(path.isAbsolute(access.path)).toBe(true);
      expect(access.path.startsWith(CWD)).toBe(true);
      const isWrite = access.operation === "write" || access.operation === "readwrite";
      expect(isWrite).toBe(writes);
    });

    it(`${name} degrades to all() on unparseable input`, () => {
      // An access declaration that cannot read the input must not claim the
      // call touches nothing.
      expect(declared(name, { nonsense: true })).toEqual([{ kind: "all" }]);
    });
  }
});
