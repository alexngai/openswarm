<h1 align="center">OpenSwarm</h1>

<p align="center">See and steer a swarm of coding agents.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/openswarm"><img alt="npm" src="https://img.shields.io/npm/v/openswarm?style=flat-square" /></a>
  <a href="#license"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <img alt="Node >= 22" src="https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat-square" />
  <img alt="3,500+ tests" src="https://img.shields.io/badge/tests-3%2C500%2B-brightgreen?style=flat-square" />
</p>

<p align="center">
  <img src="demo/see-and-steer.gif" alt="openswarm team watch — see and steer your swarm" width="820" />
</p>

---

OpenSwarm is a multi-agent-**first** coding CLI: launch a team of agents on one task, watch every member work in a live board, and steer them mid-run — all from your terminal. One agent is a tool; **N coordinated agents is the product.**

### Installation

```bash
npm install -g openswarm      # global `openswarm` command
npx openswarm "explain this codebase"   # or run on demand
```

Requires **Node.js >= 22**. Installing pulls a self-contained, prebuilt binary for your platform (macOS arm64/x64, Linux x64) that bundles the interactive TUI — no Bun install needed. Other platforms still run every headless, swarm, ACP, and API path. Prefer a single file? Grab a standalone binary from [GitHub Releases](https://github.com/alexngai/openswarm/releases). Build from source with [Bun](https://bun.sh) `>= 1.3.8`: `bun install && bun run build`.

### Authentication

OpenSwarm stores **zero credentials** — it reads what's already in your environment or keychain.

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # API billing
claude auth login                     # Claude Max subscription (via Anthropic's own CLI)
claude setup-token                    # CI / headless → CLAUDE_CODE_OAUTH_TOKEN
```

Other providers use plain API-key env vars — OpenAI, xAI, Google, DashScope. ChatGPT Plus/Pro works via `--framework codex-native`. Team members can mix providers, so peers on Claude Max, ChatGPT Plus, and direct API keys collaborate in one team.

### Quickstart

```bash
# Single agent, interactive
openswarm "explain this codebase"

# A team of agents — no YAML, built-in presets (review | fix | refactor)
openswarm team start review --detach

# Watch the swarm live, then steer it mid-run (from another shell)
openswarm team watch review
openswarm team send review "also check error handling"
openswarm team stop review            # graceful drain when done
```

`team watch` renders a live multi-pane board: every member gets a `[role]` lane with inline edit diffs, per-member `tok · $`, and a running `Σ team` cost ledger, while a shared task board flips ◐→● as work lands.

### Multi-agent teams

Beyond the built-in presets, teams are defined as [OpenTeams](docs/25-team-orchestration.md#54-openteams-yaml-compatibility) YAML templates or inline `TeamSpec` files, across six topologies:

`fanout` · `pipeline` · `peer-team` · `coordinator` · `committee` · `critic-loop`

```bash
openswarm topology peer-team --spec ./team.yaml --git-cascade
```

`--git-cascade` gives each member its own git worktree so parallel agents edit files without stomping each other, then auto-merges to a target branch. Full topology catalog, TeamSpec schema, and daemon commands (`team list`/`logs`/`status`/`stop`) are in [docs/25-team-orchestration.md](docs/25-team-orchestration.md).

### Editor integration (ACP)

OpenSwarm speaks the [Agent Client Protocol](https://agentclientprotocol.com), so it runs as an agent inside editors like [Zed](https://zed.dev). Add to Zed's `settings.json`:

```json
{ "agent_servers": { "openswarm": { "command": "openswarm", "args": ["acp"] } } }
```

Each ACP session is a coordinator team: you converse with a long-lived lead that spawns peers, and every member's tool calls surface `[role]`-attributed with inline diffs. Details in [docs/36-meta-swarm-convention.md](docs/36-meta-swarm-convention.md).

### Tools & extensibility

Fourteen built-in Tier-0 tools (`bash`, `read_file`, `edit_file`, `multi_edit`, `apply_patch`, `glob`, `grep`, shell sessions, memory, and more), plus swarm tools for team members (`agent`, `send_message`, task graph, `commit_changes`). Extend via **plugins**, **MCP servers**, **skills**, and **hooks**. Run `openswarm --help` for all flags, or `openswarm doctor` for a health check. Full flag, model-routing, tool, and provider reference is in [docs/USAGE.md](docs/USAGE.md).

### Documentation

Full CLI reference (flags, models, tools, limitations, architecture) is in [docs/USAGE.md](docs/USAGE.md). Design docs live in [`docs/`](docs/README.md) — start with the [vision](docs/00-vision.md), [architecture](docs/02-architecture.md), [team orchestration](docs/25-team-orchestration.md), and [tool tiers](docs/04-tool-tiers.md).

### Contributing

```bash
bun install          # install dependencies
bun run build        # type-check + bundle
npm test             # vitest suite (3,500+ tests)
```

Both lockfiles are tracked deliberately: `package-lock.json` is canonical (CI uses `npm ci`); `bun.lock` feeds the compiled-binary build — resync with `bun install --lockfile-only` after any dependency change. See [CONTRIBUTING.md](CONTRIBUTING.md) and [CLAUDE.md](CLAUDE.md). File issues at [github.com/alexngai/openswarm/issues](https://github.com/alexngai/openswarm/issues).

### License

MIT © [Alex Ngai](mailto:alexander.s.ngai@gmail.com)
