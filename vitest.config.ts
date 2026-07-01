import { defineConfig } from "vitest/config";
import * as os from "node:os";

// Cap worker forks to roughly half the cores. The integration suites spawn real
// worker subprocesses; an unthrottled unit-test fork storm starves those
// subprocesses and trips their wall-clock deadlines (see test/util/compute-scale
// and swarm.test.ts:363). Leaving CPU headroom keeps the subprocess tests honest
// without meaningfully slowing the fast unit suite. Override with TEST_MAX_FORKS.
const maxForks = Math.max(
  2,
  Number(process.env.TEST_MAX_FORKS) || Math.ceil(os.cpus().length / 2),
);

export default defineConfig({
  test: {
    poolOptions: { forks: { maxForks } },
    // .ts only (not .tsx). OpenTUI tests live in src/ui/repl-solid/**/*.test.tsx
    // and run via `bun test` — they need Bun's runtime for bun:ffi.
    // Pure-TS tests inside repl-solid (e.g. store.test.ts) still run here.
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Bun-only subprocess test lives in repl-solid/; vitest can't load
    // its `bun:test` imports. It runs under `bun test` instead.
    exclude: ["src/ui/repl-solid/cli-bun.test.ts", "**/node_modules/**"],
    environment: "node",
    globalSetup: ["./test/integration/global-setup.ts"],
    // Per-worker setup that runs before any test file. Phase 4 follow-up:
    // sets OPENSWARM_HISTORY_PATH so tests never touch the user's real
    // ~/.openswarm/history (symmetric to bun:test's test-setup.ts).
    setupFiles: ["./test/vitest-setup.ts"],
    testTimeout: 15_000,
    hookTimeout: 60_000,
  },
});
