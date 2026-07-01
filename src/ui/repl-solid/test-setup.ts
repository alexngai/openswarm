/**
 * test-setup.ts — loaded via bunfig.toml [test] preload before any test file.
 *
 * OpenTUI's test renderer registers listeners on an internal
 * TerminalConsoleCache EventTarget each time a render is spun up. Across a
 * suite of 40+ testRender calls this trips Node's default-10-listener
 * warning, which pollutes test output with "possible memory leak" noise.
 *
 * `setMaxListeners(n)` with no target argument sets the default for newly
 * created EventTargets/EventEmitters — affects anything OpenTUI creates
 * after this preload runs.
 *
 * SWARM_HARNESS_HISTORY_PATH is set to a per-process temp path so tests
 * never read from or write to the user's real ~/.swarm-harness/history file.
 */

import { setMaxListeners } from "events";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

setMaxListeners(100);

// Isolate history file from the real user history for all bun:test runs.
process.env["SWARM_HARNESS_HISTORY_PATH"] = path.join(
  os.tmpdir(),
  `openswarm-test-history-${crypto.randomUUID()}`,
);
