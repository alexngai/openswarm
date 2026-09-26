/**
 * Read back what each cell actually changed.
 *
 * A pass/fail cannot distinguish the change we asked for from an accident that
 * satisfied the check, and a token count says nothing about how the harness
 * modified itself. This prints the shape of every preserved diff and the tool
 * calls the member made.
 *
 *   node inspect.mjs [cell-substring]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '.eval-runs/artifacts')
if (!existsSync(root)) {
  console.error(`no artifacts at ${root} — run with artifactsDir set`)
  process.exit(1)
}
const filter = process.argv[2]

for (const cell of readdirSync(root).filter((c) => filter === undefined || c.includes(filter))) {
  const dir = join(root, cell)
  const outcome = JSON.parse(readFileSync(join(dir, 'outcome.json'), 'utf8'))
  console.log(`\n━━ ${cell}`)
  console.log(`   accepted=${outcome.accepted} confidences=${JSON.stringify(outcome.confidences)}`)

  const patchPath = join(dir, 'change.patch')
  if (existsSync(patchPath)) {
    const patch = readFileSync(patchPath, 'utf8')
    const files = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1])
    const added = (patch.match(/^\+(?!\+\+)/gm) ?? []).length
    const removed = (patch.match(/^-(?!--)/gm) ?? []).length
    console.log(`   diff: ${files.length} file(s), +${added}/-${removed}`)
    for (const f of files) console.log(`     ${f}`)
  } else {
    console.log('   diff: (none — the run committed nothing)')
  }

  // Tool calls are the trace of HOW it got there.
  const sessions = join(dir, 'sessions')
  if (existsSync(sessions)) {
    const tools = []
    for (const f of readdirSync(sessions)) {
      for (const line of readFileSync(join(sessions, f), 'utf8').split('\n')) {
        if (line.trim() === '') continue
        let e
        try { e = JSON.parse(line) } catch { continue }
        if (e?.type === 'tool/call') tools.push(e.data?.name ?? '?')
      }
    }
    const counts = tools.reduce((acc, t) => ({ ...acc, [t]: (acc[t] ?? 0) + 1 }), {})
    console.log(`   tool calls: ${tools.length} ${JSON.stringify(counts)}`)
  }
}
