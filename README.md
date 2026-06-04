# swarm-harness

A TypeScript coding agent where one agent is a tool and N coordinated agents is the product. Built on Anthropic's Claude Agent SDK with first-class multi-agent swarm orchestration, multi-provider support, and a Bun-native interactive REPL.

## Quickstart

```bash
# Download the standalone binary (no Bun/Node required)
curl -fsSL https://github.com/alexngai/swarm-harness/releases/latest/download/swarm-harness-darwin-arm64 -o swarm-harness
chmod +x swarm-harness

# Authenticate (pick one)
export ANTHROPIC_API_KEY=sk-ant-...        # API billing
# or: claude auth login                    # Claude Max subscription

# Run a single agent
./swarm-harness "explain this codebase"

# Run a team of agents
./swarm-harness team start my-team --spec team.yaml
```

## Install

### Standalone binary (recommended)

Download a prebuilt binary from [GitHub Releases](https://github.com/alexngai/swarm-harness/releases):

| Platform | Binary |
|----------|--------|
| macOS (Apple Silicon) | `swarm-harness-darwin-arm64` |
| macOS (Intel) | `swarm-harness-darwin-x64` |
| Linux (x64) | `swarm-harness-linux-x64` |

No runtime dependencies required.

### Build from source

Requires [Bun](https://bun.sh) >= 1.3.8:

```bash
git clone https://github.com/alexngai/swarm-harness.git
cd swarm-harness
bun install
bun run build                  # dist/cli.js (Bun bundle)
bun run build:compile          # dist/swarm-harness (standalone binary)
```

## Authentication

swarm-harness does NOT manage Claude credentials. It detects what's available from your environment and uses it. Three paths for Anthropic; the other providers use plain env-var API keys.

### 1. API key (hits API billing)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
swarm-harness "explain this codebase"
```

Get a key at [console.anthropic.com](https://console.anthropic.com).

### 2. Claude subscription (hits subscription quota)

If you have a Claude Max subscription, use Anthropic's own CLI to authenticate:

```bash
claude auth login
```

This persists credentials to your system keychain (macOS/Linux) or `~/.claude/.credentials.json`. swarm-harness inherits them automatically.

### 3. CI / headless (long-lived token)

```bash
claude setup-token
export CLAUDE_CODE_OAUTH_TOKEN=...
swarm-harness "say hello"
```

**Important:** Per Anthropic's Terms of Service, swarm-harness owns zero auth code. Users authenticate via Anthropic's own tools. swarm-harness only reads what's already available in your environment or keychain.

## Usage

### Single-agent mode

```bash
# Interactive TUI with markdown rendering, syntax highlighting, inline approvals
swarm-harness "explain this codebase"

# Choose a model
swarm-harness --model opus "refactor this codebase for performance"

# Resume a previous session
swarm-harness --resume latest "and now add tests for the changes"

# Read-only mode (bash validation blocks writes)
swarm-harness --permission-mode read-only "find all TypeScript errors"

# Headless mode for CI / orchestrators (structured JSONL output)
swarm-harness --headless --output-format json "list all .ts files"
```

The agent runs in an interactive TUI built on OpenTUI/Solid. Markdown is rendered with syntax-highlighted fenced code blocks (TypeScript, JavaScript, Markdown, Zig via Tree-sitter). It reads files, edits code, runs commands, searches with grep, and iterates until the task is done.

**Keybindings in the input line:** Enter submits, Shift+Enter / Ctrl+J insert a newline, standard Emacs motions (Ctrl+A/E/K/U/W, Alt+B/F/D) work as in `readline`. **Ctrl+S** is "steering" — while the model is mid-turn, type a follow-up and press Ctrl+S to queue it for the next turn boundary without aborting the current turn.

**OpenAI prompt cache** is automatic for `gpt-4o*`, `gpt-5*`, and the `o1`/`o3`/`o4` reasoning models. Each session uses a stable `prompt_cache_key` (a `crypto.randomUUID()` for fresh sessions; the resumed id for `--resume`) so the server-side cache stays warm across turns. Each subprocess worker uses its own `agentId` as its key for the same reason.

### Swarm run (task fanout)

```bash
swarm-harness swarm run tasks.jsonl --concurrency 5 --output out.jsonl
```

Fans out tasks across a worker pool with role overlays, retry policies, dead-letter handling, and lane-event telemetry.

### Team orchestration

Run multi-agent teams using six topology patterns. Teams are defined as openteams YAML templates or inline JSON/YAML `TeamSpec` files.

**Six topologies:**

| Topology | Pattern | Use case |
|----------|---------|----------|
| `fanout` | Parallel independent tasks | Batch processing, map-style workloads |
| `pipeline` | Sequential chained stages | Build → test → deploy, multi-pass refactors |
| `peer-team` | Lateral peers with messaging | Collaborative coding, research teams |
| `coordinator` | Model-driven dynamic spawning | Adaptive teams where the lead decides what's needed |
| `committee` | Consensus from multiple candidates | Code review panels, multi-perspective analysis |
| `critic-loop` | Executor + critic quality gate | Write → review → revise cycles |

**Running a team:**

```bash
# From an openteams template
swarm-harness team start gsd

# From a TeamSpec file
swarm-harness topology peer-team --spec ./team.yaml

# With ecosystem adapters
swarm-harness topology peer-team --spec ./team.yaml \
  --git-cascade \          # worktree-per-member (filesystem isolation)
  --agent-inbox \          # persistent threaded messaging
  --map ws://localhost:8080  # forward events to MAP observer
```

**Example TeamSpec** (`team.yaml`):

```yaml
name: refactor-team
topology: peer-team
members:
  - name: architect
    role: lead
    prompt: "Design the refactoring plan for the auth module"
  - name: implementer
    role: worker
    prompt: "Implement the changes from the architect's plan"
  - name: reviewer
    role: worker
    prompt: "Review the implementation for correctness and style"
coordination:
  mergeStreams:
    targetBranch: main    # auto-merge each member's work to main
```

**Background daemons:**

```bash
swarm-harness team start gsd --detach   # fork a background daemon
swarm-harness team list                 # show running daemons
swarm-harness team logs gsd --follow    # tail live events
swarm-harness team send gsd "add error handling to the API routes"
swarm-harness team stop gsd             # graceful drain
swarm-harness team kill gsd             # immediate stop
```

**Git-cascade worktree isolation** (`--git-cascade`): each team member runs in its own git worktree under `.swarm-harness/worktrees/`. Parallel members edit files without stomping each other. Members can commit with Change-Id trailers for audit trails, and streams auto-merge to a target branch on completion.

```bash
# Pipeline with fork-from-prev: each stage picks up the previous stage's commits
swarm-harness topology pipeline --spec ./pipeline.yaml --git-cascade

# Clean up worktrees after the run
swarm-harness topology peer-team --spec ./team.yaml --git-cascade --cleanup-worktrees

# Manage worktrees manually
swarm-harness worktree list
swarm-harness worktree clean --dry-run
```

### Editor integration (ACP)

swarm-harness speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP), so it runs as an external agent inside ACP-aware editors like [Zed](https://zed.dev). It serves JSON-RPC over stdio:

```bash
swarm-harness acp            # a coordinator team (default)
swarm-harness acp --single   # one agent (the Stage A surface)
```

You won't usually run this by hand — the editor spawns it. In Zed, add to `settings.json`:

```json
{
  "agent_servers": {
    "swarm-harness": {
      "command": "swarm-harness",
      "args": ["acp"]
    }
  }
}
```

Then pick **swarm-harness** in the Agent Panel.

**Team mode (default).** Each ACP session is a coordinator team: you converse with a long-lived **lead** that can spawn peers via the `agent` tool. The lead narrates; every member's tool calls surface `[role]`-attributed (with file locations and inline diffs for edits); the team roster drives a live plan; a member's permission escalation is routed to the editor's approval UI. Member work is also tagged with versioned `_meta.swarm` so a swarm-aware client can re-expand per-member lanes (stock clients ignore it). Follow-up prompts **steer the same root** — the conversation continues with context — and `session/cancel` stops the turn. `session/load` replays a prior team session's transcript (the lead's narration + tool calls + plan board, wall-clock order) and resumes its engine context. Shared flags apply, e.g. `"args": ["acp", "--model", "opus", "--permission-mode", "workspace-write"]`.

**Single mode (`--single`).** One agent per session: streamed text, tool calls, `todo_write` as a plan, permission prompts, and `session/load` transcript replay + resume.

**Known limits.** `bash` output is delivered when the command finishes (not streamed live), reasoning isn't streamed, and file reads/writes run locally (the editor's unsaved buffers aren't consulted). Team mode is *collapsed* by default — the lead is the single narrating voice and raw member chatter is suppressed (opt into `memberText: "interleave"` for speaker-labeled member text). The agent emits `_meta.swarm` enrichment + a `swarm/steer` ext, so a swarm-aware client re-expands per-member lanes and steers mid-turn; `scripts/acp-rich-client.ts` is the reference one ([docs/35](docs/35-acp-b2-rich-client-plan.md), B2 shipped). Stock clients ignore `_meta` and render collapsed. The convention is a published, versioned spec — [docs/36](docs/36-meta-swarm-convention.md) — so any ACP client can adopt it. Team mode also binds one coordinator team per connection: a second `session/new` on the same connection is rejected — open a new connection for a separate team. See [docs/30](docs/30-acp-compatibility-plan.md) / [docs/33](docs/33-teams-acp-implementation-plan.md) for the design and [docs/33 §9](docs/33-teams-acp-implementation-plan.md) for the tracked follow-on backlog.

### Subcommands

```bash
swarm-harness acp                    # serve over the Agent Client Protocol (stdio)
swarm-harness doctor                 # health check (auth, config, install, workspace)
swarm-harness init                   # scaffold .swarm-harness/ + .gitignore + CLAUDE.md
swarm-harness plugin list            # list installed plugins
swarm-harness plugin install <spec>  # install a plugin
swarm-harness help                   # show usage
swarm-harness --version              # print version
```

## Flags

```
--model <id>                   Model id or alias (default: claude-sonnet-4-6)
                               Examples: sonnet, opus, grok, gpt-5, kimi
                               See "Models & aliases" below.

--framework <name>             Engine framework: claude-agent-sdk (default),
                               codex-chatgpt (ChatGPT Plus/Pro via Codex CLI)

--resume <session-id|latest>   Resume a previous session.

--permission-mode <mode>       read-only | workspace-write | danger-full-access
                               Default: workspace-write

--output-format <fmt>          text | json (default: text)

--headless                     Force JSONL output to stdout (no TUI)

--git-cascade                  Enable worktree-per-member isolation (teams)
--cleanup-worktrees            Remove worktrees on team exit (with --git-cascade)
--agent-inbox                  Enable persistent threaded messaging backend
--opentasks                    Mirror tasks to an opentasks daemon
--map <url>                    Forward lane events to a MAP observer

--no-plugins                   Disable plugin discovery
--no-skills                    Disable skill discovery
--no-mcp                       Disable MCP server discovery
--no-hooks                     Disable hook config discovery

--max-tokens <N>               Abort run when cumulative token usage exceeds N.
                               Exits with code 3.
--max-cost-usd <N>             Abort run when estimated cost exceeds $N USD.
                               Exits with code 3.

--help, -h                     Show usage
--version, -V                  Print version
```

## Models & aliases

swarm-harness routes `--model <id>` by prefix to the matching provider transport. Built-in aliases resolve short names to canonical model ids; users can override or extend via `~/.swarm-harness/settings.json`:

```json
{ "aliases": { "my-fast": "gpt-4o-mini" } }
```

| Prefix | Provider | Auth | Built-in aliases |
|---|---|---|---|
| `claude-*` | Anthropic (via Claude Agent SDK) | `ANTHROPIC_API_KEY`, `claude auth login`, or `CLAUDE_CODE_OAUTH_TOKEN` | `opus` → `claude-opus-4-7`, `sonnet` → `claude-sonnet-4-6`, `haiku` → `claude-haiku-4-5` |
| `gpt-*`, `o[134]*`, `openai/*` | OpenAI | `OPENAI_API_KEY` | `gpt-4o` → `gpt-4o-2024-11-20`, `gpt-5` → `gpt-5-2025-08-07`, `o3` → `o3-mini-2025-01-31` |
| `grok*` | xAI | `XAI_API_KEY` | `grok` → `grok-3`, `grok-mini` → `grok-3-mini` |
| `gemini-*` | Google Generative AI | `GOOGLE_GENERATIVE_AI_API_KEY` | (pass-through) |
| `qwen*`, `kimi*` | DashScope (OpenAI-compatible) | `DASHSCOPE_API_KEY` | `kimi` → `kimi-k2.5` |

### `--framework codex-chatgpt` mode

Delegates the agent loop to the locally-installed Codex CLI binary via its App Server (JSON-RPC over stdio). Uses your ChatGPT Plus/Pro subscription quota rather than an API key.

```bash
npm install -g @openai/codex
codex login
swarm-harness --framework codex-chatgpt --model gpt-5.4 "explain this codebase"
```

Teams can mix engine frameworks — peers on Claude Max, ChatGPT Plus, and direct API can collaborate in the same team.

## Tools

Eight Tier 0 tools ship built-in. Additional tools are auto-discovered from plugins, skills, and MCP servers at startup.

| Tool | Purpose |
|------|---------|
| `bash` | Run shell commands with 6-submodule validation (read-only / destructive / mode / sed / path / semantics) |
| `read_file` | Read file contents (up to 10 MiB) with offset/limit |
| `write_file` | Write or create files atomically, respecting workspace boundaries |
| `edit_file` | Replace text in existing files with mandatory uniqueness check |
| `multi_edit` | Atomic batch edits — all succeed or all fail |
| `glob` | Find files by pattern (respects `.gitignore`) |
| `grep` | Search file contents (via bundled ripgrep binary) |
| `todo_write` | Persistent task list scoped to the session |

**Swarm tools** (available to team members): `agent`, `send_message`, `check_inbox`, `task_create`, `task_update`, `task_list`, `task_get`, `task_pull_next`, `task_stop`, `task_output`, `commit_changes`.

**Extension points:**
- **Plugins** — `~/.swarm-harness/plugins/` (owned) + read-only discovery of `~/.claude/plugins/`
- **MCP servers** — first-class stdio client; tools registered as `mcp__<server>__<tool>`
- **Skills** — auto-loaded from `.claude/skills/`
- **Hooks** — PreToolUse / PostToolUse / SessionStart

## Known limitations

- **Per-server MCP failure classification** — basic MCP bridge ships; per-server degraded-mode reporting is partial.
- **Codex peers** see 8 of 10 swarm tools (missing: `agent`, `task_create`, `task_update`).
- **Cron scheduler** — `CronRegistry` is in-memory; scheduled tasks don't persist across restarts.
- **Auto-mode cascade rebase** — the primitive exists but Pipeline topology doesn't auto-invoke it yet.
- **Merge conflict resolution** — conflicts during `mergeStreams` emit lane events but have no interactive resolution UX.
- **Windows** — macOS-first; Linux works but is less tested. No Windows support.

## Architecture

swarm-harness is structured around three stable abstraction seams:

1. **AgentEngine** — pluggable conversation loop (Claude Agent SDK, NativeEngine via Vercel AI SDK, Codex ChatGPT framework)
2. **ToolDispatcher** — tiered tool registry with unified permission gating
3. **SwarmHost** — team orchestration layer (topologies, worker lifecycle, task graph, messaging)

```
src/
  cli/         CLI entry points + slash commands
  engine/      AgentEngine implementations + compaction
  providers/   Multi-provider adapters (Anthropic, OpenAI, xAI, Google, DashScope)
  tools/       Tier 0-2 tool implementations + bash validation
  swarm/       Orchestrator, topologies, worker host, task registry, inbox, git adapters
  mcp/         MCP client + tool bridge
  plugins/     Plugin discovery + lifecycle
  skills/      Skill auto-loading
  hooks/       Hook config + dispatch
  permissions/ Permission engine (mode-based gating)
  session/     Session persistence (JSONL)
  ui/          OpenTUI/Solid REPL + headless JSONL output
  auth/        Auth detection (zero credentials stored)
  core/        Shared type definitions
```

Design docs live in `docs/` (37 markdown files). Key references:

- [Vision](docs/00-vision.md) — one agent is a tool, N coordinated agents is the product
- [Architecture](docs/02-architecture.md) — engine, tools, permissions, session store
- [Tool tiers](docs/04-tool-tiers.md) — what ships at each tier (0-5)
- [Team orchestration](docs/25-team-orchestration.md) — topology catalog, TeamSession, MAP scope semantics
- [git-cascade integration](docs/29-v0.7-git-cascade-plan.md) — worktree-per-member design

Research notes live in `docs/research/` (7 files, 3,300+ lines).

## Contributing

```bash
bun install          # install dependencies
bun run build        # type-check + bundle
npm test             # vitest suite (1893 tests)
bun test src/ui/     # OpenTUI/Solid component tests
```

- File issues at [github.com/alexngai/swarm-harness/issues](https://github.com/alexngai/swarm-harness/issues)
- See [CLAUDE.md](CLAUDE.md) for local development conventions

## License

MIT

## Author

Alex Ngai — [alexander.s.ngai@gmail.com](mailto:alexander.s.ngai@gmail.com)
