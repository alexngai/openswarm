import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
    // sets SWARM_HARNESS_HISTORY_PATH so tests never touch the user's real
    // ~/.swarm-harness/history (symmetric to bun:test's test-setup.ts).
    setupFiles: ["./test/vitest-setup.ts"],
    testTimeout: 15_000,
    hookTimeout: 60_000,
  },
});
