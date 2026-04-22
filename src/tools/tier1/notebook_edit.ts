import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";

const inputSchema = z.object({
  notebook_path: z.string().endsWith(".ipynb"),
  cell_id: z.string().optional(),
  new_source: z.string().optional(),
  cell_type: z.enum(["code", "markdown"]).optional(),
  edit_mode: z.enum(["replace", "insert", "delete"]).default("replace"),
});

type Input = z.infer<typeof inputSchema>;

const spec: ToolSpec = {
  name: "notebook_edit",
  description:
    "Edit a Jupyter notebook (.ipynb) cell-by-cell. Supports replace, insert, and delete operations. " +
    "Use cell_id to target a specific cell. For insert without cell_id, the new cell is appended. " +
    "Requires write permission.",
  inputSchema: zodToJsonSchema(inputSchema as never) as JsonSchema,
  requiredPermission: "write",
  tier: 1,
};

interface NotebookCell {
  id: string;
  cell_type: string;
  source: string;
  metadata: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: null;
}

interface Notebook {
  cells: NotebookCell[];
  metadata?: {
    kernelspec?: {
      language?: string;
    };
  };
}

async function execute(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: Input = parsed.data;

  // Resolve path
  const notebookPath = path.isAbsolute(input.notebook_path)
    ? input.notebook_path
    : path.resolve(ctx.cwd, input.notebook_path);

  // Read file
  let raw_content: string;
  try {
    raw_content = await fs.promises.readFile(notebookPath, "utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `failed to read notebook: ${msg}` };
  }

  // Parse JSON
  let notebook: Notebook;
  try {
    notebook = JSON.parse(raw_content) as Notebook;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `invalid notebook JSON: ${msg}` };
  }

  // Validate cells array
  if (!Array.isArray(notebook.cells)) {
    return { status: "error", message: "not a valid notebook (missing cells array)" };
  }

  // Language detection
  const language = notebook.metadata?.kernelspec?.language ?? "python";

  // Determine cell index
  let cellIndex: number;
  let resolvedCellId: string;
  let resolvedCellType: string;

  if (input.cell_id !== undefined) {
    const idx = notebook.cells.findIndex((c) => c.id === input.cell_id);
    if (idx === -1) {
      return { status: "error", message: `cell not found: ${input.cell_id}` };
    }
    cellIndex = idx;
    resolvedCellId = notebook.cells[idx].id;
    resolvedCellType = notebook.cells[idx].cell_type;
  } else {
    if (input.edit_mode === "insert") {
      cellIndex = notebook.cells.length;
      resolvedCellId = `cell-${notebook.cells.length}`;
      resolvedCellType = input.cell_type ?? "code";
    } else {
      return { status: "error", message: "cell_id required for replace/delete" };
    }
  }

  // Apply edit
  if (input.edit_mode === "replace") {
    if (input.new_source === undefined) {
      return { status: "error", message: "new_source required for replace" };
    }
    notebook.cells[cellIndex].source = input.new_source;
    if (input.cell_type !== undefined) {
      notebook.cells[cellIndex].cell_type = input.cell_type;
      resolvedCellType = input.cell_type;
      // Ensure code cells have outputs/execution_count, markdown cells don't
      if (input.cell_type === "code") {
        if (!notebook.cells[cellIndex].outputs) {
          notebook.cells[cellIndex].outputs = [];
        }
        if (notebook.cells[cellIndex].execution_count === undefined) {
          notebook.cells[cellIndex].execution_count = null;
        }
      } else {
        delete notebook.cells[cellIndex].outputs;
        delete notebook.cells[cellIndex].execution_count;
      }
    }
  } else if (input.edit_mode === "delete") {
    notebook.cells.splice(cellIndex, 1);
  } else {
    // insert
    if (input.new_source === undefined) {
      return { status: "error", message: "new_source required for insert" };
    }
    if (input.cell_type === undefined) {
      return { status: "error", message: "cell_type required for insert" };
    }
    const newCell: NotebookCell = {
      id: resolvedCellId,
      cell_type: input.cell_type,
      source: input.new_source,
      metadata: {},
      ...(input.cell_type === "code"
        ? { outputs: [], execution_count: null }
        : {}),
    };
    // If cell_id was provided, insert AFTER that index; if absent, append
    const insertAt = input.cell_id !== undefined ? cellIndex + 1 : notebook.cells.length;
    notebook.cells.splice(insertAt, 0, newCell);
  }

  // Write back
  await fs.promises.writeFile(notebookPath, JSON.stringify(notebook, null, 1) + "\n", "utf8");

  return {
    status: "ok",
    output: JSON.stringify({
      new_source: input.new_source,
      cell_id: resolvedCellId,
      cell_type: resolvedCellType,
      language,
      edit_mode: input.edit_mode,
      notebook_path: input.notebook_path,
      original_file: notebookPath,
      updated_file: notebookPath,
    }),
  };
}

export const notebookEditTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
