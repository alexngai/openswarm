# Requirements

## Functional — v0 (must ship)

See [`07-implementation-plan.md`](./07-implementation-plan.md) for milestone-by-milestone exit criteria. v0 = M0 + M1 combined.

### M0 — atomic agent

- Single Claude-backed coding agent, invokable as CLI and as a library
- Anthropic `TransportProvider` via `@ai-sdk/anthropic` (Vercel AI SDK)
- `AuthSource` interface + `AnthropicApiKeyAuth` (`ANTHROPIC_API_KEY`). OAuth / subscription auth deferred to M3+
- Tier 0 tools with concrete behavior:
  - `bash` — timeout handling, 16 KiB stdout/stderr truncation on UTF-8 boundaries, background PID return
  - `read_file` — 10 MiB cap, NUL-in-first-8-KiB binary detection, offset/limit
  - `write_file` — 10 MiB cap, canonical workspace boundary check enforced (not left as helper lib like claw)
  - `edit_file` — **mandatory uniqueness check** (reject ambiguous matches; fixes claw's silent first-match bug)
  - `glob` — gitignore-respecting
  - `grep` — real ripgrep binary (not walkdir+regex)
  - `todo_write` — in-memory + session-persisted
- Permission modes: `read-only`, `workspace-write`, `danger-full-access`. Two-layer evaluation (deny → mode-required → allow). Hook layer deferred to M2.
- **Per-worktree session isolation** at `.openswarm/sessions/<fnv1a(cwd)>/` — non-negotiable. JSONL with `session_meta` header + append-on-push records + atomic-rename snapshots.
- `--resume latest` and `--resume <session-id>`
- `doctor` — auth / config / install / workspace checks with `--output-format json`
- `init` — scaffolds `.openswarm/`, `.gitignore` entries, stack-detected `CLAUDE.md`
- CLI: bare-positional → `prompt` shorthand, `--model`, `--permission-mode`, `--output-format text|json`, `--headless`
- Headless mode emits JSONL events on stdout; ink bypassed when `!isTTY`
- ink-based interactive REPL (minimal in M0; full affordances in M2)

### M1 — minimum viable swarm

- Tier 2 subset: `agent` (spawn sub-agent via SwarmHost), `task_create`, `task_update`, `task_get`, `task_list`
- `SwarmHost` interface with `StandaloneHost` (in-process) and `WorkerHost` (JSONL-over-stdio to parent)
- Subprocess spawn inherits `ANTHROPIC_API_KEY`; sets `OPENSWARM_AGENT_ID`, `OPENSWARM_PARENT_PID`, `OPENSWARM_SESSION_ID`
- Lane event stream with event-name catalog + failure taxonomy + fingerprint dedup (ported from claw's `lane_events.rs`)
- Orchestrator: `openswarm swarm run tasks.jsonl --concurrency N` → `results.jsonl`

## Functional — v1 (M2 + M3)

### M2 — productivity and UI depth

- Tier 1 tools: `web_fetch`, `web_search`, `structured_output`, `skill`
- ink TUI: streaming markdown, tab-completion dropdown, emacs keybindings, spinner, slash prefix detection
- Slash commands: `/help`, `/exit`, `/clear`, `/status`, `/cost`, `/model`, `/permissions`, `/resume`, `/doctor`, `/tasks`, `/approve`, `/deny`, `/stop`
- Mechanical compaction with tool-use/tool-result boundary guard + post-compaction `glob` health probe
- Hooks (shell-command protocol — JSON stdin, exit codes 0/2/other, stdout schema). Claude-code-compatible.
- Plugin discovery via `PluginSource.claude-code` (read-only)
- Skill discovery via `SkillSource.claude-code` (tiered path walk)
- MCP stdio client, read-only (list/read resources; dispatch via generic `mcp` tool)

### M3 — orchestration depth + Claude Max subscription

- Tier 2 remainder: `send_message`, `check_inbox`, `task_stop`, `task_output`
- Git coordination: `branch_lock`, `stale_base`, `stale_branch` (ported near-verbatim from claw)
- `TaskPacket` with `branch_policy` / `commit_policy` / `escalation_policy` as **enums, not free-form strings**
- Orchestrator retry policies (fixed count, exponential backoff, dead-letter)
- Team roles: architect / executor / reviewer (system-prompt overlay + tool allowlist)
- Prompt caching (Anthropic) via `providerOptions.anthropic.cacheControl`
- Parallel tool execution
- `notebook_edit`
- `ask_user_question` routed via SwarmHost lane events (not stdin)
- Server-side `count_tokens` preflight with silent fallback
- **`ClaudeAgentSDKProvider` (FrameworkProvider) for Claude Max subscription auth** — delegates loop + auth to Agent SDK; users opt in via `--framework claude-agent-sdk`; constrained swarm features in this mode
- `openswarm login` command for OAuth flow; tokens persist to `~/.openswarm/auth.json`

## Functional — later (M4+)

### M4 — provider breadth + ChatGPT subscription

- xAI, Google, DashScope TransportProviders via Vercel AI SDK wrappers (with 6 MB DashScope request-body cap at preflight)
- Model-prefix routing (`claude*`/`grok*`/`openai/`/`gpt-`/`qwen*`/`gemini-*`) over env-var sniffing
- Cross-provider stream translation handled inside Vercel AI SDK — we don't port claw's translator
- Model-family quirks (`gpt-5*` max_completion_tokens, reasoning-model param stripping, Kimi `is_error` rejection) at provider boundary
- **`CodexChatGPTProvider` (FrameworkProvider) for ChatGPT Plus/Pro subscription** — custom provider targeting `chatgpt.com/backend-api/codex` + Codex App Server OAuth; policy-tolerated not contracted
- Plugin install / enable / disable / update / uninstall
- **Explicitly excluded:** GitHub Copilot subscription routing (ToS violation); direct Anthropic-OAuth-to-Messages-API impersonation path

### M5+ — deferred tiers

- Tier 3: real cron scheduler (not claw's storage-only stub), team persistence, remote agent triggers
- Tier 4: LSP full protocol, MCP first-class tools via deferred schema registration
- Tier 5: `plan_mode`, `sandbox` (Linux `unshare`), `pdf_extract`, `repl`, full hooks runtime
- In-process atomic-agent mode as a spawn optimization

## Non-functional

- Ship as an npm package with both a CLI bin and library exports
- Node ≥ 18
- Atomic agent cheap to spawn — goal: subprocess startup < 500ms cold
- Headless output is machine-parseable with a stable JSONL schema
- Provider interface leaks no Anthropic SDK types to callers
- `PluginSource` / `SkillSource` admit future formats without breaking v0 consumers
- No circular imports between modules (enforce via lint rule)

## Out of scope

- Full claw-code tool surface (40 tools)
- Non-TypeScript runtime components
- Hosted service / multi-tenant deployment
- Claude subscription auth

## Acceptance for v0

v0 is done when:

1. `openswarm prompt "do X"` runs an atomic agent end to end with Tier 0 tools and exits cleanly
2. `openswarm --headless --task-file=tasks.jsonl` runs one agent and emits a parseable event stream
3. The swarm orchestrator can spawn ≥ 3 atomic agents from a task list and collect their results
4. `doctor` passes on a clean install with only `ANTHROPIC_API_KEY` set
5. Sessions resume correctly via `--resume latest`
