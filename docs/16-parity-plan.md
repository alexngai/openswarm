# Parity implementation plan

Phased execution plan for closing the prioritized gaps in [15-parity-gaps.md](docs/15-parity-gaps.md). Each phase has a goal, scope (by gap ID), acceptance criteria, and an estimate. Phases are sequenced by dependencies and risk, not strictly by priority — ship-ready work goes first so we're never blocked on a single decision.

**Ground rules:**
- Each phase ends in a shippable state (main stays green).
- Acceptance criteria are observable, not subjective. "Works on my machine" is not acceptance.
- If a phase slips, cut scope inside the phase, don't reshuffle phases.
- Reference gap IDs from `15-parity-gaps.md` so the gap doc stays the source of truth for *what*; this doc is the source of truth for *how and when*.
- **Phases 2–5 all target OpenTUI/Solid, not Ink/React.** Phase 0 (below) resolves that substrate change before the TUI-heavy phases begin. Any lingering Ink references in later phases are stale and should be read as "the OpenTUI equivalent."

---

## Phase 0 — Bun runtime + OpenTUI/Solid migration

**Goal:** Migrate swarm-harness from Node → Bun (required by `@opentui/core`'s `bun:ffi` native dependency) AND replace the Ink/React TUI substrate with OpenTUI/Solid. Decided 2026-04-22 per Q15 in [17-parity-design-questions.md](docs/17-parity-design-questions.md) after Bun viability was confirmed empirically.

**Why both at once:** OpenTUI is Bun-only (uses `bun:ffi` to load a native Zig rendering library). Empirical probe showed swarm-harness's existing TypeScript runs cleanly under Bun with zero code changes — migration is tooling + distribution, not a rewrite. Doing the runtime swap alongside the TUI swap avoids two disruptive transitions.

**Gaps closed:** None directly — enabling work. Unlocks native solutions for T1, T2, T3, T4 (see [15-parity-gaps.md](docs/15-parity-gaps.md)).

**Scope (split into sub-phases for sequencing):**

### Phase 0a — Runtime + tooling foundation (sequential, 2–3 days)
1. Add `bunfig.toml` with `preload = ["@opentui/solid/preload"]` so Bun registers the Solid JSX plugin at startup.
2. Create `src/ui/repl-solid/tsconfig.json` extending main with `"jsx": "preserve"` + `"jsxImportSource": "@opentui/solid"` for editor/type-checking.
3. Update [package.json](package.json) scripts:
   - `build`: `bun build src/cli.ts --target=bun --outfile=dist/cli.js` (bundle) + `tsc --noEmit` (type check).
   - `build:compile`: `bun build --compile --target=bun-darwin-arm64 src/cli.ts --outfile=dist/swarm-harness` (standalone binary).
   - `test`: keep `vitest run` for non-TUI tests. Add `test:ui` as `bun test src/ui/repl-solid/**/*.test.tsx`.
4. Keep [src/ui/repl-solid/store.ts](src/ui/repl-solid/store.ts) from the spike (already committed in 9bc1925).

### Phase 0b — Component ports (parallelizable across a team, ~1–2 weeks)
Port each component one-for-one. All take store state as input; write bun tests per component:
- `app-solid.tsx` — Solid root with `CliRenderer`, event iteration, shutdown wiring.
- `transcript-solid.tsx` — `<scrollbox>` of message entries, use `<code filetype="markdown" streaming={true}>` for assistant text.
- `input-solid.tsx` — `TextareaRenderable` + keybinding map (reference opencode's [textarea-keybindings.ts](references/opencode/packages/opencode/src/cli/cmd/tui/component/textarea-keybindings.ts)).
- `status-solid.tsx` — status bar, reactive to store.
- `dropdown-solid.tsx` — slash-command autocomplete.
- `spinner-solid.tsx` — use `opentui-spinner` or port from [spinner.tsx](src/ui/repl/spinner.tsx).

### Phase 0c — CLI integration (sequential, 2–3 days)
1. Rewire [src/cli.ts](src/cli.ts) to use `render(() => <AppSolid .../>)` from `@opentui/solid` when TTY.
2. Keep headless (`--headless`) path unchanged — still emits JSONL.
3. Verify Ctrl-C/shutdown, session persistence, prompt-history persistence.
4. Remove the Ink path once the Solid path is proven on real terminals.

### Phase 0d — Dependency cleanup (sequential, 1 day)
1. Remove `ink`, `@types/react` from package.json.
2. Delete [src/ui/repl/](src/ui/repl/) after Phase 0c proves the Solid root works.
3. Run full test suite under Bun + vitest + bun test to confirm no regressions.

### Phase 0e — Distribution (sequential, 1–2 days)
1. Set up `bun build --compile` for darwin-arm64, darwin-x64, linux-x64 targets.
2. GitHub Releases pipeline: attach compiled binaries per platform.
3. Update install docs: `curl | sh` style installer that downloads the right binary. Or keep npm install for the Node-compatible path if we ship a dual distribution.
4. Deprecate the npm distribution OR clearly document that npm install gives a Node/Ink build (without OpenTUI).

**Acceptance criteria:**
- `bun run build` produces a working bundle at `dist/cli.js`.
- `bun dist/cli.js --help` matches current `node dist/cli.js --help` output.
- `bun dist/cli.js doctor` passes all checks under Bun.
- Running `bun dist/cli.js` interactively drops into an OpenTUI REPL with transcript, input, status line, slash-command dropdown, compaction UI, pending-permission status — all visually equivalent to or better than the current Ink version.
- Streaming assistant responses render progressively via `<code streaming={true}>`.
- `--headless` mode still emits plain JSONL; OpenTUI is bypassed in non-TTY paths.
- `bun build --compile` produces a standalone binary for at least darwin-arm64 that runs without Bun installed on the target machine.
- Full test suite: vitest suite (1171+ tests) still green; new bun test suite for OpenTUI components green.

**Estimate:** 2–3 weeks total for a single dev (revised down from 3–6w after Bun compatibility was confirmed empirically). Breakdown:
- Phase 0a (runtime/tooling): 2–3 days
- Phase 0b (component ports): 1–2 weeks (parallelizable — good team candidate)
- Phase 0c (CLI integration): 2–3 days
- Phase 0d (Ink cleanup): 1 day
- Phase 0e (distribution): 1–2 days

**Risks:**
- **OpenTUI/Solid pre-1.0 API churn.** Mitigation: pin versions; mirror opencode's batch-upgrade script pattern.
- **Bun runtime quirks in code we haven't exercised.** Mitigation: full test suite under Bun in Phase 0a before starting component ports. Known risk areas: native modules, worker_threads, some fs edge cases.
- **Solid reactivity model is unfamiliar.** Mitigation: opencode's code is a working reference for every pattern we need.
- **Distribution disruption.** Mitigation: document the migration path clearly; offer compiled-binary install before deprecating npm path.
- **Scope creep into opencode-parity features.** Mitigation: port only what existing components do; don't build new affordances.

**Dependencies:** None. Can run in parallel with Phase 1 (Phase 1 is non-TUI, non-runtime work — Bun hasn't been proven to break anything there).

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
- `swarm-harness plugin install <local-path>` then `plugin enable <name>` surfaces the plugin's commands/hooks in the next session.
- `~/.claude/plugins/state.json` matches Claude Code's format (no drift) — diff against a pre-change snapshot.
- `swarm-harness --model grok-<x> "hello"` returns a response via xAI transport (local smoke).
- Same for `--model gemini-<x>` and a dashscope/qwen model.
- `npm test` green across `src/plugins/` and `src/providers/`.

**Estimate:** 1–2 days. Code is written; work is wiring + smoke + fixing the inevitable small integration bugs.

**Risks:**
- Staged code may have drifted from current interfaces — budget 0.5d for integration fixes.
- Provider smoke tests need real credentials; get these set up in the dev environment first.

---

## Phase 2 — Inline approvals (unblock headless-ish UX)

**Goal:** Build the approval-prompt system for the first time. Claw parity: inline y/N prompt when mode denies a tool; no slash-command fallback. Design locked in [17-parity-design-questions.md](docs/17-parity-design-questions.md) "Phase 2 — design lock (2026-04-22)".

**Gaps closed:** T5

**Revised premise.** Pre-Phase-2 audit (2026-04-22) found the existing `/approve` + `/deny` slash commands, `pendingPermission` state, and `status.tsx` pending line are **dead code**: nothing in the engine flow populates `pendingPermission`. `canUseTool` (`main.ts:446-452`) calls `PermissionEngine.check()` synchronously and returns allow/deny to the SDK — no UI interaction ever. Phase 2 builds the bridge end-to-end rather than "replacing" anything.

**Scope (SDK engine first; Native engine stays on sync mode-only gating):**
1. **Widen `canUseTool` in `main.ts`.** After `PermissionEngine.check()` returns deny, **prompt instead of failing** (claw parity — `permissions.rs:234-264`). Branch:
   - TTY → dispatch `permission-request` reducer event, await `permission-response`, return decision.
   - `--headless` → emit JSONL `permission_required` line, block on `process.stdin.read()`, parse `y\n` / `yes\n` / EOF / other.
2. **Promise bridge** between `canUseTool` and the store. One pending prompt at a time (claw is strictly serial via `conversation.rs:400` for-loop; SDK's `CanUseTool` is one call per tool use). `PendingPermission` drops `toolUseId` — not in the SDK callback and not needed.
3. **`PermissionPrompt.tsx`** — new Solid component rendered inline in the transcript in `awaiting-permission` state. Content matches claw exactly (`main.rs:7379-7388`): tool name, input JSON (truncated), current mode, required mode, reason. Prompt suffix: `Approve this tool call? [y/N]: `.
4. **Keystroke routing** — `y` / `Y` → approve; `Enter` / `n` / `N` / `Esc` → deny; Ctrl-C → deny (claw `main.rs:7406-7408` treats stdin-read-error same as deny, engine continues). Partially-typed input survives in `historyDraft`; restored after decision.
5. **Delete `/approve` + `/deny`** commands, their registry entries, and their tests. Claw has neither; inline prompt owns the interaction. Update `dispatcher.test.ts` command count.
6. **Keep the status-bar pending-permission line** (T11) — still shows which tool is pending while the user decides.
7. **SDK-mode integration.** `danger-full-access` → SDK `bypassPermissions` → SDK skips `canUseTool` entirely (no prompt ever fires). `read-only` / `workspace-write` → SDK `default` → every tool use hits `canUseTool`. Our mode mapping (`claude-agent-sdk.ts:57-65`) is already correct; no change needed.

**Acceptance criteria:**
- Running a command that requires elevation shows y/N inline; no slash command typed; no modal overlay.
- Ctrl-C during the prompt denies the tool; engine continues to the next tool in the turn (matches claw). Second Ctrl-C after the prompt resolves cancels the turn (existing behaviour).
- `--headless` emits `{"type":"permission_required", "tool":..., "input":..., "currentMode":..., "requiredMode":..., "reason":...}` before blocking on stdin; consumer supplies `y\n` / `yes\n` to approve, `EOF` / anything else to deny.
- `danger-full-access` runs never prompt (SDK skips `canUseTool`).
- Dead-code removal: no references to `/approve` or `/deny` remain in `src/cli/slash/` or any registry test.
- Tests: bridge unit test (canUseTool → reducer → Promise resolution), integration test against SDK engine in `default` mode.

**Estimate:** 2–3 days. (Doc estimate pre-audit was 0.5–1d; it assumed the bridge existed.)

**Dependencies:** Phase 0 complete.

**Known-risk deferral.** SDK option `settingSources: ["project"]` (`claude-agent-sdk.ts:267`) loads `~/.claude/settings.json`. If that file has permission rules (e.g., "always allow Read"), the SDK *may* auto-allow SDK-side before `canUseTool` fires — silently bypassing our prompt. Risk is low for fresh installs; 90% use case is safe. Logged as **Q18** in the discussion backlog; revisit in a v0.2 security pass.

---

## Phase 3 — Markdown + code rendering via OpenTUI primitives

**Goal:** Wire up OpenTUI's native `<code>` / `<markdown>` renderables to our transcript. Phase 0 eliminated the hand-rolled-vs-library decision — OpenTUI provides both.

**Gaps closed:** T2, T3, T4

> **Implementation note (2026-04-30):** the scope below predates implementation; the post-investigation calls live in the [Phase 3 design lock](17-parity-design-questions.md#phase-3--design-lock-2026-04-30). Most notably P3.Q1 chose `<markdown>` (structured renderer) over `<code filetype="markdown">` (highlighted source) — when scope item #1 below conflicts with the design lock, the design lock wins.

**Scope:**
1. Replace the transcript's plain-text assistant rendering with `<code filetype="markdown" streaming={true}>` from `@opentui/core`. Evidence path: [references/opencode/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:1459-1497](references/opencode/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx). _(Superseded — see design lock P3.Q1; we ship `<markdown>` instead.)_
2. For fenced code blocks inside assistant messages with an explicit filetype, prefer nested `<code filetype={lang}>` for proper syntax highlighting. _(Superseded — see design lock P3.Q2; the `<markdown>` renderer creates a per-block CodeRenderable internally, and Tree-sitter highlighting comes via a shared `treeSitterClient` prop.)_
3. Evaluate the experimental `<markdown>` renderable behind opencode's `OPENCODE_EXPERIMENTAL_MARKDOWN` flag — if it handles tables/links well enough, switch. Otherwise accept syntax-highlighted-code mode as the v0 bar. _(Resolved — `<markdown>` ships as a first-class renderable in `@opentui/core@0.1.99`, no flag.)_
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
   - Write submitted prompts to `~/.swarm-harness/history` (newline-delimited, 10k-entry cap).
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
- Running `swarm-harness --headless` with a deliberately destructive prompt is blocked at the validation layer (not just at exec time), with a structured error naming the submodule that rejected it.
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
- `swarm-harness login --provider openai` opens browser, completes OAuth, stores token.
- Subsequent `swarm-harness --model gpt-<x>` uses the token via the Codex endpoint.
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
