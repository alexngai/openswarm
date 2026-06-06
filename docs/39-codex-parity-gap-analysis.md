# 39 — Codex Parity Gap Analysis

Gap analysis between swarm-harness and OpenAI Codex CLI (`codex-rs`).
Companion to `15-parity-gaps.md` (which tracks claw-code parity).

Codex is the reference for production-hardened agent behavior: sandboxing,
safety, and execution policy. swarm-harness leads on multi-agent orchestration,
topology diversity, and composable architecture.

## Legend

| Status | Meaning |
|---|---|
| ❌ missing | No equivalent exists in swarm-harness |
| ⚠️ partial | Functionally present but significantly less capable |
| ✅ parity | Behaviorally equivalent or superior |
| 🟦 divergent | Intentionally different design; not a gap |
| 🔵 swarm-lead | swarm-harness has it; Codex doesn't |

**Priority:** `P0` (blocks production safety) · `P1` (meaningful gap) · `P2` (nice-to-have) · `P3` (deferred)

**Effort:** `XS` (<0.5d) · `S` (0.5–1d) · `M` (1–3d) · `L` (3–7d) · `XL` (>1w)

---

## 1. Safety & Sandboxing

The largest gap. Codex runs every shell command and file write inside an
OS-level sandbox. swarm-harness relies on permission modes and bash validation
gates but has no process isolation.

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| S1 | **OS-level sandbox (bubblewrap + seccomp + Landlock)** | ✅ | P0 | XL | `sandbox.ts`: bubblewrap primary (mount namespaces, seccomp BPF blocking 27 syscalls, PID/IPC/UTS/network isolation) with Landlock fallback (compiled C helper with `--check` probe). `buildSeccompFilter()` generates raw BPF bytecode. `detectSandboxMode()` caches detection with runtime Landlock probe. `spawnSandboxed()` (async) and `spawnSandboxedSync()` (sync) APIs. Wired into `bash.ts` and `shell-session.ts`. Policy: require/prefer/off. |
| S2 | **Network proxy / firewall** | ✅ | P0 | XL | `network-policy.ts`: domain-level allow/deny with Codex-compatible glob syntax (exact, `*.`, `**.`, `*`). SSRF protection via DNS resolution + RFC 1918/loopback/link-local blocking. `network-proxy.ts`: local HTTP/CONNECT proxy server for sandboxed processes. Config from `.swarm-harness/network.json` (layered: env/project/home). Proxy env vars injected into all sandbox modes (bwrap --setenv, Landlock env, fallback). `web_fetch` enforces policy directly. |
| S3 | **Guardian (AI-powered approval reviewer)** | ✅ | P1 | XL | `guardian.ts`: LLM sub-agent reviews dangerous actions. Fail-closed design (timeout/error/parse failure → deny). 90s default timeout. Circuit breaker (3 consecutive or 10/50 denials → escalate to human). Risk classification (critical/high/medium/low). Callback-based review function for provider independence. Action types: shell_command, file_write, network_request, tool_call, permission_escalation. |
| S4 | **Process hardening (pre-main security)** | ✅ | P1 | M | `process-hardening.ts`: strips 33 dangerous env vars (LD_*, DYLD_*, NODE_OPTIONS, PYTHONSTARTUP, BASH_ENV, etc.), disables core dumps. Wired into bash, shell sessions, hooks. Commit `071772e`. |
| S5 | **Patch safety with hardlink/TOCTTOU awareness** | ✅ | P1 | M | TOCTTOU protection: `edit_file` and `multi_edit` compute SHA-256 hash of content at read time, re-verify before atomic rename. `write_file` re-validates parent directory realpath after mkdir. `TocttouError` sentinel class for clean detection. |
| S6 | **Secrets detection** | ✅ | P2 | M | `secrets.ts`: 16 regex patterns (AWS, GitHub, Slack, Stripe, private keys, JWTs, GCP service accounts, generic API keys, password-in-URL, Anthropic, npm, pypi). Shannon entropy filter for generic patterns. `detectSecrets()`, `containsSecrets()`, `redactSecrets()` API. |

---

## 2. Execution Policy

Codex has a sophisticated rule-based policy engine for shell commands.
swarm-harness has bash validation gates (6 submodules) but no declarative
rule system.

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| E1 | **Declarative execution policy engine (.rules files)** | ✅ | P1 | L | `exec-policy.ts`: Layered rules.json files (system → project → user → env). Prefix matching with alternative tokens (`["npm", ["install", "ci"]]`). Allow/Prompt/Forbidden decisions (strictest wins). Shell `-c` unwrapping (E4 lite). Basename fallback for paths. Config validation. Integrates alongside existing 6 bash-validation submodules. |
| E2 | **Auto-amendment of policy rules** | ✅ | P2 | M | `exec-policy.ts`: `deriveAmendment()` extracts up-to-3-token prefix from approved commands (with shell -c unwrapping). `persistAmendment()` writes to `~/.swarm-harness/rules.json`, deduplicates, resets cached policy. |
| E3 | **Banned prefix suggestions** | ✅ | P2 | S | `banned-prefixes.ts`: 55+ banned commands (shells, interpreters, package managers, privilege escalation, remote exec, containers, git, system-level, eval wrappers, compilers). Detects bare commands AND shell -c / interpreter -e patterns. `checkBannedPrefix()`, `checkBannedPrefixes()`, `getBannedPrefixList()` API. |
| E4 | **Command canonicalization** | ✅ | P2 | M | `exec-policy.ts`: `canonicalizeCommand()` pipeline — strips env var prefixes (`VAR=val`), command prefixes (sudo/env/nohup/nice/ionice/timeout/strace/ltrace/time/command/builtin/exec), unwraps shell `-c`/`-lc` (bash/sh/zsh/dash/ksh), unwraps interpreter `-c`/`-e` (python/ruby/perl/node), strips heredoc markers (`<<`). Exported and used by `evaluate()`. |
| E5 | **Granular approval modes** | ✅ | P2 | M | `approval-policy.ts`: 5 approval modes (never, always, unless-allowed, on-failure, on-request) layered on top of existing 3 PermissionModes. `unless-allowed` integrates with ExecPolicy for rule-driven auto-approval. Separate from PermissionMode (WHAT vs WHEN). |

---

## 3. Session & Context

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| C1 | **Remote compaction (model-based summarization)** | ✅ | P2 | L | `engine/compact-remote.ts`: LLM-based session compaction modeled on Codex `compact_remote_v2.rs`. Calls configurable provider/model with structured summarization prompt (analysis + 9-section summary). `RemoteCompactionConfig` extends `CompactionConfig` with provider/model/timeout/maxSummaryTokens. Fail-safe: falls back to mechanical compaction on error/timeout. Reuses boundary walk-back and continuation message infrastructure. `isRemoteCompactionConfig()` type guard for dispatch. Integrated into both NativeEngine and HardenedNativeEngine (emergency context_overflow paths stay mechanical for speed). 17 tests. |
| C2 | **Rich context fragments (29 types)** | ✅ | P2 | L | `context/index.ts`: Composable `ContextFragment` interface with typed `ContextState`. 9 built-in fragments: environment, permissions, approved-commands, network-rules, exec-policy, user-instructions, model-context, tool-inventory, agent-role. `ContextBuilder` with register/unregister, priority sorting, singleton. Integrates with `buildSystemPrompt()` via extensions param. |
| C3 | **State database (SQLite-backed)** | ✅ | P2 | L | `state/index.ts`: SQLite-backed (better-sqlite3) persistent store with WAL mode. 4 tables: sessions, goals, memories, audit_log. Automatic migrations with schema versioning. Full CRUD for all entities. Memory search (LIKE query). Session listing with reverse-chronological ordering. Singleton with configurable path (default `~/.swarm-harness/state.db`). |

---

## 4. Goals & Memory

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| G1 | **Goals engine (persistent thread goals)** | ✅ | P2 | L | `core/goal.ts`: 6-state machine (active/paused/blocked/usage_limited/budget_limited/complete) with validated transitions. Token + cost budget tracking with per-turn usage recording. Automatic state transitions on budget exhaustion (`enforcebudget()`). Checkpointing with snapshot data. `GoalRegistry` for in-memory CRUD. Serialization via `toRecord()`/`fromRecord()` for StateDB persistence. |
| G2 | **Memory system (cross-session learning)** | ❌ | P2 | XL | Codex: `memories/read/`, `memories/write/`. Two-phase pipeline: Phase 1 (rollout extraction from session transcripts) and Phase 2 (global consolidation). Memories injected into subsequent sessions. swarm-harness: no long-term memory across sessions. |

---

## 5. Tools & Agent Features

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| F1 | **apply_patch tool (unified diff editing)** | 🟦 | — | — | Codex: `core/src/apply_patch.rs`. Unified diff format with add/delete/update/move. swarm-harness: edit_file with exact-string replacement + multi_edit for atomic batches. Different approach; swarm's is arguably safer (no ambiguous hunks). |
| F2 | **View image tool** | ✅ | P3 | S | `tools/tier1/view_image.ts`: Reads image files (PNG/JPEG/GIF/WebP/SVG/BMP/ICO), returns base64 data URI. 20 MiB max file size. Resolves relative paths against cwd. Registered in tier1 tool builder. |
| F3 | **Tool search (dynamic tool discovery)** | ✅ | P3 | S | `tools/tier1/tool_search.ts`: `setToolRegistry()` for registration, `scoreMatch()` for ranking by name/description keyword match. Returns formatted tool specs with metadata (tier, permission). Registered in tier1 tool builder. |
| F4 | **Code mode (sandboxed V8 tool orchestration)** | ❌ | P3 | L | Codex: `core/src/tools/code_mode/`. Sandboxed V8 JavaScript runtime exposed as `exec`/`wait` tools. Model writes JS that calls other tools via `await tools.some_tool(args)`. NOT for running user code — meta-tool for tool orchestration. Execute/yield/wait lifecycle with background execution. swarm-harness: no equivalent; multi-agent orchestration fills a similar niche differently. |
| F5 | **Request permissions tool** | ✅ | P2 | S | `request_permissions.ts`: Tier 0 tool for mid-session permission elevation. Module-level callback pattern (no SwarmHost dep). Modes: read-only < workspace-write < danger-full-access. Handler: `getCurrentMode()` + `requestElevation()`. Commit `071772e`. |
| F6 | **Request user input tool** | ✅ | — | — | Codex: `core/src/tools/handlers/request_user_input.rs`. swarm-harness: `ask_user_question` (Tier 2). Parity. |
| F7 | **Multi-agent v2 (spawn/send/wait/close/followup)** | 🟦 | — | — | Codex: `core/src/tools/handlers/multi_agents_v2/`. swarm-harness: richer model with task queue, pull protocol, topologies, team daemon. swarm-harness leads. |
| F8 | **Mention syntax (@plugin, @tool)** | ✅ | P3 | S | `tools/tier1/mention-syntax.ts`: `parseMentions()` extracts @tool and @plugin:tool references with lookbehind regex. `resolveMentions()` classifies against known tools/agents. `stripMentions()` removes mentions from text. Handles punctuation, email exclusion, index tracking. |
| F9 | **File watcher (skills hot-reload)** | ❌ | P3 | M | Codex: `file-watcher/`. Uses `notify` crate (inotify/FSEvents). NOT in agent loop — serves UI via `fs/watch` JSON-RPC + skills hot-reload. Multi-subscriber ref-counted model with RAII cleanup. swarm-harness: no filesystem change notification; skills are static per session. |
| F10 | **Web search (multi-action)** | ⚠️ | P3 | M | Codex: `web-search/`. 4 action types (Search, OpenPage, FindInPage, Other). swarm-harness: web_search is a placeholder (intercepted by SDK); web_fetch works. |
| F11 | **Persistent shell sessions (unified_exec)** | ✅ | P1 | L | `shell_exec` tool: persistent /bin/bash sessions surviving across tool calls. `ShellSessionManager` with LRU eviction (max 64). Create or reuse sessions by ID. `shell_list` for lifecycle mgmt. Commit `8dd4d64`. |
| F12 | **Interactive stdin / process polling** | ✅ | P1 | M | `shell_write` tool: send text input + signals (SIGINT/SIGTERM/SIGKILL) to running sessions. Cursor-tracked output so each read returns only new data. Supports REPL/debugger/server interaction. Commit `8dd4d64`. |
| F13 | **HeadTailBuffer (smart output truncation)** | ✅ | P1 | S | `headTailTruncate()` in internal.ts: preserves first 20 KiB + last 20 KiB with UTF-8-safe boundaries. Replaces old 16 KiB hard truncation in bash tool. Both bash and shell tools use it. Commit `8dd4d64`. |
| F14 | **Shell state snapshots** | ✅ | P2 | M | State probe after each `shell_exec` captures cwd, env vars (SHLVL, PATH, HOME, USER, SHELL), shell options (`set +o`). State stored on session and included in output as a diff. Model tracks cwd changes, env mutations, shell option toggles across commands. Commit `5b79bc0`. |
| F15 | **Process lifecycle management** | ✅ | P2 | M | `shell_list` enhanced: `reattach` (read ALL buffered output from beginning), `close_all`, richer metadata (idle time, total output bytes, last command). Sessions track totalStdoutBytes, totalStderrBytes, lastAccessedAt, lastCommand, state. Commit `5b79bc0`. |

---

## 6. Hooks & Observability

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| H1 | **Extended hook events (10 vs 5)** | ✅ | P2 | M | 11 events matching Codex: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, Stop, PermissionRequest, SubagentStart, SubagentStop, PreCompact, PostCompact. Payload types for each. Config schema and runtime dispatch updated. |
| H4 | **Hook context injection (additionalContext)** | ✅ | P2 | S | `additionalContext` field in HookResult parsed from hook stdout JSON. Propagated through invoke(), toSdkOutput(), and invokeStop(). Available for both allow and deny results. Commit `071772e`. |
| H5 | **Hook trust model (hash verification)** | ✅ | P3 | M | `hooks/config.ts`: `contentHash` field on HookConfig. `computeHookHash()` returns SHA-256 of script file content. `verifyHookTrust()` checks hash match (trusted if no hash configured, hash matches, or inline command). `verifyAllHooks()` verifies all hooks in a config file. |
| H6 | **Stop hook (force continuation)** | ✅ | P2 | S | "Stop" HookEvent added. `invokeStop()` convenience method returns `{ forceContinue, additionalContext }`. Deny/fail results force agent to continue. Hook config via `Stop` key in hooks.json. Commit `071772e`. |
| H2 | **OpenTelemetry / distributed tracing** | ❌ | P3 | L | Codex: `otel/`, `core/src/otel_init.rs`. OTLP-based tracing + analytics. swarm-harness: lane events only (no structured telemetry export). |
| H3 | **Feature flags / rollout system** | ❌ | P3 | L | Codex: `features/`, `rollout/`, `core/src/config/managed_features.rs`. Managed feature gating. swarm-harness: capabilities static per engine/provider. |

---

## 7. Realtime & Media

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| R1 | **Realtime / voice mode** | ❌ | P3 | XL | Codex: `realtime-webrtc/`, `core/src/realtime_context.rs`, `realtime_conversation.rs`. WebRTC transport for voice sessions. swarm-harness: request/response streaming only. |
| R2 | **Image generation instructions** | ✅ | P3 | S | `tools/tier1/image-gen-instructions.ts`: `buildImageGenContext()` generates context string with output dir, supported formats, max dimensions. `resolveImagePath()` generates timestamped, sanitized file paths with configurable output dir. |

---

## 8. swarm-harness Leads (Codex doesn't have)

These are areas where swarm-harness is ahead. Not gaps to close — competitive
advantages to preserve.

| # | Feature | Notes |
|---|---|---|
| 🔵1 | **6 swarm topologies** | Fanout, Pipeline, PeerTeam, Committee, CriticLoop, Coordinator |
| 🔵2 | **Task queue with atomic claiming** | task_pull_next, task_create/update/get/list/stop/output |
| 🔵3 | **Inter-agent messaging with broadcasts** | send_message with role addressing, check_inbox |
| 🔵4 | **Role-based tool filtering** | architect/executor/reviewer with per-role allowlists |
| 🔵5 | **ACP (Agent Client Protocol)** | Stdio server, single + team modes, permission escalation routing |
| 🔵6 | **Notebook editing** | notebook_edit (Jupyter .ipynb cell operations) |
| 🔵7 | **commit_changes with git-cascade** | Change-Id trailers + audit-log entries |
| 🔵8 | **Long-lived team daemon** | team start --detach / send / list / stop / kill / logs |
| 🔵9 | **Dead letter queue** | Failed tasks persisted to JSONL for post-mortem |
| 🔵10 | **RetryingProvider with fallback** | Provider-level retry + fallback to secondary provider |
| 🔵11 | **Composable engine architecture** | 5 engines (SDK, Native, Hardened, Codex, Test) with EngineCapabilities |
| 🔵12 | **Resource-based tool scheduling** | ToolScheduler with per-resource conflict graph (vs Codex's binary RwLock) |

---

## Prioritized Plan (draft)

### Phase A — Safety Foundation (P0, ~3 weeks)

Close the critical safety gaps that block production use with untrusted input.

1. **S1: Linux sandbox** — bubblewrap integration for bash tool. Workspace-write
   mode: read-only root, writable project dir. Landlock as fallback when bwrap
   unavailable.
2. **S2: Network policy** — proxy-based or seccomp-based network filtering.
   Domain allow/deny lists in `.swarm-harness/network.json`.

### Phase B — Execution Policy (P1, ~2 weeks)

Layer configurable policy on top of existing bash validation.

3. **E1: Rule engine** — `.rules` file format (layered: global/user/project).
   Prefix matching + Allow/Prompt/Forbidden decisions. Integrate with existing
   bash-validation submodules.
4. **S4: Process hardening** — strip dangerous env vars, disable core dumps.

### Phase C — Interactive Sessions & Process Management (P1, ~3 weeks)

Close the interactive session gap that prevents agents from working with
long-running processes, REPLs, debuggers, and dev servers.

5. **F11: Persistent shell sessions** — PTY-based shell sessions that persist
   across tool calls. Session registry with ID-based reuse. Configurable max
   concurrent sessions with LRU eviction.
6. **F12: Interactive stdin** — `write_stdin` capability for sending input to
   running processes (keystrokes, Ctrl-C, REPL commands). Polling for new output.
7. **F13: HeadTailBuffer** — smart output truncation preserving first N + last N
   bytes. Replace current 16 KiB hard cap with configurable head+tail windows
   (default ~20 KiB each).

### Phase D — Guardian & Patch Safety (P1, ~2 weeks)

8. **S3: Guardian** — lightweight LLM reviewer for dangerous actions. Fail-closed
   with timeout. Circuit breaker for repeated denials. Runs in read-only
   context.
9. **S5: Patch safety** — hardlink/TOCTTOU checks in write_file/edit_file
   when sandbox is available.

### Phase E — Hooks & Context (P2, ~3 weeks)

10. **H1: Extended hook events** — add PermissionRequest, Stop, SubagentStart/
    SubagentStop, PreCompact/PostCompact events.
11. **H4: Hook context injection** — implement `additionalContext` field in hook
    output that gets injected as a system message into the conversation.
12. **H6: Stop hook** — allow hooks to force agent continuation on stop event
    (non-zero exit code → keep working).
13. **C2: Context fragments** — extensible context injection system. Start
    with environment context, permission instructions, approved commands.
14. **E5: Granular approval modes** — add OnFailure and UnlessTrusted to
    existing 3 modes.
15. **F5: Request permissions tool** — agent can request elevated permissions.

### Phase F — Persistence & Intelligence (P2, ~4 weeks)

16. **C3: State database** — SQLite backend for session state, goals, memory.
17. **G1: Goals engine** — persistent thread goals with budget tracking.
18. **C1: Remote compaction** — model-based summarization for better context
    preservation.
19. **F14: Shell state snapshots** — capture env/cwd/shell-options after each
    command for cross-invocation state tracking.
20. **F15: Process lifecycle management** — process inventory with list/kill/
    reattach, LRU eviction.

### Deferred (P3)

- G2 (Memory system) — large scope, deferred until state database exists
- R1 (Realtime/voice) — different product category
- H2 (OpenTelemetry) — observability enhancement, not blocking
- H3 (Feature flags) — operational maturity, not blocking
- F9 (File watcher/skills hot-reload)
- F4 (Code mode) — V8 tool orchestration; swarm multi-agent fills similar niche

---

## Tracking

Each task above has a priority and effort estimate. Track progress by
updating status in the tables above. Each gap references its Codex source
(crate/file) for auditing.

When closing a gap, add a decision-log entry below with date, gap ID,
and commit hash.

### Decision log

- **2026-06-05** — Document created from deep-research audit of Codex (130+ crates) vs swarm-harness. Codex system prompt ported to swarm-harness default-system-prompt.ts (commits `bf33eee`, `74d6166`, `59813fd`). HardenedNativeEngine shipped (commits `bed3ac5`–`2240667`): retry, eager dispatch, mid-turn compaction, context_overflow recovery.
- **2026-06-05** — Deep-dive updates: added F11–F15 (interactive sessions / process management, P1), expanded F4 (code mode: V8 tool orchestration), F9 (file watcher: skills hot-reload), H1 (10 vs 5 hook events detail), H4–H6 (hook context injection, trust model, stop hook). Reorganized phased plan: new Phase C (interactive sessions), Phase E (hooks), Phase F (persistence). Process management elevated to P1.
- **2026-06-05** — F11/F12/F13 implemented (commit `8dd4d64`). Persistent shell sessions (`shell_exec`), interactive stdin (`shell_write`), HeadTailBuffer (`headTailTruncate`). Session lifecycle management (`shell_list`). System prompt updated with persistent shell guidance. 56 tests passing.
- **2026-06-05** — F14/F15 implemented (commit `5b79bc0`). Shell state snapshots (cwd/env/opts probe after each command with diff output). Process lifecycle mgmt (reattach, close_all, richer metadata). 75 tests passing.
- **2026-06-05** — Batch A: S4/F5/H4/H6 implemented (commit `071772e`). Process hardening (33 dangerous env vars stripped from all spawned processes). Request permissions tool. Hook context injection (additionalContext). Stop hook (force continuation). 53 new tests passing.
- **2026-06-05** — Batch B: S5/S6/E3 implemented. TOCTTOU protection (SHA-256 hash verification in edit_file/multi_edit, parent dir re-validation in write_file). Secrets detection (16 patterns, entropy filter, redaction). Banned prefix suggestions (55+ commands). 53 new tests passing.
- **2026-06-05** — S1: OS-level sandbox implemented. bubblewrap primary (mount namespaces + seccomp BPF blocking 27 syscalls + namespace isolation). Landlock fallback with embedded C helper compiled at runtime, `--check` probe for runtime Landlock availability detection. `spawnSandboxed()` (async) and `spawnSandboxedSync()` (sync) APIs. Wired into bash.ts and shell-session.ts. Policy modes: require/prefer/off. 26 sandbox tests + 8 bash + 25 shell-session all passing.
- **2026-06-05** — S2: Network policy + proxy implemented. Domain-level allow/deny engine with Codex-compatible glob syntax (exact, `*.`, `**.`, `*`). SSRF protection: DNS resolution + private IP blocking (RFC 1918, loopback, link-local, IPv4-mapped IPv6). Local HTTP/CONNECT proxy server. Config from `.swarm-harness/network.json` (layered discovery: env var, project, home). Proxy env vars injected into all sandbox modes. `web_fetch` enforces policy directly. 52 new tests passing.
- **2026-06-05** — S3+E1: Guardian reviewer + execution policy engine. Guardian: LLM sub-agent with fail-closed design (90s timeout), circuit breaker (3 consecutive or 10/50), risk classification, callback-based review for provider independence. ExecPolicy: layered rules.json (system/project/user/env), prefix matching with alternatives, Allow/Prompt/Forbidden (strictest wins), shell -c unwrapping. 51 new tests passing.
- **2026-06-05** — E2+E5+H1: Auto-amendment (deriveAmendment + persistAmendment for learning from approvals). Granular approval modes (5 modes: never/always/unless-allowed/on-failure/on-request layered on PermissionMode). Extended hook events (11 events matching Codex: added PermissionRequest, SubagentStart/Stop, PreCompact/PostCompact with payload types, config schema, runtime dispatch). 24 new tests.
- **2026-06-05** — E4+H5+F2+F3+F8+R2: Command canonicalization (full pipeline: env vars, command prefixes, shell/interpreter unwrapping, heredoc stripping). Hook trust model (SHA-256 content hash verification). View image tool (base64 data URI, 7 formats, 20 MiB limit). Tool search (keyword matching with scoring). Mention syntax (@tool/@plugin:tool parsing with email exclusion). Image generation instructions (context builder + path resolver). 98 tests passing.
- **2026-06-05** — C1: Remote compaction (model-based summarization). LLM-based session compaction modeled on Codex `compact_remote_v2.rs`. Structured 9-section summary prompt with analysis/summary tags. `RemoteCompactionConfig` extends `CompactionConfig`. Fail-safe fallback to mechanical on error/timeout. Type guard dispatch integrated into NativeEngine and HardenedNativeEngine. Emergency context_overflow paths stay mechanical for speed. 17 new tests, 28 existing compactor + 56 engine tests still passing.
- **2026-06-06** — C2+C3+G1: Context fragments (9 built-in types with composable ContextBuilder, priority sorting, register/unregister, singleton). State database (SQLite-backed via better-sqlite3, WAL mode, 4 tables with migrations, full CRUD, memory search). Goals engine (6-state machine, token+cost budget tracking, checkpoint system, GoalRegistry, StateDB serialization). 67 new tests passing.
