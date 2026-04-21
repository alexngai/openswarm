# Implementation plan

Concrete path from empty repo to v0 and beyond. Milestones are sized for working software at each checkpoint, not calendar-aligned. Every milestone has an **exit criterion** you can point at.

Claw-code research backing this plan lives in [`research/`](./research/). Each milestone cites the specific research note for deeper detail.

## Sequencing rationale

We ship **M0 (atomic agent)** before **M1 (swarm orchestrator)** because the orchestrator is a consumer of the atomic unit. If the atomic unit is wobbly, a swarm of wobbles is worse. M2 (UI depth) is after M1 because a shaky swarm with pretty output is not the goal — headless M1 has to work before we invest in ink affordances.

## Milestone M0 — atomic agent, end to end

Runnable single-agent CLI. No swarm yet.

**Scope:**

- `AgentEngine` interface + `ClaudeAgentSdkEngine` implementation wrapping `@anthropic-ai/claude-agent-sdk`. Engine owns turn loop, streaming, MCP, compaction, session, prompt cache internally.
- `AuthSource` interface + `AnthropicApiKeyAuth` (`ANTHROPIC_API_KEY`) **+ `AnthropicOAuthAuth`** (Claude Max subscription). OAuth is first-class in M0 — not deferred.
- Tool and permission callbacks bound at the engine boundary: our `PermissionEngine` implements `canUseTool`; our tool dispatcher implements `executeTool`. Tools stay out of the engine's internal surface.
- Preflight handled by Agent SDK — we don't implement token estimation in M0.
- `PermissionEngine`: three modes (`read-only`, `workspace-write`, `danger-full-access`); two-layer evaluation (deny → mode-required → allow). Bound to the engine's `canUseTool` callback. Hook layer deferred to M2 (research/03-runtime.md §4).
- No `ConversationRuntime` / turn loop in M0 — Agent SDK owns it. Our turn loop arrives with `NativeEngine` in M4.
- `SessionStore`: per-worktree isolation at `.swarm-coder/sessions/<fnv1a(cwd)>/` — non-negotiable. Append-on-push JSONL with atomic-rename snapshots (research/03-runtime.md §3; research/05-swarm.md §2). Stores the engine's opaque `SessionSnapshot` alongside our JSONL log so `--resume` works against whichever engine produced the session.
- CLI: `swarm-coder login` + `swarm-coder logout` commands for OAuth (`AnthropicOAuthAuth.login()` → Max subscription flow). Tokens persist to `~/.swarm-coder/auth.json`.
- Tier 0 tools:
  - `bash` — timeout, 16 KiB stdout/stderr truncation on UTF-8 boundaries, background PID return (research/02-tools.md §2)
  - `read_file` — 10 MiB cap, NUL-in-first-8-KiB binary detection, offset/limit
  - `write_file` — 10 MiB cap, canonical workspace boundary check (claw has the helpers but leaves them unwired; we wire them)
  - `edit_file` — **mandatory uniqueness check** (fixes claw's first-match silent bug; research/02-tools.md §2)
  - `multi_edit` — atomic all-or-nothing batch of edits (per Q9)
  - `glob` — gitignore-respecting
  - `grep` — bundled `@vscode/ripgrep` binary (per Q11)
  - `todo_write` — in-memory + session-persisted
- CLI: bare-positional → `prompt` shorthand; `--model`, `--resume latest`, `--permission-mode`, `--output-format text|json`, `--headless`
- `doctor` — four claw-parity checks: auth / config / install / workspace. `sandbox` and `system` checks slip to M5 (research/06-cli.md §5)
- `init` — creates `.swarm-coder/`, `.gitignore` entries, stack-detected `CLAUDE.md` if missing
- Headless mode: JSONL events on stdout; ink is bypassed when `!process.stdout.isTTY`

**Out of scope for M0:**
Our own MCP client (Agent SDK's is used), LSP, plugin loader, skill loader, hooks, our compactor (Agent SDK's is used), Tier 1+ tools, any swarm primitives, Vercel AI SDK / `NativeEngine` / `Provider` impls.

**Exit criterion:** Two paths both work end-to-end:
1. API-key path: `ANTHROPIC_API_KEY=... swarm-coder prompt "add a docstring to file.ts"` completes a real multi-turn tool-using session and writes the session log.
2. Subscription path: `swarm-coder login` → OAuth flow → `swarm-coder prompt "..."` runs against the user's Claude Max subscription.

`swarm-coder --headless --task-file=t.json` produces a parseable event stream on stdout in both paths.

## Milestone M1 — minimum viable swarm

The thesis proof. One orchestrator fans out N tasks to N atomic agents, collects N results.

**Scope:**

- `SwarmHost` interface with two implementations:
  - `StandaloneHost` — in-process event bus; task registry scoped to this agent
  - `WorkerHost` — JSONL-over-stdio to parent
- Subprocess spawn machinery: child inherits `ANTHROPIC_API_KEY`; gets fresh env `SWARM_CODER_AGENT_ID`, `SWARM_CODER_PARENT_PID`, `SWARM_CODER_SESSION_ID` (research/05-swarm.md §4)
- `TaskRegistry` — worktree-scoped, per claw's `task_registry.rs` lifecycle (states, output stream, dispatch) but ours lives at the orchestrator, not as a global `OnceLock` (research/05-swarm.md §2)
- Tier 2 subset:
  - `agent` — spawn sub-agent via SwarmHost
  - `task_create` / `task_update` / `task_get` / `task_list`
- Lane-event port — near-verbatim TS translation of claw's `lane_events.rs` catalog (event names, failure taxonomy, provenance tags, fingerprint dedup) (research/05-swarm.md §5)
- Orchestrator CLI: `swarm-coder swarm run tasks.jsonl --concurrency N`
- Result aggregation: `results.jsonl` with status, output, usage, wall-clock per task

**Out of scope for M1:**
`send_message`, `check_inbox`, `task_stop`, `task_output` (M3); git coordination (M3); team roles / cron (M5+); retry policies (M3).

**Exit criterion:** `swarm-coder swarm run tasks.jsonl --concurrency 3` spawns 3 subprocess workers on 10 tasks, each task runs to completion or failure with isolated session logs, and `results.jsonl` is machine-parseable.

## Milestone M2 — UI depth and productivity tools

The "feels like a real CLI" milestone. Atomic-agent UX catches up to claw's.

**Scope:**

- ink TUI:
  - Streaming markdown renderer — port claw's `MarkdownStreamState.push` logic or wrap `marked-terminal` (unresolved, see open question §10)
  - Tab-completion dropdown component (rustyline's native cycling has no ink equivalent — we build it)
  - Emacs keybindings (Ctrl+A/E/K/U/W via manual `useInput` wiring)
  - Spinner coexisting with ink re-renders
  - Slash completion only when line starts with `/` and cursor is at end (research/06-cli.md §3)
- Slash commands: `/help`, `/exit`, `/clear`, `/status`, `/cost`, `/model`, `/permissions`, `/resume`, `/doctor`, `/tasks`, `/approve`, `/deny`, `/stop`
- Tier 1 tools: `web_fetch`, `web_search`, `structured_output`
- Compaction (mechanical, not LLM-driven, per claw) with tool-use/tool-result boundary guard + post-compaction `glob` health probe (research/03-runtime.md §7)
- Hooks: shell-command protocol — JSON on stdin, exit codes 0/2/other, stdout schema with `permissionDecision`, `updatedInput`, `systemMessage` (research/03-runtime.md §5). Claude-code-compatible.
- Additional TransportProviders: `@ai-sdk/openai` (M2 surface only — Anthropic remains default), wired behind `AuthSource` variants `OpenAIApiKeyAuth` and `OpenAICompatApiKeyAuth` (the latter for Ollama / LM Studio / OpenRouter via `OPENAI_BASE_URL`)
- Discovery sources (read-only, no install/enable yet):
  - `PluginSource.claude-code` — JSON manifests at `~/.claude/plugins`
  - `SkillSource.claude-code` — tiered path walk: `CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `.claude` / `.codex` / `.claw` / `.omc` (research/04-integrations.md §3)
- MCP: stdio client, read-only (list + read resources). **First-class tool registration at startup** (per Q12) — each discovered MCP tool registers into the tool table as `mcp__<server>__<tool>`. Parallel connect with per-server timeout; fail-soft on unreachable servers (emit `degraded_startup` event, skip those tools). Dynamic mid-session registration deferred to M5.

**Out of scope for M2:**
`notebook_edit` (M3 — niche); plugin install/enable/disable (M4); prompt caching (M3); parallel tool execution (M3).

**Exit criterion:** Interactive REPL is pleasant on real tasks. A user with `~/.claude/plugins` already installed sees them discovered. Slash commands work. Compaction kicks in before context exhaustion without orphaning tool-use blocks.

## Milestone M3 — orchestration depth + Claude Max subscription

The swarm becomes a real coordination platform. Subscription auth arrives for Anthropic users.

**Scope:**

- Tier 2 remainder: `send_message`, `check_inbox`, `task_stop`, `task_output`
- Git coordination: port `branch_lock.rs`, `stale_base.rs`, `stale_branch.rs` near-verbatim — small, pure, well-tested (research/05-swarm.md §6)
- `TaskPacket` format: `branch_policy`, `commit_policy`, `escalation_policy` fields. Ours are **enums, not claw's free-form strings** — runtime-enforced, not just model hints (research/05-swarm.md §2)
- Orchestrator retry policies: fixed retry count, exponential backoff, dead-letter for permanent failures
- Team roles: system-prompt overlay + tool allowlist per role. Starter roles: `architect`, `executor`, `reviewer`
- Prompt caching (Anthropic): cache declaration via `providerOptions.anthropic.cacheControl`, fingerprint, usage-delta analytics (research/01-api.md §7)
- Parallel tool execution when `ProviderCapabilities.parallelToolUse === true`
- `notebook_edit` tool
- `ask_user_question` routed via SwarmHost (not stdin blocking — research/05-swarm.md §9)
- Server-side token preflight (`count_tokens` with silent local-estimate fallback; research/01-api.md §8)

### Claude Max subscription auth (FrameworkProvider)

- `ClaudeAgentSDKProvider` — a `FrameworkProvider` backed by `@anthropic-ai/claude-agent-sdk`. Agent SDK owns the turn loop, permissions, sessions, and tool execution in this mode.
- `AnthropicOAuthAuth` — `kind: "framework-managed"` — delegates to the Agent SDK's OAuth helpers rather than reimplementing PKCE + impersonating `user-agent: claude-code/…` headers. See decision Q16 in `06-open-questions.md`.
- CLI flag: `--framework claude-agent-sdk` opts in.
- Event translation layer: map Agent SDK events into our `NormalizedEvent` / lane-event stream so session logs and orchestrator observability stay unified.
- **Constrained swarm features:** in this mode, `send_message`, `check_inbox`, and other `SwarmHost`-routed tools either degrade to no-ops or are removed from the tool surface. Documented as tradeoff at CLI invocation time and in `--help`.
- Login UX: `swarm-coder login` runs the Agent SDK's OAuth flow and persists tokens to `~/.swarm-coder/auth.json`.

**Exit criterion:** A config like "1 architect, 2 executors, 1 reviewer on this feature branch" produces a multi-agent run where `branch_lock` prevents concurrent writes, agents exchange messages, and escalation policies actually escalate.

## Milestone M4 — provider breadth + ChatGPT subscription

Flexibility milestone. Additional `TransportProvider`s slot in behind the existing `Provider` interface. ChatGPT subscription auth lands as a second `FrameworkProvider`.

**Scope:**

- xAI TransportProvider (`grok*`) via `@ai-sdk/xai`
- Google TransportProvider (`gemini-*`) via `@ai-sdk/google`
- DashScope via OpenAI-compat TransportProvider (`qwen*`, `qwen/*`) — **6 MB request-body cap** enforced at preflight (research/01-api.md §8)
- Model-prefix routing (`claude*` / `grok*` / `openai/` / `gpt-` / `qwen*` / `gemini-*`) takes precedence over env-var sniffing (research/01-api.md §6)
- Model-family quirks handled at provider boundary: `gpt-5*` uses `max_completion_tokens`, reasoning models (`o1/o3/o4/*-thinking/qwq*`) strip tuning params, Kimi rejects `is_error` on tool results. Vercel AI SDK handles most of these; we layer the rest.
- Cross-provider stream translation is **handled inside Vercel AI SDK** — we don't port claw's OpenAI→Anthropic translator.
- Plugin install / enable / disable / update / uninstall (research/04-integrations.md §2)
- Per-provider model alias table with user-defined extension (`~/.swarm-coder/settings.json aliases`)

### ChatGPT Plus/Pro subscription auth (FrameworkProvider)

- `CodexChatGPTProvider` — a second `FrameworkProvider`. Custom Vercel AI SDK provider targeting `https://chatgpt.com/backend-api/codex/responses` (NOT `api.openai.com`; `@ai-sdk/openai` cannot be reused). Per decision Q17.
- `OpenAIOAuthAuth` — `kind: "oauth-bearer"` — implements Codex App Server OAuth against `auth.openai.com/oauth/` with PKCE. Uses client ID documented by OpenAI's Codex App Server (note: not a formal third-party program — policy-tolerated rather than contracted).
- CLI flag: `--framework codex-chatgpt` opts in.
- `swarm-coder login --provider codex-chatgpt` runs the OAuth flow.
- **Constrained swarm features:** same tradeoff as Claude-Max FrameworkProvider.

### Explicitly NOT in M4

- **GitHub Copilot subscription** — no supported third-party API; community proxies violate March 2026 Copilot terms. Decision Q18. Any future Copilot support requires an official API from GitHub.
- **Direct OAuth to Anthropic Messages API** without the Agent SDK — technically works (claw-code does it) but requires impersonating `user-agent: claude-code/…` and conflicts with Anthropic's Feb 2026 OAuth-proxying policy. Rejected per Q16.

**Exit criterion:** `swarm-coder --model gpt-4o` with API key, `--model gemini-2.0-flash`, `--model llama3.2` against local Ollama, and `swarm-coder login --provider codex-chatgpt && swarm-coder prompt "…"` all work without collapsing under provider-specific limits.

## Milestone M5+ — deferred tiers

Not sequenced yet. Pulled in based on demand.

- **Tier 3** — real cron scheduler (don't copy claw's storage-only stub); team persistence; remote agent triggers over proper RPC; finalized `ask_user_question`
- **Tier 4** — LSP full protocol (claw stubs the wire; we implement it); **dynamic mid-session MCP tool registration** (first-class registration at startup already lands in M2 per Q12 — M5 adds hot-add/remove of MCP servers during a running session)
- **Tier 5** — `plan_mode`, `sandbox` (Linux `unshare` with macOS/Windows fallback), `pdf_extract`, `repl`, full hooks runtime

## What we explicitly refuse to copy from claw

These are design anti-patterns we are not replicating. Each has an evidence citation.

1. **Thread-based sub-agents.** Claw's `Agent` tool spawns `std::thread` + `ConversationRuntime`. We use subprocess. (research/05-swarm.md §1)
2. **Dead bash-validation modules.** All six claw validation submodules exist in `bash_validation.rs` but none are wired into `execute_bash`. If we port them, we wire them. (research/02-tools.md §3)
3. **Silent first-match `edit_file`.** No uniqueness check. We reject ambiguous edits. (research/02-tools.md §2)
4. **Fake `grep_search`.** Claw's grep is walkdir+regex with no gitignore. We use real ripgrep. (research/02-tools.md §2)
5. **Storage-only `CronRegistry`.** No actual scheduler. We don't ship cron until we have one. (research/05-swarm.md §3)
6. **Roleless `TeamRegistry`.** Just `{name, [task_id]}`. We ship teams with roles and tool allowlists, or not at all. (research/05-swarm.md §3)
7. **Echoing `SendUserMessage`.** No delivery mechanism. We deliver or we don't expose the tool. (research/05-swarm.md §9)
8. **Stdin-blocking `AskUserQuestion`.** Unusable from threads or headless. Ours routes via SwarmHost. (research/05-swarm.md §9)
9. **MCP as a single generic tool.** The model can't plan against individual MCP tools when they're hidden behind a `{server, tool, args}` dispatcher. We register each MCP tool first-class in M5. (research/04-integrations.md §4)
10. **Global `OnceLock` registries.** Fine for one process, hostile to subprocess workers. Our registries are per-runtime with explicit IPC. (research/05-swarm.md §1)

## Cross-cutting tracks

These run continuously alongside milestones:

- **Testing** — mock Anthropic service + clean-env parity harness (port claw's pattern; 10 scripted scenarios is a good baseline)
- **Typecheck** — strict TS, no `any` in public interfaces
- **Lint** — enforce layering rules from `02-architecture.md` via no-circular-imports and per-module import allowlists
- **Docs** — keep `README.md` index current; resolved open questions migrate to the decision log in `06-open-questions.md`

## M0 task breakdown (first concrete work unit)

To make M0 executable without further planning, here is the dependency order:

1. `src/core/types.ts` — `PermissionMode`, `Usage`, `StopReason`, `AgentId`, `ToolSpec`, `NormalizedEvent`, `ProviderError` *(drafted)*
2. `src/engine/index.ts` — `AgentEngine`, `RunConfig`, `PermissionGate`, `ToolExecutor`, `SessionSnapshot` *(drafted)*
3. `src/auth/index.ts` — `AuthSource` + `InteractiveAuth` *(drafted)*
4. `src/auth/anthropic-api-key.ts` — `AnthropicApiKeyAuth` reading `ANTHROPIC_API_KEY`
5. `src/auth/anthropic-oauth.ts` — `AnthropicOAuthAuth` implementing `InteractiveAuth` (delegates to Agent SDK's OAuth flow, or reimplements from claw-code's `oauth.rs` if the SDK's helpers aren't public)
6. `src/engine/claude-agent-sdk.ts` — `ClaudeAgentSdkEngine` wrapping `@anthropic-ai/claude-agent-sdk`; translates SDK events → `NormalizedEvent`; binds engine's `canUseTool` to our `PermissionEngine`; binds engine's tool execution to our dispatcher
7. `src/session/store.ts` — per-worktree `SessionStore` with JSONL append + atomic snapshots, persists engine `SessionSnapshot` alongside our log
8. `src/permissions/index.ts` — `PermissionEngine`: mode evaluator + rule grammar (`tool(subject:*)`)
9. `src/tools/tier0/{bash,read_file,write_file,edit_file,multi_edit,glob,grep,todo_write}.ts` — Tier 0 tools, each implementing the dispatcher contract (not auto-executed by the engine)
10. `src/tools/dispatcher.ts` — resolves tool name → implementation, applies permission check, returns `ToolResult` to the engine
11. `src/cli/argv.ts` — flag parsing (hand-rolled or `commander` — TBD)
12. `src/cli/login.ts` / `src/cli/logout.ts` — OAuth entry commands
13. `src/cli/doctor.ts` — four checks (auth / config / install / workspace)
14. `src/cli/init.ts` — scaffolding (`.swarm-coder/`, `.gitignore`, `CLAUDE.md`)
15. `src/ui/headless.ts` — JSONL event emitter
16. `src/ui/ink/app.tsx` — minimal ink shell, TTY-gated; `ink-markdown` for streaming output
17. `src/cli/main.ts` — entry wiring: argv → auth + engine → session → dispatcher → UI
18. Tests — mock Agent SDK fixture + 3–5 scripted scenarios

Everything else waits. No premature Tier 1+ tools, no `Provider` impls, no `NativeEngine`, no MCP client, no compactor, no swarm primitives, no hooks.

**Files already drafted:** core/types.ts, engine/index.ts, auth/index.ts, providers/index.ts (stub), swarm/host.ts, swarm/events.ts, plugins/index.ts, skills/index.ts. Typechecks clean under `tsc --noEmit`. Real implementations are next.
