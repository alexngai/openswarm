// Smoke the headless eval surface against the REAL profile.
//
//   source ~/.zshrc && node scripts/smoke-headless.mjs
//
// Covers what changed when `run --output-format json` stopped hand-mounting its
// own context and started booting `--profile openswarm`:
//
//   A  the JSONL contract, parsed the way swarmkit-eval parses it
//   B  budget caps, which MOVED into the reporter plugin and had only unit tests
//   C  the interactive path stays clean (the profile is shared; an always-on
//      reporter would spray JSONL into a human's terminal)
//   D  the tool surface is the profile's, not the old minimal stack's
//
// Live and keyed: this exercises the composition that unit tests cannot, which
// is the whole reason the harness-identity bug survived so long.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const BIN = resolve(import.meta.dirname, '..', 'bin', 'openswarm.mjs')
const HOME = process.env.OPENSWARM_HOME ?? '/tmp/os-smoke-home'

for (const k of ['AZURE_API_BASE', 'AZURE_API_KEY']) {
  if (!process.env[k]) { console.error(`missing ${k} — source ~/.zshrc`); process.exit(2) }
}

/** Verbatim port of swarmkit-eval's `openSwarmParse` (cli-adapter.ts:379). */
function openSwarmParse(stdout) {
  let output = '', isError = false, sawResult = false
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
  const trajectory = []
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    let o; try { o = JSON.parse(t) } catch { continue }
    if (o.type === 'text_delta' && typeof o.text === 'string') output += o.text
    else if (o.type === 'tool_use_start') trajectory.push(o.name ?? 'tool')
    else if (o.type === 'error') isError = true
    else if (o.type === 'message_stop') {
      sawResult = true
      usage.inputTokens += o.usage?.inputTokens ?? 0
      usage.outputTokens += o.usage?.outputTokens ?? 0
      usage.cacheReadTokens += o.usage?.cacheReadInputTokens ?? 0
    }
  }
  usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens
  return { output, usage, trajectory, isError, sawResult, raw: stdout }
}

function run(args, cwd) {
  try {
    const stdout = execFileSync('node', [BIN, ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OPENSWARM_HOME: HOME },
      timeout: 600_000,
    })
    return { code: 0, stdout }
  } catch (e) {
    return { code: e.status ?? -1, stdout: e.stdout ?? '' }
  }
}

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n    ${detail}`}`)
}

// ── A: the JSONL contract, end to end ────────────────────────────────────────
{
  const ws = mkdtempSync(join(tmpdir(), 'os-smoke-'))
  const r = run(['run', '--output-format', 'json', '--max-turns', '8', 'create smoke.txt containing exactly OK, then stop'], ws)
  const p = openSwarmParse(r.stdout)
  check('A1 exit 0', r.code === 0, `exit ${r.code}`)
  check('A2 file written', existsSync(join(ws, 'smoke.txt')) && readFileSync(join(ws, 'smoke.txt'), 'utf8').includes('OK'))
  check('A3 parser sees a result', p.sawResult, p.raw.slice(0, 200))
  check('A4 no error line', !p.isError)
  // Zero usage means no model call was billed — the signature of a harness that
  // died before reaching a model, which grades as a cheap task failure.
  check('A5 usage is real', p.usage.totalTokens > 0, JSON.stringify(p.usage))
  check('A6 tool trajectory captured', p.trajectory.length > 0, JSON.stringify(p.trajectory))
  // D: the profile's own editing tool, absent from the retired minimal stack.
  check('D1 profile tool surface', p.trajectory.some((t) => t !== 'bash'), JSON.stringify(p.trajectory))
}

// ── B: budget caps (moved into the reporter; previously unit-tested only) ─────
{
  const ws = mkdtempSync(join(tmpdir(), 'os-smoke-'))
  const r = run(['run', '--output-format', 'json', '--max-turns', '1', 'list every file under this directory one at a time, then summarise'], ws)
  const p = openSwarmParse(r.stdout)
  check('B1 exit 3 on cap', r.code === 3, `exit ${r.code}`)
  check('B2 budget_exceeded emitted', r.stdout.includes('budget_exceeded'))
  // Load-bearing: openSwarmParse sets sawResult from message_stop ALONE, so a
  // capped run that omitted it is indistinguishable from a crash.
  check('B3 capped run still reports a result', p.sawResult)
  check('B4 capped run reports spent usage', p.usage.totalTokens > 0, JSON.stringify(p.usage))
}

// ── B5: an unenforceable cap is refused, not ignored ─────────────────────────
{
  const ws = mkdtempSync(join(tmpdir(), 'os-smoke-'))
  const r = run(['run', '--output-format', 'json', '--max-cost-usd', '5', 'hi'], ws)
  check('B5 --max-cost-usd refused', r.code !== 0, `exit ${r.code}`)
}

// ── C: the interactive path stays free of JSONL ──────────────────────────────
{
  const ws = mkdtempSync(join(tmpdir(), 'os-smoke-'))
  const r = run(['run', 'say the word ready and stop'], ws)
  const jsonl = r.stdout.split('\n').some((l) => l.trim().startsWith('{"type":"message_stop"'))
  check('C1 no JSONL without --output-format', !jsonl, r.stdout.slice(0, 200))
}

console.log(failures === 0 ? '\nall smokes passed' : `\n${failures} smoke check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
