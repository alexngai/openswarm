/**
 * Contract tests for resource-access declarations.
 *
 * `ToolAccesses` has two consumers with opposite failure modes. The scheduler
 * reads it to decide what may run in parallel, and its default for an
 * undeclared tool is optimistic: "conflicts with nothing". The permission gate
 * reads it to learn which resources a call will touch, and there an undeclared
 * tool must be treated pessimistically instead.
 *
 * The optimistic default is why these tests exist. A tool that can touch
 * arbitrary paths but declares nothing is not merely unscheduled — it is
 * declared conflict-free, so the scheduler will happily run it alongside a
 * write to the same file. Nothing about the tool's own code reveals the
 * omission, and nothing fails until two calls race. So the expectation is
 * pinned here by name.
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

describe("tools that run commands declare a global barrier", () => {
  for (const name of OPAQUE_SIDE_EFFECT_TOOLS) {
    it(`${name} declares all()`, () => {
      const accesses = declared(name, {});
      expect(accesses).toEqual([{ kind: "all" }]);
    });
  }

  it("none of them rely on the scheduler's optimistic default", () => {
    for (const name of OPAQUE_SIDE_EFFECT_TOOLS) {
      const tool = byName(name);
      // Either an explicit declaration or concurrencySafe:false would do; the
      // bug this guards against is neither being present.
      const guarded = tool.accesses !== undefined || tool.spec.concurrencySafe === false;
      expect(guarded, `${name} is scheduled as conflict-free`).toBe(true);
    }
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
