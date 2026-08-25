// Initialize an OpenSwarm dsh profile home for local boot (docs/01
// packaging). Creates $DSH_HOME/profiles/<name>/ listing dsh-base +
// openswarm-bundle, and heals a flat node_modules so bare plugin names in
// the patch resolve to the workspace packages. Two profiles:
//   openswarm      — HMR cold (headless/eval default)
//   openswarm-dev  — HMR hot + app-server bound (cordis.dev.patch.yml)
//
// Usage: node scripts/init-profile.mjs [dshHome]   (default .dsh-home)
import { mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const dshHome = resolve(process.argv[2] ?? '.dsh-home')
const repo = resolve('.')

/** Every workspace package a profile must resolve by bare name. */
const WORKSPACE = readdirSync(join(repo, 'packages'))
  .map((d) => join(repo, 'packages', d))
  .filter((p) => existsSync(join(p, 'package.json')))
  .map((p) => ({ dir: p, name: JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')).name }))

function healModules(dir) {
  const modules = join(dir, 'node_modules')
  mkdirSync(modules, { recursive: true })
  // Workspace packages → their source dirs.
  for (const { dir: pkgDir, name } of WORKSPACE) link(join(modules, name), pkgDir)
  // dsh + framework deps → the repo's installed copies (scoped names need the dir).
  const repoModules = join(repo, 'node_modules')
  for (const name of readdirSync(repoModules)) {
    if (name.startsWith('@')) {
      const scopeDir = join(modules, name)
      mkdirSync(scopeDir, { recursive: true })
      for (const sub of readdirSync(join(repoModules, name))) link(join(scopeDir, sub), join(repoModules, name, sub))
    } else if (!name.startsWith('.') && !WORKSPACE.some((w) => w.name === name)) {
      link(join(modules, name), join(repoModules, name))
    }
  }
}

function link(linkPath, target) {
  try {
    rmSync(linkPath, { recursive: true, force: true })
  } catch {}
  symlinkSync(target, linkPath, 'dir')
}

function initProfile(name, extraBundles = []) {
  const dir = join(dshHome, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: `dsh-profile-${name}`,
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'openswarm-bundle', ...extraBundles] } },
      },
      null,
      2,
    ) + '\n',
  )
  // A cold profile carries no user patch; the dev profile overlays the dev patch.
  const devPatch = join(repo, 'packages', 'bundle', 'cordis.dev.patch.yml')
  writeFileSync(
    join(dir, 'cordis.patch.yml'),
    name.endsWith('-dev') ? readFileSync(devPatch, 'utf8') : '[]\n',
  )
  healModules(dir)
  console.log(`profile ${name} → ${dir}`)
}

mkdirSync(dshHome, { recursive: true })
initProfile('openswarm')
initProfile('openswarm-dev')
console.log(`DSH_HOME=${dshHome}`)
