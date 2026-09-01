#!/usr/bin/env node
/**
 * openswarm — user launcher for the dsh-based stack (docs/03).
 *
 * Wraps `dsh --profile openswarm[-dev]` so running a swarm is one command:
 * it initializes the profiles on first use, auto-detects the model provider
 * from your environment, and maps friendly flags to the OPENSWARM_* env the
 * bundle reads.
 *
 *   openswarm "<task>"            run one task headless
 *   openswarm run "<task>"        same
 *   openswarm web [flags]         open the DeepSeek browser UI on a swarm context
 *   openswarm serve [--port N]    start the app-server (JSON-RPC, for UIs/TUIs)
 *   openswarm setup               (re)initialize the profiles
 *   openswarm config              print the resolved provider/model/home
 *
 * Options: --model <id>, --provider <azure|openai|bedrock>, --home <dir>.
 * Provider auto-detect (when --provider is unset): Azure (AZURE_API_KEY +
 * AZURE_API_BASE) → OpenAI (OPENAI_API_KEY) → Bedrock (AWS_BEARER_TOKEN_BEDROCK).
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The OpenSwarm package root — the repo from a clone, node_modules/openswarm
// when installed. dsh and the init script resolve through Node from here, so
// the launcher works either way (deps may be hoisted above an install).
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(pkgRoot, 'package.json'))

/** Resolve the dsh runtime bin through Node (hoist-agnostic). */
function resolveDsh() {
  try {
    const pkgPath = require.resolve('@deepseek-ai/dsh/package.json')
    const pkg = require('@deepseek-ai/dsh/package.json')
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.dsh
    if (bin) return join(dirname(pkgPath), bin)
  } catch {}
  return undefined
}
const dshScript = resolveDsh()

const VALUE_FLAGS = new Set(['--model', '--provider', '--home', '--port'])
/**
 * Flags the headless eval surface understands. They are parsed but NOT acted on
 * here — `runCli` in packages/cli owns them. Listing them keeps the interactive
 * parser from rejecting an eval invocation with `unknown option`, which is how
 * every harness cell used to die on its very first argument.
 */
const HEADLESS_VALUE_FLAGS = new Set([
  '--output-format',
  '--permission-mode',
  '--max-tokens',
  '--max-turns',
  '--max-cost-usd',
  '--workers',
  '--spec',
  '--output',
  '--trace-output',
])
const HEADLESS_BOOL_FLAGS = new Set(['--headless', '--single', '--team'])

/**
 * `lenient` forwards flags this launcher does not own instead of rejecting
 * them — `openswarm web` passes the dsh web app's own flags (--host,
 * --no-open, --trusted-host, …) straight through.
 */
function parse(argv, lenient = false) {
  const opts = {}
  const rest = []
  const headless = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (HEADLESS_VALUE_FLAGS.has(a)) {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) die(`${a} requires a value`)
      headless.push(a, value)
      i++
    } else if (HEADLESS_BOOL_FLAGS.has(a)) {
      headless.push(a)
    } else if (VALUE_FLAGS.has(a)) {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) die(`${a} requires a value`)
      opts[a.slice(2)] = value
      i++
    } else if (a === '--help' || a === '-h') {
      opts.help = true
    } else if (a.startsWith('--')) {
      if (!lenient) die(`unknown option "${a}"`)
      rest.push(a)
    } else {
      rest.push(a)
    }
  }
  return { opts, rest, headless }
}

function die(msg) {
  process.stderr.write(`openswarm: ${msg}\n`)
  process.exit(1)
}

/** Resolve provider route + model + adapter env from flags and environment. */
function resolveModel(opts) {
  const provider = opts.provider ?? process.env.OPENSWARM_PROVIDER ?? autoProvider()
  if (provider === undefined) {
    die(
      'no model provider configured. Set one of:\n' +
        '  AZURE_API_KEY + AZURE_API_BASE   (Azure OpenAI)\n' +
        '  OPENAI_API_KEY                   (OpenAI)\n' +
        '  AWS_BEARER_TOKEN_BEDROCK         (Bedrock / Anthropic)\n' +
        'or pass --provider <azure|openai|bedrock>.',
    )
  }
  const model = opts.model ?? process.env.OPENSWARM_MODEL ?? defaultModel(provider)
  const env = { OPENSWARM_DEFAULT_MODEL: model }
  if (provider === 'azure') {
    if (!process.env.AZURE_API_BASE || !process.env.AZURE_API_KEY) die('azure needs AZURE_API_BASE and AZURE_API_KEY')
    env.OPENSWARM_DEFAULT_PROVIDER = 'openai'
    env.OPENSWARM_LLM_BASE_URL = `${process.env.AZURE_API_BASE.replace(/\/+$/, '')}/openai/v1`
    env.OPENSWARM_LLM_API_KEY = process.env.AZURE_API_KEY
    env.OPENSWARM_OPENAI_MODELS = JSON.stringify([{ id: model, contextWindow: 200000 }])
  } else if (provider === 'openai') {
    if (!process.env.OPENAI_API_KEY && !process.env.OPENSWARM_LLM_API_KEY) die('openai needs OPENAI_API_KEY')
    env.OPENSWARM_DEFAULT_PROVIDER = 'openai'
    env.OPENSWARM_LLM_BASE_URL = process.env.OPENSWARM_LLM_BASE_URL ?? 'https://api.openai.com/v1'
    env.OPENSWARM_LLM_API_KEY = process.env.OPENSWARM_LLM_API_KEY ?? process.env.OPENAI_API_KEY
    env.OPENSWARM_OPENAI_MODELS = JSON.stringify([{ id: model, contextWindow: 200000 }])
  } else if (provider === 'bedrock') {
    if (!process.env.AWS_BEARER_TOKEN_BEDROCK) die('bedrock needs AWS_BEARER_TOKEN_BEDROCK')
    env.OPENSWARM_DEFAULT_PROVIDER = 'bedrock'
    env.OPENSWARM_ANTHROPIC_MODELS = JSON.stringify([{ id: model, contextWindow: 200000 }])
    if (process.env.AWS_REGION) env.AWS_REGION = process.env.AWS_REGION
  } else {
    die(`unknown provider "${provider}" (use azure, openai, or bedrock)`)
  }
  return { provider, model, env }
}

function autoProvider() {
  if (process.env.AZURE_API_KEY && process.env.AZURE_API_BASE) return 'azure'
  if (process.env.OPENAI_API_KEY) return 'openai'
  if (process.env.AWS_BEARER_TOKEN_BEDROCK) return 'bedrock'
  return undefined
}

function defaultModel(provider) {
  if (provider === 'bedrock') return 'us.anthropic.claude-haiku-4-5-20251001-v1:0'
  return 'gpt-5.5'
}

function ensureBuilt() {
  if (!existsSync(join(pkgRoot, 'packages', 'swarm', 'dist', 'index.js'))) {
    die('packages are not built. Run:  npm install && npm run build')
  }
  if (dshScript === undefined || !existsSync(dshScript)) die('dsh is not installed. Run:  npm install')
}

const PROFILES = ['openswarm', 'openswarm-dev', 'openswarm-web']

function ensureProfiles(home) {
  // Re-init when ANY profile is missing, so a home from an older version
  // gains the profiles a newer one added.
  if (PROFILES.every((p) => existsSync(join(home, 'profiles', p)))) return
  process.stderr.write('openswarm: initializing profiles…\n')
  execFileSync('node', [join(pkgRoot, 'scripts', 'init-profile.mjs'), home], { cwd: pkgRoot, stdio: 'inherit' })
}

function bootDsh(profile, positional, extraEnv, home) {
  const child = spawn('node', [dshScript, '--profile', profile, ...positional], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env, DSH_HOME: home, ...extraEnv },
  })
  child.on('exit', (code) => process.exit(code ?? 0))
}

const HELP = `openswarm — run a swarm of coding agents on the dsh stack

Usage:
  openswarm "<task>"            run one task headless
  openswarm run "<task>"        same
  openswarm web [flags]         open the DeepSeek browser UI on a swarm context
  openswarm serve [--port N]    start the app-server (JSON-RPC for UIs/TUIs)
  openswarm setup               (re)initialize the profiles
  openswarm config              print the resolved provider/model/home

Options:
  --model <id>        model id (default: gpt-5.5, or haiku for bedrock)
  --provider <name>   azure | openai | bedrock (default: auto-detect)
  --home <dir>        profile home (default: $OPENSWARM_HOME or ~/.openswarm)
  --port <n>          web / serve port (web default: 3080, serve: 4620)

The web command forwards its remaining flags to the dsh web app (--host,
--no-open, --trusted-host …); type /swarm in the UI to run a team.

Providers are auto-detected from the environment:
  AZURE_API_KEY + AZURE_API_BASE   → azure
  OPENAI_API_KEY                   → openai
  AWS_BEARER_TOKEN_BEDROCK         → bedrock
`

/** Value of `flag` in a flat [flag, value, …] list, or undefined. */
function valueOf(flat, flag) {
  const i = flat.indexOf(flag)
  return i === -1 ? undefined : flat[i + 1]
}

function main() {
  const argv = process.argv.slice(2)
  const { opts, rest, headless } = parse(argv, argv[0] === 'web')
  const home = opts.home ?? process.env.OPENSWARM_HOME ?? join(homedir(), '.openswarm')
  const cmd = rest[0]

  if (opts.help || cmd === 'help' || (cmd === undefined && rest.length === 0)) {
    process.stdout.write(HELP)
    process.exit(0)
  }

  ensureBuilt()

  if (cmd === 'setup') {
    execFileSync('node', [join(pkgRoot, 'scripts', 'init-profile.mjs'), home], { cwd: pkgRoot, stdio: 'inherit' })
    process.stdout.write(`profiles ready in ${home}\n`)
    return
  }
  if (cmd === 'config') {
    const { provider, model } = resolveModel(opts)
    process.stdout.write(`home:     ${home}\nprovider: ${provider}\nmodel:    ${model}\n`)
    return
  }

  ensureProfiles(home)

  if (cmd === 'web') {
    // dsh's own browser UI, composed over the OpenSwarm context: the swarm
    // service, the OpenSwarm model adapters, and the `/swarm` command.
    const { env } = resolveModel(opts)
    const args = rest.slice(1)
    if (opts.port) args.push('--port', String(opts.port))
    bootDsh('openswarm-web', args, env, home)
    return
  }

  if (cmd === 'serve') {
    const { env } = resolveModel(opts)
    if (opts.port) env.OPENSWARM_APP_PORT = String(opts.port)
    process.stderr.write(`openswarm: serving app-server on :${opts.port ?? 4620} (Ctrl-C to stop)\n`)
    bootDsh('openswarm-dev', [], env, home)
    return
  }

  // run (explicit or implicit): the task is everything after an optional `run`.
  const task = cmd === 'run' ? rest.slice(1) : rest
  const outputFormat = valueOf(headless, '--output-format')

  // The headless eval path: in-process, JSONL on stdout. It deliberately does
  // NOT boot dsh — see `bootHarness` in packages/cli for the drift caveat.
  if (cmd === 'topology' || outputFormat === 'json') {
    const { env } = resolveModel(opts)
    Object.assign(process.env, env)
    const argvForCli =
      cmd === 'topology'
        ? ['topology', ...rest.slice(1), ...headless]
        : ['run', ...headless, '--model', resolveModel(opts).model, ...task]
    return import(join(pkgRoot, 'packages', 'cli', 'dist', 'index.js'))
      .then(({ runCli }) => runCli(argvForCli))
      .then((code) => process.exit(code))
  }

  if (task.length === 0) die('no task given. Try:  openswarm "explain this repo"')
  const { env } = resolveModel(opts)
  bootDsh('openswarm', [task.join(' ')], env, home)
}

main()
