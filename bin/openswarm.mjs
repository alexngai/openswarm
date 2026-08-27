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
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshBin = join(repo, 'node_modules', '.bin', 'dsh')

function parse(argv) {
  const opts = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--model' || a === '--provider' || a === '--home' || a === '--port') {
      opts[a.slice(2)] = argv[++i]
    } else if (a === '--help' || a === '-h') {
      opts.help = true
    } else {
      rest.push(a)
    }
  }
  return { opts, rest }
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
  if (!existsSync(join(repo, 'packages', 'swarm', 'dist', 'index.js'))) {
    die('packages are not built. Run:  npm install && npm run build')
  }
  if (!existsSync(dshBin)) die('dsh is not installed. Run:  npm install')
}

function ensureProfiles(home) {
  if (existsSync(join(home, 'profiles', 'openswarm'))) return
  process.stderr.write('openswarm: initializing profiles…\n')
  execFileSync('node', [join(repo, 'scripts', 'init-profile.mjs'), home], { cwd: repo, stdio: 'inherit' })
}

function bootDsh(profile, positional, extraEnv, home) {
  const child = spawn(dshBin, ['--profile', profile, ...positional], {
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
  openswarm serve [--port N]    start the app-server (JSON-RPC for UIs/TUIs)
  openswarm setup               (re)initialize the profiles
  openswarm config              print the resolved provider/model/home

Options:
  --model <id>        model id (default: gpt-5.5, or haiku for bedrock)
  --provider <name>   azure | openai | bedrock (default: auto-detect)
  --home <dir>        profile home (default: $OPENSWARM_HOME or ~/.openswarm)
  --port <n>          serve port (default: 4620)

Providers are auto-detected from the environment:
  AZURE_API_KEY + AZURE_API_BASE   → azure
  OPENAI_API_KEY                   → openai
  AWS_BEARER_TOKEN_BEDROCK         → bedrock
`

function main() {
  const { opts, rest } = parse(process.argv.slice(2))
  const home = opts.home ?? process.env.OPENSWARM_HOME ?? join(homedir(), '.openswarm')
  const cmd = rest[0]

  if (opts.help || cmd === 'help' || (cmd === undefined && rest.length === 0)) {
    process.stdout.write(HELP)
    process.exit(0)
  }

  ensureBuilt()

  if (cmd === 'setup') {
    execFileSync('node', [join(repo, 'scripts', 'init-profile.mjs'), home], { cwd: repo, stdio: 'inherit' })
    process.stdout.write(`profiles ready in ${home}\n`)
    return
  }
  if (cmd === 'config') {
    const { provider, model } = resolveModel(opts)
    process.stdout.write(`home:     ${home}\nprovider: ${provider}\nmodel:    ${model}\n`)
    return
  }

  ensureProfiles(home)

  if (cmd === 'serve') {
    const { env } = resolveModel(opts)
    if (opts.port) env.OPENSWARM_APP_PORT = String(opts.port)
    process.stderr.write(`openswarm: serving app-server on :${opts.port ?? 4620} (Ctrl-C to stop)\n`)
    bootDsh('openswarm-dev', [], env, home)
    return
  }

  // run (explicit or implicit): the task is everything after an optional `run`.
  const task = cmd === 'run' ? rest.slice(1) : rest
  if (task.length === 0) die('no task given. Try:  openswarm "explain this repo"')
  const { env } = resolveModel(opts)
  bootDsh('openswarm', [task.join(' ')], env, home)
}

main()
