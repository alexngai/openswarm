# Parity implementation plan

Phased execution plan for closing the prioritized gaps in [15-parity-gaps.md](docs/15-parity-gaps.md). Each phase has a goal, scope (by gap ID), acceptance criteria, and an estimate. Phases are sequenced by dependencies and risk, not strictly by priority — ship-ready work goes first so we're never blocked on a single decision.

**Ground rules:**
- Each phase ends in a shippable state (main stays green).
- Acceptance criteria are observable, not subjective. "Works on my machine" is not acceptance.
- If a phase slips, cut scope inside the phase, don't reshuffle phases.
- Reference gap IDs from `15-parity-gaps.md` so the gap doc stays the source of truth for *what*; this doc is the source of truth for *how and when*.
- **Phases 2–5 all target OpenTUI/Solid, not Ink/React.** Phase 0 (below) resolves that substrate change before the TUI-heavy phases begin. Any lingering Ink references in later phases are stale and should be read as "the OpenTUI equivalent."

---

## Phase 0 — OpenTUI + Solid migration

**Goal:** Replace the Ink/React TUI substrate with OpenTUI/Solid before we invest in Ink-specific patterns for markdown, multi-line input, or inline approvals. Decided 2026-04-22 per Q15 in [17-parity-design-questions.md](docs/17-parity-design-questions.md).

**Why Phase 0, not later:** opencode's production use of OpenTUI provides every primitive we'd otherwise hand-roll in Phases 3–4. Migrating first avoids ~1–2w of rework on phases that would otherwise build against Ink.

**Gaps closed:** None directly — this is enabling work. Unlocks native solutions for T1, T2, T3, T4 (see [15-parity-gaps.md](docs/15-parity-gaps.md)).

**Scope:**
1. **Pin OpenTUI versions** — add `@opentui/core` and `@opentui/solid` to [package.json](package.json) at the same versions opencode uses (currently `0.1.99`). Mirror opencode's batch-upgrade script pattern (see [references/opencode/packages/opencode/script/upgrade-opentui.ts](references/opencode/packages/opencode/script/upgrade-opentui.ts)) for future bumps.
2. **Port state model** — rewrite [src/ui/repl/state.ts](src/ui/repl/state.ts) from a React-style reducer to Solid's `createStore` + `setStore`. The state shape stays the same; the reactivity primitives change. Keep the existing tests; port them to the new store.
3. **Port components one-for-one:**
   - `app.tsx` → Solid root with `CliRenderer`
   - `transcript.tsx` → `<scrollbox>` of message `<box>` elements
   - `input.tsx` → `TextareaRenderable` (sets up T1 for free — see Phase 4)
   - `status.tsx` → `<box>` with reactive Solid signals
   - `dropdown.tsx` → custom Solid component using `<box>` + `<text>`
   - `spinner.tsx` → port or replace with `opentui-spinner`
4. **Context providers** — set up equivalents for theme, keybinds, route, SDK client. Model after opencode's [context/](references/opencode/packages/opencode/src/cli/cmd/tui/context/) directory but keep only what we need.
5. **Wire streaming events** — dispatch assistant deltas into the Solid store; let `<code streaming={true}>` handle rendering.
6. **Manual scroll tracking** — `ScrollBoxRenderable` doesn't auto-scroll. Port opencode's scroll utilities ([util/scroll.ts](references/opencode/packages/opencode/src/cli/cmd/tui/util/scroll.ts)).
7. **Keybinding map** — every textarea action must be mapped. Start from opencode's [component/textarea-keybindings.ts](references/opencode/packages/opencode/src/cli/cmd/tui/component/textarea-keybindings.ts) and adapt to our keybind config.
8. **Tests** — at minimum, reducer-equivalent state tests, input-submit test, permission-prompt-transition test, streaming-append test.

**Acceptance criteria:**
- Clean `npm run build` and `npm test` green.
- Running `swarm-coder` drops into an OpenTUI REPL with transcript, input, and status line visually equivalent to the current Ink version.
- Streaming assistant responses render progressively.
- Slash-command dropdown works (don't regress T9 from gaps doc).
- Compaction lifecycle UI works (don't regress T10).
- Pending-permission status bar works (don't regress T11).
- `--headless` mode still emits plain JSONL; OpenTUI is bypassed in non-TTY paths.
- No `ERR_REQUIRE_ASYNC_MODULE` on Node 18/20/22 (what bit us with `ink-markdown`).

**Estimate:** 3–6 weeks for a single dev. Breakdown per research in [17-parity-design-questions.md](docs/17-parity-design-questions.md) Q15.

**Risks:**
- **Pre-1.0 API churn.** Mitigation: pin versions; plan one dedicated upgrade sprint before v0.1.
- **Solid reactivity model is unfamiliar.** Mitigation: opencode's code is a working reference for every pattern we need.
- **Scope creep into opencode-parity features.** Mitigation: port only what existing components do; don't build new affordances in this phase.
- **Regression on existing tests.** Mitigation: run the existing state.ts tests against the Solid port first; that's the contract.

**Dependencies:** None. Can run in parallel with Phase 1 (Phase 1 is non-TUI work).

---

## Phase 1 — Ship what's already built

**Goal:** Turn the code that's staged in `src/plugins/` and `src/providers/` into shipped, user-facing features. Unblocks customization and provider breadth in one release.

**Gaps closed:** PS1, PS2, P1, P2, P3

**Scope:**
1. **Plugin lifecycle wire-up** (PS1, PS2)
   - Audit staged files: [install.ts](src/plugins/install.ts), [enable.ts](src/plugins/enable.ts), [disable.ts](src/plugins/disable.ts), [update.ts](src/plugins/update.ts), [uninstall.ts](src/plugins/uninstall.ts), [state.ts](src/plugins/state.ts), [registry.ts](src/plugins/registry.ts).
   - Wire `/plugin install <spec>`, `/plugin enable <name>`, `/plugin disable <name>`, `/plugin update <name>`, `/plugin uninstall <name>`, `/plugin list` into the slash-command dispatcher.
   - Confirm state persistence round-trips through `~/.claude/plugins/state.json` without clobbering Claude Code's own writes.
   - Run existing test files (`*.test.ts`) and confirm they pass against the wired CLI.

2. **Provider ship** (P1, P2, P3)
   - Audit staged transports: [xai-transport.ts](src/providers/xai-transport.ts), [google-transport.ts](src/providers/google-transport.ts), [dashscope-transport.ts](src/providers/dashscope-transport.ts), [dashscope-preflight.ts](src/providers/dashscope-preflight.ts).
   - Verify each is registered in [providers/index.ts](src/providers/index.ts) and picked up by [routing.ts](src/providers/routing.ts).
   - Add smoke tests that hit each provider end-to-end with a trivial prompt (skip in CI without credentials; run locally before merge).
   - Update `/model` alias table to expose grok/gemini/qwen model names.

**Acceptance criteria:**
- `swarm-coder plugin install <local-path>` then `plugin enable <name>` surfaces the plugin's commands/hooks in the next session.
- `~/.claude/plugins/state.json` matches Claude Code's format (no drift) — diff against a pre-change snapshot.
- `swarm-coder --model grok-<x> "hello"` returns a response via xAI transport (local smoke).
- Same for `--model gemini-<x>` and a dashscope/qwen model.
- `npm test` green across `src/plugins/` and `src/providers/`.

**Estimate:** 1–2 days. Code is written; work is wiring + smoke + fixing the inevitable small integration bugs.

**Risks:**
- Staged code may have drifted from current interfaces — budget 0.5d for integration fixes.
- Provider smoke tests need real credentials; get these set up in the dev environment first.

---

## Phase 2 — Inline approvals (unblock headless-ish UX)

**Goal:** Replace `/approve`/`/deny` slash-command approvals with inline y/N prompts. Biggest daily UX friction in the current TUI.

**Gaps closed:** T5

**Scope:**
1. Add an approval-prompt Solid component modeled on opencode's [routes/session/permission.tsx](references/opencode/packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx). Three-stage flow from opencode is overkill for v0 — start with single-stage (Allow / Reject / Always-this-session-OFF per Q4 decision).
2. When the store transitions to `awaiting-permission`, render the prompt inline (not modal overlay): tool name, arguments, current mode, required mode, reason. Enter defaults to deny (match claw exactly).
3. Keep the status-bar pending-permission line (T11).
4. Keep `/approve`/`/deny` working for backwards compat and scripted headless use.
5. Store transitions already exist; wire them to the new prompt component.

**Acceptance criteria:**
- Running a command that triggers approval shows y/N inline without a slash command.
- Ctrl-C during the prompt cancels the tool call cleanly (no zombie).
- `--headless` still works: stdin-piped `y` approves, EOF denies (matches claw's simpler model per Q5).
- Store-transition tests cover prompt-accept / prompt-deny.

**Estimate:** 0.5–1 day, post-Phase-0.

**Dependencies:** Phase 0 complete.

---

## Phase 3 — Markdown + code rendering via OpenTUI primitives

**Goal:** Wire up OpenTUI's native `<code>` / `<markdown>` renderables to our transcript. Phase 0 eliminated the hand-rolled-vs-library decision — OpenTUI provides both.

**Gaps closed:** T2, T3, T4

**Scope:**
1. Replace the transcript's plain-text assistant rendering with `<code filetype="markdown" streaming={true}>` from `@opentui/core`. Evidence path: [references/opencode/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1459-1497](references/opencode/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx).
2. For fenced code blocks inside assistant messages with an explicit filetype, prefer nested `<code filetype={lang}>` for proper syntax highlighting.
3. Evaluate the experimental `<markdown>` renderable behind opencode's `OPENCODE_EXPERIMENTAL_MARKDOWN` flag — if it handles tables/links well enough, switch. Otherwise accept syntax-highlighted-code mode as the v0 bar.
4. Theme: use our existing theme tokens; pass `syntaxStyle`, `fg` props on `<code>`.
5. Tests: golden-output tests comparing rendered frames before/after for a fixed set of message inputs (headings, code, mixed).

**Acceptance criteria:**
- A response with headings, bullet lists, bold/italic, and a syntax-highlighted TS code block renders correctly.
- Streaming looks smooth (OpenTUI's `streaming={true}` handles boundary cases internally — no Q3 re-implementation needed if it works; verify during implementation).
- `--headless` still emits plain text.
- No visual regression in the OpenTUI REPL's layout at 80-col and 120-col widths.

**Estimate:** 1–2 days, post-Phase-0. Significantly lower than the pre-migration estimate because OpenTUI ships the renderers.

**Fallback:** if `streaming={true}` has boundary-detection bugs, port claw's `find_stream_safe_boundary` logic into our store layer (buffer chunks, dispatch complete blocks only). Adds ~0.5d.

---

## Phase 4 — TUI polish

**Goal:** Address remaining daily-friction TUI items. Most of T1 is free from Phase 0 (`TextareaRenderable` handles multi-line out of the box).

**Gaps closed:** T1, T6, T7

**Scope:**
1. **Multi-line input keybinding map** (T1)
   - `TextareaRenderable` from Phase 0 already supports newlines. Wire keybindings: `input_newline` → Shift+Enter + Ctrl+J; `input_submit` → Enter. Match claw's scheme.
   - Paste detection: `onPaste` receives a `PasteEvent` with `bytes`; decode and insert. Match opencode's implementation at [component/prompt/index.tsx](references/opencode/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx).
2. **Persistent history** (T6)
   - Write submitted prompts to `~/.swarm-coder/history` (newline-delimited, 10k-entry cap).
   - Load on startup; map Up/Down to history navigation via textarea keybindings.
3. **Full Emacs keybindings** (T7)
   - Map remaining textarea actions: `move-word-left/right`, `delete-word-backward`, `move-line-start/end`, etc. Reference opencode's [component/textarea-keybindings.ts](references/opencode/packages/opencode/src/cli/cmd/tui/component/textarea-keybindings.ts) for the action set.

**Acceptance criteria:**
- Shift+Enter (and Ctrl+J) insert a newline; Enter submits. Pasted multi-line text is preserved with line breaks normalized.
- Restart the CLI; Up arrow recalls prior prompts.
- Emacs motions (Ctrl-A/E/K/W, Alt-B/F) work; covered by store + keybind tests.

**Estimate:** 1–1.5 days. Shorter than the pre-migration estimate because `TextareaRenderable` does the cursor math.

**Risks:**
- Keybinding config schema interaction. Mitigation: define the action set up-front, map once, don't re-architect mid-implementation.

---

## Phase 5 — Runtime hardening

**Goal:** Make `--headless` and unattended runs trustworthy enough to use without babysitting.

**Gaps closed:** TO1, A1, A5

**Scope:**

### Phase 5a — Bash validation depth (TO1, M)

Port the 6-submodule approach from claw's `runtime/bash_validation.rs`:
1. `readOnlyValidation` — in read-only mode, reject commands that write.
2. `destructiveCommandWarning` — warn/block on `rm -rf`, `git reset --hard`, etc. without explicit flag.
3. `modeValidation` — cross-check command against current permission mode.
4. `sedValidation` — reject in-place sed without explicit flag.
5. `pathValidation` — commands that touch outside the workspace get flagged.
6. `commandSemantics` — parse common invocations to classify intent.

Each submodule is independently tested. Output is a structured validation result, not a boolean.

### Phase 5b — Worker boot state machine + typed lane events (A1, A5, M)

1. Add an explicit state enum for worker lifecycle: `spawning | trust_required | ready_for_prompt | prompt_accepted | running | blocked | finished | failed`.
2. Make transitions the single point of observation for TUI + telemetry.
3. Replace ad-hoc lane events with a typed discriminated union (`LaneEvent`) so consumers get exhaustive-check enforcement.
4. Update WorkerHost and Orchestrator to emit new events; keep JSONL stream shape backwards-compatible (add fields, don't remove).

**Acceptance criteria:**
- Running `swarm-coder --headless` with a deliberately destructive prompt is blocked at the validation layer (not just at exec time), with a structured error naming the submodule that rejected it.
- A worker that fails during trust-prompt surfaces `trust_required → failed` in the lane event stream, visible in both TUI and `--headless` JSONL.
- Downstream consumers of TaskPacket compile-error if a new LaneEvent variant is added and not handled (TS exhaustive check).

**Estimate:** 3–5 days total (1.5–2d for 5a, 1.5–3d for 5b).

**Dependencies:** 5b touches TaskPacket; coordinate with any in-flight work on Orchestrator.

---

## Phase 6 — OpenAI OAuth (external-dependency)

**Goal:** Ship ChatGPT Plus/Pro login path via Codex endpoint.

**Gaps closed:** P4

**Scope:**
- Finish M4b Phase 4 OAuth wiring.
- Codex App Server endpoint integration.
- PKCE + browser callback flow.

**Acceptance criteria:**
- `swarm-coder login --provider openai` opens browser, completes OAuth, stores token.
- Subsequent `swarm-coder --model gpt-<x>` uses the token via the Codex endpoint.
- Token refresh works across session boundaries.

**Estimate:** 2–4 days of our work + external dependency.

**Blocker:** operator Codex spike for endpoint documentation (per M4b plan). Do not start until unblocked.

---

## Deferred (not in this plan)

Explicitly out of scope for this cycle. Revisit after Phases 1–5:

- A3 recovery recipes, A4 policy engine, A6 sandbox, A7 green contract
- PS3 cron scheduler, PS4–PS6 extended slashes
- TO3 pdf_extract, TO4 repl tool, TO5 powerShell
- D1 mock parity harness (do once we have regressions that need it)

---

## Timeline sketch

Single implementer, sequential where dependencies require it, parallel where not:

| Week | Phase |
|---|---|
| 1–3 (or 1–6) | **Phase 0** — OpenTUI/Solid migration. 3–6w range. |
| 1 (parallel) | **Phase 1** — ship plugins + providers. Non-TUI; doesn't block or depend on Phase 0. |
| post-0 | Phase 2 (0.5–1d inline approvals) |
| post-0 | Phase 3 (1–2d markdown/code via OpenTUI primitives) |
| post-0 | Phase 4 (1–1.5d multi-line input + history + Emacs keys) |
| post-0+ | Phase 5a (1.5–2d bash validation depth) |
| post-0+ | Phase 5b (1.5–3d worker state machine + lane events) |
| post-0+ | Phase 6 (OAuth, blocked on operator Codex spike) |

**Total:** 4–8 weeks for a single implementer. Phase 0 dominates. Phases 2–5 on top of Phase 0 sum to ~1 week.

**Risk buffer.** OpenTUI at 0.1.99 may churn mid-migration. Budget +1 week if that happens. v0.1 ship target: ~8 weeks from Phase 0 kickoff.

---

## Sequencing note

Phase 0 is non-negotiable for the TUI-heavy phases (2–4). Phases 1, 5a, 5b, 6 are substrate-independent — they can land before, during, or after Phase 0. If two implementers are available:
- Dev A: Phase 0 (migration) → Phase 2 → Phase 3 → Phase 4
- Dev B: Phase 1 (ship staged work) → Phase 5a → Phase 5b → Phase 6

---

## Decision points in this plan

Flag these for explicit discussion before starting the phase they gate:

1. **Before Phase 1:** confirm plugin install state.json format matches Claude Code's current format (not a stale snapshot).
2. **Before Phase 3a:** decide who owns the TUI library choice — is this worth a spike, or are we accepting recommendation (c)?
3. **Before Phase 5b:** decide whether LaneEvent is a breaking change to external `--headless` consumers or strictly additive.
4. **Before Phase 6:** confirm operator Codex spike is done and the endpoint is documented.
