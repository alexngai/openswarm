<h1 align="center">OpenSwarm</h1>

<p align="center">Run a swarm of coding agents — peer teams, worktree isolation, heterogeneous models — on <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>.</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" />
  <img alt="Node >= 22" src="https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat-square" />
  <img alt="status: developer preview" src="https://img.shields.io/badge/status-developer%20preview-orange?style=flat-square" />
</p>

---

OpenSwarm is a multi-agent coding system: launch a **team** of agents on one task, run each member in its own isolated git worktree, mix cheap and frontier models in one roster, and let peers message each other mid-run. One agent is a tool; **N coordinated agents is the product.**

It is built as a set of **out-of-tree plugins on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** (`dsh`, Cordis-based) — the harness supplies the agent loop, tools, sessions, and sandbox; OpenSwarm adds the swarm layer (`ctx.swarm`), the git worktree/merge layer, model adapters, a JSON-RPC app-server, and agent-authored plugins. The design rationale lives in [`docs/01-dsh-foundation.md`](docs/01-dsh-foundation.md).

> **Developer preview.** OpenSwarm runs on a pinned pre-release of `dsh`; expect breaking changes.

## What it does

- **Peer + hierarchical teams** — seven topologies (fanout, critic-loop, cascade, committee, pipeline, peer-team, coordinator) over a durable, log-backed task board and mailbox. Peers send each other messages that wake a teammate's turn.
- **Worktree isolation** — each member runs as a full subprocess harness in its own git worktree; a sequential merge queue folds completed branches, conflicts are retained for inspection, and your checkout is never touched.
- **Heterogeneous, cross-provider rosters** — route cheap tiers to Bedrock haiku and hard work to Azure gpt-5.5 in one cascade, with per-model usage accounting.
- **App-server** — a JSON-RPC interface (`swarm/runTeam`, `swarm/runs`, `swarm/board`, streamed events) any UI/TUI can drive over a socket.
- **Agent-authored plugins** — an agent can write and hot-load a Cordis plugin into its own harness (freely) or the shared one (with approval).

## Install

As a package (once published):

```bash
npm install -g openswarm      # global `openswarm` command
# or: npx openswarm "explain this codebase"
```

From a clone (development):

```bash
git clone https://github.com/alexngai/openswarm
cd openswarm && npm install && npm run build   # ./bin/openswarm ...
```

Requires **Node.js ≥ 22**. The launcher works identically whether installed or run from a clone — it resolves the harness and its own plugin packages through Node and initializes its profiles on first use.

## Configure a model provider

OpenSwarm stores **zero credentials** — it reads your environment. Set one of:

```bash
# Azure OpenAI
export AZURE_API_BASE=https://<resource>.openai.azure.com
export AZURE_API_KEY=...
# OpenAI
export OPENAI_API_KEY=sk-...
# Bedrock (Anthropic)
export AWS_BEARER_TOKEN_BEDROCK=...   # + AWS_REGION
```

The launcher auto-detects the provider (Azure → OpenAI → Bedrock). Override with `--provider` / `--model`.

## Quickstart

```bash
./bin/openswarm "explain what this repository does"      # one-shot task
./bin/openswarm --model gpt-5.5 "fix the failing test"
./bin/openswarm config                                   # show resolved provider/model/home
./bin/openswarm serve --port 4620                        # start the JSON-RPC app-server
```

The launcher initializes its profiles on first use (into `~/.openswarm`, override with `--home` / `$OPENSWARM_HOME`), auto-detects your provider, and boots the composed `dsh` harness. See [`docs/03-usage.md`](docs/03-usage.md) for the full runbook — profiles, the app-server wire protocol, driving a team programmatically, and the eval harness.

## How it's structured

| Package | Role |
|---|---|
| `openswarm-swarm` | `ctx.swarm`: topologies, log-backed board, peer mailbox |
| `openswarm-git` | per-task worktrees, auto-commit, merge queue |
| `openswarm-llm-openai` | OpenAI-compatible adapter (Azure, LiteLLM, any Bearer endpoint) |
| `openswarm-llm-anthropic` | Anthropic Messages adapter (Bedrock + direct API) |
| `openswarm-app-server` | JSON-RPC interface for UIs/TUIs |
| `openswarm-plugin-authoring` | agent-authored, hot-loaded plugins |
| `openswarm-bundle` | the dsh bundle stacking all of the above over `dsh-base` |

Two profiles: **`openswarm`** (headless one-shot, HMR cold — the default) and **`openswarm-dev`** (app-server + hot HMR).

## Develop

```bash
npm test                              # full suite (keyless, uses a scripted mock LLM)
npm run typecheck                     # tsc across every package
OPENSWARM_LIVE=1 npm test             # also run the env-gated live tests (needs creds)
```

The reusable live/integration harness for peer messaging lives in [`packages/swarm/tests/support/board-harness.ts`](packages/swarm/tests/support/board-harness.ts); the same scenarios run mock (CI) and live (real model).

## Legacy

The pre-rewrite v0.x implementation (TUI, single-binary CLI) is frozen under [`legacy/`](legacy/) for reference. It is not maintained; new work is the dsh-based stack above.

## License

MIT.
