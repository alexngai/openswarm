# 06 — CLI, REPL, Slash Commands, Doctor, Bootstrap

Source: `references/claw-code/rust/crates/rusty-claude-cli/`, `crates/commands/`, and select `crates/runtime/` modules. Binary name is `claw`; its first-run guidance is `/doctor`.

## 1. Summary

Claw-code's user-facing surface is a Rust CLI with:

- A thin hand-rolled argv parser (not clap) in `main.rs::parse_args` — supports a small top-level flag set, a handful of verb subcommands, and a shorthand where a bare positional becomes a one-shot prompt.
- A `rustyline`-powered REPL with slash-command tab completion, Emacs editing, Shift+Enter / Ctrl+J for newline, history, and a fallback for non-TTY stdin.
- A single hard-coded slash-command registry in `crates/commands/src/lib.rs` with **~140 specs** (`SlashCommandSpec { name, aliases, summary, argument_hint, resume_supported }`). Most are stubs routed to the LLM; a dozen or so are implemented natively.
- `claw doctor` runs six local-only diagnostic checks (auth, config, install source, workspace, sandbox, system) and emits text or JSON. No network call.
- `claw init` creates `.claw/`, `.claw.json`, appends gitignore entries, and writes a detected-stack `CLAUDE.md`.
- A declarative `BootstrapPlan` enum lists startup fast-path phases (for a telemetry/introspection surface rather than actual control flow).
- `TrustResolver` handles folder-trust prompts; `recovery_recipes` enumerates seven known failure scenarios with one-shot auto-recovery; `GreenContract` is a verification gating type.

For openswarm, the claw CLI is a reasonable v0 blueprint **with heavy trimming** — the slash registry is 10x larger than we need, and many surfaces (acp, sandbox, cron, team, bughunter, stickers) are claw-specific noise.

## 2. CLI surface

Binary: `claw`. Parser is `main.rs::parse_args` (hand-rolled — easy to port to `commander`/`yargs`/raw argv walk).

### Top-level flags (global, pre-subcommand)

| Flag | Behavior |
|---|---|
| `--model MODEL` | Override active model; aliases `opus`/`sonnet`/`haiku` resolve to full IDs. Defaults to `claude-opus-4-6`. |
| `--output-format text\|json` | Affects non-interactive subcommands (`doctor`, `status`, `sandbox`, `version`, `prompt`, `agents`, `mcp`, `skills`, `init`, `bootstrap-plan`, `dump-manifests`, `system-prompt`, `acp`). Invalid suffix flags are rejected at parse time. |
| `--permission-mode MODE` | `read-only` \| `workspace-write` \| `danger-full-access`. |
| `--dangerously-skip-permissions` | Bypass all permission checks. |
| `--allowedTools TOOLS` \| `--allowed-tools TOOLS` | Comma-separated allowlist (repeatable). |
| `--resume [SESSION.jsonl\|session-id\|latest]` | Load a saved session; trailing args must be slash commands, executed non-interactively. |
| `--compact` | Strip tool call details from text output — print only final assistant text (prompt mode only). |
| `--base-commit` | Stale-base preflight comparison target. |
| `-p "..."` | Claw-compat one-shot prompt shorthand. |
| `--acp` / `-acp` | Alias for `acp` subcommand (discoverability only today). |
| `--version` / `-V` | Version + build info (BUILD_DATE, GIT_SHA, BUILD_TARGET). |
| `--help` / `-h` | Help text. Per-subcommand `--help` routed to topic-specific help. |

### Subcommands

| Subcommand | Behavior | JSON |
|---|---|---|
| `prompt TEXT` | One-shot prompt; runs a single turn and exits. Merges piped stdin when permissions allow. | yes |
| *(bare positional)* | Shorthand for `prompt` when first arg isn't a known verb. | yes |
| `doctor` | Six local diagnostic checks; non-zero exit on failure. | yes |
| `status` | Workspace snapshot: model, permission mode, git state, config files, sandbox status. | yes |
| `sandbox` | Resolved sandbox / isolation detail for cwd. | yes |
| `agents` | List configured agents (from `.claw/agents/` and similar). | yes |
| `mcp [list\|show <server>]` | Inspect configured MCP servers. | yes |
| `skills [list\|install <path>\|help\|<skill> [args]]` | Skill catalog and install/invoke. | yes |
| `acp [serve]` | Discoverability only — reports ACP/Zed status; no daemon. | yes |
| `init` | Create `.claw/`, `.claw.json`, update `.gitignore`, write stock `CLAUDE.md` based on detected stack. | yes |
| `bootstrap-plan` | Emit the `BootstrapPlan` phase list (mostly telemetry). | yes |
| `dump-manifests [--manifests-dir PATH]` | Dump tool/prompt manifests from upstream TS source (compat-harness). | yes |
| `system-prompt [--cwd PATH] [--date YYYY-MM-DD]` | Print assembled system prompt. | yes |
| `export [PATH] [--session SESSION] [--output PATH]` | Dump a session as markdown. | yes |
| `version` / `help` | Aliases for the flags. | yes |
| `state` | Read `.claw/worker-state.json` — file-based worker observability. | yes |

### Resume mode

`claw --resume <session-ref> [/slash ...]` runs a saved session then dispatches trailing slash commands non-interactively. Only slash commands whose `SlashCommandSpec.resume_supported == true` are allowed. Session-ref aliases: `latest`, `last`, `recent`.

### Piped stdin

When stdin isn't a terminal, non-empty content is **only** merged into the prompt under `danger-full-access` (because interactive approval needs stdin). Under other modes, piped content is ignored to keep the permission prompter alive.

## 3. REPL features

Source: `src/input.rs` (editor) + `src/main.rs::run_repl`.

- **Editor:** `rustyline` with `SlashCommandHelper` implementing `Completer`/`Hinter`/`Highlighter`/`Validator`. Emacs edit mode.
- **Prompt:** fixed string `"> "`. Startup banner renders an ASCII `CLAW Code 🦞` logo plus model / permissions / branch / workspace / directory / session / auto-save lines.
- **Tab completion:** Only fires when line starts with `/` and cursor is at end. Candidates come from `slash_command_completion_candidates_with_sessions(model, session_id, managed_session_ids)` — includes slash command names, model aliases, permission modes, and known session IDs. Helper normalizes (dedupe, `/`-prefixed only).
- **Multiline input:** `Shift+Enter` and `Ctrl+J` bound to `Cmd::Newline`. Enter submits.
- **History:** per-session, in-memory via `DefaultHistory`. `push_history` skips blank entries. Also mirrored into `prompt_history` on the session object (persisted).
- **Ctrl-C / Ctrl-D:** Ctrl-C with non-empty input → `Cancel`; empty → `Exit`. Ctrl-D → `Exit`. Both trigger `persist_session()` before exiting.
- **Non-TTY fallback:** `read_line_fallback` uses raw `stdin().read_line()` — no history, no completion.
- **Slash routing:** REPL line → `SlashCommand::parse`. If Some → `handle_repl_command`. If None → bare-skill lookup (`try_resolve_bare_skill_prompt`) then LLM turn. Unknown slashes produce "did you mean" suggestions.
- **Spinner:** `render::Spinner` with 10-frame braille cycle; `tick` / `finish` (✔) / `fail` (✘). Used during turns ("🦀 Thinking...", "✨ Done").
- **Markdown streaming:** `render::MarkdownStreamState.push()` buffers deltas at stream-safe boundaries (paragraph breaks, closed fenced code blocks). Uses `pulldown-cmark` + `syntect` for ANSI output with syntax highlighting, background shading on code blocks, nested-fence upgrade pass.
- **Session persistence:** every turn auto-saves to `.claw/sessions/<session-id>.jsonl`. `persist_session()` called after each successful turn and on exit.

## 4. Slash command catalog

The catalog lives in `crates/commands/src/lib.rs` as `SLASH_COMMAND_SPECS`. Count: ~140 entries. Most are thin stubs that route prompts to the LLM ("STUB_COMMANDS" are filtered out of help rendering). Below are the meaningful ones grouped by purpose; v0/v1/later reflects openswarm priority.

### Session / visibility (v0 core)

| Command | Summary | Class |
|---|---|---|
| `/help` | Show available slash commands | **v0** |
| `/status` | Session status: model, perms, branch, messages, cost | **v0** |
| `/version` | CLI version + build info | v1 |
| `/cost` | Cumulative token usage | **v0** |
| `/usage` | Detailed API usage stats | v1 |
| `/stats` | Workspace / session stats | later |
| `/sandbox` | Sandbox isolation status | later (skip v0) |
| `/tokens` | Token count for current conversation | v1 |
| `/cache` | Prompt cache statistics | v1 |

### Workspace / session lifecycle (v0 core)

| Command | Summary | Class |
|---|---|---|
| `/clear [--confirm]` | Start fresh local session (backs up the old one) | **v0** |
| `/compact` | Compact local session history | **v0** |
| `/resume <session-path>` | Load saved session into REPL | **v0** |
| `/session [list\|switch\|fork\|delete]` | Manage local sessions | v1 |
| `/rename <name>` | Rename current session | v1 |
| `/export [file]` | Export conversation to file | v1 |
| `/history [count]` | Conversation history summary | v1 |
| `/context [show\|clear]` | Inspect / manage conversation context | v1 |
| `/memory` | Inspect loaded CLAUDE.md / memory files | v1 |
| `/config [env\|hooks\|model\|plugins]` | Inspect config files and merged sections | v1 |
| `/workspace [path]` (alias `/cwd`) | Show / change working dir | later |

### Model / permissions / tools (v0 core)

| Command | Summary | Class |
|---|---|---|
| `/model [model]` | Show / switch active model | **v0** |
| `/permissions [read-only\|workspace-write\|danger-full-access]` | Show / switch permission mode | **v0** |
| `/allowed-tools [add\|remove\|list] [tool]` | Show / modify allowed tools | v1 |
| `/approve` (aliases `/yes`, `/y`) | Approve pending tool call | **v0** (only if async permission prompts) |
| `/deny` (aliases `/no`, `/n`) | Deny pending tool call | **v0** |
| `/stop` | Stop current generation | **v0** |
| `/retry` | Retry last failed message | v1 |
| `/undo` | Undo last file write/edit | later |

### Discovery / debugging (v1)

| Command | Summary | Class |
|---|---|---|
| `/doctor` | Setup / environment health | **v0** |
| `/init` | Create starter `CLAUDE.md` | v1 |
| `/skills [list\|install <path>\|help\|<skill>]` | Skill catalog / invoke | v1 |
| `/agents [list\|help]` | List configured agents | v1 |
| `/mcp [list\|show <server>\|help]` | Inspect MCP servers | v1 (consumer only) |
| `/plugin [list\|install\|enable\|disable\|uninstall\|update]` (aliases `/plugins`, `/marketplace`) | Manage plugins | v1 |
| `/hooks [list\|run <hook>]` | Lifecycle hooks | later |
| `/tasks [list\|get <id>\|stop <id>]` | Background task mgmt | **v0** (needed for Tier 2 swarm) |
| `/providers` | List providers | later |
| `/tool-details <tool-name>` | Detailed tool info | later |
| `/env` | Env vars visible to tools | later |
| `/debug-tool-call` | Replay last tool call | later |
| `/system-prompt` | Show active system prompt | later |
| `/files` | Files in context window | later |

### Git / workspace actions

| Command | Summary | Class |
|---|---|---|
| `/diff` | git diff for workspace changes | v1 |
| `/commit` | Generate commit message + create commit | v1 |
| `/pr [context]` | Draft / create PR | later |
| `/issue [context]` | Draft / create GitHub issue | later |
| `/branch [name]` | Create / switch git branches | later |
| `/stash`, `/blame`, `/log`, `/git` | Git passthrough | later |

### Automation / analysis

| Command | Summary | Class |
|---|---|---|
| `/review [scope]` | Code review | later |
| `/security-review [scope]` | Security review | later |
| `/plan [on\|off]` | Toggle planning mode | later |
| `/ultraplan [task]` | Deep planning prompt | later |
| `/bughunter [scope]` | Heuristic bug scan | later |
| `/subagent [list\|steer\|kill]` | Control subagent execution | later |
| `/agent [list\|spawn\|kill]` | Manage sub-agents / spawned sessions | v1 (swarm orchestrator) |
| `/team [list\|create\|delete]` | Agent teams | later |
| `/parallel <count> <prompt>` | Run N subagents in parallel | later (v1 for swarm) |
| `/cron [list\|add\|remove]` | Scheduled tasks | skip |
| `/insights`, `/advisor`, `/telemetry`, `/metrics` | Assorted analysis | skip |

### Output / UX / input

| Command | Summary | Class |
|---|---|---|
| `/exit` / `/quit` | Exit REPL | **v0** |
| `/theme [theme-name]` | Color theme | later |
| `/keybindings` | Shortcut config | later |
| `/vim` | Toggle vim mode | skip |
| `/voice`, `/listen`, `/speak` | Voice I/O | skip |
| `/output-style [style]` | Switch output format | later |
| `/effort [low\|medium\|high]` | Response effort | later |
| `/fast`, `/brief` | Concise/brief output | later |
| `/copy [last\|all]` | Copy to clipboard | later |
| `/paste` | Paste clipboard as input | later |
| `/screenshot`, `/image <path>` | Add image/screenshot | later |
| `/pin`, `/unpin` | Persist messages across compaction | later |
| `/bookmarks` | Bookmark manager | skip |

### Long-tail stubs (skip unless justified)

`/bughunter`, `/teleport`, `/ultraplan`, `/stickers`, `/thinkback`, `/release-notes`, `/rewind`, `/summary`, `/desktop`, `/ide`, `/tag`, `/refactor`, `/docs`, `/fix`, `/perf`, `/chat`, `/focus`, `/unfocus`, `/web`, `/map`, `/symbols`, `/references`, `/definition`, `/hover`, `/diagnostics`, `/autofix`, `/multi`, `/macro`, `/alias`, `/reasoning`, `/budget`, `/rate-limit`, `/search`, `/upgrade`, `/share`, `/feedback`, `/color`, `/language`, `/profile`, `/max-tokens`, `/temperature`, `/format`, `/changelog`, `/test`, `/lint`, `/build`, `/run`, `/benchmark`, `/migrate`, `/reset`, `/project`, `/templates`, `/explain`, `/privacy-settings`, `/add-dir`, `/api-key`, `/terminal-setup`, `/notifications`.

These are almost all stub entries in claw-code's registry that route text to the LLM — **skip for v0**. Some (`/refactor`, `/explain`, `/docs`, `/test`, `/lint`, `/build`) may become prompt templates later.

## 5. Doctor checks

`run_doctor()` emits a `DoctorReport { checks: Vec<DiagnosticCheck> }`. Each check has `{ name, level: Ok|Warn|Fail, summary, details, data }`. Text mode prints a human report; JSON mode emits `{ kind, message, report, has_failures, summary: { total, ok, warnings, failures }, checks: [...] }`. Exit code is non-zero when any check fails.

1. **Auth** (`check_auth_health`) — checks `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` env vars; inspects legacy saved OAuth credentials (warn if only legacy present, fail if inspection errors).
2. **Config** (`check_config_health`) — discovers config files in the hierarchy, counts loaded vs present, surfaces resolved model, counts MCP servers. Fail if config file parse error.
3. **Install source** (`check_install_source_health`) — static OK; reminds user of official repo vs deprecated `cargo install claw-code` stub.
4. **Workspace** (`check_workspace_health`) — cwd, project root, git branch, git state, changed files, memory files loaded, config files loaded. Warn if not inside a git repo.
5. **Sandbox** (`check_sandbox_health`) — enabled/active/supported flags, filesystem mode, namespace/network support, fallback reason. Warn if sandbox requested but degraded.
6. **System** (`check_system_health`) — OS, arch, version, build target, git SHA, default model.

For openswarm v0, checks 1/2/4/6 map cleanly (auth → `ANTHROPIC_API_KEY`; config → our hierarchy; workspace → cwd+git; system → node/platform info). Checks 3 and 5 are claw-specific and can be skipped.

## 6. Bootstrap & trust

### `BootstrapPlan` (`runtime/src/bootstrap.rs`)

A declarative `Vec<BootstrapPhase>` — not actual startup control flow, just a surface the `bootstrap-plan` CLI exposes for introspection. Phases:

`CliEntry, FastPathVersion, StartupProfiler, SystemPromptFastPath, ChromeMcpFastPath, DaemonWorkerFastPath, BridgeFastPath, DaemonFastPath, BackgroundSessionFastPath, TemplateFastPath, EnvironmentRunnerFastPath, MainRuntime`.

`claude_code_default()` returns a fixed dedup-preserving order. Mostly telemetry / mock-parity test hook. **openswarm can skip this entirely.**

### `TrustResolver` (`runtime/src/trust_resolver.rs`)

Implements folder-trust prompting. `detect_trust_prompt(screen_text)` scans for phrases like "do you trust the files in this folder", "yes, proceed". `TrustPolicy::{AutoTrust, RequireApproval, Deny}`. `TrustConfig` holds allowlisted + denied path prefixes. `resolve(cwd, screen_text)` returns either `NotRequired` or `Required { policy, events }` with a small event log (`TrustRequired`, `TrustResolved`, `TrustDenied`). Path matching normalizes via `std::fs::canonicalize` then prefix-matches.

For openswarm: a lightweight trust gate at first-run (prompt once, persist trust in config) would satisfy the pattern. **v1 for us.**

### `init` command (`rusty-claude-cli/src/init.rs`)

Artifacts created on first run (all idempotent — "skipped (already exists)" if present):

- `.claw/` directory
- `.claw.json` with starter content `{"permissions": {"defaultMode": "dontAsk"}}`
- Appends `.gitignore` lines: comment header, `.claw/settings.local.json`, `.claw/sessions/`, `.clawhip/`
- `CLAUDE.md` generated from repo detection: scans `Cargo.toml`, `rust/Cargo.toml`, `pyproject.toml`/`requirements.txt`/`setup.py`, `package.json` (typescript/next/react/vite/nest), `tsconfig.json`, `src/`, `tests/`, `rust/`. Emits sections: **Detected stack**, **Verification** (per-language verification commands), **Repository shape**, **Framework notes**, **Working agreement**.

Never overwrites an existing `CLAUDE.md`. Returns an `InitReport` with a table of artifacts + status.

**For openswarm v0:** copy this pattern directly — `.swarmharness/` dir + `.swarmharness.json` + gitignore + stack-detecting `CLAUDE.md`-ish `SWARM.md`.

## 7. Recovery recipes

`runtime/src/recovery_recipes.rs` enumerates seven known failure scenarios with one-shot automatic recovery before human escalation. Each scenario maps to a `RecoveryRecipe { scenario, steps, max_attempts=1, escalation_policy }`.

| Scenario | Steps | Escalation |
|---|---|---|
| `TrustPromptUnresolved` | `AcceptTrustPrompt` | `AlertHuman` |
| `PromptMisdelivery` | `RedirectPromptToAgent` | `AlertHuman` |
| `StaleBranch` | `RebaseBranch`, `CleanBuild` | `AlertHuman` |
| `CompileRedCrossCrate` | `CleanBuild` | `AlertHuman` |
| `McpHandshakeFailure` | `RetryMcpHandshake { timeout: 5000 }` | `Abort` |
| `PartialPluginStartup` | `RestartPlugin`, `RetryMcpHandshake { timeout: 3000 }` | `LogAndContinue` |
| `ProviderFailure` | `RestartWorker` | `AlertHuman` |

`attempt_recovery(scenario, ctx)` emits structured `RecoveryEvent`s (`RecoveryAttempted`, `RecoverySucceeded`, `RecoveryFailed`, `Escalated`). A `WorkerFailureKind -> FailureScenario` bridge lets worker-boot events consume this policy.

**For openswarm:** this is a useful pattern for the orchestrator (Tier 2). v0 can keep it implicit; v1 should formalize at least `ProviderFailure` (retry once then escalate) and `PromptMisdelivery` (router tier).

## 8. Green contract

`runtime/src/green_contract.rs` encodes a verification gating level: `GreenLevel::{TargetedTests, Package, Workspace, MergeReady}` ordered. `GreenContract { required_level }` is satisfied when observed ≥ required. Outcomes: `Satisfied` / `Unsatisfied { required, observed }`.

This is used to reason about "do we have enough test signal to claim green?" — e.g., a merge-ready claim requires full workspace tests passing. Not wired into the CLI user surface; lives in the runtime layer for policy checks.

**For openswarm:** pattern is useful for a future verifier tool — out of scope for v0. **later.**

## 9. Requirements for openswarm

### CLI surface

- [v0] Top-level `--model`, `--output-format text|json`, `--permission-mode {read-only|workspace-write|danger-full-access}`, `--resume [session|latest]`, `--help`, `--version`.
- [v0] Subcommands `prompt`, `doctor`, `init`, `status`. Bare positional → `prompt` shorthand.
- [v0] `--headless` (openswarm-specific) + `--task-file=PATH` for JSONL orchestrator workers (from `01-requirements.md`, not in claw).
- [v0] Piped stdin merged into prompt under `danger-full-access` only (keep stdin free for permission approvals in other modes).
- [v1] `--allowed-tools`, `--dangerously-skip-permissions`, `--compact` (text-only final assistant output).
- [v1] Subcommands `agents`, `skills`, `plugin`, `export`, `system-prompt`.
- [v1] Resume mode trailing slash dispatch (`openswarm --resume latest /status /diff`).
- [later] `sandbox`, `mcp`, `acp`, `dump-manifests`, `bootstrap-plan`, `state`.
- [skip] `--base-commit`, `--acp`, `-acp` aliases.

### REPL

- [v0] ink-based TUI (openswarm uses ink, not rustyline — see "Ink vs. rustyline" below).
- [v0] Slash-command completion on `/` prefix (trigger when line starts with `/`).
- [v0] Multiline input via Shift+Enter (standard ink pattern; Ctrl+J optional).
- [v0] In-memory history per session, persisted into session JSONL.
- [v0] Ctrl+C with empty input exits; with input cancels input.
- [v0] Auto-persist session each turn under `.swarmharness/sessions/<id>.jsonl`.
- [v0] Spinner / thinking indicator during turn.
- [v1] Startup banner with model, permissions, branch, workspace, directory, session.
- [v1] Markdown + syntax highlighting stream renderer (nested fence normalization).
- [v1] Tab-complete model aliases, permission modes, known session IDs.

### Slash commands (v0 minimum set)

Based on `01-requirements.md` v1 list + this research:

- [v0] `/help`, `/exit`, `/quit`, `/clear`, `/status`, `/cost`, `/model`, `/permissions`, `/resume`, `/doctor`.
- [v0] `/approve`, `/deny`, `/stop` (needed for permission prompts and cancellation).
- [v0] `/tasks` (needed for Tier 2 swarm visibility).
- [v1] `/compact`, `/session`, `/config`, `/memory`, `/init`, `/diff`, `/commit`, `/version`, `/usage`, `/tokens`, `/skills`, `/agents`, `/plugin`, `/export`, `/history`.
- [v1] Unknown-slash "did you mean" suggestions; OMC plugin-prefix hint.
- [later] `/mcp`, `/hooks`, `/parallel`, `/agent spawn`, `/subagent`, `/team`.
- [skip] All claw-specific or pure-UX stubs (sandbox, voice, vim, stickers, cron, upgrade, bughunter, ultraplan, thinkback, ide, desktop, marketplace, etc).

### Doctor

- [v0] Auth check (`ANTHROPIC_API_KEY`).
- [v0] Config check (config file hierarchy: `~/.swarmharness.json`, `~/.config/openswarm/settings.json`, `<repo>/.swarmharness.json`, `<repo>/.swarmharness/settings.json`, `<repo>/.swarmharness/settings.local.json` — mirroring claw's 5-layer hierarchy from `USAGE.md`).
- [v0] Workspace check (cwd, git repo, branch, memory files).
- [v0] System check (node version, platform, openswarm version).
- [v0] Exit non-zero on failure; `--output-format json` envelope matching `{ kind, has_failures, summary, checks }`.
- [v1] Provider reachability smoke (optional ping).
- [later] Sandbox status (out of scope until Tier 5).

### Bootstrap & init

- [v0] `openswarm init` creates `.swarmharness/`, `.swarmharness.json` (with starter permissions block), appends `.gitignore`, writes a stack-detected `CLAUDE.md` (or `SWARM.md`). Idempotent per claw pattern — never overwrite existing files; report per-artifact `created|updated|skipped`.
- [v0] Stack detection for node (`package.json`, `tsconfig.json`, next/react/vite), python, rust. Emit verification commands.
- [v1] Folder-trust prompt on first run in an unknown workspace; persist trust allowlist in `~/.swarmharness/settings.json`.
- [later] `bootstrap-plan` telemetry surface.

### Recovery & verification

- [v1] `ProviderFailure` auto-retry-once before escalation in orchestrator.
- [v1] `PromptMisdelivery` routing check at Tier 2.
- [later] Full recovery recipe catalog.
- [later] Green contract verification gating type.

## 10. Open questions

1. **ink vs. rustyline feature parity.** ink is React-based and does not ship tab completion, readline keybindings, or history out of the box. We'll need to layer `ink-text-input` or a custom input component + a completions popup. Harder areas:
   - Tab completion with cycle-through (rustyline's `CompletionType::List` is native; ink needs a dedicated dropdown component).
   - Emacs keybindings (Ctrl+A/E/K/U/W — rustyline has them built in, ink needs manual `useInput` wiring).
   - Shift+Enter for newline — doable in ink but terminal-dependent; Ctrl+J is more portable.
   - Streaming markdown renderer — claw's pipeline (pulldown-cmark + syntect + ANSI shading + nested-fence normalization) doesn't have a direct ink equivalent. We can use `marked-terminal` or `cli-highlight` but the stream-safe boundary detection (claw's `MarkdownStreamState.push`) is custom and we'd port that logic.
   - Spinner in a non-full-screen line (claw uses `SavePosition`/`RestorePosition` crossterm — ink manages this via React re-render automatically).

2. **Headless mode flag contract.** claw has no `--headless` flag. We need to decide whether `--output-format json` on `prompt` is sufficient (claw-style single JSON envelope) or whether we need `--headless` emitting the full JSONL event stream (per `02-architecture.md`). Lean: `--headless` prints event stream; `--output-format json` on `prompt` is a single-envelope convenience.

3. **Permission mode default.** claw defaults to `danger-full-access` (`.claw.json` starter writes `"defaultMode": "dontAsk"`). Requirements doc lists `workspace-write` as a mode but doesn't state a default. Our call.

4. **Slash command registry shape.** claw's single static `SLASH_COMMAND_SPECS` array is simple but rigid. Our `PluginSource` / `SkillSource` interfaces imply slash commands may come from plugins — registry should be mergeable.

5. **Resume session reference aliases.** claw accepts `latest|last|recent`. Worth replicating? Lean yes — `latest` is ergonomic.

6. **`init` output file name.** claw writes `CLAUDE.md`; we probably want `CLAUDE.md` too for Claude ecosystem compat, or `SWARM.md`, or both. Open.

7. **Auto-save granularity.** claw saves per-turn. For openswarm headless JSONL, events stream continuously — per-event write vs. per-turn flush.

8. **Non-TTY prompt detection.** claw blocks interactive prompts when stdin isn't a terminal; worth mirroring.

9. **ACP/LSP surface.** claw has `acp` as a discoverability placeholder. Our Tier 4 LSP is `later`; we don't need the placeholder.

10. **OpenAI provider CLI routing.** claw's model-name prefix routing (`openai/`, `gpt-`, `qwen/`, `qwen-`) is provider-selection logic that leaks into the CLI surface. Our v0 is Anthropic-only so we can defer.

## 11. File references

Primary sources read:

- `references/claw-code/rust/crates/rusty-claude-cli/src/main.rs` (12k lines; read heads, targeted sections, and grep'd for flags/verbs/doctor)
- `references/claw-code/rust/crates/rusty-claude-cli/src/init.rs`
- `references/claw-code/rust/crates/rusty-claude-cli/src/input.rs`
- `references/claw-code/rust/crates/rusty-claude-cli/src/render.rs`
- `references/claw-code/rust/crates/rusty-claude-cli/tests/cli_flags_and_config_defaults.rs`
- `references/claw-code/rust/crates/rusty-claude-cli/tests/resume_slash_commands.rs`
- `references/claw-code/rust/crates/commands/src/lib.rs` (~5600 lines; `SlashCommandSpec` table)
- `references/claw-code/rust/crates/runtime/src/bootstrap.rs`
- `references/claw-code/rust/crates/runtime/src/trust_resolver.rs`
- `references/claw-code/rust/crates/runtime/src/recovery_recipes.rs`
- `references/claw-code/rust/crates/runtime/src/green_contract.rs`
- `references/claw-code/USAGE.md`
- `references/claw-code/rust/README.md`

Key symbols:

- `rusty-claude-cli/src/main.rs::parse_args` — argv parser
- `rusty-claude-cli/src/main.rs::CliAction` enum — subcommand dispatch targets
- `rusty-claude-cli/src/main.rs::run_repl` — REPL loop
- `rusty-claude-cli/src/main.rs::LiveCli::startup_banner` — ASCII banner
- `rusty-claude-cli/src/main.rs::render_doctor_report` / `check_auth_health` / `check_config_health` / `check_install_source_health` / `check_workspace_health` / `check_sandbox_health` / `check_system_health`
- `rusty-claude-cli/src/main.rs::print_help_to` — the authoritative help text (line 8234)
- `rusty-claude-cli/src/input.rs::LineEditor`, `SlashCommandHelper`, `slash_command_prefix`
- `rusty-claude-cli/src/render.rs::TerminalRenderer`, `MarkdownStreamState`, `Spinner`, `normalize_nested_fences`
- `commands/src/lib.rs::SLASH_COMMAND_SPECS` — the slash command catalog
- `runtime/src/trust_resolver.rs::TrustResolver`, `detect_trust_prompt`
- `runtime/src/recovery_recipes.rs::recipe_for`, `attempt_recovery`, `FailureScenario`
- `runtime/src/green_contract.rs::GreenContract`, `GreenLevel`
- `runtime/src/bootstrap.rs::BootstrapPhase`, `BootstrapPlan::claude_code_default`
