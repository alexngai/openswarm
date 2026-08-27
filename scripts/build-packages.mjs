// Build each publishable package's src/index.ts → dist/index.js (docs/01
// packaging). Every bare import (dsh, cordis, sibling openswarm-*) stays
// external, so the emitted JS resolves package-to-package at boot exactly
// like published npm packages — the shape a `dsh --profile openswarm` boot
// needs. Dev tests keep reading src through the vitest alias, so this build
// is only for boot/publish, not the test loop.
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'

const PACKAGES = [
  'git',
  'swarm',
  'llm-openai',
  'llm-anthropic',
  'app-server',
  'plugin-authoring',
  'swarm-member',
  'cli',
]

for (const pkg of PACKAGES) {
  const dir = `packages/${pkg}`
  const entry = `${dir}/src/index.ts`
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'external', // every bare import stays external
    outfile: `${dir}/dist/index.js`,
    logLevel: 'warning',
  })
  const name = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')).name
  console.log(`built ${name} → ${dir}/dist/index.js`)
}
