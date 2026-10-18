#!/usr/bin/env node
/**
 * A stand-in for `codex exec --json` (codex-rs 0.144 `exec/src/exec_events.rs`),
 * for keyless codex member tests (docs/05 R2). It reads the prompt on stdin
 * and streams what the real CLI does: `thread.started`, `turn.started`,
 * items, then `turn.completed` with the thread's usage. The prompt picks the
 * behaviour:
 *
 *   FAKE_HANG    start two `sleep`s, one in its process group and one in a
 *                session of its own (as Codex starts its shell tool), then wait;
 *                SIGINT ends it without a final event, as Codex's does
 *   FAKE_FAIL    report `error` and `turn.failed`, exit 1
 *   FAKE_CRASH   start a turn, then exit 2 without ending it
 *   otherwise    write codex-out.txt in its cwd, then complete
 *
 * `--version` prints a version and exits. With FAKE_CODEX_LOG set, it appends
 * one JSON line per event (a version call; its start: pid, argv, cwd, prompt,
 * and the credential-shaped or launcher-route variables it inherited; the
 * sleeps' pids; a SIGINT) to that file.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const log = (entry) => process.env.FAKE_CODEX_LOG && appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify(entry)}\n`)
const emit = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)

const argv = process.argv.slice(2)
if (argv.includes('--version')) {
  log({ event: 'version' })
  process.stdout.write('codex-cli 0.0.0-fake\n')
  process.exit(0)
}
const prompt = readFileSync(0, 'utf8')
const cwd = argv[argv.indexOf('-C') + 1] ?? process.cwd()
const secrets = Object.keys(process.env).filter((k) => /KEY|PASSWORD|SECRET|TOKEN|^(OPENSWARM_|DSH_|DEEPSEEK_|OPENAI_|AZURE_API_)/i.test(k)).sort()
log({ event: 'start', pid: process.pid, argv, cwd: process.cwd(), prompt, secrets })
const USAGE = { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 80, reasoning_output_tokens: 30 }

emit({ type: 'thread.started', thread_id: `fake-thread-${process.pid}` })
emit({ type: 'turn.started' })

if (prompt.includes('FAKE_HANG')) {
  const grandchild = spawn('sleep', ['60'], { stdio: 'ignore' })
  const detached = spawn('sleep', ['60'], { stdio: 'ignore', detached: true })
  log({ event: 'grandchild', pid: grandchild.pid, detached: detached.pid })
  process.on('SIGINT', () => {
    log({ event: 'sigint' })
    process.exit(1)
  })
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'thinking' } })
  setInterval(() => {}, 1_000)
} else if (prompt.includes('FAKE_FAIL')) {
  emit({ type: 'error', message: 'unexpected status 401 Unauthorized' })
  emit({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized' } })
  process.exit(1)
} else if (prompt.includes('FAKE_CRASH')) {
  process.stderr.write('codex: panicked\n')
  process.exit(2)
} else {
  writeFileSync(join(cwd, 'codex-out.txt'), 'done\n')
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'echo done > codex-out.txt', aggregated_output: '', exit_code: 0, status: 'completed' } })
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'first thought' } })
  emit({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'wrote codex-out.txt' } })
  emit({ type: 'turn.completed', usage: USAGE })
}
