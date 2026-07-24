# openswarm design docs

Design capture for openswarm — a TypeScript agent harness where the atomic unit is a single coding agent and the primary product surface is multi-agent swarm orchestration.

Numbering is chronological and stable: numbers are never reused, and archived docs keep their numbers. Historical plans and build records live in [`archive/`](./archive/).

For end-user CLI reference (flags, model routing, tools, limitations, architecture), see [USAGE.md](./USAGE.md).

## Foundations (design of record)

- [00-vision.md](./00-vision.md) — project intent, what openswarm is, relationship to claw-code
- [01-requirements.md](./01-requirements.md) — functional and non-functional requirements, scope
- [02-architecture.md](./02-architecture.md) — package layout, layering, process topologies
- [03-interfaces.md](./03-interfaces.md) — the three abstraction seams that must stay stable
- [04-tool-tiers.md](./04-tool-tiers.md) — tiered tool catalog (Tier 0 → Tier 5)
- [05-swarm-model.md](./05-swarm-model.md) — atomic agent and orchestrator contracts
- [06-open-questions.md](./06-open-questions.md) — unresolved decisions, provisional leans, and decision log
- [07-implementation-plan.md](./07-implementation-plan.md) — original tiered milestones (M0 → M5+); per-milestone plans are archived

## Teams & orchestration

- [25-team-orchestration.md](./25-team-orchestration.md) — canonical team design: `TeamSession`, topologies, long-lived workers, openteams loader (shipped v0.4)
- [28-v0.5-daemon-plan.md](./28-v0.5-daemon-plan.md) — long-lived team daemon design (design lock; daemon shipped through 5E/5F)
- [29-v0.7-git-cascade-plan.md](./29-v0.7-git-cascade-plan.md) — git-cascade integration design (design lock)
- [45-adaptive-orchestration-design.md](./45-adaptive-orchestration-design.md) — adaptive orchestration design spike (draft)
- [47-h1-experimental-findings.md](./47-h1-experimental-findings.md) — H1 single-vs-team experimental findings (eval results)
- [50-heterogeneous-cost-scaling.md](./50-heterogeneous-cost-scaling.md) — heterogeneous cost/throughput Pareto study: does compute-optimal allocation (small-model swarm + dynamic escalation) expand the frontier? (draft; extends 45/47)
- [51-eval-execution-plan.md](./51-eval-execution-plan.md) — operational plan for running the docs/50 study on swarmkit-eval: cascade-as-one-cell, the two-grader architecture, arms/measurement contract, staged fixit-local → SWE-E2B → vLLM (draft; extends 50)
- [52-handoff-fidelity.md](./52-handoff-fidelity.md) — lossless multi-agent handoffs (diff + reason + trajectory) so a fair mono-vs-multi test is possible: external baseline (CC/OpenCode/Codex are all lossy-prose), OpenSwarm-primitive mapping, phased plan; Phase A landed (draft; extends 50/51)
- [53-token-efficiency-plan.md](./53-token-efficiency-plan.md) — token-efficiency improvement tracker (TE-1…TE-15) + eval plan: memory-injection rework, pi-parity output caps, topology token budgets, tool-surface trims; measured against the cost-frontier harness (draft; extends 50/51)
- [54-hard-slice-findings.md](./54-hard-slice-findings.md) — hard-slice eval findings: haiku↔gpt-5.5 capability gap ≈ 0 on Verified's 1–4h bucket (both 0.31), cascades tie at lower tokens (escalation = cost lever, not quality lever), one coordination-rescue cell (scikit-25102), advisor-resident malfunction; TE-16/18 cache fix validated at 88–95% (eval results; extends 50/52/53)
- [59-powered-frontier-findings.md](./59-powered-frontier-findings.md) — powered seed-replicated re-run on an honest cost axis (75 cells, 0 zero-usage): cascade-τ0.5 Pareto-dominates mono-large (same 0.80 quality, ~15% cheaper), advisor-resident > cold advisor (+0.13 resolve-rate), the non-dominated frontier is heterogeneous/coordinated not monolithic; fixes the advisor-$0 scratch-wipe (39125f7) + docs/54 F6 (1fa0eba) (eval results; extends 50/52/54)
- [60-gap-regime-findings.md](./60-gap-regime-findings.md) — gap-selected decisive run: the 15min–1h bucket yields a real gap regime (~27% small-fails∧large-succeeds, vs ~0% at 1–4h), but on a PURE-gap slice cascade-τ0.5 only TIES mono-large (0.90 vs 1.00 n.s., ~equal cost) — the docs/59 dominance came from cheap-solvable tasks, not gap tasks; escalation breaks even not loses even when mis-routed (handoff offsets the wasted cheap tier) (eval results; extends 50/54/59)
- [61-composition-sweep-findings.md](./61-composition-sweep-findings.md) — workload-composition sweep (200 cells): the docs/59 cascade win does NOT replicate on a random 15min–1h sample — cascade-τ0.5 is tied-to-dominated by mono-large (q0.95 vs 1.00, +6% cost); haiku is a coin-flip everywhere (no reliably-cheap-solvable tasks), and cost is driven by handoff-context bloat (escalation can cost 2× a cold monolith) not the cheap tier's success rate; 1-seed screening too noisy to classify difficulty. H2.1 not robustly supported — needs a cheaper/more-reliable small tier (Qwen) (eval results; extends 50/54/59/60)
- [62-offline-frontier-reconstruction.md](./62-offline-frontier-reconstruction.md) — cheaper/de-confounded methodology: measure each model once → evaluate every routing policy offline (signal AUC + oracle-cascade frontier), plus the reusable **oracle pre-check** (`cost(C) < p_C·cost(E)` on honest compute). Phase 0 (free, existing cells): both haiku↔gpt-5.5 and Nova-Pro↔gpt-5.5 are structurally dead — on fresh compute the small tier is not cheaper (haiku ≈ gpt at lower quality → dominated; its 3× "cheapness" is 96% cache-reads, the §8.1 confound), and solves ~nothing uniquely; the structural cost loses before signal/handoff enter. Phase 1: single-shot code-gen (HumanEval/MBPP) + test signal (proposal + eval results; extends 50/54/59/60/61)
- [55-cross-harness-cache-efficiency.md](./55-cross-harness-cache-efficiency.md) — cache-efficiency lessons from DeepSeek-Reasonix: a measurement/visibility track first (accurate `/cost`, live cache indicator, miss-attribution, local A/B harness), then improvements (native-path prefix-stability guard, self-calibrated token estimate, standing-constraints summary section + verbatim user-turn pinning) — TE-19…TE-25b landed, TE-26/27 optional; extends 48/53
- [55-live-eval-handoff.md](./55-live-eval-handoff.md) — runbook to finish the one doc-55 measurement that needs a real model: the TE-25 constraint-retention eval (baseline vs section vs verbatim), with the decision rule and where to record results
- [48-compaction-design.md](./48-compaction-design.md) — Claude Code-aligned compaction redesign (trigger, microcompaction, in-session summarization, post-compact rebuild). Implemented (phases 1–6); follow-ups F1/F2 open

## Engines & parity

- [37-hardened-engine-design.md](./37-hardened-engine-design.md) — production-hardened NativeEngine (retry, eager dispatch, mid-turn compaction)
- [39-codex-parity-gap-analysis.md](./39-codex-parity-gap-analysis.md) — gap analysis vs OpenAI Codex CLI (all P0/P1/P2 gaps closed)
- [42-codex-native-provider-plan.md](./42-codex-native-provider-plan.md) — native Codex (ChatGPT-plan) provider (Phase 1 complete)
- [43-macro-agent-parity.md](./43-macro-agent-parity.md) — gap analysis vs macro-agent; tracked checklist + scope decisions (draft)
- [44-macro-agent-parity-implementation-plan.md](./44-macro-agent-parity-implementation-plan.md) — phased build plan: Track A (git-workspace) + Track B (OpenHive hosting) (draft)

## Memory & learning

- [40-memory-system-design.md](./40-memory-system-design.md) — 4-layer memory architecture (curated memory, skills, session archive, provider protocol). Implemented — all 5 phases complete
- [46-sessionlog-trajectory-ingest.md](./46-sessionlog-trajectory-ingest.md) — sessionlog trajectory ingest design (Layer 0 kickoff)

## ACP (Agent Client Protocol — Zed/editor integration)

All ACP stages are shipped; the staged build records are archived. The living references:

- [31-teams-acp-design.md](./31-teams-acp-design.md) — driving a *team* from an editor: `_meta.swarm` enrichment, capability-negotiated baseline-vs-rich emission, per-topology mapping (fully implemented)
- [36-meta-swarm-convention.md](./36-meta-swarm-convention.md) — the `_meta.swarm` convention (v1): self-contained versioned spec so any third-party ACP client can adopt rich multi-agent rendering

## TUI

- [41-tui-redesign.md](./41-tui-redesign.md) — OpenTUI/Solid REPL redesign (active)
- [49-tui-parity-plan.md](./49-tui-parity-plan.md) — parity plan vs Claude Code/Codex/opencode: syntax highlighting, `<diff>`/`<code>` adoption, transcript ergonomics, half-wired feature fixes (plan)

## Archive

Historical milestone plans, audits, spikes, and build records live in [`archive/`](./archive/). They are retained verbatim for provenance (code comments cite them by section) but no longer describe current behavior:

- **Milestones:** [08 M0](./archive/08-m0-plan.md) · [09 M1](./archive/09-m1-plan.md) · [10 M2](./archive/10-m2-plan.md) · [11 M3a](./archive/11-m3a-plan.md) · [12 M3b](./archive/12-m3b-plan.md) · [13 M4a](./archive/13-m4a-plan.md) · [14 M4b](./archive/14-m4b-plan.md)
- **Claw parity push:** [15 gaps](./archive/15-parity-gaps.md) · [16 plan](./archive/16-parity-plan.md) · [17 design questions](./archive/17-parity-design-questions.md) · [18 phase 4](./archive/18-phase-4-plan.md) · [19 phase 5](./archive/19-phase-5-plan.md)
- **Launch & roadmap:** [20 v0.1 launch](./archive/20-v0.1-launch.md) · [21 roadmap v0.2–v0.4](./archive/21-roadmap-v0.2-to-v0.4.md)
- **Audits:** [22 branch-lock](./archive/22-a2-branch-lock-audit.md) · [23 smoke](./archive/23-d2-smoke-audit.md)
- **Codex app-server:** [24 phase 6 plan](./archive/24-phase-6-codex-app-server-plan.md)
- **Team spikes & v0.4 build record:** [26 spikes](./archive/26-team-orchestration-spikes.md) · [26b codex protocol](./archive/26b-spike-track-b-codex-protocol.md) · [27 v0.4 teams plan](./archive/27-v0.4-teams-implementation-plan.md)
- **ACP build records:** [30 Stage A plan](./archive/30-acp-compatibility-plan.md) · [32 Stage A build](./archive/32-acp-implementation-plan.md) · [33 Stage B build + status board](./archive/33-teams-acp-implementation-plan.md) · [34 B1](./archive/34-acp-b1-meta-swarm-plan.md) · [35 B2](./archive/35-acp-b2-rich-client-plan.md)
- **Engine build record:** [38 hardened engine plan](./archive/38-hardened-engine-implementation-plan.md)

## Research

Feature extraction from the claw-code reference implementation lives in [`research/`](./research/):

- [01-api.md](./research/01-api.md) — providers, auth, streaming, multi-provider routing
- [02-tools.md](./research/02-tools.md) — tool catalog, bash validation, sandbox, edge cases
- [03-runtime.md](./research/03-runtime.md) — conversation loop, sessions, permissions, hooks, compaction
- [04-integrations.md](./research/04-integrations.md) — plugins, skills, MCP, LSP
- [05-swarm.md](./research/05-swarm.md) — task/team/cron/worker/lane/branch — our most-cited slice
- [06-cli.md](./research/06-cli.md) — CLI surface, slash commands, doctor, bootstrap, ink/rustyline gaps

## Status

Foundations (00–07) are the design of record; resolved open questions migrate to the decision log at the bottom of `06-open-questions.md`. Everything under `archive/` is historical. Research notes are read-only reference for where design decisions came from.
