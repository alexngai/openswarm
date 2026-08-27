import { defineConfig } from "vitest/config";

// Standalone vitest config for eval/ research code — decoupled from the main suite's
// integration globalSetup/setupFiles. Run: npx vitest run -c eval/vitest.config.ts
export default defineConfig({
  test: {
    include: ["eval/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    environment: "node",
    testTimeout: 15_000,
  },
});
