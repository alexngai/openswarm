# swarm-harness

A TypeScript coding agent built on Anthropic's Claude Agent SDK with first-class swarm-orchestration support. Multi-provider, scriptable for `--headless` runs, and shipping a Bun-native interactive REPL.

## Status

**v0.1-ready** as of 2026-04-30. Phases 0–5.5 of the [parity plan](docs/16-parity-plan.md) are complete; Phase 6 (OpenAI OAuth) is blocked on an external dependency. See [docs/20-v0.1-launch.md](docs/20-v0.1-launch.md) for the full ship checklist.

**Runtime:** Bun ≥ 1.3.8 (the OpenTUI/Solid REPL uses `bun:ffi`). A standalone compiled binary is produced via `bun build --compile` so end users don't need to install Bun separately.

**What ships:**

- Single-agent CLI + interactive REPL with markdown rendering, syntax-highlighted fenced code blocks, native tables, and inline y/N permission prompts.
- Swarm orchestration: `WorkerPool`, lane events, role overlays, ancestry tracking, message inbox, role-based addressing.
- Multi-provider: Anthropic (SDK + direct), OpenAI, xAI (Grok), Google Generative AI, DashScope (Qwen / Kimi).
- Plugins discovered from `~/.swarm-harness/plugins/` (owned namespace) + read-only discovery of `~/.claude/plugins/` (Claude Code's namespace).
- MCP servers (first-class client + bridge for tier-2 tools).
- Skills auto-loaded from `.claude/skills/`.
- Hooks: PreToolUse / PostToolUse / SessionStart wired through the dispatcher.
- Persistent prompt history at `~/.swarm-harness/history` (10k cap, dedup, multi-line escape).
- Bash-command validation (6 submodules: read-only / destructive / mode / sed / path / semantics) with an inline approval prompt for warn-level cases.
- Worker lifecycle state machine + typed lane-event discriminated union.
- Headless mode (`--headless`) emits structured JSONL for orchestrators / CI.

## Install

Clone and build from source:

```bash
git clone https://github.com/alexngai/swarm-harness.git
cd swarm-harness
bun install
bun run build
```

Output: `dist/cli.js` (Bun bundle) + `dist/swarm-harness` (standalone binary, darwin-arm64). Run via:

```bash
bun dist/cli.js --help
# or
./dist/swarm-harness --help
```

(npm publish + multi-platform binary releases planned for post-v0.1.)

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

### Prompt (interactive)

```bash
swarm-harness "explain this codebase"
swarm-harness prompt "refactor src/foo.ts"
```

The agent runs in an interactive TUI built on OpenTUI/Solid. Markdown is rendered with syntax-highlighted fenced code blocks (TypeScript, JavaScript, Markdown, Zig out of the box via Tree-sitter). It can read files, edit code, run commands, search with grep, and iterate until the task is done. Pressing the Up arrow recalls prior prompts across sessions.

### Doctor (health check)

```bash
swarm-harness doctor
swarm-harness doctor --output-format json
```

Checks auth, config, install, workspace.

### Init (scaffold)

```bash
swarm-harness init
```

Creates `.swarm-harness/` for session state, adds a `.gitignore` entry, drops a stack-detected `CLAUDE.md` if needed. Idempotent.

### Help and version

```bash
swarm-harness help
swarm-harness --version
```

### Plugin management

```bash
swarm-harness plugin list
swarm-harness plugin install <local-path-or-spec>
swarm-harness plugin enable <name>
swarm-harness plugin disable <name>
```

Plugins are persisted to `~/.swarm-harness/plugins/{settings,installed}.json`. Plugins installed via Claude Code (`~/.claude/plugins/`) are discovered read-only.

### Swarm run

```bash
swarm-harness swarm run tasks.jsonl --concurrency 5 --output out.jsonl
```

Fans out tasks across a worker pool with role overlays, retry policies, dead-letter handling, and lane-event telemetry.

## Flags

```
--model <id>                   Model id or alias (default: claude-sonnet-4-6)
                               Examples: sonnet, opus, grok, gpt-5, kimi
                               See "Models & aliases" below.

--resume <session-id|latest>   Resume a previous session.

--permission-mode <mode>       read-only | workspace-write | danger-full-access
                               Default: workspace-write

--output-format <fmt>          text | json (default: text)

--headless                     Force JSONL output to stdout (no TUI)

--no-plugins                   Disable plugin discovery
--no-skills                    Disable skill discovery
--no-mcp                       Disable MCP server discovery
--no-hooks                     Disable hook config discovery

--max-tokens <N>               Abort run when cumulative token usage (input +
                               output + cache) exceeds N. Exits with code 3.
--max-cost-usd <N>             Abort run when estimated cost exceeds $N USD.
                               Uses built-in model pricing table; unknown models
                               ignore cost limit (token limit still applies).
                               Exits with code 3.

--help, -h                     Show usage
--version, -V                  Print version
```

## Examples

```bash
# Simple query
swarm-harness "what does package.json describe?"

# Model selection
swarm-harness --model opus "refactor this codebase for performance"

# Resume and continue
swarm-harness --resume latest "and now add tests for the changes"

# Read-only mode (safe exploration; bash validation blocks writes)
swarm-harness --permission-mode read-only "find all TypeScript errors"

# Headless (for orchestrators)
swarm-harness --headless --output-format json "list all .ts files" \
  | jq '.[] | select(.type == "message_stop")'

# Init a new workspace
swarm-harness init /path/to/project
cd /path/to/project
swarm-harness "set up a test suite"
```

## Models & aliases

swarm-harness routes `--model <id>` by prefix to the matching provider transport. Built-in aliases (in `src/providers/aliases.ts`) resolve short names to canonical model ids; users can override or extend via `~/.swarm-harness/settings.json`:

```json
{ "aliases": { "my-fast": "gpt-4o-mini" } }
```

| Prefix | Provider | Auth | Built-in aliases |
|---|---|---|---|
| `claude-*` | Anthropic (via Claude Agent SDK) | `ANTHROPIC_API_KEY`, `claude auth login`, or `CLAUDE_CODE_OAUTH_TOKEN` | `opus` → `claude-opus-4-7`, `sonnet` → `claude-sonnet-4-6`, `haiku` → `claude-haiku-4-5` |
| `gpt-*`, `o[134]*`, `openai/*` | OpenAI | `OPENAI_API_KEY` | `gpt-4o` → `gpt-4o-2024-11-20`, `gpt-5` → `gpt-5-2025-08-07`, `o3` → `o3-mini-2025-01-31` |
| `grok*` | xAI | `XAI_API_KEY` | `grok` → `grok-3`, `grok-mini` → `grok-3-mini` |
| `gemini-*` | Google Generative AI | `GOOGLE_GENERATIVE_AI_API_KEY` | (pass-through — e.g. `gemini-2.0-flash`) |
| `qwen*`, `qwen/*`, `kimi*`, `kimi/*` | DashScope (OpenAI-compatible) | `DASHSCOPE_API_KEY` | `kimi` → `kimi-k2.5` |

Unknown prefixes fail with `unknown model prefix`. Identity aliases (e.g. `grok-2 → grok-2`) are rejected as cycles — pass unaliased canonical ids directly.

Run `scripts/smoke-m4b.sh --live` to smoke-test each provider with a one-turn "say hi" prompt against whichever of `XAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `DASHSCOPE_API_KEY` are set.

## Tools

swarm-harness ships eight Tier 0 tools, plus tier-1 (skills + plugins) and tier-2 (MCP) tools auto-discovered at startup:

| Tool | Purpose |
|------|---------|
| `bash` | Run shell commands with timeout, output truncation (16 KiB), and command-string validation (6 submodules — see [bash-validation/](src/tools/tier0/bash-validation/)) |
| `read_file` | Read file contents (up to 10 MiB) with offset/limit support |
| `write_file` | Write or create files atomically, respecting workspace boundaries |
| `edit_file` | Replace text in existing files with mandatory uniqueness check |
| `multi_edit` | Atomic batch edits — all succeed or all fail |
| `glob` | Find files by pattern (respects `.gitignore`) |
| `grep` | Search file contents (via bundled ripgrep binary) |
| `todo_write` | Persistent task list scoped to the session |

Each tool:
- Has strict input validation (Zod schemas)
- Respects workspace boundaries (no symlink escape)
- Reports clear error messages on failure
- Can be restricted via `--permission-mode`
- Routes through `canUseTool` for unified Block / Warn / Allow gating

## Known limitations / deferred to v0.2+

- **OpenAI ChatGPT Plus / Pro OAuth** (P4) — blocked on an external Codex endpoint spike. Direct API works via `OPENAI_API_KEY`.
- **Per-server MCP failure classification** (TO2) — basic MCP bridge ships; partial-success / degraded-mode reporting is partial.
- **Server-side token preflight** (A8) — compaction triggers are local heuristics; no `count_tokens` API call yet.
- **Branch-lock / stale-base detection** (A2) — partial git coordination; full claw-parity audit pending.
- **Recovery recipes** (A3), **policy engine** (A4), **sandbox abstraction** (A6), **green contract** (A7) — claw has them; we don't need them yet.
- **Cron scheduler** (PS3) — `CronRegistry` is in-memory; scheduled tasks never fire. Defer until needed.
- **Extended slash commands** (`/ultraplan`, `/teleport`, deeper `/plan`) — could ship as plugins later.
- **Tier-3 tools** (`pdf_extract`, `repl`, `powerShell`) — low value or platform-specific.
- **Mock parity harness** (D1) — preempts no current regression; build when one bites.

See [docs/15-parity-gaps.md](docs/15-parity-gaps.md) for the full gap tracker and [docs/16-parity-plan.md](docs/16-parity-plan.md) for the phased roadmap.

## Design & architecture

- [Vision](docs/00-vision.md) — One agent is a tool. N coordinated agents is the product.
- [Architecture](docs/02-architecture.md) — Engine, tools, permissions, session store
- [Tool tiers](docs/04-tool-tiers.md) — What ships when (Tier 0–3)
- [Parity plan](docs/16-parity-plan.md) — Phased execution against [docs/15-parity-gaps.md](docs/15-parity-gaps.md)
- [Phase design locks](docs/17-parity-design-questions.md) — Per-phase pre-implementation decisions (Q1–Q18, P2.Q1–10, P3.Q1–6)
- [Phase 4 plan](docs/18-phase-4-plan.md) — TUI polish (T1, T6, T7)
- [Phase 5 plan](docs/19-phase-5-plan.md) — Runtime hardening (TO1, A1, A5)
- [v0.1 launch readiness](docs/20-v0.1-launch.md) — Ship checklist

Research notes live in `docs/research/` (3,300+ lines informing the design).

## Contributing

- File issues at [github.com/alexngai/swarm-harness/issues](https://github.com/alexngai/swarm-harness/issues)
- See [CLAUDE.md](CLAUDE.md) for local development setup

## License

MIT

## Author

Alex Ngai — [alexander.s.ngai@gmail.com](mailto:alexander.s.ngai@gmail.com)
