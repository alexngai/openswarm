// Initialize an OpenSwarm dsh profile home for local boot (docs/01
// packaging). Creates $DSH_HOME/profiles/<name>/ listing dsh-base +
// openswarm-bundle, and heals a flat node_modules so bare plugin names in
// the patch resolve to the workspace packages. Two profiles:
//   openswarm      — HMR cold (headless/eval default)
//   openswarm-dev  — HMR hot + app-server bound (cordis.dev.patch.yml)
//
// Usage: node scripts/init-profile.mjs [dshHome]   (default .dsh-home)
import { mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const dshHome = resolve(process.argv[2] ?? '.dsh-home')

// The OpenSwarm package root (parent of scripts/) — the repo when run from a
// clone, or node_modules/openswarm when installed. Both ship packages/*.
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(pkgRoot, 'package.json'))

/** Every OpenSwarm plugin package a profile must resolve by bare name. */
const WORKSPACE = readdirSync(join(pkgRoot, 'packages'))
  .map((d) => join(pkgRoot, 'packages', d))
  .filter((p) => existsSync(join(p, 'package.json')))
  .map((p) => ({ dir: p, name: JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')).name }))

// The node_modules dir that actually holds the dsh app + framework — resolved
// through Node, so it works whether deps sit in the repo's node_modules or are
// hoisted above an installed package.
const depsRoot = dirname(dirname(dirname(require.resolve('@deepseek-ai/dsh/package.json'))))

function healModules(dir) {
  const modules = join(dir, 'node_modules')
  mkdirSync(modules, { recursive: true })
  // OpenSwarm plugin packages → their dirs (source in the repo, dist when installed).
  for (const { dir: pkgDir, name } of WORKSPACE) link(join(modules, name), pkgDir)
  // dsh + framework deps → wherever Node resolved them (scoped names need the dir).
  for (const name of readdirSync(depsRoot)) {
    if (name.startsWith('@')) {
      const scopeDir = join(modules, name)
      mkdirSync(scopeDir, { recursive: true })
      for (const sub of readdirSync(join(depsRoot, name))) link(join(scopeDir, sub), join(depsRoot, name, sub))
    } else if (!name.startsWith('.') && !WORKSPACE.some((w) => w.name === name)) {
      link(join(modules, name), join(depsRoot, name))
    }
  }
}

function link(linkPath, target) {
  try {
    rmSync(linkPath, { recursive: true, force: true })
  } catch {}
  symlinkSync(target, linkPath, 'dir')
}

/**
 * Inter-package imports (e.g. openswarm-swarm → openswarm-git) resolve from a
 * package's own on-disk location, walking up to the nearest node_modules. In a
 * clone, npm workspaces already placed those sibling links; in an installed
 * package there are none, so create them under the package root's node_modules
 * so every openswarm-* package can find its siblings. Idempotent.
 */
function linkSiblings() {
  const modules = join(pkgRoot, 'node_modules')
  mkdirSync(modules, { recursive: true })
  for (const { dir: pkgDir, name } of WORKSPACE) {
    const target = join(modules, name)
    if (existsSync(target)) continue // workspace clone already linked it
    symlinkSync(pkgDir, target, 'dir')
  }
}

function initProfile(name, extraBundles = []) {
  const dir = join(dshHome, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  // The headless one-shot runner drives a task then exits — right for the
  // cold `openswarm` profile (headless/eval). The `-dev` server profile omits
  // it: the app-server's bound socket keeps the process alive to serve.
  const isServer = name.endsWith('-dev')
  const bundles = isServer
    ? ['@deepseek-ai/dsh-base', 'openswarm-bundle', ...extraBundles]
    : ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'openswarm-bundle', ...extraBundles]
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: `dsh-profile-${name}`,
        private: true,
        dependencies: {},
        dsh: { profile: { bundles } },
      },
      null,
      2,
    ) + '\n',
  )
  // A cold profile carries no user patch; the dev profile overlays the dev patch.
  const devPatch = join(pkgRoot, 'packages', 'bundle', 'cordis.dev.patch.yml')
  writeFileSync(
    join(dir, 'cordis.patch.yml'),
    name.endsWith('-dev') ? readFileSync(devPatch, 'utf8') : '[]\n',
  )
  healModules(dir)
  console.log(`profile ${name} → ${dir}`)
}

linkSiblings()
mkdirSync(dshHome, { recursive: true })
initProfile('openswarm')
initProfile('openswarm-dev')
console.log(`DSH_HOME=${dshHome}`)
