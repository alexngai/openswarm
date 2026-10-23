# eval

Experiments on OpenSwarm, built on
[`swarmkit-eval`](https://www.npmjs.com/package/swarmkit-eval).

**Its own package on purpose.** `swarmkit-eval` is a dependency of the
experiments, not of OpenSwarm, so it must never reach consumers of the
published `openswarm` package. Keeping it here rather than in the root
`package.json` is what guarantees that.

`pilot/` is the RoadmapBench rig behind [docs/07](../docs/07-coordination-that-works.md)
§7: the runner, the arms, stage 2 and the reviewer bench; its README has the
details.

The self-modification rig of [docs/04](../docs/04-gate-discrimination.md) and
docs/05 (the cascade adapter, its benchmark, the mutation gate) finished its
study (self-modification was used 0 of 103 times) and was removed; it is at
`1849cf7` in git history.
