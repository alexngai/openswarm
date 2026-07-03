# OpenSwarm

A TypeScript coding agent where one agent is a tool and N coordinated agents is the product. Built on Anthropic's Claude Agent SDK with first-class multi-agent swarm orchestration, multi-provider support, and a Bun-native interactive REPL.

## Quickstart

```bash
# Run without installing (npm picks the right platform binary)
npx openswarm "explain this codebase"

# Authenticate first (pick one)
export ANTHROPIC_API_KEY=sk-ant-...        # API billing
# or: claude auth login                    # Claude Max subscription

# Run a team of agents
npx openswarm team start my-team --spec team.yaml
```

## Install

### npm (recommended)

```bash
npm install -g openswarm     # global `openswarm` command
# or run on demand:
npx openswarm "..."
```

The legacy `openswarm` command remains as an alias during the migration.

Requires **Node.js >= 22**. Installing pulls in a self-contained, prebuilt
binary for your platform (shipped as an `optionalDependencies` package) that
bundles the Bun runtime and the full interactive TUI — no Bun install needed.

**Platform support:**

| Platform | Interactive TUI | Headless / swarm / ACP / API |
|----------|:---:|:---:|
| macOS (Apple Silicon) — `darwin-arm64` | ✅ | ✅ |
| macOS (Intel) — `darwin-x64` | ✅ | ✅ |
| Linux (x64) — `linux-x64` | ✅ | ✅ |
| Other platforms (Node ≥ 20) | — | ✅ |

On platforms without a prebuilt binary, the pure-Node launcher still runs every
headless, swarm, ACP, and programmatic-API path; only the interactive TUI
(which needs the Bun runtime) is unavailable and degrades to headless output.

### Standalone binary

Prefer a single file with no npm at all? Download a prebuilt binary from
[GitHub Releases](https://github.com/alexngai/openswarm/releases):

```bash
curl -fsSL https://github.com/alexngai/openswarm/releases/latest/download/openswarm-darwin-arm64 -o openswarm
chmod +x openswarm
./openswarm "explain this codebase"
```

| Platform | Binary |
|----------|--------|
| macOS (Apple Silicon) | `openswarm-darwin-arm64` |
| macOS (Intel) | `openswarm-darwin-x64` |
| Linux (x64) | `openswarm-linux-x64` |

No runtime dependencies required.

### Build from source

Requires [Bun](https://bun.sh) >= 1.3.8:

```bash
git clone https://github.com/alexngai/openswarm.git
cd openswarm
bun install
bun run build                  # dist/ (node bundle)
bun run build:compile          # packages/cli-<platform>/openswarm (standalone binary)
```

## Authentication

OpenSwarm does NOT manage Claude credentials. It detects what's available from your environment and uses it. Three paths for Anthropic; the other providers use plain env-var API keys.

### 1. API key (hits API billing)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
openswarm "explain this codebase"
```

Get a key at [console.anthropic.com](https://console.anthropic.com).

### 2. Claude subscription (hits subscription quota)

If you have a Claude Max subscription, use Anthropic's own CLI to authenticate:

```bash
claude auth login
```

This persists credentials to your system keychain (macOS/Linux) or `~/.claude/.credentials.json`. OpenSwarm inherits them automatically.

### 3. CI / headless (long-lived token)

```bash
claude setup-token
export CLAUDE_CODE_OAUTH_TOKEN=...
openswarm "say hello"
```

**Important:** Per Anthropic's Terms of Service, OpenSwarm owns zero auth code. Users authenticate via Anthropic's own tools. OpenSwarm only reads what's already available in your environment or keychain.

## Usage

### Single-agent mode

```bash
# Interactive TUI with markdown rendering, syntax highlighting, inline approvals
openswarm "explain this codebase"

# Choose a model
openswarm --model opus "refactor this codebase for performance"

# Resume a previous session
openswarm --resume latest "and now add tests for the changes"

# Read-only mode (bash validation blocks writes)
openswarm --permission-mode read-only "find all TypeScript errors"

# Headless mode for CI / orchestrators (structured JSONL output)
openswarm --headless --output-format json "list all .ts files"
```

The agent runs in an interactive TUI built on OpenTUI/Solid. Markdown is rendered with syntax-highlighted fenced code blocks (TypeScript, JavaScript, Markdown, Zig via Tree-sitter). It reads files, edits code, runs commands, searches with grep, and iterates until the task is done.

**Keybindings in the input line:** Enter submits, Shift+Enter / Ctrl+J insert a newline, standard Emacs motions (Ctrl+A/E/K/U/W, Alt+B/F/D) work as in `readline`. **Ctrl+S** is "steering" — while the model is mid-turn, type a follow-up and press Ctrl+S to queue it for the next turn boundary without aborting the current turn.

**OpenAI prompt cache** is automatic for `gpt-4o*`, `gpt-5*`, and the `o1`/`o3`/`o4` reasoning models. Each session uses a stable `prompt_cache_key` (a `crypto.randomUUID()` for fresh sessions; the resumed id for `--resume`) so the server-side cache stays warm across turns. Each subprocess worker uses its own `agentId` as its key for the same reason.

### Swarm run (task fanout)

```bash
openswarm swarm run tasks.jsonl --concurrency 5 --output out.jsonl
```

Fans out tasks across a worker pool with role overlays, retry policies, dead-letter handling, and lane-event telemetry.
Pass `--model <id>` to set the default worker model for tasks that do not
specify their own `model` field. Task-level `model` wins over the CLI default.

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
openswarm team start gsd

# From a TeamSpec file
openswarm topology peer-team --spec ./team.yaml

# With ecosystem adapters
openswarm topology peer-team --spec ./team.yaml \
  --git-cascade \          # worktree-per-member (filesystem isolation)
  --agent-inbox \          # persistent threaded messaging
  --map ws://localhost:8080  # forward events to MAP observer
```

Pass `--model <id>` to set the default model for members that do not specify
their own `model`. A member-level `model` in the TeamSpec wins over the CLI
default.

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
openswarm team start gsd --detach   # fork a background daemon
openswarm team list                 # show running daemons
openswarm team logs gsd --follow    # tail live events
openswarm team send gsd "add error handling to the API routes"
openswarm team stop gsd             # graceful drain
openswarm team kill gsd             # immediate stop
```

**Git-cascade worktree isolation** (`--git-cascade`): each team member runs in its own git worktree under `.openswarm/worktrees/`. Parallel members edit files without stomping each other. Members can commit with Change-Id trailers for audit trails, and streams auto-merge to a target branch on completion.

```bash
# Pipeline with fork-from-prev: each stage picks up the previous stage's commits
openswarm topology pipeline --spec ./pipeline.yaml --git-cascade

# Clean up worktrees after the run
openswarm topology peer-team --spec ./team.yaml --git-cascade --cleanup-worktrees

# Manage worktrees manually
openswarm worktree list
openswarm worktree clean --dry-run
```

### Editor integration (ACP)

OpenSwarm speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP), so it runs as an external agent inside ACP-aware editors like [Zed](https://zed.dev). It serves JSON-RPC over stdio:

```bash
openswarm acp            # a coordinator team (default)
openswarm acp --single   # one agent (the Stage A surface)
```

You won't usually run this by hand — the editor spawns it. In Zed, add to `settings.json`:

```json
{
  "agent_servers": {
    "openswarm": {
      "command": "openswarm",
      "args": ["acp"]
    }
  }
}
```

Then pick **OpenSwarm** in the Agent Panel.

**Team mode (default).** Each ACP session is a coordinator team: you converse with a long-lived **lead** that can spawn peers via the `agent` tool. The lead narrates; every member's tool calls surface `[role]`-attributed (with file locations and inline diffs for edits); the team roster drives a live plan; a member's permission escalation — or a question — is routed to the editor's approval UI. Member work is also tagged with versioned `_meta.swarm` so a swarm-aware client can re-expand per-member lanes (stock clients ignore it). Follow-up prompts **steer the same root** — the conversation continues with context — and `session/cancel` stops the turn. `session/load` replays a prior team session's transcript (the lead's narration + `[role]` tool calls *with arguments* + plan board, wall-clock order) and resumes its engine context. Shared flags apply, e.g. `"args": ["acp", "--model", "opus", "--permission-mode", "workspace-write"]`.

**Single mode (`--single`).** One agent per session: streamed text, tool calls, `todo_write` as a plan, permission prompts, and `session/load` transcript replay + resume.

**Known limits.** `bash` output is delivered when the command finishes (not streamed live), reasoning isn't streamed, and file reads/writes run locally (the editor's unsaved buffers aren't consulted). Team mode is *collapsed* by default — the lead is the single narrating voice and raw member chatter is suppressed (opt into `memberText: "interleave"` for speaker-labeled member text). The agent emits `_meta.swarm` enrichment + a `swarm/steer` ext, so a swarm-aware client re-expands per-member lanes and steers mid-turn; `scripts/acp-rich-client.ts` is the reference one ([docs/archive/35](docs/archive/35-acp-b2-rich-client-plan.md), B2 shipped). Stock clients ignore `_meta` and render collapsed. The convention is a published, versioned spec — [docs/36](docs/36-meta-swarm-convention.md) — so any ACP client can adopt it. Team mode also binds one coordinator team per connection: a second `session/new` on the same connection is rejected — open a new connection for a separate team. The full design lives in [docs/archive/30–36](docs/31-teams-acp-design.md): Stage A ([32](docs/archive/32-acp-implementation-plan.md)), the team stages B0–B2 ([33](docs/archive/33-teams-acp-implementation-plan.md)/[34](docs/archive/34-acp-b1-meta-swarm-plan.md)/[35](docs/archive/35-acp-b2-rich-client-plan.md)), and the published `_meta.swarm` convention ([36](docs/36-meta-swarm-convention.md)).

### Subcommands

```bash
openswarm acp                    # serve over the Agent Client Protocol (stdio)
openswarm doctor                 # health check (auth, config, install, workspace)
openswarm init                   # scaffold .openswarm/ + .gitignore + CLAUDE.md
openswarm plugin list            # list installed plugins
openswarm plugin install <spec>  # install a plugin
openswarm help                   # show usage
openswarm --version              # print version
```

## Flags

```
--model <id>                   Model id or alias (default: claude-sonnet-4-6)
                               Examples: sonnet, opus, grok, gpt-5, kimi
                               See "Models & aliases" below.

--framework <name>             Engine framework. Default: auto (Claude → Agent
                               SDK; every other model → hardened native engine).
                               codex-native   ChatGPT-subscription path, primary
                                              (in-process; no Codex CLI)
                               codex-chatgpt  ChatGPT via the local Codex CLI
                                              (team-execution path)
                               claude-agent-sdk | native | hardened-native

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

OpenSwarm routes `--model <id>` by prefix to the matching provider transport. Built-in aliases resolve short names to canonical model ids; users can override or extend via `~/.openswarm/settings.json`:

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

### ChatGPT subscription: `codex-native` (primary) vs `codex-chatgpt`

Two ways to spend ChatGPT Plus/Pro quota instead of an API key:

**`--framework codex-native` — the primary path.** Runs OpenSwarm's own
`HardenedNativeEngine` against the ChatGPT (codex) Responses backend in-process:
no Codex CLI dependency, full access to OpenSwarm tools/hooks/compaction, and
prompt-cache-aware compaction sized to the real context window. Backend accepts
gpt-5.x only; a non-gpt `--model` is coerced to `gpt-5.5`.

```bash
openswarm login --provider openai-codex
openswarm --framework codex-native "explain this codebase"
```

**`--framework codex-chatgpt` — the team-execution path.** Delegates the agent
loop to the locally-installed Codex CLI binary via its App Server (JSON-RPC over
stdio). Kept as the codex path for team members until `codex-native` covers team
spawns (see `docs/42`).

```bash
npm install -g @openai/codex
codex login
openswarm --framework codex-chatgpt --model gpt-5.4 "explain this codebase"
```

Teams can mix engine frameworks — set `framework` per member
(`claude-agent-sdk`, `codex-chatgpt`, `codex-native`, `native`,
`hardened-native`) so peers on Claude Max, ChatGPT Plus, and direct API can
collaborate in the same team.

## Tools

Fourteen Tier 0 tools ship built-in. Additional tools are auto-discovered from plugins, skills, and MCP servers at startup.

| Tool | Purpose |
|------|---------|
| `bash` | Run shell commands with 6-submodule validation (read-only / destructive / mode / sed / path / semantics) |
| `read_file` | Read file contents (up to 10 MiB) with offset/limit |
| `write_file` | Write or create files atomically, respecting workspace boundaries |
| `edit_file` | Replace text in existing files with mandatory uniqueness check |
| `multi_edit` | Atomic batch edits — all succeed or all fail |
| `apply_patch` | Apply a multi-file unified patch atomically |
| `glob` | Find files by pattern (respects `.gitignore`) |
| `grep` | Search file contents (via bundled ripgrep binary) |
| `todo_write` | Persistent task list scoped to the session |
| `shell_exec` | Persistent shell sessions surviving across tool calls |
| `shell_write` | Send input / signals to a running shell session |
| `shell_list` | List, inspect, reattach, or close shell sessions |
| `memory_manage` | Manage curated memory entries that persist across sessions |
| `memory_search` | Search past session archives and memories |

The single-agent REPL and headless paths additionally register `request_permissions`, which lets the model ask to raise the permission mode mid-session (bounded by the CLI ceiling); the user approves via the normal permission prompt. It is not advertised on ACP bridges or swarm workers yet.

**Swarm tools** (available to team members): `agent`, `send_message`, `check_inbox`, `task_create`, `task_update`, `task_list`, `task_get`, `task_pull_next`, `task_stop`, `task_output`, `commit_changes`.

**Extension points:**
- **Plugins** — `~/.openswarm/plugins/` (owned) + read-only discovery of `~/.claude/plugins/`
- **MCP servers** — first-class stdio client; tools registered as `mcp__<server>__<tool>`
- **Skills** — auto-loaded from `.claude/skills/`
- **Hooks** — PreToolUse / PostToolUse / SessionStart / SessionEnd / Stop / PermissionRequest / SubagentStart / SubagentStop / PreCompact / PostCompact / UserPromptSubmit

## Known limitations

- **Per-server MCP failure classification** — basic MCP bridge ships; per-server degraded-mode reporting is partial.
- **Codex peers** see 8 of 10 swarm tools (missing: `agent`, `task_create`, `task_update`).
- **Cron scheduler** — `CronRegistry` is in-memory; scheduled tasks don't persist across restarts.
- **Auto-mode cascade rebase** — the primitive exists but Pipeline topology doesn't auto-invoke it yet.
- **Merge conflict resolution** — conflicts during `mergeStreams` emit lane events but have no interactive resolution UX.
- **Windows** — macOS-first; Linux works but is less tested. No Windows support.

## Architecture

OpenSwarm is structured around three stable abstraction seams:

1. **AgentEngine** — pluggable conversation loop (Claude Agent SDK, NativeEngine via Vercel AI SDK, Codex ChatGPT framework)
2. **ToolDispatcher** — tiered tool registry with unified permission gating
3. **SwarmHost** — team orchestration layer (topologies, worker lifecycle, task graph, messaging)
4. **MemoryCoordinator** — cross-session memory with pluggable providers (curated memory, skills, session archive)

```
src/
  cli/         CLI entry points + slash commands
  engine/      AgentEngine implementations + compaction
  providers/   Multi-provider adapters (Anthropic, OpenAI, xAI, Google, DashScope)
  tools/       Tier 0-2 tool implementations + bash validation
  swarm/       Orchestrator, topologies, worker host, task registry, inbox, git adapters
  memory/      4-layer memory system (curated, skills, archive, providers)
  state/       SQLite-backed state database (sessions, goals, memory, audit log)
  context/     Composable system prompt fragments with priority ordering
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

Design docs live in `docs/` (40 markdown files; see [`docs/README.md`](docs/README.md) for the index). Key references:

- [Vision](docs/00-vision.md) — one agent is a tool, N coordinated agents is the product
- [Architecture](docs/02-architecture.md) — engine, tools, permissions, session store
- [Tool tiers](docs/04-tool-tiers.md) — what ships at each tier (0-5)
- [Memory system](docs/40-memory-system-design.md) — 4-layer memory architecture (curated, skills, archive, providers)
- [Team orchestration](docs/25-team-orchestration.md) — topology catalog, TeamSession, MAP scope semantics
- [git-cascade integration](docs/29-v0.7-git-cascade-plan.md) — worktree-per-member design
- [Codex parity](docs/39-codex-parity-gap-analysis.md) — gap analysis vs OpenAI Codex CLI

Research notes live in `docs/research/` (7 files, 3,300+ lines).

## Contributing

```bash
bun install          # install dependencies
bun run build        # type-check + bundle
npm test             # vitest suite (3,500+ tests)
bun test src/ui/     # OpenTUI/Solid component tests
```

### Package management

Both lockfiles are tracked deliberately:

- **`package-lock.json` is canonical** — CI installs with `npm ci`, and all
  dependency changes should go through `npm install <pkg>`.
- **`bun.lock` feeds the compiled-binary build** (`npm run build:compile`),
  which resolves dependencies with Bun.

After any dependency change, resync the Bun lockfile with
`bun install --lockfile-only` and commit both files. CI enforces this with a
`bun install --frozen-lockfile --dry-run` check, so a stale `bun.lock` fails
the build instead of shipping a binary built from different resolutions.

- File issues at [github.com/alexngai/openswarm/issues](https://github.com/alexngai/openswarm/issues)
- See [CLAUDE.md](CLAUDE.md) for local development conventions

## License

MIT

## Author

Alex Ngai — [alexander.s.ngai@gmail.com](mailto:alexander.s.ngai@gmail.com)
