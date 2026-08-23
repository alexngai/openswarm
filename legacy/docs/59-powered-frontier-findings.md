# 59 — Powered frontier findings: the cost axis, fixed

**Status:** findings (eval results). The seed-replicated re-run docs/54 §5 called for, now on an
honest cost axis. Extends 50/51 (cost-frontier study), 52 (handoff fidelity), 54 (hard-slice).
**Run:** 2026-07-13/15, cascade-swe on the self-hosted **docker** backend (m7i.4xlarge, native x86),
harness at `1fa0eba`. **3 instances × 5 arms × 5 seeds = 75 cells.** `CS_TAUS=0.5 CS_RESIDENT=1
CS_CONCURRENCY=16`. Raw cells + `cost-frontier.json` archived off-box; analyzer `tsx eval/analysis/cost-frontier.ts`.

## 1. Why this run — and what was actually broken

docs/54 measured a stale published binary and reported the advisor arms at $0 / malfunctioning; its
own §5 flagged that the cost axis was untrustworthy. Chasing that down surfaced **two real bugs, both
now fixed**, and one methodological correction:

- **B1 — advisor $0 was a scratch-wipe, not a usage bug (`39125f7`).** The eval adapters wrote their
  topology scratch (`results.jsonl`, holding the flushed `team_usage` line) to a **relative `.sbx/`
  path inside `/testbed`** — the workspace git repo. The advisor executor, following the repro-first
  prompt, runs a `git clean`-style reset in `/testbed` that deletes untracked files, wiping the output
  before `readTeamUsage` could read it → `cat` on a deleted file → `$0`. Usage was captured correctly
  the whole time (verified end-to-end across 9 container reproductions). Fix: scratch → absolute
  `/tmp/os-eval/<agent>`, immune to `/testbed` git ops. Applied to both adapters.
- **B2 — advisor-resident no-op'd (docs/54 F6, `1fa0eba`).** A resident (long-lived) worker that
  closed before its first `task_result` resolved via the host's close-failure synthesis
  (`{status:"failure", wallClockMs:0, no usage}`), silently aborting the cell with empty output + $0.
  Fix: detect that precise close-failure and retry the turn once as a cold spawn (17/17 tests pass).
- **M1 — the stale/fresh binary A/B is a no-op on docker.** The bake installs the CLI with
  `--omit=optional`, so the published platform binary is never in the image; the launcher always runs
  fresh `dist`. The stale-binary phenomenon was E2B-only. `CS_STALE_BINARY` toggling changes nothing here.

**All 75 cells reported nonzero, consistent `team_usage` (0 zero-usage cells).** The cost axis is honest.

## 2. Results (mean over 3 tasks × 5 seeds)

| Arm | Quality | $/cell | Mtok | cache% | Frontier |
|---|--:|--:|--:|--:|:--|
| mono-small (haiku) | 0.467 | $0.23 | 1.60 | 94% | ★ cheapest |
| advisor (cold) | 0.400 | $0.98 | 3.59 | 85% | dominated |
| advisor-resident | 0.533 | $1.10 | 3.78 | 86% | ★ |
| cascade-τ0.5 | 0.800 | $2.38 | 3.47 | 94% | ★ top quality |
| mono-large (gpt-5.5) | 0.800 | $2.82 | 1.62 | 93% | dominated |

Per-task quality (resolve-rate, 5 seeds):

| Task | m-small | advisor | advisor-res | cascade-τ0.5 | m-large |
|---|--:|--:|--:|--:|--:|
| django-12708 | 0.6 | 0.4 | 0.6 | 1.0 | 1.0 |
| pytest-6197 | 0.0 | 0.0 | 0.2 | 0.4 | 0.4 |
| sympy-11618 | 0.8 | 0.8 | 0.8 | 1.0 | 1.0 |

## 3. Findings

**F1 — cascade-τ0.5 Pareto-dominates mono-large.** Same resolve-rate (0.800) at ~15% lower cost
($2.38 vs $2.82/cell). The cheap tier resolves the easy cells and the escalation only pays for the
large model when needed. First real support for H2.1 (heterogeneous cascade expands the frontier),
which docs/54 could not test because the cost axis was broken.

**F2 — the non-dominated frontier is heterogeneous/coordinated, not monolithic.**
mono-small (0.47 @ $0.23) → advisor-resident (0.53 @ $1.10) → cascade-τ0.5 (0.80 @ $2.38). **Both
monoliths-or-cold pieces are dominated:** mono-large loses to cascade-τ0.5 (F1), and cold-advisor
(0.40 @ $0.98) is beaten outright by mono-small (higher quality *and* cheaper). Every point on the
frontier uses either cross-provider escalation or resident coordination.

**F3 — resident coordination beats cold (docs/52).** advisor-resident (0.533) > advisor cold (0.400)
at near-equal cost — a +0.13 resolve-rate lift from keeping executor+critic context alive across
rounds. Directly enabled by the F6 fix (the resident arm previously no-op'd, docs/54 F6). This is the
first clean coordination-fidelity signal in the study.

**F4 — the frontier point beats the naive default.** The study's implicit prior ("just use the big
model") is dominated: cascade-τ0.5 gets mono-large's quality for less, and where a bit less quality is
acceptable, advisor-resident and mono-small sit below it on cost. "Mono is better" does not hold once
the coordination arms are equipped to run and measured honestly.

## 4. Caveats

- **Pilot scale.** 3 tasks × 5 seeds. Per-task variance is large (pytest-6197 is hard for all arms;
  sympy easy). The per-arm means ride on 15 cells each — directional, not definitive.
- **Slice inheritance.** These 3 instances are docs/54 holdovers, not a fresh gap-selected slice
  (docs/54 §5's dual-screen selection is still the right next step for a decisive H2.1 test).
- **τ unsept.** Only τ0.5 ran; the τ-sweep (docs/54 F2) was not repeated here.

## 5. Next steps

1. Scale seeds/tasks on a **gap-selected** slice (mono-small-fails ∧ mono-large-succeeds) to turn F1/F3
   from directional into decisive — the machinery now produces honest cost, so this is finally worth it.
2. Re-run the τ-sweep (τ0.3 vs τ0.5) on the fixed pipeline for the cost-shaping curve.
3. The Qwen/DashScope small tier (uncommitted `cost-model.ts` + `DASHSCOPE_API_KEY` work) widens the
   capability spread docs/50 §9.4 wants — a natural third small-tier arm.
