/**
 * The system under test: OpenSwarm's self-modification loop.
 *
 * One cell = give a cascade a change to make in a checkout of this repo, let
 * the command gate judge it, and hand the resulting branch to the grader. The
 * arm decides whether the gate is present at all, which is the contrast C1/C2
 * exists to measure — a gate that never rejects and no gate at all should be
 * distinguishable.
 *
 * `placement: "backend"`, and the reason is not cosmetic. `CheckpointGrader`
 * grades the provisioned `Workspace` — `passed: workspace ? runCheck(...) : false`
 * — NOT `RawRun.workdir`. A self-placing adapter therefore scores every
 * checkpoint `false` no matter what the agent produced, silently, because the
 * grader has nothing to grade. (This adapter did exactly that until the uniform
 * zero across both arms stopped looking like a result and started looking like a
 * bug.)
 *
 * So the cascade still runs in a worktree WE provision — `InProcessBackend`
 * seeds `setup.files` but neither clones `setup.repo` nor runs `initCommands` —
 * and the resulting tree is then exported into the backend's workspace, where
 * the sealed checkpoints run against it.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })

/**
 * A worktree at `ref` with `node_modules` hardlinked in.
 *
 * `cp -al` rather than a symlink, and the distinction is load-bearing:
 * symlinking the node_modules DIRECTORY leaves `openswarm-*` (relative symlinks
 * to ../packages/*) re-anchoring to the ORIGINAL checkout, so tsc sees two
 * identities of the same package and fails. A hardlink copy makes the directory
 * real, so those relative links resolve locally. ~12s and no extra disk, versus
 * ~60s and 380MB for `npm ci`.
 */
function provision(repoRoot, ref, label) {
  const dir = mkdtempSync(join(tmpdir(), `openswarm-cell-${label}-`))
  rmSync(dir, { recursive: true, force: true })
  git(repoRoot, 'worktree', 'add', '-q', '--detach', dir, ref)
  execFileSync('cp', ['-al', join(repoRoot, 'node_modules'), join(dir, 'node_modules')])
  return dir
}

/**
 * Make `dest` a USABLE checkout of `ref`, not just its source.
 *
 * `git archive` exports tracked files only, so a bare export has no
 * `node_modules` and no `packages/*[/]dist` (both gitignored) — every check that
 * imports our built code would fail for want of a build rather than for want of
 * a correct change. Sealed checks are therefore given the same thing a developer
 * would have: source, dependencies, and a fresh build.
 *
 * Exported here rather than inlined because the discrimination guard has to
 * materialize the BASE commit exactly the same way; a check proven against a
 * differently-built tree proves nothing about the graded one.
 */
export function materialize(repoRoot, ref, dest) {
  execFileSync('bash', ['-c', `git archive ${ref} | tar -x -C ${JSON.stringify(dest)}`], {
    cwd: repoRoot,
  })
  execFileSync('cp', ['-al', join(repoRoot, 'node_modules'), join(dest, 'node_modules')])
  execFileSync('npm', ['run', 'build'], { cwd: dest, stdio: 'ignore' })
}

function release(repoRoot, dir) {
  try {
    git(repoRoot, 'worktree', 'remove', '--force', dir)
  } catch {
    rmSync(dir, { recursive: true, force: true })
    try {
      git(repoRoot, 'worktree', 'prune')
    } catch {
      // Best effort — a stale entry is swept by the next run.
    }
  }
}

/**
 * @param opts.repoRoot  repo the cascade edits (this one)
 * @param opts.boot      () => harness (mock for validation, live for real runs)
 * @param opts.gate      commands the gated arm runs, and the paths it pins
 */
export function makeSelfModAdapter({ repoRoot, boot, gate }) {
  /**
   * Swarm branches created across the matrix, reclaimed by `cleanup()`. They
   * must outlive `run()`: the tree is exported from the branch into the
   * workspace, and the core grades that workspace after the adapter returns.
   */
  const branches = []

  return {
    /** Reclaim swarm branches. Call after `runEval` resolves. */
    cleanup() {
      for (const branch of branches.splice(0)) {
        try {
          git(repoRoot, 'branch', '-D', branch)
        } catch {
          // Already gone, or never created — nothing to reclaim.
        }
      }
    },
    id: 'openswarm-selfmod',
    placement: 'backend',
    // Result-affecting knobs that live outside EvalConfig, so a changed gate
    // re-keys exactly its dependent cells instead of silently reusing them.
    contentHash: { commands: gate.commands, pinPaths: gate.pinPaths, tiers: gate.tiers ?? 1 },

    async run(cell, ctx) {
      const started = Date.now()
      const gated = cell.arm.id !== 'ungated'
      const base = git(repoRoot, 'rev-parse', 'HEAD').trim()
      const work = provision(repoRoot, base, cell.task.id.replace(/[^A-Za-z0-9]/g, '-'))
      let grading
      let harness

      try {
        harness = await boot()
        const tiers = Array.from({ length: gate.tiers ?? 1 }, (_, i) => ({ name: `tier-${i + 1}` }))
        const result = await harness.swarm.runTeam(
          {
            topology: 'cascade',
            tiers,
            task: cell.task.prompt,
            // The ungated arm carries no confidence gate at all, so the cascade
            // accepts its first completed tier — "what would have merged with
            // nobody checking".
            ...(gated ? { confidence: { commands: gate.commands, tau: 1 } } : {}),
          },
          {
            parent: harness.lead.agent,
            signal: ctx.signal,
            ...(gated && gate.pinPaths ? { confidencePinPaths: gate.pinPaths } : {}),
            worktrees: { repoRoot: work, member: { env: harness.memberEnv } },
            onProgress: (line) => ctx.trace?.emit?.({ type: 'progress', line }),
          },
        )

        // Grade whatever the run actually produced: the integration branch when
        // it merged, the withheld task branch when the gate refused it. Grading
        // only the merged case would score the gated arm on a strict subset of
        // its runs and flatter it.
        const merged = result.git?.merged?.[0]
        const withheld = result.git?.withheld?.[0]
        const branch = merged?.branch ?? withheld?.branch
        // Every branch this run created, not just the graded one: each team also
        // cuts an integration branch, and tracking only the task branch left
        // those accumulating in the repo one per cell.
        for (const b of [
          result.git?.targetBranch,
          ...(result.git?.merged ?? []).map((m) => m.branch),
          ...(result.git?.withheld ?? []).map((m) => m.branch),
          ...(result.git?.empty ?? []).map((m) => m.branch),
          ...(result.git?.conflicts ?? []).map((m) => m.branch),
        ]) {
          if (b !== undefined && !branches.includes(b)) branches.push(b)
        }

        if (branch !== undefined && ctx.workspace !== undefined) {
          // Export the branch's tree into the workspace the grader will read.
          // `git archive` rather than a checkout: it writes files without
          // touching an index or needing the workspace to be a git dir at all.
          materialize(repoRoot, branch, ctx.workspace.root)
          grading = ctx.workspace.root
        }

        return {
          output: result.final?.text ?? '',
          workdir: grading,
          usage: harness.usage(),
          trajectory: [],
          durationMs: Date.now() - started,
          metadata: {
            accepted: result.accepted === true,
            tier: result.tier,
            confidences: (result.attempts ?? []).map((a) => a.confidence),
            // Present only when a command gate rejected a tier — this is what
            // makes a rejection attributable rather than a bare 0.
            failures: (result.attempts ?? [])
              .map((a) => a.failure?.command)
              .filter((c) => c !== undefined),
            merged: result.git?.merged?.length ?? 0,
            withheld: result.git?.withheld?.length ?? 0,
            gradedBranch: branch,
          },
        }
      } catch (error) {
        // Infrastructure faults must not be scored as task failures — that is
        // what `envError` is for; the core excludes and retries them.
        return {
          output: '',
          usage: harness?.usage?.() ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          trajectory: [],
          durationMs: Date.now() - started,
          envError: { kind: 'adapter', message: String(error?.message ?? error) },
        }
      } finally {
        await harness?.close?.().catch?.(() => undefined)
        // The workspace belongs to the backend; the core tears it down after grading.
        release(repoRoot, work)
      }
    },
  }
}
