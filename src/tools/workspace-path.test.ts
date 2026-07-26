/**
 * Tests for the shared tool-level containment helper.
 *
 * The point of consolidating seven near-copies was not tidiness — it was that
 * six of them resolved a symlink only at the leaf, so a file reached through a
 * symlinked parent directory escaped. These tests exercise that case through
 * the real tools, because a helper that is correct in isolation proves nothing
 * about the tools that were supposed to adopt it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveInWorkspace, resetWorkspaceAuthorities } from "./workspace-path.js";
import { readFileTool, writeFileTool, editFileTool, multiEditTool } from "./tier0/index.js";
import { notebookEditTool, viewImageTool } from "./tier1/index.js";
import type { ToolImpl } from "./types.js";

let workspace: string;
let outside: string;

beforeEach(() => {
  resetWorkspaceAuthorities();
  const root = fs.realpathSync(os.tmpdir());
  workspace = fs.mkdtempSync(path.join(root, "wspath-ws-"));
  outside = fs.mkdtempSync(path.join(root, "wspath-out-"));
});

afterEach(() => {
  resetWorkspaceAuthorities();
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("resolveInWorkspace", () => {
  it("returns the path the caller named, not the canonical one", async () => {
    // Tools write to and rename over the path the user gave. Handing back a
    // symlink's target would change which entry an atomic rename replaces.
    const target = path.join(workspace, "real.txt");
    fs.writeFileSync(target, "x");
    const link = path.join(workspace, "link.txt");
    fs.symlinkSync(target, link);

    const result = await resolveInWorkspace(link, workspace);
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.path).toBe(link);
  });

  it("resolves a relative path against the workspace", async () => {
    const result = await resolveInWorkspace("a/b.txt", workspace);
    expect(result.ok === true && result.path).toBe(path.join(workspace, "a", "b.txt"));
  });

  it("allows a file that does not exist yet", async () => {
    expect((await resolveInWorkspace("new.txt", workspace)).ok).toBe(true);
  });

  it("distinguishes a wrong path from a link that leads out", async () => {
    const plain = await resolveInWorkspace(path.join(outside, "x.txt"), workspace);
    expect(plain.ok === false && plain.message).toContain("resolves outside");

    fs.symlinkSync(outside, path.join(workspace, "gateway"));
    const viaLink = await resolveInWorkspace("gateway/x.txt", workspace);
    expect(viaLink.ok === false && viaLink.message).toContain("symlink pointing outside");
  });

  it("reports an unresolvable workspace root rather than allowing the path", async () => {
    const gone = path.join(workspace, "does-not-exist");
    const result = await resolveInWorkspace("a.txt", gone);
    expect(result.ok).toBe(false);
  });

  it("does not cache a failed root permanently", async () => {
    const later = path.join(workspace, "later");
    expect((await resolveInWorkspace("a.txt", later)).ok).toBe(false);
    fs.mkdirSync(later);
    expect((await resolveInWorkspace("a.txt", later)).ok).toBe(true);
  });
});

describe("every file tool refuses a symlinked parent", () => {
  // The gap that survived in six of seven per-tool checks: the leaf is an
  // ordinary file, so a leaf-only lstat sees nothing to follow.
  const cases: ReadonlyArray<{
    readonly tool: ToolImpl;
    readonly input: (p: string) => Record<string, unknown>;
    readonly filename: string;
  }> = [
    { tool: readFileTool, input: (p) => ({ file_path: p }), filename: "victim.txt" },
    {
      tool: writeFileTool,
      input: (p) => ({ file_path: p, content: "pwned" }),
      filename: "victim.txt",
    },
    {
      tool: editFileTool,
      input: (p) => ({ file_path: p, old_string: "secret", new_string: "pwned" }),
      filename: "victim.txt",
    },
    {
      tool: multiEditTool,
      input: (p) => ({
        file_path: p,
        edits: [{ old_string: "secret", new_string: "pwned" }],
      }),
      filename: "victim.txt",
    },
    {
      tool: notebookEditTool,
      input: (p) => ({ notebook_path: p, cell_id: "cell-1", new_source: "pwned" }),
      filename: "victim.ipynb",
    },
    { tool: viewImageTool, input: (p) => ({ path: p }), filename: "victim.png" },
  ];

  for (const { tool, input, filename } of cases) {
    it(`${tool.spec.name} refuses it`, async () => {
      const target = path.join(outside, filename);
      const body = filename.endsWith(".ipynb")
        ? JSON.stringify({
            cells: [{ id: "cell-1", cell_type: "code", source: "secret", metadata: {} }],
            metadata: {},
            nbformat: 4,
            nbformat_minor: 5,
          })
        : "secret";
      fs.writeFileSync(target, body);
      const before = fs.readFileSync(target, "utf8");

      fs.symlinkSync(outside, path.join(workspace, "gateway"));
      const viaParent = path.join(workspace, "gateway", filename);
      expect(fs.lstatSync(viaParent).isSymbolicLink()).toBe(false);

      const result = await tool.execute(input(viaParent), { cwd: workspace });

      expect(result.status).toBe("error");
      expect(fs.readFileSync(target, "utf8")).toBe(before);
    });
  }
});
