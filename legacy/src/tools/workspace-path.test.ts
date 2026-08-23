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

describe("dangling links", () => {
  it("refuses a link to a file that does not exist yet outside the workspace", async () => {
    // The escape a leaf-only or realpath-only check cannot see: nothing at the
    // target means realpath reports ENOENT, which reads as "new file here"
    // rather than "existing link to there".
    const target = path.join(outside, "absent.txt");
    fs.symlinkSync(target, path.join(workspace, "dangling.txt"));

    const result = await resolveInWorkspace("dangling.txt", workspace);
    expect(result.ok).toBe(false);
  });

  it("allows a dangling link whose target stays inside", async () => {
    fs.symlinkSync(path.join(workspace, "not-yet.txt"), path.join(workspace, "pending.txt"));

    expect((await resolveInWorkspace("pending.txt", workspace)).ok).toBe(true);
  });

  it("refuses a symlink cycle instead of surfacing a raw errno", async () => {
    fs.symlinkSync(path.join(workspace, "b"), path.join(workspace, "a"));
    fs.symlinkSync(path.join(workspace, "a"), path.join(workspace, "b"));

    // Previously ELOOP escaped the helper as an unhandled error, so a cycle
    // crashed the tool rather than being denied by it.
    await expect(resolveInWorkspace("a", workspace)).resolves.toMatchObject({ ok: false });
  });

  it("write_file does not create a file outside through a dangling link", async () => {
    const target = path.join(outside, "planted.txt");
    fs.symlinkSync(target, path.join(workspace, "dangling.txt"));

    const result = await writeFileTool.execute(
      { file_path: path.join(workspace, "dangling.txt"), content: "pwned" },
      { cwd: workspace },
    );

    expect(result.status).toBe("error");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("write_file does not create a file under a dangling directory link", async () => {
    fs.symlinkSync(path.join(outside, "absent-dir"), path.join(workspace, "hop"));

    const result = await writeFileTool.execute(
      { file_path: path.join(workspace, "hop", "planted.txt"), content: "pwned" },
      { cwd: workspace },
    );

    expect(result.status).toBe("error");
    expect(fs.existsSync(path.join(outside, "absent-dir"))).toBe(false);
  });

  it("write_file allows a dangling link that stays inside", async () => {
    // Both ends are in the workspace, so there is nothing to refuse. The
    // read-before-overwrite contract must not fire either: lstat would see the
    // link and demand a prior read that read_file can never supply, because it
    // follows the link and finds nothing there.
    const named = path.join(workspace, "pending.txt");
    fs.symlinkSync(path.join(workspace, "not-yet.txt"), named);

    const result = await writeFileTool.execute(
      { file_path: named, content: "fine" },
      { cwd: workspace },
    );

    expect(result.status).not.toBe("error");
    // The atomic rename replaces the link rather than writing through it, which
    // is what makes the write atomic; either way the bytes stay inside.
    expect(fs.readFileSync(named, "utf8")).toBe("fine");
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
