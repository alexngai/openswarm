/**
 * vitest-setup.ts — per-worker setup that fires before any vitest test file.
 *
 * Phase 4 follow-up: history.ts respects SWARM_HARNESS_HISTORY_PATH so tests
 * never touch the user's real ~/.swarm-harness/history. The bun:test side
 * sets this in src/ui/repl-solid/test-setup.ts; this file does the same on
 * the vitest side, making the safety net symmetric. Without this, a future
 * vitest test that forgot to pass an explicit `filePath` argument to
 * loadHistory / appendHistoryEntry would write to the real path.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), `swarm-harness-vitest-${crypto.randomUUID()}-`),
);
process.env["SWARM_HARNESS_HISTORY_PATH"] = path.join(tmpDir, "history");
// Prevent vitest tests from writing to the user's real ~/.swarm-harness/workers/.
// Mirror the SWARM_HARNESS_HISTORY_PATH pattern used above.
process.env["SWARM_HARNESS_WORKERS_DIR"] = path.join(tmpDir, "workers");
