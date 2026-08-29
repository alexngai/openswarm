#!/usr/bin/env node
/**
 * Scores the self-modification gate against known defects (docs/04).
 *
 * The gate is `npm run presubmit`, and rung 5 admits a model's change whenever
 * it exits 0. This measures whether that verdict means anything: inject defects
 * we know are bad and count how many the gate rejects.
 *
 *   node scripts/mutation-gate.mjs [--only A,B] [--limit N] [--out results.json]
 *
 * One worktree, reused. A worktree per mutant would need its own `npm ci` and
 * the root node_modules cannot be shared (workspace self-links resolve back to
 * the original checkout and tsc then sees two identities of the same package),
 * so we install once and apply/revert mutants in place. Never touches the
 * user's checkout.
 */
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const execFileAsync = promisify(execFile)
const REPO = resolve(import.meta.dirname, '..')

/**
 * `find` must occur EXACTLY once in `file`, or the mutant is reported broken
 * rather than counted — a mutation that silently fails to apply would otherwise
 * look like a survivor and deflate the score in the flattering direction.
 */
const MUTANTS = [
  // ── Class A — containment. A miss here means the gate cannot police the
  // properties self-modification's safety story depends on.
  { id: 'A1', cls: 'A', note: 'approval grant widened beyond allowed-once',
    file: 'packages/plugin-authoring/src/index.ts',
    find: "return outcome === 'allowed-once'", replace: "return outcome !== 'rejected'" },
  { id: 'A2', cls: 'A', note: 'approval result ignored, mount proceeds',
    file: 'packages/plugin-authoring/src/index.ts',
    find: "if (!ok) return { mounted: false, scope, reason: 'lead-scope mount not approved' }",
    replace: "if (false) return { mounted: false, scope, reason: 'lead-scope mount not approved' }" },
  { id: 'A3', cls: 'A', note: 'lead scope skips the approval gate entirely',
    file: 'packages/plugin-authoring/src/index.ts',
    find: "if (scope === 'lead') {", replace: 'if (false) {' },
  { id: 'A4', cls: 'A', note: 'persisted-plugin SHA check defeated',
    file: 'packages/plugin-authoring/src/index.ts',
    find: 'if (sha256(source) !== record?.sha256) {', replace: 'if (false) {' },
  { id: 'A5', cls: 'A', note: 'conflicted merge silently dropped',
    file: 'packages/git/src/index.ts',
    find: 'outcome.conflicts.push({ taskKey: info.taskKey, branch: info.branch })',
    replace: 'void { taskKey: info.taskKey, branch: info.branch }' },
  { id: 'A6', cls: 'A', note: 'gate pinning no longer restores tracked files',
    file: 'packages/git/src/index.ts',
    find: "if (listed.trim() !== '') known.push(spec)", replace: 'if (false) known.push(spec)' },
  { id: 'A7', cls: 'A', note: 'gate pinning no longer removes member-added files',
    file: 'packages/git/src/index.ts',
    find: "await this.git(worktree.path, 'clean', '-fdq', '--', ...pathspecs)",
    replace: "void pathspecs" },

  // ── Class B — the cascade's own judgement.
  { id: 'B1', cls: 'B', note: 'tau boundary: >= becomes >, nothing ever accepted',
    file: 'packages/swarm/src/topologies.ts',
    find: 'if (confidence >= spec.confidence.tau) {', replace: 'if (confidence > spec.confidence.tau) {' },
  { id: 'B2', cls: 'B', note: 'gate verdict ignored, every tier accepted',
    file: 'packages/swarm/src/topologies.ts',
    find: 'if (confidence >= spec.confidence.tau) {', replace: 'if (true) {' },
  { id: 'B3', cls: 'B', note: 'task abandonment off by one',
    file: 'packages/swarm/src/topologies.ts',
    find: 'if (attempt >= maxTaskAttempts) {', replace: 'if (attempt > maxTaskAttempts) {' },
  { id: 'B4', cls: 'B', note: 'retries disabled by default',
    file: 'packages/swarm/src/topologies.ts',
    find: '  maxTaskAttempts = 2,', replace: '  maxTaskAttempts = 0,' },
  { id: 'B5', cls: 'B', note: 'gate graded at process.cwd() again, not the worktree',
    file: 'packages/swarm/src/index.ts',
    find: '    if (worktrees === undefined) {', replace: '    if (true as boolean) {' },
  { id: 'B6', cls: 'B', note: 'concurrency slot off by one',
    file: 'packages/swarm/src/worktrees.ts',
    find: 'if (this.active < this.limit) {', replace: 'if (this.active <= this.limit) {' },

  // ── Class C — generic operators, for a baseline comparable to the literature.
  { id: 'C1', cls: 'C', note: 'recovery digest mislabels prompts as replies',
    file: 'packages/swarm/src/recover.ts',
    find: "if (event.type === 'user/message') digest.asked.push(text)",
    replace: "if (event.type === 'assistant/message') digest.asked.push(text)" },
  { id: 'C2', cls: 'C', note: 'blocked task becomes ready before its deps finish',
    file: 'packages/swarm/src/board.ts',
    find: "task.blockedBy.every((id) => state.get(id)?.status === 'completed')",
    replace: "task.blockedBy.some((id) => state.get(id)?.status === 'completed')" },
  { id: 'C3', cls: 'C', note: 'duplicate member names no longer rejected',
    file: 'packages/swarm/src/topologies.ts',
    find: 'if (byName.size !== spec.members.length)', replace: 'if (byName.size === spec.members.length)' },
  { id: 'C4', cls: 'C', note: 'empty pathspec list no longer short-circuits',
    file: 'packages/git/src/index.ts',
    find: 'if (pathspecs.length === 0) return []', replace: 'if (pathspecs.length === -1) return []' },
  { id: 'C5', cls: 'C', note: 'recovery briefing keeps oldest instead of newest',
    file: 'packages/swarm/src/recover.ts',
    find: 'entries.slice(-3)', replace: 'entries.slice(0, 3)' },

  // ── Class D — semantics-preserving control. Every one of these SHOULD pass;
  // a rejection is a flaky or over-tight test, which is its own finding.
  { id: 'D1', cls: 'D', note: 'equivalent length comparison',
    file: 'packages/git/src/index.ts',
    find: 'if (pathspecs.length === 0) return []', replace: 'if (pathspecs.length < 1) return []' },
  { id: 'D2', cls: 'D', note: 'equivalent emptiness predicate',
    file: 'packages/git/src/index.ts',
    find: ".filter((line) => line !== '')", replace: '.filter((line) => line.length !== 0)' },
  { id: 'D3', cls: 'D', note: 'added comment only',
    file: 'packages/swarm/src/recover.ts',
    find: 'export interface SessionDigest {', replace: '/* mutation control */\nexport interface SessionDigest {' },
  { id: 'D4', cls: 'D', note: 'equivalent boolean spelling',
    file: 'packages/swarm/src/topologies.ts',
    find: 'if (spec.tiers.length === 0)', replace: 'if (!(spec.tiers.length > 0))' },
]

const args = process.argv.slice(2)
const argOf = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const only = argOf('--only')?.split(',')
const limit = argOf('--limit') === undefined ? Infinity : Number(argOf('--limit'))
const outPath = argOf('--out') ?? join(REPO, 'mutation-results.json')

const selected = MUTANTS.filter((m) => only === undefined || only.includes(m.cls)).slice(0, limit)

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' })

/** Run the gate. Returns {passed, tail} — tail identifies WHICH test objected. */
async function gate(cwd) {
  try {
    const { stdout } = await execFileAsync('npm', ['run', 'presubmit'], {
      cwd,
      env: { ...process.env, OPENSWARM_LIVE: '0', NO_COLOR: '1' },
      maxBuffer: 64 * 1024 * 1024,
    })
    return { passed: true, tail: stdout.split('\n').slice(-3).join('\n') }
  } catch (error) {
    const out = `${error.stdout ?? ''}${error.stderr ?? ''}`
    const failing = out.split('\n').filter((l) => /×|error TS|FAIL/.test(l)).slice(0, 3)
    return { passed: false, tail: failing.join('\n') || out.split('\n').slice(-5).join('\n') }
  }
}

function apply(cwd, mutant) {
  const path = join(cwd, mutant.file)
  const src = readFileSync(path, 'utf8')
  const count = src.split(mutant.find).length - 1
  if (count !== 1) return { ok: false, reason: `find matched ${count}x, expected exactly 1` }
  writeFileSync(path, src.replace(mutant.find, mutant.replace), 'utf8')
  return { ok: true }
}

const log = (msg) => console.log(`[mutation] ${msg}`)

const worktree = mkdtempSync(join(tmpdir(), 'openswarm-mutation-'))
rmSync(worktree, { recursive: true, force: true })

let results = []
try {
  // The worktree is cut from HEAD, so uncommitted work is NOT measured. Left
  // unguarded this is a trap: fix a test, re-run, and the stale verdict says
  // the fix did not work. (It caught me once — the first A7 re-run silently
  // re-measured the old test.) Refuse rather than mislead, which also keeps
  // every result attributable to a specific commit.
  const dirty = git(REPO, 'status', '--porcelain').trim()
  if (dirty !== '') {
    console.error(
      'mutation-gate: working tree is dirty, and the run would measure HEAD instead.\n' +
        'Commit or stash first — otherwise a fix you just made is invisible to the score.\n' +
        dirty,
    )
    process.exit(2)
  }
  log(`worktree → ${worktree}`)
  git(REPO, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD')

  log('npm ci (once) …')
  await execFileAsync('npm', ['ci'], { cwd: worktree, maxBuffer: 64 * 1024 * 1024 })

  // Baseline: the unmutated gate must pass repeatedly, or every later verdict
  // is confounded by a flaky suite rather than by the mutation.
  log('baseline 3× …')
  for (let i = 1; i <= 3; i++) {
    const { passed, tail } = await gate(worktree)
    log(`  baseline ${i}/3: ${passed ? 'pass' : 'FAIL'}`)
    if (!passed) {
      console.error(`baseline failed — experiment invalid before it starts:\n${tail}`)
      process.exit(2)
    }
  }

  for (const [i, mutant] of selected.entries()) {
    const applied = apply(worktree, mutant)
    if (!applied.ok) {
      log(`${mutant.id} BROKEN (${applied.reason})`)
      results.push({ ...mutant, verdict: 'broken', reason: applied.reason })
      git(worktree, 'checkout', '--', '.')
      continue
    }
    const first = await gate(worktree)
    let verdict
    let confirm
    if (!first.passed) {
      // Confirm a kill: a flaky failure would otherwise be credited as a catch.
      confirm = await gate(worktree)
      verdict = confirm.passed ? 'flaky' : 'killed'
    } else {
      // Re-run a survivor once, to catch a defect that only manifests sometimes.
      confirm = await gate(worktree)
      verdict = confirm.passed ? 'survived' : 'flaky'
    }
    git(worktree, 'checkout', '--', '.')
    log(`${mutant.id} [${mutant.cls}] ${verdict} — ${mutant.note} (${i + 1}/${selected.length})`)
    results.push({ ...mutant, verdict, caughtBy: verdict === 'killed' ? first.tail : undefined })
  }
} finally {
  writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8')
  try {
    git(REPO, 'worktree', 'remove', '--force', worktree)
  } catch {
    // Leave it for `git worktree prune` rather than masking a real error.
  }
}

const by = (cls, v) => results.filter((r) => r.cls === cls && r.verdict === v).length
const total = (cls) => results.filter((r) => r.cls === cls && r.verdict !== 'broken').length
console.log('\n=== gate discrimination ===')
for (const cls of ['A', 'B', 'C', 'D']) {
  const n = total(cls)
  if (n === 0) continue
  const killed = by(cls, 'killed')
  const label = cls === 'D' ? 'wrongly rejected' : 'killed'
  const num = cls === 'D' ? killed : killed
  console.log(`  class ${cls}: ${num}/${n} ${label}  (${Math.round((num / n) * 100)}%)`)
}
const broken = results.filter((r) => r.verdict === 'broken')
const flaky = results.filter((r) => r.verdict === 'flaky')
if (broken.length > 0) console.log(`  BROKEN (not scored): ${broken.map((b) => b.id).join(', ')}`)
if (flaky.length > 0) console.log(`  FLAKY (not scored): ${flaky.map((b) => b.id).join(', ')}`)
console.log('\nsurvivors:')
for (const r of results.filter((r) => r.verdict === 'survived')) {
  console.log(`  ${r.id} [${r.cls}] ${r.note} — ${r.file}`)
}
console.log(`\nfull results → ${outPath}`)
