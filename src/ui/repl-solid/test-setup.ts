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
 */

import { setMaxListeners } from "events";

setMaxListeners(100);
