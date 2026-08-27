# 02 — Discrimination-set rerun on the dsh stack

Status: **complete** · 2026-08-24 · the Phase-5 acceptance run (docs/01)

## Setup

Legacy run-2 composition, unchanged: 8 SWE-bench-Verified instances
(`legacy/eval/.artifacts/swe-subset`) × 3 arms × 1 seed on E2B, driven by the
**unchanged** legacy eval harness (`swarmkit-eval` + CascadeAdapter) — the
only delta vs legacy is `bin`, pointing at the bundled dsh-stack CLI
(`packages/cli`, deployed per `legacy/eval/experiments/dsh-sweep.ts`).
Arms: mono-haiku (Bedrock, `openswarm-llm-anthropic`), mono-gpt5.5 (Azure,
`openswarm-llm-openai`), cascade-τ0.5 (haiku→gpt-5.5, composite
compile×repro gate, run-2 protocol verbatim). The legacy advisor arm is
deferred (needs `topology critic-loop` CLI surface — deferred-work ledger).

## Result: the rewrite replicates the research harness

| Arm | dsh stack (this run) | Legacy run-2 (2026-07-09) |
|---|---|---|
| mono-haiku | **7/8** — sole failure pytest-6197 | 7/8 — sole failure pytest-6197 |
| mono-gpt5.5 | **8/8** — incl. the expensive pytest solve (2.0M tokens) | 8/8 — incl. pytest ($16.29) |
| cascade-τ0.5 | **7/8** — fails pytest-6197 | 7/8 — fails pytest-6197 |

Failure **signatures** replicated, not just counts:

- **Under-escalation on pytest-6197** — the authored-repro gate false-passed
  on haiku's wrong fix (esc=0, gpt-5.5 never called, cell failed). The exact
  run-1/run-2 finding: the visible-correctness signal, not the topology, is
  the bottleneck.
- **Over-escalation on easy instances** — django-11179 and sympy-11618 both
  escalated (esc=1) despite mono-haiku solving them alone; the same waste
  pattern legacy flagged (django $2.76 / sympy $2.74 vs haiku cents).
- 0% env errors across all 24 cells; every cell exit 0.

Conclusion: the dsh-based stack preserves the eval harness's measurement
behavior end to end — solve sets, cascade gate behavior, per-model usage
attribution — clearing the docs/01 Phase-5 acceptance bar. The standing
research conclusion is unchanged and now reproducible on the new stack:
**signal-hardening (a better visible-correctness signal), not more
topology mechanism, is the next research move.**

## Operational notes

- One cache poisoning: the `dsh-smoke` debug iterations shared the
  `dsh-mono-large` arm id and default config namespace with the sweep, so a
  stale zero-token failure cell got cache-hit for django-11179; purged and
  re-run live (solved, 91.7k tokens). Lesson: keep smoke arm ids or
  `*_CONFIG_VERSION` namespaces disjoint from sweep arms.
- One transient E2B ECONNRESET killed the first driver process during
  template polling; the retry-wrapped relaunch resumed free from the
  content-addressed cell cache.
- No Bedrock daily-quota 429s this run; haiku cells ran 1.0–3.4M tokens each
  (mostly cache reads).
- Cost axis: `costUsd` is 0 in the new CLI's team_usage (tokens are
  authoritative; the frontier analyzer's MODEL_PRICING path still applies) —
  ledgered.
