# swarm-harness design docs

Early design capture for swarm-harness — a TypeScript agent harness built around Claude, where the atomic unit is a single coding agent and the primary product surface is multi-agent swarm orchestration.

## Map

- [00-vision.md](./00-vision.md) — project intent, what swarm-harness is, relationship to claw-code
- [01-requirements.md](./01-requirements.md) — functional and non-functional requirements, scope
- [02-architecture.md](./02-architecture.md) — package layout, layering, process topologies
- [03-interfaces.md](./03-interfaces.md) — the three abstraction seams that must stay stable
- [04-tool-tiers.md](./04-tool-tiers.md) — tiered tool catalog (Tier 0 → Tier 5)
- [05-swarm-model.md](./05-swarm-model.md) — atomic agent and orchestrator contracts
- [06-open-questions.md](./06-open-questions.md) — unresolved decisions, provisional leans, and decision log
- [07-implementation-plan.md](./07-implementation-plan.md) — tiered milestones (M0 → M5+) with exit criteria
- [08-m0-plan.md](./08-m0-plan.md) — M0 runtime core: phased plan with acceptance criteria, risks, verification
- [09-m1-plan.md](./09-m1-plan.md) — M1 minimum viable swarm: subprocess workers + IPC + nested spawning + orchestrator CLI
- [10-m2-plan.md](./10-m2-plan.md) — M2 UI depth + productivity: ink REPL rewrite + 14 slash commands + Tier 1 tools + plugins/skills/MCP/hooks
- [13-m4a-plan.md](./13-m4a-plan.md) — M4a NativeEngine: Vercel AI SDK integration, OpenAI provider, routing, aliases, compaction, parallel tool fan-out
- [14-m4b-plan.md](./14-m4b-plan.md) — M4b provider breadth + OAuth: xAI/Google/DashScope providers, plugin lifecycle, OpenAI PKCE OAuth, quirks, framework-filter, CLI plumbing. Phase 5 (Codex ChatGPT custom provider) deferred pending operator SSE spike.

> **Index gap:** docs 11–29 (m3 plans, parity, teams, daemon, git-cascade, etc.) exist on disk but
> are not yet listed here. Backfill pending; browse the `docs/` directory directly meanwhile.

### Hardening & Parity

- [37-hardened-engine-design.md](./37-hardened-engine-design.md) — production-hardened NativeEngine (retry, eager dispatch, mid-turn compaction)
- [38-hardened-engine-implementation-plan.md](./38-hardened-engine-implementation-plan.md) — implementation plan for hardened engine
- [39-codex-parity-gap-analysis.md](./39-codex-parity-gap-analysis.md) — gap analysis vs OpenAI Codex CLI (all P0/P1/P2 gaps closed)
- [43-macro-agent-parity.md](./43-macro-agent-parity.md) — gap analysis vs macro-agent (the spiritual predecessor); tracked checklist + scope decisions (D1 landing model, D2 pruned scope, D3 OpenHive hosting). Draft.
- [44-macro-agent-parity-implementation-plan.md](./44-macro-agent-parity-implementation-plan.md) — phased build plan for the decided scope: Track A (git-workspace P0–P4) + Track B (OpenHive hosting P5–P7), converging at P8 (cascade actions). Draft.

### Memory System

- [40-memory-system-design.md](./40-memory-system-design.md) — 4-layer memory architecture: curated bounded memory (L1), skills/procedural memory (L2), session archive (L3), provider protocol (L4). Implemented — all 5 phases complete.

### ACP compatibility (Agent Client Protocol — Zed/editor integration)

*All stages below are **shipped** (Stage A + team stages B0–B2, the §9 robustness pass, and the
published convention). B3 (standardization) is intentionally skipped (Q5).*

- [30-acp-compatibility-plan.md](./30-acp-compatibility-plan.md) — **Stage A: single-agent ACP parity.** Expose one swarm-harness agent over ACP (JSON-RPC/ndjson on stdio) by reusing the `AgentEngine.run()` stream + `PermissionGate` seams. Event mapping, tool-kind/diff tables, staged plan A.1–A.7 with acceptance.
- [31-teams-acp-design.md](./31-teams-acp-design.md) — **Stage B: driving a *team* from an editor.** Projecting N concurrent members onto one ACP session with graceful degradation: additive `_meta.swarm` enrichment, capability-negotiated baseline-vs-rich emission, per-topology mapping. §11 decisions locked (quiescence, permissions, member-text, session/load, build-our-own-client).
- [32-acp-implementation-plan.md](./32-acp-implementation-plan.md) — **Build-ready task breakdown for Stage A.** The shared `buildAgentRuntime` refactor, `src/acp/` module layout, `AcpAgent` + translator + permission-driver signatures, test strategy, and a 7-step checkpointed build sequence (~2.5–3d). Grounded in the current `src/cli/main.ts` run-assembly seams.
- [33-teams-acp-implementation-plan.md](./33-teams-acp-implementation-plan.md) — **Stage B build plan + live status board.** B0 (team-by-default coordinator) build sequence, then §6 status and **§9 — the live board** tracking everything since: B1/B2, the robustness pass (subtree quiescence, permission-IPC serialization, `allow_always`, parity, headless `ask_user_question` park-and-resume, latency), and the post-review caveats.
- [34-acp-b1-meta-swarm-plan.md](./34-acp-b1-meta-swarm-plan.md) — **Stage B1: `_meta.swarm` enrichment + team `session/load`.** Versioned per-member meta on updates/plan/permissions, capability negotiation + `acp.memberText`, the persisted orchestration spine, and `session/load` replay (lead prose + `[role]` tool calls *with arguments* + board) with live engine context-resume.
- [35-acp-b2-rich-client-plan.md](./35-acp-b2-rich-client-plan.md) — **Stage B2: `swarm/steer` ext + swarm-aware rich client.** The mid-turn steering channel, the `RichRenderer` (folds `_meta.swarm` into per-member lanes + a board), and the reference client `scripts/acp-rich-client.ts`.
- [36-meta-swarm-convention.md](./36-meta-swarm-convention.md) — **The `_meta.swarm` convention (v1).** A self-contained, versioned spec for rich multi-agent rendering over ACP — the schema, where it rides, capability negotiation, `swarm/steer`, and the strip-`_meta` trust invariant. Published so any third-party ACP client can adopt it.

## Research

Feature extraction from the claw-code reference implementation lives in [`research/`](./research/):

- [01-api.md](./research/01-api.md) — providers, auth, streaming, multi-provider routing
- [02-tools.md](./research/02-tools.md) — tool catalog, bash validation, sandbox, edge cases
- [03-runtime.md](./research/03-runtime.md) — conversation loop, sessions, permissions, hooks, compaction
- [04-integrations.md](./research/04-integrations.md) — plugins, skills, MCP, LSP
- [05-swarm.md](./research/05-swarm.md) — task/team/cron/worker/lane/branch — our most-cited slice
- [06-cli.md](./research/06-cli.md) — CLI surface, slash commands, doctor, bootstrap, ink/rustyline gaps

## Status

Drafts. Main docs (00–07) are the design of record. Research notes are read-only reference for where design decisions came from. Resolved open questions migrate to the decision log at the bottom of `06-open-questions.md`.
