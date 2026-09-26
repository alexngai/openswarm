import { defineConfig } from 'vitest/config'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const src = (p: string) => fileURLToPath(new URL(`packages/${p}/src/index.ts`, import.meta.url))
export default defineConfig({
  resolve: {
    alias: {
      'openswarm-git': src('git'),
      'openswarm-swarm': src('swarm'),
      'openswarm-llm-openai': src('llm-openai'),
      'openswarm-llm-anthropic': src('llm-anthropic'),
      'openswarm-app-server': src('app-server'),
      'openswarm-plugin-authoring': src('plugin-authoring'),
    },
  },
  test: {
    include: ['packages/*/tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Every team run journals under $OPENSWARM_HOME/runs; tests that boot a
    // default-config swarm (the CLI, the bundle) must not write the real home.
    env: { OPENSWARM_HOME: mkdtempSync(join(tmpdir(), 'openswarm-test-home-')) },
  },
})
