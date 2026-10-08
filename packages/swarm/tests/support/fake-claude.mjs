#!/usr/bin/env node
/**
 * A stand-in for the `claude` CLI in headless mode (`-p --output-format
 * stream-json --verbose`), for keyless claude-code member tests (docs/05 R1).
 * It reads the prompt on stdin and streams what the real CLI does: a
 * `system/init` message, assistant messages carrying usage, and a final
 * `result` with usage and `total_cost_usd`. The prompt picks the behaviour:
 *
 *   FAKE_HANG       start two `sleep`s, one in its process group and one in a
 *                   session of its own (as Claude Code starts its Bash tool), then
 *                   wait for a signal; SIGTERM ends it
 *   FAKE_FAIL       report an error result and exit 1
 *   FAKE_MAX_TURNS  report `error_max_turns`
 *   FAKE_GARBAGE    interleave malformed lines, then succeed with a result line
 *                   that has no trailing newline
 *   FAKE_CRASH      stream an assistant message, then exit 2 without a result
 *   FAKE_LINGER     succeed, then never exit
 *   otherwise       write claude-out.txt in its cwd ("broken" the first time,
 *                   "fixed" when it is already there, as a repair finds it), then succeed
 *
 * `--version` prints a version and exits, as the run's preflight expects.
 * With FAKE_CLAUDE_LOG set, it appends one JSON line per event (a version
 * call; its start: pid, argv, cwd, prompt, and the credential-shaped or
 * launcher-route variables it inherited; the sleeps' pids; a SIGTERM) to that file.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const log = (entry) => process.env.FAKE_CLAUDE_LOG && appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(entry)}\n`)
const emit = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)

const argv = process.argv.slice(2)
if (argv.includes('--version')) {
  log({ event: 'version' })
  process.stdout.write('0.0.0-fake (Claude Code)\n')
  process.exit(0)
}
const prompt = readFileSync(0, 'utf8')
const at = argv.indexOf('--model')
const model = at === -1 ? 'claude-fake-1' : argv[at + 1]
const session_id = `fake-${process.pid}`
const secrets = Object.keys(process.env).filter((k) => /KEY|PASSWORD|SECRET|TOKEN|^(OPENSWARM_|DSH_|DEEPSEEK_|OPENAI_|AZURE_API_)/i.test(k)).sort()
log({ event: 'start', pid: process.pid, argv, cwd: process.cwd(), prompt, secrets })
const success = (text, usage) => ({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: text, session_id, total_cost_usd: 0.0421, usage })
const USAGE = { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 500, cache_creation_input_tokens: 200 }

emit({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id, model, tools: ['Edit', 'Write', 'Bash'], permissionMode: 'acceptEdits' })

if (prompt.includes('FAKE_HANG')) {
  const grandchild = spawn('sleep', ['60'], { stdio: 'ignore' })
  const detached = spawn('sleep', ['60'], { stdio: 'ignore', detached: true })
  log({ event: 'grandchild', pid: grandchild.pid, detached: detached.pid })
  process.on('SIGTERM', () => {
    log({ event: 'sigterm' })
    process.exit(143)
  })
  emit({ type: 'assistant', session_id, message: { id: 'msg_1', model, role: 'assistant', content: [{ type: 'text', text: 'working' }], usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
  setInterval(() => {}, 1_000)
} else if (prompt.includes('FAKE_FAIL')) {
  process.stderr.write('fake: the model endpoint refused\n')
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, session_id, total_cost_usd: 0.001, usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, errors: ['API Error: 529 overloaded'] })
  process.exitCode = 1
} else if (prompt.includes('FAKE_MAX_TURNS')) {
  emit({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 3, session_id, total_cost_usd: 0.01, usage: USAGE })
} else if (prompt.includes('FAKE_GARBAGE')) {
  process.stdout.write('not json at all\n{"type": "assistant", "message": {"id": "msg_1", "usa\nnull\n42\n{"type":"mystery"}\n\n')
  process.stdout.write(JSON.stringify(success('survived', USAGE)))
} else if (prompt.includes('FAKE_CRASH')) {
  emit({ type: 'assistant', session_id, message: { id: 'msg_1', model, role: 'assistant', content: [{ type: 'text', text: 'about to' }], usage: { input_tokens: 9, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
  process.stderr.write('fake: segfault\n')
  process.exitCode = 2
} else if (prompt.includes('FAKE_LINGER')) {
  emit(success('done, lingering', USAGE))
  setInterval(() => {}, 1_000)
} else {
  const usage = USAGE
  emit({ type: 'assistant', session_id, message: { id: 'msg_1', model, role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Write', input: { file_path: 'claude-out.txt' } }], usage } })
  const file = join(process.cwd(), 'claude-out.txt')
  writeFileSync(file, existsSync(file) ? 'fixed\n' : 'broken\n')
  emit({ type: 'user', session_id, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] } })
  emit({ type: 'assistant', session_id, message: { id: 'msg_2', model, role: 'assistant', content: [{ type: 'text', text: 'wrote claude-out.txt' }], usage } })
  emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: 'wrote claude-out.txt', session_id, total_cost_usd: 0.0421, usage, modelUsage: { [model]: { inputTokens: 12, outputTokens: 34, costUSD: 0.0421 } } })
}
