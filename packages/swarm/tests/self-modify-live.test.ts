/**
 * Rung 5, live: OpenSwarm edits ITS OWN source in a worktree, is gated on this
 * repo's real `npm run presubmit`, and merges only if that gate passes.
 *
 * The task is a genuine item from our own deferred-work ledger, and one a live
 * model found the hard way: `swarm_author_plugin` tells an authoring model to
 * call `defineTool({...})` without mentioning that `output` (with `schema` AND
 * `render`) is mandatory, or that `parameters` is a flat record rather than a
 * JSON-Schema object. Live gpt-5.5 wrote the plausible-but-wrong shape and had
 * its mount refused with an unhandled destructure.
 *
 * Two tiers, same model — the second is NOT staged to rescue a crippled first.
 * If tier 1's edit passes presubmit the cascade accepts there and tier 2 never
 * runs; if it breaks the build, the gate's rejection threads into tier 2 as
 * feedback. Either outcome is a real result.
 *
 * The gate leads with `npm ci` deliberately: a git worktree is gitignore-clean,
 * so without it every tier scores 0 on ERR_MODULE_NOT_FOUND no matter how good
 * the work was (docs/01, docs/03).
 *
 * It also scrubs OPENSWARM_LIVE, which is NOT cosmetic. The confidence runner
 * shells out without an `env`, so the gate inherits this process's environment
 * — including the very flag that enables live tests. The gate's `npm test`
 * would therefore re-run the live suite inside the worktree, THIS test
 * included, where it fails its own clean-checkout guard because the worktree is
 * legitimately dirty. That scored a correct tier-1 edit as 0 on the first
 * attempt: a false negative caused entirely by the harness observing itself.
 *
 *   source ~/.zshrc && OPENSWARM_LIVE=1 npx vitest run \
 *     packages/swarm/tests/self-modify-live.test.ts
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import * as OpenAiChat from '../../llm-openai/src/index'
import { bootHarness, type TestHarness } from './boot'

const MODEL = process.env['OPENSWARM_LIVE_MODEL'] ?? 'gpt-5.5'
const live =
  process.env['OPENSWARM_LIVE'] === '1' &&
  process.env['AZURE_API_BASE'] !== undefined &&
  process.env['AZURE_API_KEY'] !== undefined

const azureBase = () => `${(process.env['AZURE_API_BASE'] ?? '').replace(/\/+$/, '')}/openai/v1`

/** This repository — the thing being modified. */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

function azurePlugin() {
  return {
    module: OpenAiChat,
    config: {
      routes: ['openai'],
      baseURL: azureBase(),
      apiKeyEnv: 'AZURE_API_KEY',
      models: [{ id: MODEL, contextWindow: 200_000 }],
    },
    provider: 'openai',
    model: MODEL,
  }
}

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

const TASK = `You are working inside a git worktree of the OpenSwarm repository.

Edit packages/plugin-authoring/src/index.ts. The \`swarm_author_plugin\` tool
describes its \`source\` parameter to the authoring model, but that description
is incomplete, and models get it wrong as a result. Rewrite that description
string so it states explicitly that:

  1. \`output\` is REQUIRED, and must contain both \`schema\` and \`render\`.
  2. \`parameters\` is a flat record mapping each parameter name to its spec,
     e.g. { text: { type: 'string', required: true, description: '...' } } —
     it is NOT a JSON-Schema object with type/properties.

Change only that description string. Do not change any behaviour, and do not
touch any other file.

Before you finish, run \`npm ci\` and then \`OPENSWARM_LIVE=0 npm run presubmit\`
and make sure it passes. Use OPENSWARM_LIVE=0 exactly as written — without it
the suite also runs env-gated live tests that need credentials and a clean
checkout, which will fail here for reasons unrelated to your change.`

it.skipIf(!live)(
  'live: OpenSwarm edits its own source, passes its own presubmit, and merges',
  async () => {
    // Never run against a dirty checkout: the worktree is cut from HEAD, so
    // uncommitted work would silently not be part of what the gate grades.
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: REPO }).toString()
    expect(dirty, 'commit or stash before a live self-modification run').toBe('')
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO }).toString().trim()

    h = await bootHarness({ sequence: ['success'], successText: 'unused' }, undefined, azurePlugin())

    const progress: string[] = []
    const result = await h.swarm.runTeam(
      {
        topology: 'cascade',
        tiers: [{ name: 'tier-1' }, { name: 'tier-2' }],
        task: TASK,
        confidence: {
          commands: ['npm ci', 'OPENSWARM_LIVE=0 npm run presubmit'],
          tau: 1,
        },
      },
      {
        parent: h.lead.agent,
        onProgress: (line) => {
          progress.push(line)
          console.log(`[swarm] ${line}`)
        },
        // The gate runs this repo's own suite out of the member's worktree, so
        // without pinning "make presubmit pass" is satisfiable by editing the
        // tests. Graded against the suite as committed, not as edited.
        // Literal directories: git matches pathspec wildcards against WHOLE
        // paths, so 'packages/*/tests' matches nothing and pins nothing.
        confidencePinPaths: readdirSync(join(REPO, 'packages'))
          .map((pkg) => join('packages', pkg, 'tests'))
          .filter((rel) => existsSync(join(REPO, rel))),
        worktrees: {
          repoRoot: REPO,
          member: {
            model: MODEL,
            env: {
              OPENSWARM_LLM_BASE_URL: azureBase(),
              OPENSWARM_LLM_API_KEY: process.env['AZURE_API_KEY']!,
              DSH_MODEL: MODEL,
            },
          },
        },
      },
    )

    if (result.topology !== 'cascade') throw new Error('wrong topology')
    console.log('attempts:', JSON.stringify(result.attempts.map((a) => ({ tier: a.tier, confidence: a.confidence }))))

    // The gate ran this repo's real build+typecheck+test against the edit.
    expect(result.attempts.length).toBeGreaterThan(0)
    expect(result.accepted).toBe(true)

    // The accepted work is on the integration branch, and it is a real edit to
    // the file we named.
    const git = result.git!
    expect(git.conflicts).toEqual([])
    expect(git.merged.length).toBeGreaterThan(0)
    const merged = execFileSync(
      'git',
      ['show', `${git.targetBranch}:packages/plugin-authoring/src/index.ts`],
      { cwd: REPO, maxBuffer: 16 * 1024 * 1024 },
    ).toString()
    expect(merged).toContain('render')
    expect(merged).not.toBe(
      execFileSync('git', ['show', `${headBefore}:packages/plugin-authoring/src/index.ts`], {
        cwd: REPO,
        maxBuffer: 16 * 1024 * 1024,
      }).toString(),
    )

    // Our own checkout was never touched — the whole point of the worktree.
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: REPO }).toString()).toBe('')
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO }).toString().trim()).toBe(headBefore)

    console.log(`merged into ${git.targetBranch}`)
  },
  1_800_000,
)
