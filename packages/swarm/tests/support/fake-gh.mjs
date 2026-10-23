#!/usr/bin/env node
/**
 * A stand-in for the `gh` CLI's pull-request verbs, for keyless forge tests
 * (docs/05 D4). `pr create` prints a new pull request's URL (numbered from 1,
 * kept in FAKE_GH_DIR); `pr merge` accepts; `pr view <n> --json …` prints the
 * state FAKE_GH_DIR/state.json gives that number (default OPEN). Every call's
 * argv, and a created pull request's body, are appended to FAKE_GH_DIR/log.jsonl.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.env.FAKE_GH_DIR
const argv = process.argv.slice(2)
const entry = { argv }
if (argv[0] === 'pr' && argv[1] === 'create') {
  const counter = join(dir, 'counter')
  const n = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1
  writeFileSync(counter, String(n))
  entry.body = readFileSync(argv[argv.indexOf('--body-file') + 1], 'utf8')
  appendFileSync(join(dir, 'log.jsonl'), `${JSON.stringify(entry)}\n`)
  process.stdout.write(`https://github.com/owner/repo/pull/${n}\n`)
} else if (argv[0] === 'pr' && argv[1] === 'merge') {
  appendFileSync(join(dir, 'log.jsonl'), `${JSON.stringify(entry)}\n`)
} else if (argv[0] === 'pr' && argv[1] === 'view') {
  const states = existsSync(join(dir, 'state.json')) ? JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) : {}
  const state = states[argv[2]] ?? 'OPEN'
  process.stdout.write(JSON.stringify({ state, mergeCommit: state === 'MERGED' ? { oid: `merge${argv[2]}`.padEnd(40, '0') } : null }))
} else {
  process.stderr.write(`fake gh: unsupported ${argv.join(' ')}\n`)
  process.exit(1)
}
