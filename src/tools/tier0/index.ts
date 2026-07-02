/**
 * Tier 0 tool factory.
 *
 * Build the full set via `buildTier0Tools()` and register them on a `ToolDispatcher`.
 *
 * See docs/04-tool-tiers.md §"Tier 0" and docs/08-m0-plan.md §"Phase 2".
 */

import type { ToolImpl } from "../types.js";

import { applyPatchTool } from "./apply_patch.js";
import { bashTool } from "./bash.js";
import { editFileTool } from "./edit_file.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { multiEditTool } from "./multi_edit.js";
import { readFileTool } from "./read_file.js";
import { requestPermissionsTool } from "./request_permissions.js";
import { shellExecTool, shellWriteTool, shellListTool } from "./shell.js";
import { todoWriteTool } from "./todo_write.js";
import { writeFileTool } from "./write_file.js";
import { memoryManageTool } from "./memory_manage.js";
import { memorySearchTool } from "./memory_search.js";

/** All Tier 0 tools in a stable order. */
export function buildTier0Tools(): readonly ToolImpl[] {
  return [
    bashTool,
    readFileTool,
    writeFileTool,
    editFileTool,
    multiEditTool,
    applyPatchTool,
    globTool,
    grepTool,
    todoWriteTool,
    shellExecTool,
    shellWriteTool,
    shellListTool,
    requestPermissionsTool,
    memoryManageTool,
    memorySearchTool,
  ] as const;
}

// Named re-exports for direct access where needed.
export {
  applyPatchTool,
  bashTool,
  editFileTool,
  globTool,
  grepTool,
  memoryManageTool,
  memorySearchTool,
  multiEditTool,
  readFileTool,
  requestPermissionsTool,
  shellExecTool,
  shellListTool,
  shellWriteTool,
  todoWriteTool,
  writeFileTool,
};
