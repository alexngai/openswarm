# openswarm design docs

Design capture for openswarm — a TypeScript agent harness where the atomic unit is a single coding agent and the primary product surface is multi-agent swarm orchestration.

Numbering is chronological and stable: numbers are never reused, and archived docs keep their numbers. Historical plans and build records live in [`archive/`](./archive/).

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
