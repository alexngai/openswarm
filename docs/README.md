# openswarm design docs

Design capture for openswarm — a TypeScript agent harness where the atomic unit is a single coding agent and the primary product surface is multi-agent swarm orchestration.

Numbering is chronological and stable: numbers are never reused.

For end-user CLI reference (flags, model routing, tools, limitations, architecture), see [USAGE.md](./USAGE.md).

## Foundations (design of record)

- [00-vision.md](./00-vision.md) — project intent, what openswarm is, design principles
- [01-requirements.md](./01-requirements.md) — functional and non-functional requirements, scope
- [02-architecture.md](./02-architecture.md) — package layout, layering, process topologies
- [03-interfaces.md](./03-interfaces.md) — the three abstraction seams that must stay stable
- [04-tool-tiers.md](./04-tool-tiers.md) — tiered tool catalog (Tier 0 → Tier 5)
- [05-swarm-model.md](./05-swarm-model.md) — atomic agent and orchestrator contracts
- [06-open-questions.md](./06-open-questions.md) — unresolved decisions, provisional leans, and decision log
- [07-implementation-plan.md](./07-implementation-plan.md) — original tiered milestones (M0 → M5+)

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

All ACP stages are shipped. The living references:

- [31-teams-acp-design.md](./31-teams-acp-design.md) — driving a *team* from an editor: `_meta.swarm` enrichment, capability-negotiated baseline-vs-rich emission, per-topology mapping (fully implemented)
- [36-meta-swarm-convention.md](./36-meta-swarm-convention.md) — the `_meta.swarm` convention (v1): self-contained versioned spec so any third-party ACP client can adopt rich multi-agent rendering

## TUI

- [41-tui-redesign.md](./41-tui-redesign.md) — OpenTUI/Solid REPL redesign (active)
- [49-tui-parity-plan.md](./49-tui-parity-plan.md) — parity plan vs Claude Code/Codex/opencode: syntax highlighting, `<diff>`/`<code>` adoption, transcript ergonomics, half-wired feature fixes (plan)

## Status

Foundations (00–07) are the design of record; resolved open questions migrate to the decision log at the bottom of `06-open-questions.md`.
