# Vision

## One-liner

swarm-coder is a TypeScript coding agent where the atomic unit is a single Claude-backed agent, and the primary product surface is multi-agent swarm orchestration.

## Relationship to claw-code

[claw-code](https://github.com/ultraworkers/claw-code) is a ~20K-LOC Rust reimplementation of Claude Code. We use it as a reference for the *shape* of a production agent harness: tool surface, permission modes, REPL ergonomics, plugin/skill registries, session persistence, MCP lifecycle, provider routing, doctor health check.

We are **not** porting line-for-line. We take the atomic-agent design, implement it in TypeScript around Claude's SDK, and build a swarm orchestration layer on top.

## What makes swarm-coder different

| | claw-code | swarm-coder |
|---|---|---|
| Primary surface | Single-agent CLI (`claw`) | Multi-agent orchestration; atomic unit is spawnable |
| Language | Rust | TypeScript |
| Conversation loop | Built from scratch | Claude Agent SDK (provisional) |
| Multi-provider | First-class (Anthropic + xAI + OpenAI-compat + DashScope) | Anthropic-first; provider interface keeps the door open |
| UI | rustyline REPL | ink (rich TUI) + headless JSONL for workers |
| Scope | Full Claude Code parity | Tier-driven; MVP ships Tier 0 + swarm primitives |

## Core principle

**One agent is a tool. N coordinated agents is the product.**

The single-agent CLI must stay useful on its own. But every design decision asks: "does this still work when a parent orchestrator is spawning fifty of these?"

## Non-goals

- Full claw-code tool parity (40-tool surface)
- Cross-language runtime (no Python, no Rust components)
- Hosted multi-tenant service
- Anthropic Claude subscription auth (API key only)
- Windows-first UX — mac/linux primary, Windows best-effort
