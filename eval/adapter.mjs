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
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })

/** Lead-side and member-side token totals are disjoint; report their sum. */
const sumUsage = (a, b) => ({
  inputTokens: (a?.inputTokens ?? 0) + b.inputTokens,
  outputTokens: (a?.outputTokens ?? 0) + b.outputTokens,
  cacheReadInputTokens: (a?.cacheReadInputTokens ?? 0) + b.cacheReadInputTokens,
  cacheWriteInputTokens: (a?.cacheWriteInputTokens ?? 0) + b.cacheWriteInputTokens,
  totalTokens: (a?.totalTokens ?? 0) + b.totalTokens,
  calls: (a?.calls ?? 0) + b.calls,
})

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
  try {
    execFileSync('npm', ['run', 'build'], { cwd: dest, stdio: 'ignore' })
  } catch {
    // A change that does not BUILD is incorrect, not un-gradeable. Throwing here
    // turned every such cell into an env_error, which the core excludes and
    // retries — so the harness systematically discarded exactly the case the
    // experiment exists to find: broken work merged with no gate. Checks that
    // need `dist` will now fail on their own, which is the right verdict.
  }
}

/**
 * Fold token usage out of member session logs.
 *
 * A worktree member is a SUBPROCESS, so its `assistant/message` events are
 * written to the child's own session — the parent context never sees them, and
 * parent-side folding reports zero for a run that plainly called the model. The
 * member's session root is ours to choose, so read it back here. Without this
 * the cost axis is missing for exactly the execution mode the experiment uses.
 */
function foldMemberUsage(sessionRoot) {
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, totalTokens: 0, calls: 0 }
  const stack = [sessionRoot]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry)
      let isDir
      try {
        isDir = statSync(path).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        stack.push(path)
        continue
      }
      if (!entry.endsWith('.jsonl')) continue
      let raw
      try {
        raw = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue // a torn final frame is expected if a member was killed
        }
        if (event?.type !== 'assistant/message') continue
        const usage = event.data?.usage
        if (usage === undefined) continue
        totals.inputTokens += usage.inputTokens ?? 0
        totals.outputTokens += usage.outputTokens ?? 0
        totals.cacheReadInputTokens += usage.cacheReadTokens ?? 0
        totals.cacheWriteInputTokens += usage.cacheWriteTokens ?? 0
        totals.calls += 1
      }
    }
  }
  totals.totalTokens =
    totals.inputTokens + totals.outputTokens + totals.cacheReadInputTokens + totals.cacheWriteInputTokens
  return totals
}

/** Copy member session JSONL out of a per-cell root before it is discarded. */
function copySessionLogs(sessionRoot, dest) {
  const stack = [sessionRoot]
  let n = 0
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry)
      let isDir
      try {
        isDir = statSync(path).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        stack.push(path)
      } else if (entry.endsWith('.jsonl')) {
        mkdirSync(dest, { recursive: true })
        try {
          writeFileSync(join(dest, `member-${n++}.jsonl`), readFileSync(path))
        } catch {
          // Best effort: a torn log is still worth what was flushed.
        }
      }
    }
  }
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
export function makeSelfModAdapter({ repoRoot, boot, gate, artifactsDir }) {
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
          execFileSync('git', ['branch', '-D', branch], { cwd: repoRoot, stdio: 'ignore' })
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
      // Ours to choose, so the member's usage can be read back after the run.
      const sessionRoot = mkdtempSync(join(tmpdir(), 'openswarm-cell-sessions-'))
      // The swarm's task worktree must NOT live inside `work`. Nested, the outer
      // `work/node_modules` is an ancestor of the task tree, so TypeScript can
      // resolve openswarm-* through BOTH trees and fails with TS2717/TS2322 —
      // two identities of one package. That made the gate reject correct work
      // for a reason the harness created, in the whole first matrix.
      const worktreeDir = mkdtempSync(join(tmpdir(), 'openswarm-cell-wt-'))
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
            // `commands` may be a function of the run's paths: the gate executes
            // in the cascade's INNER task worktree, which is a fresh checkout
            // with no node_modules of its own, so a real gate has to provision
            // itself and needs to know where to hardlink from.
            ...(gated
              ? {
                  confidence: {
                    commands:
                      typeof gate.commands === 'function' ? gate.commands({ work }) : gate.commands,
                    tau: 1,
                  },
                }
              : {}),
          },
          {
            parent: harness.lead.agent,
            signal: ctx.signal,
            ...(gated && gate.pinPaths ? { confidencePinPaths: gate.pinPaths } : {}),
            worktrees: {
              repoRoot: work,
              worktreeDir,
              // Explicit model: a worktree member is a separate harness and does
              // not inherit the lead's route.
              member: {
                ...(harness.model ? { model: harness.model } : {}),
                env: { ...harness.memberEnv, DSH_SESSION_ROOT: sessionRoot },
              },
            },
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

        if (ctx.workspace !== undefined) {
          // Export into the workspace the grader will read. `git archive`
          // rather than a checkout: it writes files without touching an index.
          //
          // No branch means the run committed nothing — the member failed, or
          // did nothing. Grade the BASE tree then, never an empty directory:
          // "the repo, unchanged" is the honest ground truth for a run that
          // produced no work, and it scores progress-fails / guard-passes. An
          // empty workspace instead makes checks pass or fail for reasons
          // unrelated to the task — a version check comparing two empty command
          // outputs reported SUCCESS on exactly this path.
          materialize(repoRoot, branch ?? base, ctx.workspace.root)
          grading = ctx.workspace.root
        }

        // Preserve what the run actually DID, before teardown removes it. The
        // diff and the member's tool-call log are the only direct evidence of
        // how the harness modified itself; usage and a pass/fail cannot show
        // whether a change was the intended one or an accident that satisfied
        // the check. Both were being deleted — the branch by cleanup(), the
        // session log right after usage was folded out of it.
        if (artifactsDir !== undefined) {
          const slug = `${cell.task.id}__${cell.arm.id}__seed${cell.seed ?? 0}`.replace(/[^A-Za-z0-9_.-]/g, '-')
          const dest = join(artifactsDir, slug)
          mkdirSync(dest, { recursive: true })
          if (branch !== undefined) {
            try {
              writeFileSync(
                join(dest, 'change.patch'),
                execFileSync('git', ['diff', `${base}..${branch}`], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 }),
              )
            } catch {
              // A branch with no diff is a real outcome, not an error.
            }
          }
          copySessionLogs(sessionRoot, join(dest, 'sessions'))
          writeFileSync(
            join(dest, 'outcome.json'),
            `${JSON.stringify({ accepted: result.accepted === true, tier: result.tier, branch,
              confidences: (result.attempts ?? []).map((a) => a.confidence),
              failures: (result.attempts ?? []).filter((a) => a.failure).map((a) => a.failure) }, null, 2)}\n`,
          )
        }

        return {
          output: result.final?.text ?? '',
          workdir: grading,
          usage: sumUsage(harness.usage(), foldMemberUsage(sessionRoot)),
          trajectory: [],
          durationMs: Date.now() - started,
          metadata: {
            accepted: result.accepted === true,
            tier: result.tier,
            // Why a tier produced nothing is otherwise unrecoverable from the
            // record: a member that never completed and one that completed
            // badly look identical downstream.
            stopReasons: (result.attempts ?? []).map((a) => a.result?.stopReason),
            finalText: (result.final?.text ?? '').slice(0, 400),
            confidences: (result.attempts ?? []).map((a) => a.confidence),
            // Present only when a command gate rejected a tier — this is what
            // makes a rejection attributable rather than a bare 0.
            // Command AND output. Storing only the command made a systematic
            // gate rejection undiagnosable after the fact — the same bare-verdict
            // mistake the cascade gate itself used to make.
            failures: (result.attempts ?? [])
              .filter((a) => a.failure !== undefined)
              .map((a) => ({
                command: a.failure.command,
                output: (a.failure.output ?? '').slice(-1200),
              })),
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
        rmSync(sessionRoot, { recursive: true, force: true })
        rmSync(worktreeDir, { recursive: true, force: true })
        // The workspace belongs to the backend; the core tears it down after grading.
        release(repoRoot, work)
      }
    },
  }
}
