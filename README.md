# swarm-harness

A TypeScript coding agent built on Anthropic's Claude Agent SDK. M0 is the atomic-unit CLI; swarm orchestration lands in M1+.

## Status

**M0 (current):** Single-agent CLI with Tier 0 tools (bash, file I/O, glob, grep). No swarm orchestration, plugins, or skill loaders yet.

**Node requirement:** ≥ 18

## Install

Clone and build from source:

```bash
git clone https://github.com/alexngai/swarm-harness.git
cd swarm-harness
npm install
npm run build
```

The `swarm-harness` binary is now at `dist/cli.js`. Run via:

```bash
node dist/cli.js --help
```

(npm publish planned for post-M0 stable releases.)

## Authentication

swarm-harness does NOT manage Claude credentials. It detects what's available from your environment and uses it.

Three paths:

### 1. API key (hits API billing)

Set your Anthropic API key in the environment:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node dist/cli.js "explain this codebase"
```

Get a key at [console.anthropic.com](https://console.anthropic.com).

### 2. Claude subscription (hits subscription quota)

If you have a Claude Max subscription, use Anthropic's own CLI to authenticate:

```bash
claude auth login
```

This persists credentials to your system keychain (macOS/Linux) or `~/.claude/.credentials.json`. swarm-harness inherits them automatically.

Then:

```bash
node dist/cli.js "refactor src/foo.ts"
```

### 3. CI / headless (long-lived token)

For non-interactive environments, mint a long-lived token via:

```bash
claude setup-token
```

Export it:

```bash
export CLAUDE_CODE_OAUTH_TOKEN=...
node dist/cli.js "say hello"
```

**Important:** Per Anthropic's Terms of Service, swarm-harness owns zero auth code. Users authenticate via Anthropic's own tools. swarm-harness only reads what's already available in your environment or keychain.

## Usage

### Prompt (interactive)

```bash
# Bare positional shorthand
node dist/cli.js "explain this codebase"

# Explicit `prompt` subcommand
node dist/cli.js prompt "refactor src/foo.ts"
```

The agent runs in an interactive TUI (powered by ink). It can read files, edit code, run commands, search with grep, and iterate until the task is done.

### Doctor (health check)

```bash
node dist/cli.js doctor
```

Checks:
1. **Auth** — detects API key, keychain, or token
2. **Config** — validates `.swarm-harness/` directory
3. **Install** — confirms Tier 0 tools are available
4. **Workspace** — tests file I/O in the current directory

Output format:

```bash
node dist/cli.js doctor --output-format json
```

### Init (scaffold)

```bash
node dist/cli.js init
```

Creates:
- `.swarm-harness/` directory for session state
- `.gitignore` entry
- Stack-detected `CLAUDE.md` with project context (if needed)

Idempotent — safe to run multiple times.

### Help and version

```bash
node dist/cli.js help
node dist/cli.js --version
```

## Flags

```
--model <id>               Model id or alias (default: claude-sonnet-4-6)
                           Examples: sonnet, opus, grok, gpt-5, kimi
                           See "Models & aliases" below.

--resume <session-id|latest>
                           Resume a previous session. Use `latest` to
                           continue from the most recent run.

--permission-mode <mode>   read-only | workspace-write | danger-full-access
                           Default: workspace-write
                           - read-only: agent can read files, run queries,
                             but cannot write or execute shell commands
                           - workspace-write: read + edit files + safe commands
                           - danger-full-access: all tools enabled

--output-format <fmt>      text | json (default: text)
                           Use json for structured parsing or CI integration

--headless                 Force JSONL output to stdout (no TUI)
                           One JSON object per line; useful for orchestrators
                           and CI/CD pipelines

--help, -h                 Show usage
--version, -V              Print version
```

## Examples

```bash
# Simple query
node dist/cli.js "what does package.json describe?"

# Model selection
node dist/cli.js --model opus "refactor this codebase for performance"

# Resume and continue
node dist/cli.js --resume latest "and now add tests for the changes"

# Read-only mode (safe exploration)
node dist/cli.js --permission-mode read-only "find all TypeScript errors"

# Headless (for orchestrators)
node dist/cli.js --headless --output-format json "list all .ts files" \
  | jq '.[] | select(.type == "message_stop")'

# Init a new workspace
node dist/cli.js init /path/to/project
cd /path/to/project
node dist/cli.js "set up a test suite"
```

## Models & aliases

swarm-harness routes `--model <id>` by prefix to the matching provider transport.
Built-in aliases (in `src/providers/aliases.ts`) resolve short names to canonical
model ids; users can override or extend via `~/.swarm-harness/settings.json`:

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

Unknown prefixes fail with `unknown model prefix`. Identity aliases (e.g.
`grok-2 → grok-2`) are rejected as cycles — pass unaliased canonical ids
directly.

Run `scripts/smoke-m4b.sh --live` to smoke-test each provider with a one-turn
"say hi" prompt against whichever of `XAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`,
`DASHSCOPE_API_KEY` are set.

## Tools (M0)

swarm-harness ships with eight Tier 0 tools:

| Tool | Purpose |
|------|---------|
| `bash` | Run shell commands with timeout and output truncation (16 KiB) |
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

## Not in M0

These features ship later:

- **Swarm orchestration** (M1) — multi-agent coordination, task fanout, message lanes
- **Plugins & skills** (M2) — extend agent behavior via `.claude/plugins` and `.claude/skills`
- **MCP servers** (M2) — first-class MCP client (M0 uses the Agent SDK's built-in)
- **Interactive REPL** (M2) — slash commands, tab completion, history
- ~~**Multi-provider** (M4) — OpenAI, xAI, Gemini, DashScope shipped. See "Models & aliases".~~
- **Subscription auth for other platforms** (M4) — ChatGPT Plus, Codex, etc.
- **Full permission rule grammar** (M2) — fine-grained tool/subject filtering

## Design & architecture

See the design docs:

- [Vision](docs/00-vision.md) — One agent is a tool. N coordinated agents is the product.
- [Architecture](docs/02-architecture.md) — Engine, tools, permissions, session store
- [Tool tiers](docs/04-tool-tiers.md) — What ships when (Tier 0–3)
- [M0 implementation plan](docs/08-m0-plan.md) — Acceptance criteria and phases
- [Open questions](docs/06-open-questions.md) — Design decisions and tradeoffs (including Q16 on auth)

Research notes live in `docs/research/` (3,300+ lines informing the design).

## Contributing

- File issues at [github.com/alexngai/swarm-harness/issues](https://github.com/alexngai/swarm-harness/issues)
- See [CLAUDE.md](CLAUDE.md) for local development setup

## License

MIT

## Author

Alex Ngai — [alexander.s.ngai@gmail.com](mailto:alexander.s.ngai@gmail.com)
