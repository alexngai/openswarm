import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    // Build dist/ once before any integration file runs. Previously each
    // integration test's beforeAll ran `npm run build` — three files in
    // parallel raced on the shared dist/ output, producing the sporadic
    // smoke.sh [10] FAIL. globalSetup runs once per `vitest run` invocation
    // and can be bypassed with SWARM_CODER_SKIP_INTEGRATION_BUILD=1 when the
    // caller (e.g. a smoke script) already built dist.
    globalSetup: ["./test/integration/global-setup.ts"],
    // Default per-test timeout is 5s; some integration tests override with
    // their own timeout arg. Bumping the default to 15s gives unit tests
    // under load some headroom without masking real hangs (subprocess
    // tests still set explicit multi-minute timeouts).
    testTimeout: 15_000,
    hookTimeout: 60_000,
  },
});
