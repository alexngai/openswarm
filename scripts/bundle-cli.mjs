// Build the sandbox-deployable single-file CLI (docs/01 Phase 5).
// esbuild bundle + one post-patch: dsh-llm resolves its version via a
// runtime `createRequire(...)('../package.json')`, which escapes bundling
// and breaks wherever no package.json sits above the bundle. Inline it.
import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'

const OUT = 'packages/cli/dist/openswarm.mjs'
const DSH_VERSION = JSON.parse(
  readFileSync('node_modules/@deepseek-ai/dsh-llm/package.json', 'utf8'),
).version

await build({
  entryPoints: ['packages/cli/src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['node-pty', 'koffi'],
  outfile: OUT,
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'warning',
})

const bundled = readFileSync(OUT, 'utf8')
const needle = 'createRequire(import.meta.url)("../package.json")'
if (!bundled.includes(needle)) throw new Error('bundle-cli: version-require needle not found — recheck the patch')
writeFileSync(OUT, bundled.replaceAll(needle, JSON.stringify({ version: DSH_VERSION })))
console.log(`bundled ${OUT} (dsh ${DSH_VERSION} inlined)`)
