# 52 — Token efficiency: improvement tracker + eval plan

Status: draft. Extends 50/51 (cost-frontier study) with harness-level efficiency work.

Motivation: the [Databricks coding-agent benchmark](https://www.databricks.com/blog/benchmarking-coding-agents-databricks-multi-million-line-codebase) found harness design dominates token cost — the pi harness sent ~3x less context per turn than Claude Code/Codex. A five-surface audit of OpenSwarm (system prompt, tool definitions, per-turn injection, tool-result handling, multi-agent duplication) found the single-agent engine is already lean; the spend concentrates in (a) unbounded per-turn memory injection, (b) topology round costs, (c) work-product passed by value between agents. Our own eval data (`.eval-runs/cost-frontier.json`) shows 100x cost variance on identical tasks at identical quality, driven by escalation/iteration behavior.

Reference designs studied: pi (`badlogic/pi-mono` — central dual-limit truncation, 4 tools, ~300-word prompt), Codex (`openai/codex` — `ContextualUserFragment` model, `project_doc_max_bytes` 32KB budget, world-state replace-on-change), Claude Code (observed behavior — CLAUDE.md injected once at session start in first user message, event-driven `<system-reminder>` deltas after).

## Improvement tracker

Status legend: `todo` / `in-progress` / `landed` / `evaluated` / `rejected`.

### Memory injection (confirmed direction)

| ID | Improvement | Where | Expected effect | Risk | Status |
|----|-------------|-------|-----------------|------|--------|
| TE-1 | Hard aggregate byte budget on memory block: default 16KB (`OPENSWARM_MEMORY_MAX_BYTES`), relevance-ranked (stable), drop-with-debug-log; a single oversized top fragment is truncated, not dropped | `src/memory/lifecycle.ts` (`budgetFragments`) | Bounds worst case (before: coordinator capped fragment COUNT at 50 but not bytes — file provider injects whole curated files) | Dropped fragments could lose useful recall — logged under OPENSWARM_MEMORY_DEBUG | landed |
| TE-2 | Memory block moved to the USER prompt always (system prompt now byte-stable → cacheable prefix), wrapped in `<memory-context>` markers; change-dedup per (session, agent) — an unchanged block is injected once and skipped after, a changed block carries a Codex-style replacement notice. `surfacedSkills` computed from KEPT fragments and still reported on deduped turns (the block remains in history). Full history-surgery pruning of stale blocks deferred | `src/memory/lifecycle.ts` (`enrichTurnInputs`) | Restores prompt-cache hits on static prefix (~10x price difference on prefix tokens); stops per-turn re-injection of unchanged fragments | Placement change affects all three call sites (worker, main, acp) — interface unchanged | landed |
| TE-3 | REVISED: minimem *injection* was already bounded (top-5 scored snippets, minScore 0.3) — the audit's unbounded claim applies only to on-disk daily-log growth, which costs no tokens. Rotation is disk hygiene, not token efficiency | `src/memory/providers/minimem-provider.ts` | Negligible token impact | — | rejected (out of scope) |
| TE-4 | REVISED: project instructions were already budgeted (4K/file, 12K total, cross-level dedup — claw parity) and load once into the system prompt at startup (static per session → cacheable). The audit's "unbounded" claim was wrong | `src/engine/project-instructions.ts` | Already bounded | — | no change needed |

### Tool output caps (pi parity)

| ID | Improvement | Where | Expected effect | Risk | Status |
|----|-------------|-------|-----------------|------|--------|
| TE-5 | Aggregate byte cap on `read_file` (~50KB) alongside line cap — pi dual-limit. Cut at line boundary; `OPENSWARM_READ_MAX_BYTES` override; notice carries continuation offset + cap explanation | `src/tools/tier0/read_file.ts` | Closes 2000-line × 2000-char ≈ 4MB worst case | Low | landed |
| TE-6 | Bash stdout: head+tail truncation (middle elided) instead of head-only; full cleansed output spilled to a temp file named in the marker. Error path (10K middle-truncate) also spills | `src/tools/tier0/bash.ts` | Keeps failure summaries (end of output); truncation lossless — no paid re-runs with `\| tail` | Deviates from Claude Code parity phrasing (accepted) | landed |
| TE-7 | Truncation notices carry exact continuation call (offset value / file path), pi-style | read_file, bash, grep | Fewer flailing retries after truncation | Low | landed (read_file already had offset hints; bash markers now name the spill file; grep pagination note pre-existing) |

### Topology round costs

| ID | Improvement | Where | Expected effect | Risk | Status |
|----|-------------|-------|-----------------|------|--------|
| TE-8 | Per-task token budget enforced by topology via `SwarmUsageAggregator` subtree totals (kill/finalize on breach); iteration cap stays as backstop | `src/swarm/topologies/critic-loop.ts`, `cascade.ts`, `usage-aggregator.ts`, `team-spec.ts` | Bounds blast radius of gate misfires (django-12708 advisor: 9.57M tokens, quality 0) | Budget too low truncates legitimately hard tasks — sweep in eval | todo |
| TE-9 | Stall detection in critic-loop: exit when diff unchanged or critic feedback repeats | `critic-loop.ts` | Kills no-progress spins without capping real work | False-positive stall detection | todo |
| TE-10 | Work-product by reference: critic/escalation prompts carry `git diff --stat` + worktree path + short attempt summary instead of full output text | `critic-loop.ts:150`, `cascade.ts:101` | Saves 500–10K tokens per hop | Critic quality may drop without inline diff — needs eval arm | todo |

### Tool surface

| ID | Improvement | Where | Expected effect | Risk | Status |
|----|-------------|-------|-----------------|------|--------|
| TE-11 | Wire role/topology tool filtering (fanout/cascade/pipeline workers don't need messaging/task tier-2 tools); fix no-op framework filter | `src/tools/dispatcher.ts` | ~2K tokens/request/worker (audited ~55% of tool-def bytes) | Worker unexpectedly needing a filtered tool | todo |
| TE-12 | Trim largest tier-2 tool descriptions (task_stop 5.6KB, check_inbox 4.7KB, task_output 4.3KB) | `src/tools/tier2/` | Few hundred tokens/request | Instruction-following regression on trimmed tools | todo |
| TE-13 | MCP tool filtering/lazy loading for orchestrator | `src/mcp/`, runtime | +2–5K tokens/request with multiple servers | Medium | todo |

### Measurement (prerequisite for evals)

| ID | Improvement | Where | Expected effect | Risk | Status |
|----|-------------|-------|-----------------|------|--------|
| TE-14 | Record per-call input tokens + cache read/write fractions in `SwarmUsageAggregator`; surface mean-context-per-turn and cache-hit-rate per member/team | `src/swarm/usage-aggregator.ts` (`calls` on `UsageTotals`, `contextTokensPerCall`, `cacheReadFraction`), wire schema, adapters (`teamCalls`), `cost-frontier` (`ctx/call` + `cache%` columns) | The Databricks metric; makes TE-2's effect visible | Low | landed |
| TE-15 | Per-tier usage in eval adapters — REVISED: adapters already populated `perModel` (75/76 cascade cells had it; the audit claim was stale). Actual gaps fixed: per-tier pricing ignored cache tokens, and cell-level parsing read `cacheWriteTokens` where adapters persist `cacheCreationTokens` (cache writes silently unpriced) | `eval/analysis/cost-frontier.ts` | Attributes cost spikes to tiers; prices cache traffic correctly | Low | landed |

First measurement result (2026-07-09, existing cache): `cache%` reveals the mono-large arm at **0% cache-read** on astropy/django SWE cells while mono-small runs 96–98% — the expensive tier pays full price for every input token. Investigate provider-side caching for the large-tier path before drawing frontier conclusions from those arms.

## Eval plan

Harness: existing swarmkit-eval cost-frontier pipeline (docs/51), discrimination set (9 SWE-bench instances) for iteration speed, full set for confirmation.

Metrics per arm (extends existing cells):
- `meanQuality` (resolve rate) — guardrail, must stay within σ_D of baseline
- `meanTotalTokens`, `cost.usd` — primary objective
- **new (TE-14):** mean input-tokens-per-call (context-per-turn), cache-read fraction, calls-per-task

Procedure:
1. Land TE-14/TE-15 first — no behavior change, pure measurement.
2. Re-run baseline arms (mono-small, mono-large, cascade-τ, advisor) to capture context-per-turn + cache-hit baselines.
3. Land improvements in small groups; each group gets an eval arm vs. baseline:
   - Group A (TE-1..4 memory): expect cache-read fraction ↑ sharply, input tokens/call ↓; quality unchanged.
   - Group B (TE-5..7 caps): expect fewer re-run tool calls; quality unchanged.
   - Group C (TE-8..9 budgets): sweep token budget ∈ {1M, 2M, 4M} × iteration cap ∈ {3, 5, 10}; expect tail-cost collapse; watch quality on hard tasks.
   - Group D (TE-10 reference-passing): the risky one — dedicated arm, quality is the question.
   - Group E (TE-11..13 tool surface): small constant win, mostly free once cache stability (Group A) lands, since cached prefix discounts it anyway — measure to confirm ordering.
4. Accept a group when: tokens or cost improves ≥10% on the discrimination set AND quality delta within noise (σ_D from cost-frontier.json). Reject/iterate otherwise; update tracker status.

Open questions:
- Memory budget default: 8KB vs 16KB vs 32KB (Codex default) — sweep in Group A.
- TE-6 breaks byte-for-byte Claude Code parity in bash output shape — acceptable? (Parity was a compat goal in tool phrasing.)
- Whether critic sees inline diff (cheap middle ground) vs. pure by-reference in TE-10.
