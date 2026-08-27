// Probe 2 — worktree isolation (docs/01 §Phase-0, kill criterion).
// Two SDK-driven child harnesses, each launched with cwd = a distinct git
// worktree. The scripted mock LLM makes each child run `pwd; cat MARKER`
// through the real persistent-bash tool; the probe passes when each child's
// tool result shows its own worktree path and marker.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

const here = dirname(fileURLToPath(import.meta.url))
const scratch = join(here, '.scratch')
const childYml = join(here, 'child.cordis.yml')
const runtimeBin = join(here, 'node_modules', '.bin', 'dsh-jsonrpc-agent')

// -- scratch repo with two worktrees ----------------------------------------
rmSync(scratch, { recursive: true, force: true })
const main = join(scratch, 'main')
mkdirSync(main, { recursive: true })
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString()
git(main, 'init', '-q', '-b', 'main')
writeFileSync(join(main, 'README.md'), 'scratch\n')
git(main, 'add', '.')
git(main, '-c', 'user.email=probe@spike', '-c', 'user.name=probe', 'commit', '-qm', 'init')
const worktrees = ['wt-a', 'wt-b'].map((name) => {
  const path = join(scratch, name)
  git(main, 'worktree', 'add', '-q', '-b', name, path)
  writeFileSync(join(path, 'MARKER'), `marker-of-${name}\n`)
  return { name, path }
})

// -- drive one child per worktree, sequentially -----------------------------
const failures = []
for (const wt of worktrees) {
  const mock = await startMockLlmServer({
    apiKey: 'mock-key',
    sequence: ['tool_call_success', 'success'],
    toolName: 'bash',
    toolArguments: JSON.stringify({ command: 'pwd; cat MARKER' }),
    successText: 'probe done',
  })
  const base = mock.baseURL.endsWith('/v1') ? mock.baseURL : `${mock.baseURL}/v1`
  console.log(`[${wt.name}] mock LLM at ${base}`)
  let harness
  try {
    harness = new DeepSeekHarness({
      launch: {
        command: process.execPath,
        args: [runtimeBin, childYml],
        cwd: wt.path,
        env: {
          ...process.env,
          DEEPSEEK_BASE_URL: base,
          DEEPSEEK_API_KEY: 'mock-key',
          DSH_MODEL: 'mock-model',
        },
      },
      cwd: wt.path,
      provider: 'deepseek-official',
      model: 'mock-model',
    })
    const result = await harness.run('probe')
    const toolResults = result.events.filter((e) => e.type === 'tool/result')
    const text = JSON.stringify(toolResults)
    const sawPath = text.includes(wt.path)
    const sawMarker = text.includes(`marker-of-${wt.name}`)
    console.log(`[${wt.name}] final: ${result.finalResponse}`)
    console.log(`[${wt.name}] pwd in tool result: ${sawPath}, marker: ${sawMarker}`)
    if (!sawPath || !sawMarker) {
      failures.push(wt.name)
      console.log(`[${wt.name}] tool results were: ${text.slice(0, 2000)}`)
    }
  } finally {
    await harness?.close()
    await mock.close()
  }
}

if (failures.length > 0) {
  console.error(`PROBE 2 FAIL: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('PROBE 2 PASS: each child harness rooted in its own worktree')
