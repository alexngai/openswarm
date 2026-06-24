# 47 — H1 experimental findings: single agent vs multi-agent teams on hard SWE

**Status:** complete (first pass), 2026-06-24 · **Design context:** [docs/45](45-adaptive-orchestration-design.md) §6b · **Code:** [`eval/`](../eval)

This is the authoritative summary of the H1 experiment. The blow-by-blow (including a *retracted* intermediate conclusion) lives in docs/45 §6b.1–§6b.4; read this doc for the corrected bottom line.

---

## TL;DR

On a hard 9-instance SWE-bench-Verified subset, across **two model families**, a **functioning multi-agent coordinator team reaches parity with a single agent** — same resolve rate, comparable effort. **No benefit, no harm.** Teams do not beat single; the strong-single-baseline thesis (arXiv 2601.12307) holds. The reframe toward **ensemble-select over coordinated within-task teams** (docs/45 §4) stands — but the honest basis is *parity*, not team inferiority.

A mid-experiment conclusion that "GPT-5.5 teams are *worse* (0/9) due to structural coordination overhead" was **wrong** — it was a spawn bug (the team never functioned). Catching it required reading trajectories, not scores. That lesson is the most transferable result here.

---

## Setup

- **Harness:** swarm-harness (working tree, packed locally — never published) via `swarmkit-eval`'s `(task × arm × model × seed)` matrix runner, ground-truth **swebench grading** (faithful `get_eval_report`), **E2B** Firecracker sandboxes (server-side template builds — no local Docker).
- **Runtime:** node via global `tsx` (NOT bun — bun's gzip handling corrupts E2B compressed output).
- **Instances (hard set, 9):** repo-diverse SWE-bench-Verified, `1-4h` + `>4h` human-difficulty buckets (the easy set saturated single at 4/5 — useless for discrimination).
- **Arms:** `single` (one long-lived agent) · `team` (homogeneous coordinator: architect + executor + reviewer) · `hetero` (architect-lead + implementer + dedicated verifier + adversarial critic).
- **Models:** Sonnet-4.5 via **Bedrock** (Claude Agent SDK engine); GPT-5.5 via **Azure OpenAI** (`azureoai/` direct transport → native engine).

## Results (corrected, valid)

| Hard SWE (N=9) | Sonnet-4.5 | GPT-5.5 |
|---|--:|--:|
| **single** | 1/9 | 1/9 |
| **team (functioning)** | 1/9 | 1/9 |

- Both families: **parity** (1/9 = 1/9), same solved instance (xarray-3993), comparable effort (team ~182s/3 agents vs single ~179s).
- Paired Δ ≈ 0; **N=9, 1 seed → underpowered** (MDE ~0.3–0.47). The robust claim is *teams do not beat single*, replicated across two families.
- Single agrees across families: both resolve exactly xarray-3993 and fail the other 8 — the hard set is genuinely hard for both frontier families.

## The bug hunt (why the analysis mattered)

The aggregate scores were misleading at two points; reading the actual trajectories corrected both.

1. **"GPT-5.5 teams are worse (0/9)" → a spawn bug.** A comparative diagnostic ([`eval/experiments/compare-traces.ts`](../eval/experiments/compare-traces.ts)) on a single-that-solved vs team-that-failed trajectory (xarray-3993) showed the "team" never spawned: the architect (read-only by role) hit *"requires SwarmHost"* on every delegation, then deadlocked as a lone planner. **Root cause:** the **native engine** (used for all non-Claude models) dispatched tools with no `SwarmHost` in context, so tier-2 team tools (`agent`/spawn, `send_message`, `check_inbox`) errored. The Claude SDK engine was unaffected — so **Sonnet teams were valid; GPT-5.5 teams were not.** Fixed (commit `fcf9c5c`): now spawns 3–4 agents in 8/9 cells; resolve 0/9 → 1/9 (parity). This retracted the intermediate "premature termination / structural overhead" conclusions (docs/45 §6b.2–6b.3 → §6b.4).
2. **MAST failure-mode comparison** ([`eval/experiments/mast-analysis.ts`](../eval/experiments/mast-analysis.ts), Azure GPT-4.1 cross-family judge): on the *valid* runs, the dominant single-agent failure is FC3 verification (the fix doesn't pass), not coordination — consistent with "the task is just hard."

## Harness improvements shipped (independent of the experiment's outcome)

All committed with tests — genuine swarm-harness value:

| Commit | Fix |
|---|---|
| `4d0aae1` | worker model propagation (spawned workers hardcoded the default model → broke any non-default/Bedrock model) |
| `5647c75` | rich per-worker team trace capture via `--trace-output` (team traces were ~270 B vs single's 2–5 KB) |
| `c4bd9c2` | direct Azure OpenAI transport (`azureoai/<deployment>`) — agents on Azure without a gateway |
| `3e12ef6` | `detectAuth` recognizes OpenAI-compatible keys (was blocking any non-Anthropic provider at the run gate) |
| `b2cc557` | coordinator `verifiedCompletion` gate (opt-in verify-then-continue rounds) |
| `fcf9c5c` | **native-engine SwarmHost injection** — non-Claude multi-agent teams were entirely broken before this |
| swarmkit `857a05c` | E2B timeout/sandbox-kill resilience (one slow cell no longer crashes the batch) |

## Methodology lessons

1. **Verify the MAS is actually multi-agent before trusting aggregate scores.** A 0/9 "team" that never spawned looks identical to a "team that's bad at the task" until you read the trace.
2. **Pick instances on difficulty.** The easy set saturated single (4/5) → zero discriminating power. The hard set's 11% floor is the opposite problem (low power per cell); a mixed ~40–60% band would be ideal.
3. **Cross-family replication catches infra bugs** the single-family run hides (the spawn bug only manifested on the native engine).

## Open questions / next

- **Ensemble test (the design's actual bet):** best-of-N single vs a team at *equal token budget* — does union over diverse independent attempts beat one coherent agent? (The disjoint-coverage signal hinted union ≈ 3× single, but that was on the pre-fix data and is underpowered.)
- **Power:** multi-seed per arm to move below the current MDE ~0.3.
- **Finish the corrected 3-way:** the `hetero` arm on GPT-5.5 was also spawn-broken — re-run for completeness.
- **Token/cost axis:** the coordinator still surfaces no aggregate usage (spawn-tree usage isn't summed) — the cost side of the frontier is blank.

## Reproduction

```sh
# prereqs: source ~/.zshrc (E2B + Bedrock + Azure creds); global tsx; packed local harness
bash eval/scripts/pack-local-harness.sh                 # build+pack working-tree swarm-harness (+skill-tree)
bash eval/scripts/prep-swe-subset.sh <instance ids…>    # SWE_INSTANCES_DIR=eval/.artifacts/swe-hard, SWE_DATASET=…Verified

# run an arm (node/tsx, NOT bun):
SWE_INSTANCES_DIR=eval/.artifacts/swe-hard \
  H1_PROVIDER=azure H1_MODEL=azureoai/gpt-5.5 \    # or H1_PROVIDER=bedrock (Sonnet default)
  H1_ARM=team H1_SEEDS=1 RUN_H1=1 HARNESS=local \
  tsx eval/experiments/h1-single-vs-team.ts
```

**Knobs:** `H1_PROVIDER` (bedrock|azure) · `H1_MODEL` · `H1_ARM` (single|team|hetero) · `H1_SEEDS` · `H1_INSTANCE_LIMIT` · `H1_AGENT_TIMEOUT_MS` / `H1_TEAM_TIMEOUT_MS` / `H1_SANDBOX_TIMEOUT_MS` · `H1_CONCURRENCY` · `H1_VERIFY_ROUNDS` (coordinator verified-completion) · `H1_CONFIG_VERSION` (namespace a re-run's cache).

**Analysis:** `MAST_JUDGE=azure AZURE_DEPLOYMENT=gpt-4.1 MAST_MODEL=gpt-5.5 tsx eval/experiments/mast-analysis.ts` (failure-mode histograms) · `tsx eval/experiments/compare-traces.ts` (single-solved vs team-failed diagnostic).
