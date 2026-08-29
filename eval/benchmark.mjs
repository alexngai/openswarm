/**
 * The C1/C2 task set: changes to this repo, each with SEALED ground truth.
 *
 * `checkpoints` never reach the system under test — `PublicTask` is a `Pick`
 * allowlist, so they are structurally unreachable rather than merely
 * undocumented, and a `cmd` check's `writeFiles` seeds its test into the
 * FINISHED workspace, after the agent is done, in a directory it never saw.
 *
 * ## Roles, and why every check carries a discrimination proof
 *
 * A check that cannot come out both ways measures nothing, so each declares how
 * it is proven to discriminate:
 *
 * - `role: 'progress'` — did the job get done. MUST FAIL at the base commit;
 *   `verifyDiscrimination` runs it there and refuses the task otherwise. This is
 *   SWE-bench's FAIL_TO_PASS.
 * - `role: 'guard'` — was anything broken. MUST PASS at base. Its power to fail
 *   is not proven per task: it inherits that evidence from the mutation run in
 *   [docs/04](../docs/04-gate-discrimination.md), which measured this suite
 *   against injected defects (containment 7/7, cascade logic 6/6, generic 4/5).
 *   Re-proving it per task would mean mutation-testing each one.
 *
 * The roles are the general form, not the SWE-bench shape. A measured check (a
 * threshold crossed at base) or a structural one fits the same contract — the
 * invariant is a mechanical, sealed signal proven to distinguish done from
 * not-done, not any particular pair of buckets.
 *
 * ## What this set cannot see
 *
 * Verifiable feedback selects for verifiable work. The one real self-modification
 * we have achieved — a model improving `swarm_author_plugin`'s description — has
 * no mechanical check, and would be excluded from a set built on this rule.
 * Doc, API-ergonomics and design changes are outside what these numbers speak to.
 */

/** A vitest file, seeded into the finished workspace, that the agent never saw. */
const sealedTest = (path, source) => ({ path, content: source })

/**
 * "Nothing broke" — the PASS_TO_PASS half of ground truth.
 *
 * Retried once on failure, deliberately. This suite has timing-sensitive e2e
 * tests and has now produced two non-reproducing failures in a day: one during
 * the rung-6 work, and one while first proving this very set discriminates. A
 * genuine regression fails both attempts; a flake does not. Without the retry a
 * flaky run scores a CORRECT change as incorrect, which biases the 2×2 toward
 * making the gate look better than it is — the direction we would be least
 * likely to question.
 *
 * The cost is a doubled worst case on real failures. That is the cheaper error.
 */
const GUARD = {
  id: 'suite-still-passes',
  weight: 1,
  role: 'guard',
  check: { type: 'cmd', cmd: 'OPENSWARM_LIVE=0 npm test || OPENSWARM_LIVE=0 npm test' },
}

export const TASKS = [
  {
    id: 'selfmod/launcher-version',
    benchmark: 'openswarm-selfmod',
    difficulty: 'easy',
    prompt: [
      'Add a --version flag to the launcher at bin/openswarm.mjs.',
      'Running `node bin/openswarm.mjs --version` must print the version from',
      "the repository's package.json and exit 0. Today it exits 1 with",
      '"unknown option". Do not change any other behaviour.',
    ].join(' '),
    checkpoints: [
      {
        id: 'prints-version',
        weight: 1,
        role: 'progress',
        check: {
          type: 'cmd',
          cmd: 'test "$(node bin/openswarm.mjs --version)" = "$(node -p \'require("./package.json").version\')"',
        },
      },
      GUARD,
    ],
  },

  {
    id: 'selfmod/slots-counts',
    benchmark: 'openswarm-selfmod',
    difficulty: 'easy',
    prompt: [
      'The Slots class in packages/swarm/src/worktrees.ts tracks concurrency but',
      'exposes no way to observe it. Add two public getters, `active` (slots',
      'currently held) and `queued` (callers waiting), and export nothing else new.',
    ].join(' '),
    checkpoints: [
      {
        id: 'exposes-counts',
        weight: 1,
        role: 'progress',
        check: {
          type: 'cmd',
          cmd: 'npx vitest run sealed/slots.test.ts',
          writeFiles: [
            sealedTest(
              'sealed/slots.test.ts',
              `import { expect, it } from 'vitest'
import { Slots } from '../packages/swarm/src/worktrees'

it('reports held and waiting counts', async () => {
  const slots = new Slots(1)
  await slots.acquire()
  const waiter = slots.acquire()
  expect(slots.active).toBe(1)
  expect(slots.queued).toBe(1)
  slots.release()
  await waiter
  expect(slots.queued).toBe(0)
})
`,
            ),
          ],
        },
      },
      GUARD,
    ],
  },

  {
    id: 'selfmod/digest-tool-calls',
    benchmark: 'openswarm-selfmod',
    difficulty: 'medium',
    prompt: [
      'digestSessionLog in packages/swarm/src/recover.ts folds a dead member\'s',
      'session log into what it was asked and what it reported, but drops the tool',
      'calls, so a restarted member is told the narrative and not the actions.',
      'Add a `tools: string[]` field to SessionDigest holding the name of each',
      "`tool/call` event in order (the name is at `event.data.name`), and include",
      'them in the rendered briefing from renderRecoveryBriefing.',
    ].join(' '),
    checkpoints: [
      {
        id: 'digest-captures-tools',
        weight: 1,
        role: 'progress',
        check: {
          type: 'cmd',
          cmd: 'npx vitest run sealed/digest.test.ts',
          writeFiles: [
            sealedTest(
              'sealed/digest.test.ts',
              `import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { digestSessionLog, renderRecoveryBriefing } from '../packages/swarm/src/recover'

it('captures tool calls and surfaces them in the briefing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'digest-'))
  const log = join(dir, 'session.jsonl')
  writeFileSync(
    log,
    [
      JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: 'do it' }] } }),
      JSON.stringify({ type: 'tool/call', data: { name: 'bash' } }),
      JSON.stringify({ type: 'assistant/message', data: { content: [{ type: 'text', text: 'done' }] } }),
    ].join('\\n'),
  )
  const digest = digestSessionLog(log)
  expect(digest.tools).toEqual(['bash'])
  expect(renderRecoveryBriefing(digest)).toContain('bash')
})
`,
            ),
          ],
        },
      },
      GUARD,
    ],
  },

  {
    id: 'selfmod/restore-reports-kinds',
    benchmark: 'openswarm-selfmod',
    difficulty: 'medium',
    prompt: [
      'SwarmGit.restoreFromBase in packages/git/src/index.ts returns a flat list of',
      'paths it touched, so a caller cannot tell a member EDITING a pinned file from',
      'one ADDING a file under a pinned path — the second is the more suspicious.',
      'Change it to return { modified: string[], added: string[] } instead, and',
      'update the caller in packages/swarm so the progress line still reports a count.',
    ].join(' '),
    checkpoints: [
      {
        id: 'reports-kinds',
        weight: 1,
        role: 'progress',
        check: {
          type: 'cmd',
          cmd: 'npx vitest run sealed/restore.test.ts',
          writeFiles: [
            sealedTest(
              'sealed/restore.test.ts',
              `import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SwarmGit } from '../packages/git/src'

it('separates edited pinned files from added ones', async () => {
  const root = mkdtempSync(join(tmpdir(), 'restore-'))
  const git = (...a: string[]) => execFileSync('git', a, { cwd: root })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(root, 'pinned.txt'), 'original\\n')
  git('add', '.')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')

  const swarm = new SwarmGit({ repoRoot: root, teamId: 'kinds' })
  const wt = await swarm.worktree('task')
  writeFileSync(join(wt.path, 'pinned.txt'), 'edited\\n')
  mkdirSync(join(wt.path, 'extra'), { recursive: true })
  writeFileSync(join(wt.path, 'extra', 'new.txt'), 'added\\n')

  const out = await swarm.restoreFromBase(wt, ['pinned.txt', 'extra'])
  expect(out.modified).toContain('pinned.txt')
  expect(out.added.join(' ')).toContain('new.txt')
  await swarm.removeAll()
  await swarm.dispose()
})
`,
            ),
          ],
        },
      },
      GUARD,
    ],
  },
]

export function selfModBenchmark(tasks = TASKS) {
  return {
    id: 'openswarm-selfmod',
    execution: 'native',
    async load(opts = {}) {
      const ids = opts.taskIds
      const chosen = ids === undefined ? tasks : tasks.filter((t) => ids.includes(t.id))
      return opts.limit === undefined ? chosen : chosen.slice(0, opts.limit)
    },
  }
}

/**
 * Gate-on vs gate-off. Everything else held constant, so a difference between
 * the arms is attributable to the gate — backbone-controlled, in JIT-Agent's
 * sense, applied to our own loop.
 */
export const ARMS = [
  { id: 'gated', label: 'gate on', scaffold: {} },
  { id: 'ungated', label: 'gate off', scaffold: {} },
]
