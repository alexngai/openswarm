/**
 * Vitest globalSetup for integration tests.
 *
 * Builds the `dist/` directory exactly once before any integration test file
 * runs. Previously each integration file ran `npm run build` inside its own
 * beforeAll — three files x serial tsc invocations fighting over the same
 * output directory produced a flaky subprocess-spawning race, observable as
 * the sporadic `[10] FAIL` in `scripts/smoke.sh` whenever vitest tried to
 * stand up all three integration suites in parallel.
 *
 * Running the build once in globalSetup eliminates that contention without
 * regressing any correctness guarantee — the builds were previously
 * idempotent and produced the same dist content.
 *
 * Opt out with `OPENSWARM_SKIP_INTEGRATION_BUILD=1` — useful when the
 * caller (e.g. smoke.sh) has already built dist.
 */

import { execSync } from "node:child_process";
import * as path from "node:path";

export default function setup(): void {
  if (process.env.OPENSWARM_SKIP_INTEGRATION_BUILD === "1") return;

  const repoRoot = path.resolve(__dirname, "..", "..");
  execSync("npm run build", {
    cwd: repoRoot,
    stdio: "pipe",
  });
}
