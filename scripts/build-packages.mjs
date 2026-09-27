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

// Subpath exports that are their own plugin rows (`openswarm-swarm/command`).
const SUBPATHS = { swarm: ['command', 'eval-reporter'], 'swarm-member': ['server'], 'app-server': ['web'] }

for (const pkg of PACKAGES) {
  const dir = `packages/${pkg}`
  const name = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')).name
  for (const mod of ['index', ...(SUBPATHS[pkg] ?? [])]) {
    await build({
      entryPoints: [`${dir}/src/${mod}.ts`],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      packages: 'external', // every bare import stays external
      outfile: `${dir}/dist/${mod}.js`,
      logLevel: 'warning',
    })
    console.log(`built ${name} → ${dir}/dist/${mod}.js`)
  }
}

// The Swarm tab's browser half (docs/05 A9), in dsh's `dsh.client` bundle
// format: one classic script whose only effect is registering a CJS factory
// with the page's module loader. The host's `require` serves just these shared
// modules (React is the host's), so everything else is bundled in.
const SHARED = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]
const client = 'packages/swarm-client'
const clientId = JSON.parse(readFileSync(`${client}/package.json`, 'utf8')).name
await build({
  entryPoints: [`${client}/src/client.jsx`],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  loader: { '.css': 'text' },
  external: SHARED,
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(clientId)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
  outfile: `${client}/dist/client.js`,
  logLevel: 'warning',
})
console.log(`built ${clientId} → ${client}/dist/client.js`)
