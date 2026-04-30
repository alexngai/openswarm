import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { notebookEditTool } from "./notebook_edit.js";
import type { ToolExecutionContext } from "../types.js";

const FIXTURE = path.resolve(
  new URL(".", import.meta.url).pathname,
  "../../../test/fixtures/notebooks/simple.ipynb",
);

function ctx(cwd: string): ToolExecutionContext {
  return { cwd };
}

let tmpDir: string;

function setupTmp(): string {
  tmpDir = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "nb-test-"));
  fs.copyFileSync(FIXTURE, path.join(tmpDir, "simple.ipynb"));
  return tmpDir;
}

function readNotebook(dir: string, filename = "simple.ipynb"): { cells: Array<{ id: string; cell_type: string; source: string | string[] }> } {
  return JSON.parse(fs.readFileSync(path.join(dir, filename), "utf8"));
}

/** Write a notebook fixture with the given cells to a tmp file. */
function writeTmpNotebook(dir: string, filename: string, cells: unknown[]): string {
  const nb = {
    cells,
    metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" } },
    nbformat: 4,
    nbformat_minor: 5,
  };
  const p = path.join(dir, filename);
  fs.writeFileSync(p, JSON.stringify(nb, null, 1) + "\n", "utf8");
  return p;
}

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("notebookEditTool", () => {
  it("insert append: no cell_id appends a new code cell (4 total, id matches cell-N pattern)", async () => {
    const dir = setupTmp();
    const result = await notebookEditTool.execute(
      {
        notebook_path: path.join(dir, "simple.ipynb"),
        new_source: "y = 99",
        cell_type: "code",
        edit_mode: "insert",
      },
      ctx(dir),
    );
    expect(result.status).toBe("ok");
    const nb = readNotebook(dir);
    expect(nb.cells).toHaveLength(4);
    const last = nb.cells[3];
    expect(last.id).toMatch(/^cell-\d+$/);
    expect(last.cell_type).toBe("code");
    expect(last.source).toBe("y = 99");
  });

  it("insert after id: insert with cell_id 'cell-0' places new cell at index 1", async () => {
    const dir = setupTmp();
    const result = await notebookEditTool.execute(
      {
        notebook_path: path.join(dir, "simple.ipynb"),
        cell_id: "cell-0",
        new_source: "inserted = True",
        cell_type: "code",
        edit_mode: "insert",
      },
      ctx(dir),
    );
    expect(result.status).toBe("ok");
    const nb = readNotebook(dir);
    expect(nb.cells).toHaveLength(4);
    expect(nb.cells[0].id).toBe("cell-0");
    expect(nb.cells[1].source).toBe("inserted = True");
    expect(nb.cells[2].id).toBe("cell-1");
  });

  it("replace by id: replaces cell-1 source; cell_type unchanged, source updated", async () => {
    const dir = setupTmp();
    const result = await notebookEditTool.execute(
      {
        notebook_path: path.join(dir, "simple.ipynb"),
        cell_id: "cell-1",
        new_source: "## New Title",
        edit_mode: "replace",
      },
      ctx(dir),
    );
    expect(result.status).toBe("ok");
    const nb = readNotebook(dir);
    expect(nb.cells).toHaveLength(3);
    expect(nb.cells[1].source).toBe("## New Title");
    expect(nb.cells[1].cell_type).toBe("markdown");
  });

  it("delete by id: delete cell-1; notebook has 2 cells; remaining ids are cell-0 and cell-2", async () => {
    const dir = setupTmp();
    const result = await notebookEditTool.execute(
      {
        notebook_path: path.join(dir, "simple.ipynb"),
        cell_id: "cell-1",
        edit_mode: "delete",
      },
      ctx(dir),
    );
    expect(result.status).toBe("ok");
    const nb = readNotebook(dir);
    expect(nb.cells).toHaveLength(2);
    expect(nb.cells[0].id).toBe("cell-0");
    expect(nb.cells[1].id).toBe("cell-2");
  });

  it("non-.ipynb rejection: notebook_path ending in .txt → Zod error", async () => {
    const dir = setupTmp();
    const result = await notebookEditTool.execute(
      {
        notebook_path: path.join(dir, "simple.txt"),
        edit_mode: "replace",
        cell_id: "cell-0",
        new_source: "x",
      },
      ctx(dir),
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBeTruthy();
    }
  });

  it("invalid notebook JSON: file containing 'not json {' → error 'invalid notebook JSON'", async () => {
    const dir = setupTmp();
    const badPath = path.join(dir, "bad.ipynb");
    fs.writeFileSync(badPath, "not json {", "utf8");
    const result = await notebookEditTool.execute(
      {
        notebook_path: badPath,
        cell_id: "cell-0",
        edit_mode: "replace",
        new_source: "x",
      },
      ctx(dir),
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("invalid notebook JSON");
    }
  });

  it("language detection: kernelspec.language='rust' → output language is 'rust'", async () => {
    const dir = setupTmp();
    const rustNb = {
      cells: [
        { id: "cell-0", cell_type: "code", source: "fn main() {}", metadata: {}, outputs: [], execution_count: null },
      ],
      metadata: {
        kernelspec: { name: "rust", display_name: "Rust", language: "rust" },
      },
      nbformat: 4,
      nbformat_minor: 5,
    };
    const nbPath = path.join(dir, "rust.ipynb");
    fs.writeFileSync(nbPath, JSON.stringify(rustNb, null, 1), "utf8");
    const result = await notebookEditTool.execute(
      {
        notebook_path: nbPath,
        cell_id: "cell-0",
        new_source: "fn main() { println!(\"hi\"); }",
        edit_mode: "replace",
      },
      ctx(dir),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const output = JSON.parse(result.output);
      expect(output.language).toBe("rust");
    }
  });

  it("missing cell_id for replace → error 'cell_id required'", async () => {
    const dir = setupTmp();
    const result = await notebookEditTool.execute(
      {
        notebook_path: path.join(dir, "simple.ipynb"),
        new_source: "something",
        edit_mode: "replace",
      },
      ctx(dir),
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("cell_id required");
    }
  });

  // M2 regression: array-form source round-trip
  it("M2: array-form source round-trips — edited cell stays string, unedited array cells keep array form", async () => {
    const dir = setupTmp();
    const nbPath = writeTmpNotebook(dir, "array-source.ipynb", [
      { id: "cell-0", cell_type: "code", source: ["line1\n", "line2\n"], metadata: {}, outputs: [], execution_count: null },
      { id: "cell-1", cell_type: "markdown", source: ["# Title\n"], metadata: {} },
      { id: "cell-2", cell_type: "code", source: ["x = 42\n"], metadata: {}, outputs: [], execution_count: null },
    ]);

    // Edit cell-1 (markdown); leave cell-0 and cell-2 untouched.
    const result = await notebookEditTool.execute(
      {
        notebook_path: nbPath,
        cell_id: "cell-1",
        new_source: "## New Heading",
        edit_mode: "replace",
      },
      ctx(dir),
    );
    expect(result.status).toBe("ok");

    const nb = JSON.parse(fs.readFileSync(nbPath, "utf8")) as {
      cells: Array<{ id: string; source: string | string[] }>;
    };

    // Unedited cells that originally had array source must keep array form.
    expect(Array.isArray(nb.cells[0]!.source)).toBe(true);
    expect(nb.cells[0]!.source).toEqual(["line1\n", "line2\n"]);
    expect(Array.isArray(nb.cells[2]!.source)).toBe(true);
    expect(nb.cells[2]!.source).toEqual(["x = 42\n"]);

    // Edited cell is plain string (new content has no trailing newline to split).
    expect(typeof nb.cells[1]!.source).toBe("string");
    expect(nb.cells[1]!.source).toBe("## New Heading");
  });

  // M3 regression: collision-free cell id after deletes
  it("M3: insert after delete does not collide with surviving cell ids", async () => {
    const dir = setupTmp();
    const nbPath = writeTmpNotebook(dir, "collide.ipynb", [
      { id: "cell-0", cell_type: "code", source: "a=1", metadata: {}, outputs: [], execution_count: null },
      { id: "cell-1", cell_type: "code", source: "b=2", metadata: {}, outputs: [], execution_count: null },
      { id: "cell-2", cell_type: "code", source: "c=3", metadata: {}, outputs: [], execution_count: null },
      { id: "cell-3", cell_type: "code", source: "d=4", metadata: {}, outputs: [], execution_count: null },
    ]);

    // Delete cell-2; remaining: cell-0, cell-1, cell-3.
    const delResult = await notebookEditTool.execute(
      { notebook_path: nbPath, cell_id: "cell-2", edit_mode: "delete" },
      ctx(dir),
    );
    expect(delResult.status).toBe("ok");

    // Insert without cell_id → appends. cells.length is now 3, but cell-3 exists.
    // Old code would generate id "cell-3" (collision!). Fixed code must use "cell-4".
    const insResult = await notebookEditTool.execute(
      { notebook_path: nbPath, new_source: "e=5", cell_type: "code", edit_mode: "insert" },
      ctx(dir),
    );
    expect(insResult.status).toBe("ok");

    const nb = JSON.parse(fs.readFileSync(nbPath, "utf8")) as {
      cells: Array<{ id: string }>;
    };
    const ids = nb.cells.map((c) => c.id);
    // New cell id must not collide with cell-3.
    expect(ids.filter((id) => id === "cell-3")).toHaveLength(1);
    // All ids must be unique.
    expect(new Set(ids).size).toBe(ids.length);
    // The new cell's id should be cell-4 (max was 3, so max+1=4).
    expect(ids[ids.length - 1]).toBe("cell-4");
  });
});
