/**
 * vitest-setup.ts — per-worker setup that fires before any vitest test file.
 *
 * Phase 4 follow-up: history.ts respects OPENSWARM_HISTORY_PATH so tests
 * never touch the user's real ~/.openswarm/history. The bun:test side
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
  path.join(os.tmpdir(), `openswarm-vitest-${crypto.randomUUID()}-`),
);
process.env["OPENSWARM_HISTORY_PATH"] = path.join(tmpDir, "history");
// Prevent vitest tests from writing to the user's real ~/.openswarm/workers/.
// Mirror the OPENSWARM_HISTORY_PATH pattern used above.
process.env["OPENSWARM_WORKERS_DIR"] = path.join(tmpDir, "workers");

// The same hazard, one dependency over. `sessionlog` is configured entirely
// through ambient SESSIONLOG_* variables: SESSIONLOG_REPO_REMOTE redirects
// session storage into a clone of that remote under ~/.sessionlog/repos/<hash>,
// SESSIONLOG_PROJECT_DIR moves where settings are read from, and the rest move
// individual paths. A developer with any of them exported gets tests that write
// fixture state into their own session-history checkout — and the remote path
// clones over the network on first use, inside a suite that is supposed to be
// hermetic.
//
// Deleted rather than blanked: sessionlog tests these for truthiness in some
// places and existence in others, so an empty string is not reliably "unset".
//
// This is also why the swarm checkpointer fixtures looked like a macOS defect.
// They passed in the Docker cell, which forwards no SESSIONLOG_* variables, and
// failed on the host, which had one exported — a platform difference in
// appearance only. The Linux-only gate matrix is what let the two be confused.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("SESSIONLOG_")) delete process.env[key];
}
