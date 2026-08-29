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

## Not yet built

The OpenSwarm `ExecutionAdapter` (drive a self-modification cascade in a
workspace) and the task set with sealed checkpoints. Note the existing
`openSwarm` harness in swarmkit-eval's registry is NOT the basis for this: it
drives the legacy v0.x CLI (`--single --headless`), flags the current launcher
rejects, and it has only ever run OpenSwarm as a single agent — its own registry
comment records that team mode "has never been exercised through this adapter".
