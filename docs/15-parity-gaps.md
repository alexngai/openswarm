# Parity gaps: openswarm vs claw-code

Living tracker of disparities between `openswarm` (TS) and `references/claw-code/` (Rust reference). Not all gaps should be closed — some reflect intentional design divergence. Use this doc to decide which to close, which to defer, and which to reject.

**openswarm is not a port.** It is a swarm-native reimplementation that borrows from claw-code where the design aligns. Anchor every decision in `00-vision.md` and `05-swarm-model.md` before adopting a claw pattern.

## Legend

| Status | Meaning |
|---|---|
| ❌ missing | No equivalent exists in openswarm |
| ⚠️ partial | Implemented but incomplete or staged-not-shipped |
| ✅ present | Behaviorally equivalent |
| 🟦 divergent | Intentionally different design; not a gap |
| 🚫 rejected | Claw has it; we've decided not to adopt |

**Priority:** `P0` (blocks usability) · `P1` (meaningful UX/feature gap) · `P2` (nice-to-have) · `P3` (deferred / unclear value)

**Effort:** `XS` (<0.5d) · `S` (0.5–1d) · `M` (1–3d) · `L` (3–7d) · `XL` (>1w)

---

## 1. TUI

openswarm uses Ink/React; claw-code uses crossterm + rustyline + syntect + pulldown_cmark. The rendering stacks produce visibly different experiences. This section is where the user's pain is most tangible.

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| T1 | Multi-line input (Shift+Enter / Ctrl+J) | ✅ | P1 | M | Phase 4 stage A/C — TextareaRenderable mounted (shift+Enter/Ctrl+J wired in Phase 0) + Phase 4 stage C CRLF normalization on paste. |
| T2 | Markdown rendering in transcript (headings, lists, bold/italic, block quotes) | ✅ | P1 | M | Phase 3 (`0120fe2`) — OpenTUI's `<markdown>` primitive in [transcript.tsx](src/ui/repl-solid/transcript.tsx) parses with `marked` and conceals syntax markers. Theme-tuned `SyntaxStyle.fromTheme(...)` against [theme.ts](src/ui/repl-solid/theme.ts). |
| T3 | Syntax-highlighted code blocks | ✅ | P1 | M | Phase 3 follow-up — Tree-sitter wired via `getTreeSitterClient()` in [transcript.tsx](src/ui/repl-solid/transcript.tsx). Bundled OpenTUI WASM grammars for typescript, javascript, markdown, zig; fenced code blocks pick up language-aware highlighting via the markdown grammar's `infoStringMap`. |
| T4 | Tables in markdown | ✅ | P2 | S | Phase 3 — free from OpenTUI's native table layout in `<markdown>` (Markdown.d.ts:11-50). Width-regression tests in [e2e.test.tsx](src/ui/repl-solid/e2e.test.tsx) assert table cells render at 80 + 120 col. |
| T5 | Inline approval prompts (y/N) instead of `/approve`/`/deny` | ✅ | P0 | S | Phase 2 stages C–G (`eeb4293..6d27a94`) — `PermissionBridge` async coordinator + inline `PermissionPrompt` Solid component + headless JSONL `permission_required` + stdin reader. `/approve` and `/deny` slash commands removed (P2.Q5). |
| T6 | Persistent command history across sessions | ✅ | P2 | S | Phase 4 stage A — `src/ui/history.ts` writes to `~/.openswarm/history` (10k-entry cap, dedup, multi-line escape). |
| T7 | Emacs keybindings (full set) | ✅ | P2 | S | Phase 4 stage B — Alt+B/F/D/Backspace word motions + Ctrl+Y yank wired in `input.tsx` KEY_BINDINGS + reducer. |
| T8 | Spinner that overwrites same line and transitions to ✔/✘ | ✅ | P3 | XS | v0.2 Stage 2F — [spinner.tsx](src/ui/repl-solid/spinner.tsx) now transitions to ✔ (success) or ✘ (failure) for `transitionMs` ms (default 500) when `active` goes false. `outcome` prop controls which glyph. Phase collapses to "done" (hidden) after transition. Tests in spinner.test.tsx cover success transition, failure transition, and post-transition hide. |
| T9 | Slash-command dropdown menu (openswarm has this) | 🟦 | — | — | Nice-to-keep; claw only has silent rustyline completion. Don't regress. |
| T10 | Compaction lifecycle UI (openswarm has this) | 🟦 | — | — | Don't regress. |
| T11 | Pending-permission display in status bar (openswarm has this) | 🟦 | — | — | Keep even after T5 lands — status bar shows *what* is pending. |

**TUI decision** (resolved 2026-04-30 in Phase 3): T2/T3/T4 ship via OpenTUI's native `<markdown>` primitive + bundled Tree-sitter WASM grammars (typescript, javascript, markdown, zig). The Phase 0 substrate migration (Bun + OpenTUI/Solid) made the original "hand-roll vs library" choice moot. See [Phase 3 design lock](17-parity-design-questions.md#phase-3--design-lock-2026-04-30).

---

## 2. Architecture / Runtime

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| A1 | Worker boot state machine (spawning → trust_required → ready_for_prompt → …) | ✅ | P1 | M | Phase 5 stage B — `src/swarm/worker-lifecycle.ts` (8-state enum + transition table) + `WorkerHost.getLifecycleState()` + `worker_lifecycle_changed` lane event. |
| A2 | Branch lock / stale-base / stale-branch detection | 🟦 | P1 | M | Audited in Stage 2C (doc 22). No correctness gaps vs claw's three modules. Deliberate divergences: cross-process file lock (claw uses in-process OnceLock, unsafe for subprocess workers), `.swarm-base` marker file, `resolveMainRef` fallback chain, silent `not-a-git-repo`. One observability gap (`StaleBranchEvent` envelope) deferred to v0.3+ telemetry pass. See `docs/22-a2-branch-lock-audit.md`. |
| A3 | Recovery recipes | ❌ | P2 | L | claw: `runtime/recovery_recipes.rs`. Structured fallback for known failure modes. Lower priority until we have telemetry showing which failures repeat. |
| A4 | Policy engine (merge/retry/rebase/escalation) | ❌ | P2 | L | claw: `runtime/policy_engine.rs`. Currently swarm handles retries inline in Orchestrator. |
| A5 | Typed lane events (blockers, failure classification) | ✅ | P1 | M | Phase 5 stage C — `TypedLaneEvent` discriminated union + `assertNeverEvent` exhaustiveness gate (incremental migration; 3 new variants typed, 70+ existing stay unknown per P5.Q9). v0.2.Q6 Stage 2F: 10 more variants typed (text_delta, tool_use_start, tool_use_input, tool_use_end, tool_result, message_stop, task_created, task_updated, task_completed, task_failed) — now 13 typed variants total. |
| A6 | Sandbox abstraction (Linux `unshare`, macOS sandbox-exec) | ❌ | P3 | L | claw: `runtime/sandbox.rs`. Platform-specific; low user value for macOS-first. Defer. |
| A7 | Green contract (declarative config validation) | ❌ | P3 | S | claw: `runtime/green_contract.rs`. Cosmetic until config becomes complex. |
| A8 | Server-side token preflight | ✅ | P2 | S | v0.2.Q6 Stage 2F — `serverCountTokens()` in `src/engine/token-preflight.ts` calls `@anthropic-ai/sdk` `client.messages.countTokens()` when `ANTHROPIC_API_KEY` is set; result propagates via `countTokens()` with `source: "server"`. **Nuance:** Claude Max subscription users authenticate via OAuth (not API key) — the `count_tokens` REST endpoint returns 401 for them. Those callers always fall through to `source: "local-estimate"`. If the Agent SDK ever exposes a native token-count method compatible with OAuth, prefer it in `token-preflight.ts`. |
| A9 | Two-engine design (SDK + Native) | 🟦 | — | — | openswarm unique. Don't regress. |
| A10 | Swarm orchestration (WorkerPool, lane events, role overlays) | ✅ | — | — | openswarm lead — full team primitives shipped via `TeamSession` + topology layer (v0.4, commits `0bd0f20..<close-out>`). Multi-engine peer parity (transport / `--framework claude-agent-sdk` / `--framework codex-chatgpt` via DynamicToolCall). v0.5 added Committee + CriticLoop topologies (5A), opentasks adapter (5B), pull-protocol (5C), `team watch` MVP (5D), and the long-lived team daemon (5E.1–5E.7) with `team start --detach` / `team send` / `list` / `stop` / `kill` / `logs`. v0.6 stage 5F shipped `send_prompt` against persistent peer-team daemons. See [docs/25](25-team-orchestration.md), [docs/27](27-v0.4-teams-implementation-plan.md), [docs/28](28-v0.5-daemon-plan.md). |

---

## 3. Tools

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| TO1 | Deep bash validation (6 submodules: read-only, destructive, mode, sed, path, semantics) | ✅ | P1 | M | Phase 5 stage A — `src/tools/tier0/bash-validation/` (6 submodules ported from claw) + bash-gate in `canUseTool`. |
| TO2 | MCP lifecycle hardening (partial-success / degraded-mode reporting) | ⚠️ | P1 | M | claw: `runtime/mcp_lifecycle_hardened.rs`. swarm has basic MCP bridge; failures not classified per-server. |
| TO3 | `pdf_extract` tool | ❌ | P3 | S | claw tier 3. Defer unless a user hits it. |
| TO4 | `repl` tool (interactive REPL) | ❌ | P3 | M | claw tier 3. Unclear value relative to bash + write-to-file. |
| TO5 | `powerShell` tool | ❌ | P3 | S | Windows-specific; out of scope for v0. |
| TO6 | Edit-file ambiguity rejection (openswarm fix vs claw silent-first-match) | 🟦 | — | — | openswarm improvement over claw. Keep. |

---

## 4. Providers & Auth

M4b work is the bulk of this section. Most gaps are "written but not shipped" rather than unplanned.

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| P1 | xAI (Grok) transport + routing | ✅ | P1 | S | Phase 1 stage 4 (`f1ce7f6`) — alias table (`grok` → `grok-3`, `grok-mini`). Provider live via `--model grok` against `XAI_API_KEY`. Documented in README §Models & aliases. |
| P2 | Google Generative AI transport + routing | ✅ | P1 | S | Phase 1 — provider live via `--model gemini-*` against `GOOGLE_GENERATIVE_AI_API_KEY` (pass-through aliases). Documented in README §Models & aliases. |
| P3 | DashScope / Qwen transport + 6 MiB preflight | ✅ | P2 | S | Phase 1 stage 4 — alias `kimi` → `kimi-k2.5`. Provider live via `--model qwen*`/`--model kimi*` against `DASHSCOPE_API_KEY`. Smoke via `scripts/smoke-m4b.sh --live`. |
| P4 | OpenAI OAuth (ChatGPT Plus/Pro → Codex endpoint) | ✅ | P1 | M | Phase 6 v0.3 — App Server JSON-RPC integration shipped ([docs/24-phase-6-codex-app-server-plan.md](24-phase-6-codex-app-server-plan.md)). |
| P5 | Anthropic API-key path without Agent SDK | ⚠️ | P2 | S | Currently Max subscription → SDK; direct API key → Vercel. Confirm feature parity across paths. |

---

## 5. Plugins, Slashes, Scheduling

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| PS1 | Plugin install/enable/disable/update/uninstall lifecycle | ✅ | P0 | XS | Phase 1 stage 5 (`82a8a50`) — `/plugin install`, `/plugin enable`, `/plugin disable`, `/plugin list` slash commands wired in [src/cli/slash/commands/plugin.ts](src/cli/slash/commands/plugin.ts). |
| PS2 | Plugin state persistence | ✅ | P0 | XS | Phase 1 stage 2 (`c0a4ebc`) — two-file schema at `~/.openswarm/plugins/{settings,installed}.json` (Q1 design lock). Read-only discovery of `~/.claude/plugins/` for plugins installed via Claude Code. |
| PS3 | Real cron scheduler (background worker pool) | ❌ | P2 | L | `CronRegistry` is in-memory only; scheduled tasks never fire. Defer until a user needs it. |
| PS4 | Extended slash: `/ultraplan` | ❌ | P3 | M | Claw multi-turn planner. Could ship as a plugin. |
| PS5 | Extended slash: `/teleport` (symbol jump) | ❌ | P3 | M | Claw LSP-backed. Requires LSP client maturity. |
| PS6 | Extended slash: deeper `/plan` (session-aware) | ❌ | P3 | M | |

---

## 6. Docs & Parity Harness

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| D1 | Mock parity harness (scripted scenarios vs captured requests) | ❌ | P2 | L | claw: `PARITY.md` references 10 scenarios / 19 captured requests. Would catch regressions across engines. |
| D2 | Session trajectory smoke suite | ✅ | P2 | S | v0.2 Stage 2F — audited in `docs/23-d2-smoke-audit.md`. 8 scripts covering 35+ trajectories. Only `smoke-opentui.sh` runs in CI; remaining 7 are developer-run. Gaps documented: budget-exceeded trajectory, server-preflight live scenario, inline permission-prompt smoke, SDK-vs-NativeEngine cross-comparison (D1), MCP e2e (TO2). Recommendations: add budget-exceeded offline scenario to smoke-m4a.sh (XS), promote M1/M3a offline scripts to CI (M). |

---

## Prioritized next moves (draft — iterate)

Reflects gap status as of v0.2 close-out (2026-04-30):

**Shipped (Phases 0–5.5 + v0.2):** PS1, PS2, T5, T1, T2, T3, T4, T6, T7, P1, P2, P3, TO1, A1, A5, A2, A8, D2, T8.

**Remaining open / partial:**
1. ⚠️ **TO2** — MCP lifecycle hardening (per-server failure classification). Usage-driven; only if MCP failures bite users. M effort.
2. ⚠️ **P5** — Anthropic API-key path without Agent SDK (edge case; most users use subscription).

**Blocked:**
- ⛔ **P4** — OpenAI OAuth (Phase 6 in [16-parity-plan.md](16-parity-plan.md)). Operator Codex spike not yet done. v0.2 ships without; users with `OPENAI_API_KEY` already work via direct API. Targeted for v0.3.

**Defer indefinitely (per [16-parity-plan.md § Deferred](16-parity-plan.md#deferred-not-in-this-plan)):** A3, A4, A6, A7, PS3, PS4–PS6, TO3–TO5, D1.

---

## Decision log

- **2026-05-04** — v0.5 close-out + 5F (send_prompt) shipped early. Stages: 5A (Committee + CriticLoop topologies), 5B (opentasks daemon adapter — live-verified against opentasks 0.1.3), 5C (pull-protocol + `task_pull_next` Tier 2 tool), 5D MVP (`team watch` formatted live event tail; multi-pane TUI deferred), 5E.1–5E.7 + path-length follow-up (long-lived team daemon — `team start --detach` / `send` / `list` / `stop` / `kill` / `logs`). v0.6 stage 5F (`send_prompt` against persistent peer-team daemons) shipped early. Plus four v0.4 follow-ups discovered during integration: 4M.5 (Q9 framework forwarding fix), 4M.6 (worker-side `agent` IPC handler), 4M.7 (worker-side `agent({team:"self"})`), 4M.8 (Q9 + codex-team smokes), 4M.9 (project-wide zod v4 JSON Schema generation fix). Tests went from 1453 (v0.4 close-out) → 1795. A10 row updated.
- **2026-05-02** — v0.4 close-out. Team orchestration shipped: `TeamSession` primitive, 4 topology executors (Fanout / Pipeline / PeerTeam / Coordinator), long-lived workers, openteams YAML loader, multi-engine peer parity (drop framework-filter strip + Codex `DynamicToolCall`), in-process MAP adapter, broader CLI (`team start` / `topology` / `--ecosystem` flag + cross-process `team send/list/stop/kill` stubs deferred to v0.5+). 18 stage commits `0bd0f20..<close-out>`. A10 flipped 🟦 → ✅.
- **2026-04-30** — v0.2 close-out. All 13 v0.2 audit items closed (shipped, audit-completed, or re-deferred with rationale). Six stage commits: `deaf038` Stage 2A (bash-validation in danger-full-access), `46bbf42` Stage 2B (worker state file), `5f25888` Stage 2C (A2 branch-lock audit), `bce2007` Stage 2D (SDK-version baking doc note), `c9478d2` Stage 2E (two-prompt collapse + budget enforcement), `5ba50ff` Stage 2F (typed events +10 / token preflight / smoke audit / spinner polish). Rows A2, A8, D2, T8 flipped from ⚠️ → ✅.
- **2026-04-30** — v0.1 close-out hygiene pass. T2/T3/T4/T5 flipped from ❌ → ✅ (shipped in Phases 2 + 3); PS1/PS2/P1/P2/P3 flipped from ⚠️ → ✅ (shipped in Phase 1). Rows now cite the originating phase + commit hash. "TUI decision needed" block resolved by Phase 0 substrate migration + Phase 3 design lock.
