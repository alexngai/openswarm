# Parity gaps: swarm-coder vs claw-code

Living tracker of disparities between `swarm-coder` (TS) and `references/claw-code/` (Rust reference). Not all gaps should be closed — some reflect intentional design divergence. Use this doc to decide which to close, which to defer, and which to reject.

**swarm-coder is not a port.** It is a swarm-native reimplementation that borrows from claw-code where the design aligns. Anchor every decision in `00-vision.md` and `05-swarm-model.md` before adopting a claw pattern.

## Legend

| Status | Meaning |
|---|---|
| ❌ missing | No equivalent exists in swarm-coder |
| ⚠️ partial | Implemented but incomplete or staged-not-shipped |
| ✅ present | Behaviorally equivalent |
| 🟦 divergent | Intentionally different design; not a gap |
| 🚫 rejected | Claw has it; we've decided not to adopt |

**Priority:** `P0` (blocks usability) · `P1` (meaningful UX/feature gap) · `P2` (nice-to-have) · `P3` (deferred / unclear value)

**Effort:** `XS` (<0.5d) · `S` (0.5–1d) · `M` (1–3d) · `L` (3–7d) · `XL` (>1w)

---

## 1. TUI

swarm-coder uses Ink/React; claw-code uses crossterm + rustyline + syntect + pulldown_cmark. The rendering stacks produce visibly different experiences. This section is where the user's pain is most tangible.

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| T1 | Multi-line input (Shift+Enter / Ctrl+J) | ❌ | P1 | M | [input.tsx](src/ui/repl/input.tsx) is hard-coded single-line; claw uses rustyline native support. Blocks pasting multi-line prompts. |
| T2 | Markdown rendering in transcript (headings, lists, bold/italic, block quotes) | ❌ | P1 | M | Removed after `ink-markdown` ESM breakage ([04d3129](https://github.com/)). Need ESM-safe alternative or hand-rolled renderer. |
| T3 | Syntax-highlighted code blocks | ❌ | P1 | M | claw uses `syntect` with ANSI output. Options: `cli-highlight`, `shiki` (heavy), or ship without. |
| T4 | Tables in markdown | ❌ | P2 | S | Follows T2. |
| T5 | Inline approval prompts (y/N) instead of `/approve`/`/deny` | ❌ | P0 | S | Current slash-command approval is jarring. claw blocks stdin with tool info + y/N inline. See [status.tsx](src/ui/repl/status.tsx). |
| T6 | Persistent command history across sessions | ❌ | P2 | S | Claw via rustyline. Write to `~/.swarm-coder/history` with size cap. |
| T7 | Emacs keybindings (full set) | ⚠️ | P2 | S | Partial in [state.ts](src/ui/repl/state.ts); claw sets `EditMode::Emacs` explicitly. Ink defaults vary. |
| T8 | Spinner that overwrites same line and transitions to ✔/✘ | ⚠️ | P3 | XS | [spinner.tsx](src/ui/repl/spinner.tsx) exists; claw's is more polished. |
| T9 | Slash-command dropdown menu (swarm-coder has this) | 🟦 | — | — | Nice-to-keep; claw only has silent rustyline completion. Don't regress. |
| T10 | Compaction lifecycle UI (swarm-coder has this) | 🟦 | — | — | Don't regress. |
| T11 | Pending-permission display in status bar (swarm-coder has this) | 🟦 | — | — | Keep even after T5 lands — status bar shows *what* is pending. |

**TUI decision needed:** commit to an approach for T2/T3 or accept a stripped-down TUI. Options:
- (a) Hand-roll ANSI renderer in a dedicated module (full control, ~M+ effort)
- (b) Find an ESM-compatible markdown-for-ink package (low control, XS effort)
- (c) Accept plain text + T5 inline prompts as the v0 bar; defer markdown to v0.2

---

## 2. Architecture / Runtime

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| A1 | Worker boot state machine (spawning → trust_required → ready_for_prompt → …) | ❌ | P1 | M | claw: `runtime/worker_boot.rs`. swarm-coder's WorkerHost lifecycle is implicit. Makes trust prompts and ready handshakes testable. |
| A2 | Branch lock / stale-base / stale-branch detection | ⚠️ | P1 | M | claw: `runtime/branch_lock.rs`, `stale_base.rs`, `stale_branch.rs`. swarm has partial git coordination in M3a — verify what's actually ported vs stubbed. |
| A3 | Recovery recipes | ❌ | P2 | L | claw: `runtime/recovery_recipes.rs`. Structured fallback for known failure modes. Lower priority until we have telemetry showing which failures repeat. |
| A4 | Policy engine (merge/retry/rebase/escalation) | ❌ | P2 | L | claw: `runtime/policy_engine.rs`. Currently swarm handles retries inline in Orchestrator. |
| A5 | Typed lane events (blockers, failure classification) | ⚠️ | P1 | M | claw: `runtime/lane_events.rs`. swarm has TaskPacket but no typed event enum. Affects telemetry and UI affordances. |
| A6 | Sandbox abstraction (Linux `unshare`, macOS sandbox-exec) | ❌ | P3 | L | claw: `runtime/sandbox.rs`. Platform-specific; low user value for macOS-first. Defer. |
| A7 | Green contract (declarative config validation) | ❌ | P3 | S | claw: `runtime/green_contract.rs`. Cosmetic until config becomes complex. |
| A8 | Server-side token preflight | ⚠️ | P2 | S | swarm has CompactionConfig but no server-reported token counts before send. |
| A9 | Two-engine design (SDK + Native) | 🟦 | — | — | swarm-coder unique. Don't regress. |
| A10 | Swarm orchestration (WorkerPool, lane events, role overlays) | 🟦 | — | — | swarm-coder unique. Core differentiator. |

---

## 3. Tools

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| TO1 | Deep bash validation (6 submodules: read-only, destructive, mode, sed, path, semantics) | ⚠️ | P1 | M | claw: `runtime/bash_validation.rs` (branch-only). swarm has one-layer validation. Matters for trust in `--headless` runs. |
| TO2 | MCP lifecycle hardening (partial-success / degraded-mode reporting) | ⚠️ | P1 | M | claw: `runtime/mcp_lifecycle_hardened.rs`. swarm has basic MCP bridge; failures not classified per-server. |
| TO3 | `pdf_extract` tool | ❌ | P3 | S | claw tier 3. Defer unless a user hits it. |
| TO4 | `repl` tool (interactive REPL) | ❌ | P3 | M | claw tier 3. Unclear value relative to bash + write-to-file. |
| TO5 | `powerShell` tool | ❌ | P3 | S | Windows-specific; out of scope for v0. |
| TO6 | Edit-file ambiguity rejection (swarm-coder fix vs claw silent-first-match) | 🟦 | — | — | swarm-coder improvement over claw. Keep. |

---

## 4. Providers & Auth

M4b work is the bulk of this section. Most gaps are "written but not shipped" rather than unplanned.

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| P1 | xAI (Grok) transport + routing | ⚠️ | P1 | S | M4b Phase 2–3 staged. Ship. |
| P2 | Google Generative AI transport + routing | ⚠️ | P1 | S | M4b Phase 2–3 staged. Ship. |
| P3 | DashScope / Qwen transport + 6 MiB preflight | ⚠️ | P2 | S | M4b Phase 2–3 staged. |
| P4 | OpenAI OAuth (ChatGPT Plus/Pro → Codex endpoint) | ⚠️ | P1 | M | M4b Phase 4 staged. Blocked on operator Codex spike. |
| P5 | Anthropic API-key path without Agent SDK | ⚠️ | P2 | S | Currently Max subscription → SDK; direct API key → Vercel. Confirm feature parity across paths. |

---

## 5. Plugins, Slashes, Scheduling

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| PS1 | Plugin install/enable/disable/update/uninstall lifecycle | ⚠️ | P0 | XS | M4b Phase 3. Files staged under [src/plugins/](src/plugins/). ~0.2d remaining per [14-m4b-plan.md](docs/14-m4b-plan.md). |
| PS2 | Plugin state persistence (`~/.claude/plugins/state.json`) | ⚠️ | P0 | XS | Part of PS1. |
| PS3 | Real cron scheduler (background worker pool) | ❌ | P2 | L | `CronRegistry` is in-memory only; scheduled tasks never fire. Defer until a user needs it. |
| PS4 | Extended slash: `/ultraplan` | ❌ | P3 | M | Claw multi-turn planner. Could ship as a plugin. |
| PS5 | Extended slash: `/teleport` (symbol jump) | ❌ | P3 | M | Claw LSP-backed. Requires LSP client maturity. |
| PS6 | Extended slash: deeper `/plan` (session-aware) | ❌ | P3 | M | |

---

## 6. Docs & Parity Harness

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| D1 | Mock parity harness (scripted scenarios vs captured requests) | ❌ | P2 | L | claw: `PARITY.md` references 10 scenarios / 19 captured requests. Would catch regressions across engines. |
| D2 | Session trajectory smoke suite | ⚠️ | P2 | S | M4b Phase 8 added smoke scripts; audit what's covered. |

---

## Prioritized next moves (draft — iterate)

Ordered by impact × readiness. Revise as we debate:

1. **PS1/PS2** — ship M4b Phase 3 plugin lifecycle (XS, P0). Unblocks user customization. Nearest to done.
2. **T5** — inline y/N approval prompts (S, P0). Biggest single UX wart in the current TUI.
3. **P1/P2** — ship xAI + Google providers (S each, P1). Code exists; ship needs smoke test.
4. **T2/T3** — pick a path for markdown + code highlighting. Decision first, then M effort.
5. **T1** — multi-line input. Often-hit by anyone pasting a prompt.
6. **TO1** — deepen bash validation. Matters before we promote `--headless` for unattended runs.
7. **A1/A5** — worker boot state machine + typed lane events. Testability and telemetry. Do before adding more lanes.
8. **P4** — OpenAI OAuth. Ship once operator Codex spike returns.
9. Defer: A3, A4, A6, A7, PS3, PS4–PS6, TO3–TO5, D1.

---

## Decision log

_(Add dated entries as we lock choices.)_

- _YYYY-MM-DD_ — …
