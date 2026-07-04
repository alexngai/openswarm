# Usage & reference

Detailed usage, flags, model routing, tools, and limitations. For the quickstart and installation, see the [README](../README.md); for team topologies and the `TeamSpec` schema, see [docs/25-team-orchestration.md](25-team-orchestration.md).

## Single-agent mode

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

## Swarm run (task fanout)

```bash
openswarm swarm run tasks.jsonl --concurrency 5 --output out.jsonl
```

Fans out tasks across a worker pool with role overlays, retry policies, dead-letter handling, and lane-event telemetry. Pass `--model <id>` to set the default worker model for tasks that do not specify their own `model` field. Task-level `model` wins over the CLI default.

## Subcommands

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

**`--framework codex-native` — the primary path.** Runs OpenSwarm's own `HardenedNativeEngine` against the ChatGPT (codex) Responses backend in-process: no Codex CLI dependency, full access to OpenSwarm tools/hooks/compaction, and prompt-cache-aware compaction sized to the real context window. Backend accepts gpt-5.x only; a non-gpt `--model` is coerced to `gpt-5.5`.

```bash
openswarm login --provider openai-codex
openswarm --framework codex-native "explain this codebase"
```

**`--framework codex-chatgpt` — the team-execution path.** Delegates the agent loop to the locally-installed Codex CLI binary via its App Server (JSON-RPC over stdio). Kept as the codex path for team members until `codex-native` covers team spawns (see [docs/42](42-codex-native-provider-plan.md)).

```bash
npm install -g @openai/codex
codex login
openswarm --framework codex-chatgpt --model gpt-5.4 "explain this codebase"
```

Teams can mix engine frameworks — set `framework` per member (`claude-agent-sdk`, `codex-chatgpt`, `codex-native`, `native`, `hardened-native`) so peers on Claude Max, ChatGPT Plus, and direct API can collaborate in the same team.

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

OpenSwarm is structured around stable abstraction seams:

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

See [`docs/README.md`](README.md) for the full design-doc index. Key references: [Vision](00-vision.md), [Architecture](02-architecture.md), [Tool tiers](04-tool-tiers.md), [Memory system](40-memory-system-design.md), [Team orchestration](25-team-orchestration.md), [git-cascade](29-v0.7-git-cascade-plan.md), [Codex parity](39-codex-parity-gap-analysis.md).
