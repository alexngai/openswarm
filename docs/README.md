# swarm-coder design docs

Early design capture for swarm-coder — a TypeScript agent harness built around Claude, where the atomic unit is a single coding agent and the primary product surface is multi-agent swarm orchestration.

## Map

- [00-vision.md](./00-vision.md) — project intent, what swarm-coder is, relationship to claw-code
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
