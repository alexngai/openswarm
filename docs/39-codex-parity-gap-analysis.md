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
| S1 | **OS-level sandbox (bubblewrap + seccomp + Landlock)** | ❌ | P0 | XL | Codex: `linux-sandbox/`, `core/src/sandboxing/`, `core/src/landlock.rs`. Mount namespaces isolate filesystem; seccomp BPF blocks dangerous syscalls (io_uring, ptrace, process_vm_*); Landlock as kernel-level backup. swarm-harness: nothing — bash runs unrestricted after permission check. |
| S2 | **Network proxy / firewall** | ❌ | P0 | XL | Codex: `network-proxy/`, `core/src/network_policy_decision.rs`. Local proxy intercepts all outbound traffic; domain-level allow/deny; blocks local/private addresses (SSRF). swarm-harness: `RequiredPermission: "network"` type exists but unenforced at execution time. |
| S3 | **Guardian (AI-powered approval reviewer)** | ❌ | P1 | XL | Codex: `core/src/guardian/`. LLM sub-agent reviews dangerous actions with fail-closed design, 90s timeout, circuit breaker (3 consecutive or 10/50 denials). Runs in read-only sandbox with `approval_policy = Never`. swarm-harness: relies on user prompts or mode-based gating only. |
| S4 | **Process hardening (pre-main security)** | ❌ | P1 | M | Codex: `process-hardening/`. Disables core dumps, prevents ptrace, strips dangerous env vars (LD_PRELOAD, DYLD_*). swarm-harness: none. |
| S5 | **Patch safety with hardlink/TOCTTOU awareness** | ⚠️ | P1 | M | Codex: `core/src/safety.rs`. Validates file writes against writable roots but still runs inside sandbox to prevent hardlink attacks. swarm-harness: has symlink escape guards in write_file/edit_file but no sandbox enforcement layer. |
| S6 | **Secrets detection** | ❌ | P2 | M | Codex: `secrets/`. Detects and blocks secrets in tool output. swarm-harness: prompt says "don't commit secrets" but no automated detection. |

---

## 2. Execution Policy

Codex has a sophisticated rule-based policy engine for shell commands.
swarm-harness has bash validation gates (6 submodules) but no declarative
rule system.

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| E1 | **Declarative execution policy engine (.rules files)** | ❌ | P1 | L | Codex: `execpolicy/`, `core/src/exec_policy.rs`. Layered .rules files (global/user/project) with prefix matching, heuristic classifiers, Allow/Prompt/Forbidden decisions. Starlark support for complex rules. swarm-harness: 6 bash-validation submodules (read-only, destructive, mode, sed, path) — heuristic only, not configurable. |
| E2 | **Auto-amendment of policy rules** | ❌ | P2 | M | Codex: when user approves a command, system auto-derives narrowly-scoped prefix rule and persists to `default.rules`. swarm-harness: no learning from approvals. |
| E3 | **Banned prefix suggestions** | ❌ | P2 | S | Codex: prevents overly broad "always allow" rules for interpreters (python, bash, node, git, sudo, etc. — 40+ entries). swarm-harness: no equivalent. |
| E4 | **Command canonicalization** | ❌ | P2 | M | Codex: `core/src/command_canonicalization.rs`. Normalizes shell commands (unwraps `bash -lc "..."`, PowerShell wrappers, heredocs) for policy matching. swarm-harness: no equivalent. |
| E5 | **Granular approval modes** | ⚠️ | P2 | M | Codex: 5 modes (Never, OnFailure, OnRequest, UnlessTrusted, Granular with separate rules_approval + sandbox_approval). swarm-harness: 3 modes (read-only, workspace-write, danger-full-access). |

---

## 3. Session & Context

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| C1 | **Remote compaction (model-based summarization)** | ❌ | P2 | L | Codex: `core/src/compact_remote.rs`, `compact_remote_v2.rs`. Calls external model to compress conversation history. swarm-harness: local-only Memento compaction (char-count heuristic). |
| C2 | **Rich context fragments (29 types)** | ⚠️ | P2 | L | Codex: `core/src/context/` (29 files). Environment, permissions, user instructions, personality, plugins, skills, collaboration mode, image generation, network rules, model switching, realtime, guardian reminders, approved commands, turn aborts. swarm-harness: system prompt + role suffix + AGENTS.md — no dynamic context injection system. |
| C3 | **State database (SQLite-backed)** | ❌ | P2 | L | Codex: `state/` with migrations for goals, logs, memory. swarm-harness: in-memory + session JSONL files only. |

---

## 4. Goals & Memory

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| G1 | **Goals engine (persistent thread goals)** | ❌ | P2 | L | Codex: `core/src/goals.rs`. 6 states (Active, Paused, Blocked, UsageLimited, BudgetLimited, Complete). Token budget tracking, runtime accounting, automatic continuations. swarm-harness: no equivalent. |
| G2 | **Memory system (cross-session learning)** | ❌ | P2 | XL | Codex: `memories/read/`, `memories/write/`. Two-phase pipeline: Phase 1 (rollout extraction from session transcripts) and Phase 2 (global consolidation). Memories injected into subsequent sessions. swarm-harness: no long-term memory across sessions. |

---

## 5. Tools & Agent Features

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| F1 | **apply_patch tool (unified diff editing)** | 🟦 | — | — | Codex: `core/src/apply_patch.rs`. Unified diff format with add/delete/update/move. swarm-harness: edit_file with exact-string replacement + multi_edit for atomic batches. Different approach; swarm's is arguably safer (no ambiguous hunks). |
| F2 | **View image tool** | ❌ | P3 | S | Codex: `core/src/tools/handlers/view_image.rs`. Dedicated tool for agent to view/analyze images. swarm-harness: provider-level vision (imageIn capability) but no agent-facing tool. |
| F3 | **Tool search (dynamic tool discovery)** | ❌ | P3 | S | Codex: `core/src/tools/handlers/tool_search.rs`. Agent can search for available tools. swarm-harness: tools are statically declared per run. |
| F4 | **Code mode (execute/wait lifecycle)** | ❌ | P3 | L | Codex: `core/src/tools/code_mode/`. Specialized code execution with execute/wait. swarm-harness: bash tool only. |
| F5 | **Request permissions tool** | ❌ | P2 | S | Codex: `core/src/tools/handlers/request_permissions.rs`. Agent can request elevated permissions mid-session. swarm-harness: permission mode is fixed for the session. |
| F6 | **Request user input tool** | ✅ | — | — | Codex: `core/src/tools/handlers/request_user_input.rs`. swarm-harness: `ask_user_question` (Tier 2). Parity. |
| F7 | **Multi-agent v2 (spawn/send/wait/close/followup)** | 🟦 | — | — | Codex: `core/src/tools/handlers/multi_agents_v2/`. swarm-harness: richer model with task queue, pull protocol, topologies, team daemon. swarm-harness leads. |
| F8 | **Mention syntax (@plugin, @tool)** | ❌ | P3 | S | Codex: `core/src/mention_syntax.rs`. Text-level references to plugins/tools. swarm-harness: no equivalent. |
| F9 | **File watcher** | ❌ | P3 | M | Codex: `file-watcher/`. Watches filesystem for changes. swarm-harness: none. |
| F10 | **Web search (multi-action)** | ⚠️ | P3 | M | Codex: `web-search/`. 4 action types (Search, OpenPage, FindInPage, Other). swarm-harness: web_search is a placeholder (intercepted by SDK); web_fetch works. |

---

## 6. Hooks & Observability

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| H1 | **Extended hook events** | ⚠️ | P2 | M | Codex: 10 events (SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, Stop, SubagentStart, SubagentStop, PreCompact, PostCompact). swarm-harness: 5 events (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, SessionEnd). Missing: PermissionRequest, SubagentStart/Stop, PreCompact/PostCompact. |
| H2 | **OpenTelemetry / distributed tracing** | ❌ | P3 | L | Codex: `otel/`, `core/src/otel_init.rs`. OTLP-based tracing + analytics. swarm-harness: lane events only (no structured telemetry export). |
| H3 | **Feature flags / rollout system** | ❌ | P3 | L | Codex: `features/`, `rollout/`, `core/src/config/managed_features.rs`. Managed feature gating. swarm-harness: capabilities static per engine/provider. |

---

## 7. Realtime & Media

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| R1 | **Realtime / voice mode** | ❌ | P3 | XL | Codex: `realtime-webrtc/`, `core/src/realtime_context.rs`, `realtime_conversation.rs`. WebRTC transport for voice sessions. swarm-harness: request/response streaming only. |
| R2 | **Image generation instructions** | ❌ | P3 | S | Codex: `core/src/context/image_generation_instructions.rs`. Output directory/path instructions for generated images. swarm-harness: none. |

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

### Phase C — Guardian & Patch Safety (P1, ~2 weeks)

5. **S3: Guardian** — lightweight LLM reviewer for dangerous actions. Fail-closed
   with timeout. Circuit breaker for repeated denials. Runs in read-only
   context.
6. **S5: Patch safety** — hardlink/TOCTTOU checks in write_file/edit_file
   when sandbox is available.

### Phase D — Context & Policy (P2, ~3 weeks)

7. **C2: Context fragments** — extensible context injection system. Start
   with environment context, permission instructions, approved commands.
8. **E5: Granular approval modes** — add OnFailure and UnlessTrusted to
   existing 3 modes.
9. **F5: Request permissions tool** — agent can request elevated permissions.

### Phase E — Persistence & Intelligence (P2, ~4 weeks)

10. **C3: State database** — SQLite backend for session state, goals, memory.
11. **G1: Goals engine** — persistent thread goals with budget tracking.
12. **C1: Remote compaction** — model-based summarization for better context
    preservation.

### Deferred (P3)

- G2 (Memory system) — large scope, deferred until state database exists
- R1 (Realtime/voice) — different product category
- H2 (OpenTelemetry) — observability enhancement, not blocking
- H3 (Feature flags) — operational maturity, not blocking
- F2/F3/F4/F8/F9 (View image, tool search, code mode, mentions, file watcher)
- E2/E3/E4 (Auto-amendment, banned prefixes, canonicalization)
- S6 (Secrets detection)

---

## Tracking

Each task above has a priority and effort estimate. Track progress by
updating status in the tables above. Each gap references its Codex source
(crate/file) for auditing.

When closing a gap, add a decision-log entry below with date, gap ID,
and commit hash.

### Decision log

- **2026-06-05** — Document created from deep-research audit of Codex (130+ crates) vs swarm-harness. Codex system prompt ported to swarm-harness default-system-prompt.ts (commits `bf33eee`, `74d6166`, `59813fd`). HardenedNativeEngine shipped (commits `bed3ac5`–`2240667`): retry, eager dispatch, mid-turn compaction, context_overflow recovery.
