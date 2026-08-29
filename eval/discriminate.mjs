/**
 * Prove every sealed check can come out both ways, before spending anything.
 *
 * A check that cannot distinguish done from not-done measures nothing, and it
 * fails silently — it just reports a number that was never in question. This is
 * the general form of the "must fail at base" rule: `progress` checks are proven
 * against the base commit, `guard` checks are proven to hold there and inherit
 * their power to FAIL from the mutation run in docs/04, which measured this
 * suite against injected defects rather than assuming it was sensitive.
 *
 * The base tree is materialized exactly the way a graded tree is — same archive,
 * same dependencies, same build. A check proven against a differently-built tree
 * proves nothing about the one it will actually run on.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { materialize } from './adapter.mjs'

/** Run one check in `dir` exactly as the grader would, seeding its sealed files first. */
function runCheck(dir, check) {
  for (const file of check.writeFiles ?? []) {
    const target = join(dir, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.content, 'utf8')
  }
  try {
    execFileSync('bash', ['-c', check.cmd], {
      cwd: dir,
      stdio: 'pipe',
      timeout: 900_000,
      maxBuffer: 64 * 1024 * 1024,
    })
    return { passed: true }
  } catch (error) {
    // Keep the tail. A bare pass/fail here is unactionable in exactly the way
    // the cascade's bare `confidence 0` was: it says a check disagreed without
    // saying what it saw, which is the difference between a finding and a shrug.
    const out = `${error?.stdout ?? ''}${error?.stderr ?? ''}`
    return {
      passed: false,
      detail: out.length > 2_000 ? out.slice(-2_000) : out,
      signal: error?.signal,
      status: error?.status,
    }
  }
}

/**
 * @returns the per-check findings; throws on the first check that cannot discriminate.
 */
export function verifyDiscrimination(tasks, repoRoot, { onProgress = () => {} } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'openswarm-base-'))
  onProgress(`materializing base at HEAD → ${base}`)
  materialize(repoRoot, 'HEAD', base)

  const findings = []
  // Tasks share the guard check; running the full suite once per task would
  // multiply the cost of the slowest check by the size of the set.
  const seen = new Map()
  try {
    for (const task of tasks) {
      for (const cp of task.checkpoints ?? []) {
        if (cp.check.type !== 'cmd') continue
        const key = JSON.stringify([cp.check.cmd, cp.check.writeFiles ?? []])
        if (!seen.has(key)) seen.set(key, runCheck(base, cp.check))
        const outcome = seen.get(key)
        const role = cp.role ?? 'progress'
        const ok = role === 'progress' ? !outcome.passed : outcome.passed
        findings.push({ task: task.id, check: cp.id, role, passedAtBase: outcome.passed, ok })
        onProgress(
          `  ${ok ? '✓' : '✗'} ${task.id}/${cp.id} [${role}] ` +
            `${outcome.passed ? 'passes' : 'fails'} at base` +
            (outcome.signal ? ` (killed: ${outcome.signal})` : ''),
        )
        if (!ok) {
          const why =
            role === 'progress'
              ? `${task.id}/${cp.id} ALREADY PASSES at base — it cannot tell a real change from a no-op`
              : `${task.id}/${cp.id} FAILS at base — a guard must hold before the change, or every run is scored against a broken baseline`
          throw new Error(
            `${why}\n  command: ${cp.check.cmd}\n  exit: ${outcome.status ?? '?'}` +
              `${outcome.signal ? ` signal: ${outcome.signal}` : ''}\n${outcome.detail ?? '(no output captured)'}`,
          )
        }
      }
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
  return findings
}
