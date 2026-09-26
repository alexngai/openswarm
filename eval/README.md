# eval — self-modification experiments

Experiments measuring OpenSwarm's self-modification loop, built on
[`swarmkit-eval`](https://www.npmjs.com/package/swarmkit-eval).

**Its own package on purpose.** `swarmkit-eval` is a dependency of the
experiments, not of OpenSwarm, so it must never reach consumers of the
published `openswarm` package. Keeping it here rather than in the root
`package.json` is what guarantees that.

## Why reuse rather than build

Every design question in [docs/04](../docs/04-gate-discrimination.md) and the
C1/C2 sketch turned out to be answered here, usually better than the version we
were about to hand-roll:

| Our problem | Their mechanism |
|---|---|
| hold the acceptance test back from the model | **sealed boundary in the type system** — `PublicTask` is a `Pick` allowlist, so `checkpoints` are unreachable by the SUT, and a new field is sealed by default |
| the held-out test itself | `Check { type: "cmd", writeFiles }` seeds sealed files into the FINISHED workspace, after the agent is done, in a directory it never saw |
| gate is both treatment and outcome | grading is a separate `Grader` seam, scored against ground truth and "never agent-asserted state" |
| binary outcomes have no power at our n | paired cluster-bootstrap CIs, Chen pass@k, pass^k |
| cost as a first-class outcome | accuracy–cost Pareto |
| pre-registered thresholds | `Baseline` / `GateSpec` / `GateResult` |
| stale measurement | `contentHash` resume, on the stated principle that "silent staleness is the worse failure" |

That last row is the hazard that bit this repo three times in one day.

## Wiring check

`smoke-check.mjs` runs swarmkit-eval's own smoke benchmark on the in-process
backend with its mock adapter — **zero tokens, no credentials** — and is here to
prove the dependency works before any OpenSwarm integration is trusted.

```bash
cd eval && npm install && node smoke-check.mjs
```

Expect 9 cells and a report with CIs.

## The pieces

| file | what |
|---|---|
| `boot.mjs` | composes the swarm tree from plain ESM against the **built dist**, so the experiment drives the same artifact a real run does. Folds token usage off the session-event stream the way `packages/cli` does, because `runTeam` returns none. |
| `adapter.mjs` | the system under test: provision a worktree → run a cascade → export the resulting branch into the graded workspace. |
| `benchmark.mjs` | tasks with sealed checkpoints, and the `gated` / `ungated` arms. |
| `validate.mjs` | end-to-end check of all of the above at **zero tokens**. |

```bash
cd eval && node validate.mjs
```

Expect the base-check to pass, both cells to score `true`, and the arms to
diverge: `gated → accepted=false, withheld=1`, `ungated → accepted=true,
merged=1`.

### Two things that cost time, recorded so they don't again

**The grader grades the `Workspace`, not `RawRun.workdir`** —
`passed: workspace ? runCheck(...) : false`. A `placement: "self"` adapter has
no workspace, so every checkpoint scored `false` no matter what the agent
produced. Uniform zeroes across both arms is what a broken grader looks like,
not a result. Hence `placement: "backend"` plus a `git archive` export of the
result tree into the provisioned workspace.

**Cleanup must outlive `run()`.** The core grades after the adapter returns, so
releasing the graded tree in a `finally` deletes what the grader is about to
read. Branches are tracked and reclaimed by `cleanup()` after the matrix —
including each team's integration branch, not just the task branch, or they
accumulate one per cell.

## What validation does and does not show

It exercises the real adapter, cascade, worktree/merge machinery and sealed
grader, with a scripted mock standing in for the model. If it is green the only
untested variable in a live run is the model itself.

It is **not** a result. Both arms score 1.00 because the mock writes the marker
either way and the checkpoint only asks whether the marker landed — the gate's
rejection withholds the merge but does not erase the branch. Grading the
withheld branch is deliberate: the 2×2 needs the truth about the work
*regardless of the verdict*, otherwise the gated arm is scored only on the runs
it accepted, which flatters it.

## Not yet built

The real task set — `wiringTask` exists to prove the plumbing, not to measure
anything — and live runs against a model.

Note the `openSwarm` harness already in swarmkit-eval's registry is NOT the
basis for any of this: it drives the legacy v0.x CLI (`--single --headless`),
flags the current launcher rejects outright, and it has only ever run OpenSwarm
as a single agent. Its own registry comment records that team mode "has never
been exercised through this adapter".
