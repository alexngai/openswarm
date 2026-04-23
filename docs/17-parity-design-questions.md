# Parity plan — open design questions

Companion to [16-parity-plan.md](docs/16-parity-plan.md). These are the decisions that will shape *how* phases get built, not *whether*. Each has a **Lean** — a provisional call so work isn't blocked, but nothing is locked until we discuss. Resolved items move to the decision log in [15-parity-gaps.md](docs/15-parity-gaps.md).

Format: Question · Why it matters · Options · Lean · What'd clarify · **Claw-code reference** · **Updated lean after comparison.**

---

## Q1. Plugin state.json: share with Claude Code, or own namespace? (Phase 1)

**Why it matters.** The plan currently says we write to `~/.claude/plugins/state.json` — the same file Claude Code writes. If we mutate it, we risk format drift, races with concurrent Claude Code processes, and breaking Claude Code's own plugin state. If we own our own file, users get a worse story ("why doesn't swarm-coder see the plugins I installed through Claude Code?").

**Options:**
- **(a) Write to `~/.claude/plugins/state.json`** — shared. Mirrors Claude Code exactly. Fragile to format changes we don't control; ownership ambiguity.
- **(b) Read-only from `~/.claude/plugins/state.json`, write to `~/.swarm-coder/plugins/state.json`** — discover theirs, manage ours. Users who install via Claude Code get discovery for free; installs via swarm-coder live in our namespace.
- **(c) Own namespace only (`~/.swarm-coder/plugins/`)** — clean separation, but users with an existing Claude Code plugin library re-install everything.

**Lean: (b).** Aligns with the existing philosophy ("We never mutate Claude Code's installation" — `06-open-questions.md` Q5). Discovery of their plugins is already how we do skills/hooks.

**What'd clarify this.** What does Claude Code's state.json actually contain, and is there a documented schema? If it's internal and undocumented, (b) is the only defensible call.

**Claw-code reference.** Claw writes `{config_home}/settings.json` (not `state.json` — our assumption was off) with shape `{ "plugin_id": true|false, ... }` at `plugins/src/lib.rs:2251`. Registry manifest is a separate file at `{config_home}/plugins/installed.json` (`lib.rs:1057-1060`). Claw owns both files — not inherited from elsewhere. `SETTINGS_FILE_NAME = "settings.json"` at line 21.

**Updated lean after comparison: still (b), but with claw's file split.** We should mirror claw's two-file schema (`settings.json` for enable/disable boolean map + `installed.json` for manifest registry) under `~/.swarm-coder/plugins/`. Reading claw's files at `~/.claude/plugins/` gives us free discovery of plugins installed via claw/Claude Code. **Action:** revise Phase 1 scope to write two files, not one; match claw's exact schema for forward compatibility.

---

## Q2. TUI rendering strategy: library, hand-roll, or hybrid? (Phase 3a)

**Why it matters.** This is the single biggest unknown in the plan. Pick wrong and Phase 3 doubles in length.

**Options:**
- **(a) Hand-roll ANSI renderer.** Full control. No dependency risk. Reinvents syntax highlighting and markdown parsing. Effort: M+.
- **(b) Ink-compatible markdown component.** Another `ink-markdown`-shaped dependency. Low effort if one exists that's ESM-clean; existential risk if it breaks the same way. Effort: XS or weeks.
- **(c) Pre-render to ANSI string, feed Ink `<Text>`.** Use `marked` (ESM-clean) for parsing + `cli-highlight` (or `shiki` if we want quality) for code. Bypass Ink's component model — Ink just prints our string. Effort: S.
- **(d) Drop Ink entirely, go rustyline-style with `readline` + manual rendering.** Closer to claw. Massive rewrite of everything else in the TUI. Effort: XL.

**Lean: (c).** Matches what bit us last time (`ink-markdown` was a React component with async ESM traps). Strings don't have that problem. We keep Ink for layout, which is its actual strength.

**What'd clarify this.** A 2-hour spike: render a 50-line markdown doc with code, table, and headings via (c). If it looks acceptable and renders fast enough for streaming, done.

**Claw-code reference.** Pipeline is exactly (c)'s shape: `pulldown_cmark::Parser::new_ext()` parses markdown → event walk → `syntect::HighlightLines` with `as_24_bit_terminal_escaped` colorizes code → `crossterm::queue!` / `execute!` emits ANSI to the terminal. Evidence: `rusty-claude-cli/src/render.rs:4-12, 251` for imports; line 259 for the parser. No React, no component tree — they build a colorized string and print it.

**Updated lean after comparison: (c) confirmed.** Direct TS analogues: `marked` ≈ `pulldown_cmark` (both are streaming event parsers), `cli-highlight` or `shiki` ≈ `syntect`, Ink `<Text>` ≈ `crossterm::execute!`. This is the exact pipeline claw uses and it works. **Action:** no change to lean. When we do the Phase 3a spike, use this architecture.

---

## Q3. Streaming markdown: re-parse per chunk, line-buffered, or post-hoc replace? (Phase 3b)

**Why it matters.** Streaming responses arrive token-by-token. Re-parsing the full buffer on every chunk is wasteful but simple; line-buffered is more efficient but complicated by partial code fences; post-hoc replace renders plain text first, then replaces the block when the message ends (jarring).

**Options:**
- **(a) Re-parse full buffer per chunk.** Simple. O(n²) work total per message but n is small (thousands of tokens).
- **(b) Line-buffered.** Accumulate until newline, render completed lines. Tricky inside fenced code blocks.
- **(c) Render plain text while streaming, replace with rendered markdown on message-complete.** User sees flicker at end of each message.
- **(d) Render plain text only during streaming; only the final assistant message gets markdown.** Simplest; mild feature regression during stream.

**Lean: (a).** claw does something close to this with `MarkdownStreamState.push()`. Re-parse cost is negligible at human-readable message sizes. Measure before optimizing.

**What'd clarify this.** Profile (a) on a 10k-token response. If it's under 5ms per chunk, ship it.

**Claw-code reference.** Claw uses a smarter approach than any of (a)–(d): **boundary-detected incremental render**. `MarkdownStreamState` holds a `pending: String` buffer. Each `push()`: append delta → call `find_stream_safe_boundary()` to locate a safe split point (avoiding mid-code-fence, incomplete blocks) → re-parse only the *ready* portion → drain ready bytes → keep incomplete blocks buffered. `flush()` renders remaining pending on stream close. Evidence: `rusty-claude-cli/src/render.rs:600-625`.

**Updated lean after comparison: new option (e) = claw's approach.** Neither re-parse-all nor line-buffered — buffer the stream, detect safe boundaries, render complete blocks, hold incomplete ones. Avoids re-parse cost AND correctly handles unclosed fences. **Action:** port `find_stream_safe_boundary` logic to TS. This is load-bearing — the implementation in render.rs is the reference. Revised Phase 3b effort: +0.5d vs original estimate for boundary-detection logic, but better UX outcome.

---

## Q4. Approval prompt: what to show, and what's the default answer? (Phase 2)

**Why it matters.** Too little info → users approve blind. Too much → users skip reading. Default matters for auto-pilot scenarios (accidental Enter on a destructive command).

**Options for content:**
- **(a) Tool name + one-line argument summary.** Minimal.
- **(b) Tool name + full arguments (pretty-printed) + current permission mode + required permission mode + reason.** What claw does.
- **(c) (b) + diff preview for Edit/Write.** Costs implementation work but dramatically raises trust.

**Options for default:**
- **Enter = deny** (conservative) vs **Enter = approve** (fast-pilot).

**Options for memory:**
- **No memory** — ask every time.
- **Session memory** — "always approve Bash for this session" checkbox.
- **Persistent memory** — writes to config. Dangerous.

**Lean: (b) content, Enter = deny, session memory available via a keybind (`a` = always-this-session), no persistent memory.** Matches the conservative stance baked into the permission model.

**What'd clarify this.** Decide whether we want a "session trust" concept at all. If not, skip the memory question entirely.

**Claw-code reference.** `CliPermissionPrompter::decide()` at `rusty-claude-cli/src/main.rs:7375-7411`. Prints: tool name, current mode, required mode, reason (if provided), input/args (lines 7379-7387). Prompt string at 7388: `"Approve this tool call? [y/N]: "` — capital N = default deny. Parsing at 7394-7404: only `"y"` or `"yes"` approves; anything else (including empty Enter) denies. **No session memory. No diff preview. No "always allow" shortcut.**

**Updated lean after comparison: (b) content + Enter=deny confirmed. Drop session memory.** Claw explicitly doesn't have it. Adding it would be a divergence from claw we'd need to justify — and the user can always set permission mode to `danger-full-access` for a fast-pilot session. **Action:** match claw exactly for Phase 2; no session-memory feature. (c) diff preview stays a future enhancement, not v0.

---

## Q5. Headless mode approval behavior (Phase 2)

**Why it matters.** `--headless` can't show an interactive prompt. Today users get `/approve`/`/deny` (not interactive either — requires scripted input). Phase 2 replaces this in TTY mode. What does `--headless` do?

**Options:**
- **(a) Deny-by-default.** Anything requiring approval fails the task. Safe, but many tasks become un-runnable.
- **(b) Hook-driven.** If a PreToolUse hook is registered and approves, proceed. No hook → deny.
- **(c) CLI flag for auto-approve scope** (`--auto-approve=read,bash-safe`). Explicit scoping.
- **(d) Permission mode determines it.** In `danger-full-access` mode, auto-approve; in other modes, deny.

**Lean: (b) + (d) combined.** Hooks are the escape valve for scripted workflows; mode dictates default when no hook. Matches the "hook-first" extensibility posture we already have.

**Claw-code reference.** Claw doesn't have a separate "headless approval" mode. Non-TTY stdin is detected via `is_terminal()` (`input.rs:141-142`); piped prompts dispatch as one-shot via `main.rs:814-819`. The approval prompter still reads from stdin at `main.rs:7392` — so piped input like `echo y | claw "do the risky thing"` works, and EOF returns `Err` → `Deny` at lines 7406-7408. No hook-driven approval; no mode-based auto-approve.

**Updated lean after comparison: simplify to claw's model.** Instead of (b)+(d), go with: **stdin-read always; EOF or malformed input → deny.** Hooks still work because PreToolUse hooks short-circuit the prompter entirely (hook approves or denies before we'd even ask). Mode-based auto-approve is implicit: `danger-full-access` means tools don't need approval, so the prompter isn't called. **Action:** revised Phase 2 scope — don't build a headless-specific approval path. Stdin read + PreToolUse hooks cover scripted cases.

---

## Q6. Multi-line input: stay in Ink or drop to raw? (Phase 4)

**Why it matters.** Ink's input model is single-line-first. Multi-line with correct cursor handling across wrapped rows is genuinely finicky — claw dodges this by using rustyline, which is a real line editor. If we stay in Ink, we're writing our own line editor in React.

**Options:**
- **(a) Build a multi-line buffer in Ink** — React state + manual cursor math. Couples to Ink's measurement helpers.
- **(b) Drop Ink for the input area; keep it for transcript/status.** Use Node's `readline` or a JS line-editor library for input. Two rendering systems coexist.
- **(c) Accept single-line + paste-preserves-newlines.** Not real multi-line editing, but pasted multi-line prompts work.

**Lean: (a), but budget 1.5x effort.** Splitting rendering across two systems (b) is a worse end state than paying the one-time cost of a correct Ink editor. (c) is a cop-out that'll come back.

**What'd clarify this.** Look for prior art — has anyone built a correct multi-line Ink input we can borrow? If yes, lean (a). If no, (b) starts looking reasonable.

**Claw-code reference.** Claw uses rustyline's native multi-line: `Ctrl+J` and `Shift+Enter` bound to `Cmd::Newline`, plain `Enter` submits. Config: `CompletionType::List` + `EditMode::Emacs`. No paste detection. Evidence: `rusty-claude-cli/src/input.rs:101-123`, specifically `editor.bind_sequence()` at lines 116-117.

**Updated lean after comparison: lean stays (a), but target behavior is now concrete.** Claw's keybinding scheme (Ctrl+J / Shift+Enter = newline, Enter = submit, Emacs mode) is the bar. We need to implement this *inside* Ink. If the Phase 4 spike proves this is impractical, fall back to (b) — JS equivalent of rustyline (`@inquirer/editor`, `node-readline`, or similar) for just the input area, Ink for everything else. **Action:** Phase 4 acceptance criteria should name the exact keybindings from claw so we have a concrete target.

---

## Q7. LaneEvent: additive or breaking change? (Phase 5b)

**Why it matters.** Anyone consuming `--headless` JSONL today has expectations about the event shape. A breaking change means a version bump and downstream updates; additive-only means we carry dead fields forever.

**Options:**
- **(a) Strictly additive.** New events get new `type` values; existing events never change shape. Downstream consumers ignore unknown types.
- **(b) Breaking with major-version bump.** Clean shape; force consumers to update.
- **(c) Two output schemas** — legacy shape by default, new shape behind `--events=v2` flag. Migrate gradually.

**Lean: (a).** Pre-v0.1; nobody is pinned to the schema yet. Additive is cheap now and we can do a cleanup pass at v0.1. More importantly, exhaustive-check enforcement inside TS (phase 5b goal) doesn't require JSONL consumers to handle every variant — it's an internal invariant.

**What'd clarify this.** Confirm nobody external is consuming the JSONL yet. If they are, elevate this question.

**Claw-code reference.** No `schema_version` field in `LaneEvent`. Event variant enum (`LaneEventName`) uses `#[serde(rename_all = "snake_case")]` for a stable wire format. Optional fields use `skip_serializing_if = "Option::is_none"` so absent fields don't appear in JSON. New variants are added by appending to the enum. Evidence: `runtime/lane_events.rs:459-473` for the struct; lines 179-189 for skip_serializing_if usage. **Additive by convention, not by explicit policy comment.**

**Updated lean after comparison: (a) confirmed.** Claw treats this the same way — no version field, rely on additive conventions, consumers ignore unknown variants. **Action:** no change. When we do Phase 5b, use TS discriminated unions with exhaustive checks internally, emit the same flat JSON shape externally, add variants freely, never reshape existing ones.

---

## Q8. Bash validation: block-by-default or warn-by-default? (Phase 5a)

**Why it matters.** Destructive command detection catches `rm -rf`, `git reset --hard`, etc. False positives annoy users; false negatives lose data.

**Options:**
- **(a) Block by default; require `--confirm-destructive` or approval.** Safe. Slower.
- **(b) Warn by default; proceed unless permission mode is restrictive.** Matches current behavior.
- **(c) Mode-driven.** `read-only` mode → block all writes. `workspace-write` → warn on destructive, block on out-of-workspace. `danger-full-access` → warn only.

**Lean: (c).** Mode is the user's explicit opt-in to risk. Default mode (likely workspace-write) has sensible protections without friction.

**What'd clarify this.** What's the default permission mode on startup? If it's already `danger-full-access`, (c) collapses to warn-only and we've gained nothing. If it's `workspace-write`, (c) is meaningful.

**Claw-code reference.** Claw's policy is explicitly **warn, not block**, on destructive patterns. `check_destructive()` at `runtime/bash_validation.rs:241` returns `ValidationResult::Warn` for `DESTRUCTIVE_PATTERNS` (`rm -rf /`, `rm -rf ~`, `mkfs`, `dd if=`, fork bombs — lines 206-232) and `ALWAYS_DESTRUCTIVE_COMMANDS` (line 235). General `rm -rf *` / `rm -rf .` also warn (line 267). `validate_read_only()` at line 103 **does block** in read-only mode. Workspace-write mode warns on system-path targets (`/etc/`, `/usr/`, etc.) at lines 288-297 but allows workspace writes.

**Updated lean after comparison: (c) confirmed, with exact policy mapped.** Claw's policy decomposes to: **read-only mode → BLOCK writes; workspace-write mode → WARN on destructive patterns + WARN on system paths outside workspace; any mode → WARN on `rm -rf /` family, `mkfs`, `dd if=`, fork bombs.** Not "warn is weaker than block" — warn still surfaces in the UI and (in our system) would trigger an approval prompt for the user to override. **Action:** Phase 5a scope becomes "port claw's bash_validation.rs pattern list + policy decision tree verbatim, then translate to TS."

---

## Q9. Model alias naming: short or long? (Phase 1)

**Why it matters.** `--model grok-beta` vs `--model xai/grok-beta` vs `--model grok` (alias to latest). Naming sticks; renaming later breaks muscle memory.

**Options:**
- **(a) Vendor-prefixed** — `anthropic/claude-*`, `openai/gpt-*`, `xai/grok-*`, `google/gemini-*`, `dashscope/qwen-*`. Matches Vercel AI SDK. Verbose.
- **(b) Vendor-implicit from model name** — `claude-*`, `gpt-*`, `grok-*`, `gemini-*`, `qwen-*`. Shorter. Risks collision if two vendors share a prefix in the future.
- **(c) Short aliases + long canonical** — `grok` → latest xai/grok-*, but `xai/grok-beta` still works.

**Lean: (c).** Aliases for daily use, canonical names for pinning. Matches how `/model` already works per the gap matrix.

**What'd clarify this.** Is there an existing alias table in [src/providers/aliases.ts](src/providers/aliases.ts) we should audit before deciding?

**Claw-code reference.** `resolve_model_alias()` at `api/src/providers/mod.rs:137-163`. Short aliases: `opus → claude-opus-4-6`, `sonnet → claude-sonnet-4-6`, `haiku → claude-haiku-4-5-20251213`. xAI: `grok / grok-3`, `grok-mini / grok-3-mini`, `grok-2`. Kimi: `kimi → kimi-k2.5`. **No vendor prefix on the short aliases.** Full canonical names are unprefixed for Anthropic/xAI (e.g. `claude-opus-4-6`, `grok-3`) and prefixed for the rest (`openai/`, `qwen/`, `kimi/`). Default model hardcoded at `rusty-claude-cli/src/main.rs:59` as `"claude-opus-4-6"`.

**Updated lean after comparison: (c) confirmed, specifics tightened.** Port claw's exact alias table as the starting point. Don't invent new aliases. Prefix-needing providers (OpenAI, Google, DashScope) get prefixed canonical; Anthropic/xAI get unprefixed canonical. Short aliases are unprefixed across the board. **Action:** audit [src/providers/aliases.ts](src/providers/aliases.ts) and reconcile against claw's table in Phase 1. Add `grok`, `grok-mini`, `grok-2`, `gemini-*`, `qwen-*` short aliases to match claw's breadth.

---

## Q10. How much parity is enough? (cross-cutting)

**Why it matters.** Without a stopping criterion, this plan grows forever. Phase 1–5 close ~70% of the gaps in [15-parity-gaps.md](docs/15-parity-gaps.md). Do we stop there, or push to 90%+?

**Options:**
- **(a) Ship v0.1 after Phase 5.** Call it "parity for swarm-coder's core use cases." Document remaining gaps as v0.2 candidates.
- **(b) Push through all P0–P1 gaps before v0.1.** Longer runway, cleaner story.
- **(c) Feature-based stopping.** Ship when "daily driver" works — define "daily driver" first.

**Lean: (a).** Phase 5 end-state is a usable product. Shipping is how we find out what's actually missing vs. what we guessed at.

**What'd clarify this.** A dogfood sprint between Phase 4 and Phase 5 where we actually use swarm-coder for real work for a week and list what broke. That list becomes the revised v0.1 blocker set — and may change the plan.

**Claw-code reference.** Not a claw-comparable question — this is swarm-coder's v0.1 scoping. Claw's analogous document is `PARITY.md` (honest list of what's merged on main vs. branch-only), which suggests their model is "ship honest partial parity, document the delta." That's essentially option (a).

**Updated lean after comparison: (a) confirmed.** Claw's own `PARITY.md` ships with unfinished items explicitly documented. We can do the same: v0.1 ships after Phase 5 with a clear parity-gaps appendix. **Action:** no change to plan; add a v0.1 launch-readiness checklist in a future doc.

---

## Summary of changes driven by claw-code comparison

| Q | Change |
|---|---|
| Q1 | Revise Phase 1 to write two files (`settings.json` + `installed.json`) under `~/.swarm-coder/plugins/`, matching claw's schema. |
| Q2 | No change — claw validates our pipeline choice. |
| Q3 | **New approach (e): boundary-detected incremental render.** Port `find_stream_safe_boundary` logic. +0.5d to Phase 3b. |
| Q4 | Drop the "session memory" feature from Phase 2 scope. Match claw exactly. |
| Q5 | Simplify: remove hook-specific / mode-specific headless approval paths. Stdin-read always; EOF = deny. |
| Q6 | No change to lean. Add claw's keybindings (Ctrl+J / Shift+Enter = newline) as concrete Phase 4 acceptance criteria. |
| Q7 | No change — additive-only confirmed. |
| Q8 | Port claw's `bash_validation.rs` policy tree verbatim. Phase 5a scope tightens. |
| Q9 | Port claw's alias table as starting point. Reconcile with [aliases.ts](src/providers/aliases.ts) in Phase 1. |
| Q10 | No change — ship-with-parity-delta model confirmed. |

---

## Appendix: TUI structural comparison

The question "should our TUI look more like claw's?" is tempting but misleading — the two TUIs are built on fundamentally different models. Understanding this keeps us from porting patterns that would regress the design.

### Claw's TUI structure (Rust)

**Layout:**
- `main.rs` — 13,105 lines. Event loop, CLI orchestration, runtime lifecycle, permission prompter all colocated.
- `render.rs` — 1,071 lines. `TerminalRenderer`, `Spinner`, `MarkdownStreamState`.
- `input.rs` — 331 lines. `LineEditor` wrapping rustyline.
- `init.rs` — project scaffolding, not runtime.

**Event loop shape** (`main.rs:3579–3624`):
```rust
loop {
    match editor.read_line()? {      // blocks on keystroke
        Submit(input) => {
            /* parse slash | skill | LLM */
            cli.run_turn(&input)?;    // synchronous, streams inside
        }
        Cancel => {}
        Exit => break,
    }
}
```

**State ownership:**
- `LiveCli` struct — session handle, model, permission mode, prompt history.
- `BuiltRuntime` — conversation, plugins, MCP (held for session lifetime).
- Per-turn ephemeral: `MarkdownStreamState`, `Spinner`, `CliPermissionPrompter` — fresh each turn, dropped after.
- No central event bus. State mutations happen via direct field access in call stacks.

**Control flow:** Procedural / sequential. Keystroke → parse → run_turn → stream events in a loop → render chunk → finish → save → back to read_line.

**Notable patterns worth porting:**
1. `find_stream_safe_boundary` — render only complete markdown blocks; buffer incomplete ones (render.rs:816–845).
2. Explicit per-turn `persist_session()` — never rely on background save threads.
3. Spinner ticks inline during stream consumption — no background heartbeat thread, no races.

**Patterns to NOT port:**
1. Monolithic main.rs. Bad fit for testability even in Rust; worse in TS.
2. Tight coupling between permission UI and stdin. No dependency injection.
3. Per-turn-fresh streaming state. Can't pause/resume or show multi-pane.
4. No event emitter. Adding a second consumer (telemetry, second UI, log mirror) requires surgery.

### Swarm-coder's TUI structure (TypeScript / Ink)

**Layout** ([src/ui/repl/](src/ui/repl/)):
- `app.tsx` — root component, wires reducer to renderers.
- `input.tsx`, `transcript.tsx`, `status.tsx`, `dropdown.tsx`, `spinner.tsx` — focused components.
- `state.ts` + `state.test.ts` — reducer + transitions; single source of truth.
- `index.ts` — entrypoint.

**Event loop shape:** Ink's React reconciler. State changes in the reducer trigger re-renders. Input is a callback, not a blocking read. Streaming events dispatch reducer actions that add/update transcript entries.

**State ownership:** Centralized reducer in `state.ts`. Single discriminated union of app states (`streaming`, `awaiting-permission`, `compact`, etc.). All components derive view from the same store.

**Control flow:** Declarative / reactive. Event arrives → dispatch action → reducer produces new state → Ink diffs + re-renders affected components.

### Implications for the plan

| Dimension | Claw | Swarm-coder | Our choice |
|---|---|---|---|
| State model | Distributed, per-struct | Centralized reducer | **Keep swarm's.** Easier testing, multi-pane, future features. |
| Main loop | Blocking read, synchronous | Event-driven reconciler | **Keep Ink's.** Can't go back without full rewrite. |
| Streaming state | Per-turn ephemeral | Lives in reducer | **Keep reducer-based.** Already works; supports interrupt/resume. |
| Markdown boundary detection | Bespoke algorithm in render.rs | Missing | **Port the algorithm, keep our state shape.** See Q3. |
| Permission UX | Stdin + y/N prompt (hardcoded) | Slash-command + future inline prompt | **Match claw's UX (y/N inline)** but dispatch-driven through the reducer (not stdin). See Q4. |
| Plugin hook integration | Build-time via `RuntimePluginState` | Runtime discovery via `PluginSource` | **Keep swarm's runtime discovery.** More flexible. |
| File organization | One 13k-line main.rs | Several focused files | **Keep swarm's split.** Already better. |

**Headline:** we're ahead of claw on structural fit for a long-lived, reactive, multi-pane-capable TUI. We're behind on specific surface features (multi-line input, markdown rendering, inline approvals, code highlighting). Phase 2–4 of the plan closes surface-feature gaps without migrating to claw's structural model. Do not let "claw has it" become "we should structure like claw has it."

**One thing we may want to borrow structurally:** an event-emitter layer between the runtime and the TUI. Right now both claw and swarm-coder wire these directly. If we add telemetry, a second UI, or log mirroring, a pub/sub layer pays off. Defer to v0.2+ unless a near-term need surfaces.

---

## Discussion backlog

Add more here as they surface:

- Q11. Do we want to support `--config <path>` for ephemeral overrides? (Low priority.)
- Q12. Plugin signing / supply chain — where on the roadmap? (Claw doesn't have it either; probably v0.2+.)
- Q13. Telemetry: opt-in metrics for us, or strictly local? (Privacy-sensitive; own question.)
- Q14. Event-emitter layer between runtime and TUI — pay now or defer to v0.2? (Raised by structural comparison.)
- Q15. Migrate from Ink to OpenTUI? See below.
- Q17. Broader README refresh — pre-Phase-0 language remains in [README.md](README.md). Phase 1 stage 6 added a "Models & aliases" section and struck the "Multi-provider (M4)" not-in-M0 line, but broader edits are deferred (Status says "M0 current", lists REPL + plugins as unshipped, mentions `ink` — all stale). Effort: S.
- Q16. Drop `execMode: "in-process"` from plugin manifests? (Raised 2026-04-22 during Phase 1 planning.) **Current state:** fully implemented in [claude-code-source.ts](src/plugins/claude-code-source.ts) with a path-traversal guard (`enforceEntryModuleBoundary`) and degraded-plugin fallback; covered by tests. **Parity:** claw has shell-only. **Security:** in-process plugins run with full host privilege — no sandbox. **Tradeoffs:** removing simplifies mental model + matches claw; keeping preserves a working, tested capability. **Lean:** defer to a v0.2 security review; no action in Phase 1. **Evidence of misread during Phase 1 planning:** initial Phase-1 ambiguity list claimed "in-process isn't wired" — incorrect read of `registry.ts:203` which abstracts over execMode via `LoadedPlugin.executeTool()`. Source loaders (`_loadShell` / `_loadInProcess`) own mode dispatch.

---

## Q15. Ink → OpenTUI migration? (cross-cutting, not in phases yet)

**Why it matters.** Ink has bitten us once already (`ink-markdown` ESM). Phase 3 (markdown rendering) and Phase 4 (multi-line input, custom editor in React) are the two highest-risk Ink-specific efforts. If Ink is the wrong long-term substrate, investing more in it delays the inevitable rewrite.

**Assumption:** "OpenTUI" means SST's JS/TS TUI framework with a React reconciler and better rendering performance than Ink. If a different library is meant, revise this question.

**Options:**
- **(a) Migrate before Phase 3.** Avoid baking Ink patterns into markdown + input. Risk: OpenTUI is newer, less mature, and may have its own surprises. Migration takes time we haven't estimated.
- **(b) Phase 3a spike on Ink first; decide based on pain.** If the markdown pipeline (marked + cli-highlight → ANSI string → Ink `<Text>`) works cleanly, stay. If Ink fights us again, pivot.
- **(c) Ship v0.1 on Ink; migrate post-v0.1.** Let real dogfooding drive the decision.
- **(d) Stay on Ink indefinitely.** Invest in workarounds (we already have a non-trivial reducer; Ink is mostly a layout engine at that point).

**Lean: (b).** The spike is cheap (~2 hours) and directly answers "is Ink the right substrate for what we need next?" If the answer is yes, we save a migration. If no, we migrate with evidence instead of speculation.

**What'd tilt us toward (a) migrate now:**
- Phase 3a spike hits the same class of ESM/async bugs as `ink-markdown`.
- Large-transcript streaming shows visible lag in our existing Ink setup.
- OpenTUI has native markdown/code-block rendering, making Phase 3 near-zero effort.
- Known Ink limitations around multi-line cursor math prove fatal in a Phase 4 prototype.

**What'd tilt us toward (c)/(d) stay:**
- Phase 3a spike works smoothly.
- OpenTUI turns out to be pre-1.0 with unstable API.
- Migration cost exceeds reasonable v0.1 runway.
- Our reducer-based state model translates equally well to either framework (migration later isn't cheaper than now).

**What'd clarify this.** A short OpenTUI evaluation: does it have (1) a stable React reconciler, (2) native or easy markdown/code-block rendering, (3) reliable multi-line input support, (4) ESM cleanliness? That evaluation + the Phase 3a spike together resolve the question.

**Claw-code reference.** N/A — claw doesn't use a React-style framework. This is a swarm-coder-specific question driven by our Ink dependency.

**Opencode reference (evidence, April 2026).** [references/opencode/](references/opencode/) uses OpenTUI in production. Key findings:

- Packages: `@opentui/core@0.1.99` + `@opentui/solid@0.1.99` ([opencode package.json:37-38](references/opencode/package.json)). **Pre-1.0**; opencode ships an [upgrade-opentui.ts](references/opencode/packages/opencode/script/upgrade-opentui.ts) batch-updater suggesting frequent version bumps.
- **Binding: Solid.js, not React.** Migration is not just Ink→OpenTUI but React→Solid. `useState` → `createSignal`; our reducer in [state.ts](src/ui/repl/state.ts) → Solid `createStore`.
- No patches ([references/opencode/patches/](references/opencode/patches/) has 0 opentui entries). No FIXME/HACK/TODO comments about OpenTUI in the TUI source.
- Production status: OpenTUI is opencode's **only** TUI — not flag-gated.
- Active dev: ~15 commits in 2 weeks (March–April 2026).
- Native components that solve our gaps:
  - `<code streaming={true}>` for streaming markdown/code (Q3 solved) — [session/index.tsx:1459,1491](references/opencode/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx)
  - `TextareaRenderable` with `onPaste`/keybindings for multi-line (Q6 solved) — [component/prompt/index.tsx](references/opencode/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx)
  - Inline stateful permission prompts (Q4/Q5 solved) — [routes/session/permission.tsx:133-300](references/opencode/packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx)
- Known limitations to plan around:
  - No native markdown layout — `<code filetype="markdown">` is syntax-highlighted code, not true markdown tables/links. Experimental `<markdown>` behind `OPENCODE_EXPERIMENTAL_MARKDOWN` flag.
  - Manual scroll tracking (`ScrollBoxRenderable` doesn't auto-scroll).
  - Every textarea keybinding must be mapped manually ([component/textarea-keybindings.ts](references/opencode/packages/opencode/src/cli/cmd/tui/component/textarea-keybindings.ts)).
- Migration effort estimate for swarm-coder: **3–6 weeks** for a single dev (Ink rewrite ~1–2w, state model Solid store ~1w, input ~3–5d, markdown/code ~3–5d, dialogs ~1w, context system ~3–5d, testing ~1w).

**Updated lean after comparison: (a) migrate now, sequenced as Phase 0.** Evidence shifts this from "maybe" to "defensible yes" — opencode proves the stack works in production, and every one of our biggest TUI gaps has a native OpenTUI answer. The Solid.js shift is real but unavoidable if we want those primitives. Sequencing: Phase 0 (OpenTUI migration, ~3–6w) runs in parallel with Phase 1 (non-TUI plugin + provider ship). Phase 2–5 happen on OpenTUI from the start, avoiding the rework cost. **Risk owned:** pre-1.0 API may churn. Mitigation: pin versions, mirror opencode's upgrade-opentui.ts script pattern for batch bumps.

**DECISION — 2026-04-22 (initial):** Migrate to OpenTUI as Phase 0.

**BLOCKER — 2026-04-22 (same day, post-spike):** `@opentui/core` depends on `bun:ffi` and loads a native Zig rendering library. Node cannot resolve `bun:` imports. This was missed in the initial evaluation. Every grep under `node_modules/@opentui/core/` for `from "bun:` returned multiple hits in both `.d.ts` and runtime `.js` files. README examples exclusively use `bun install` / `bun run`. OpenTUI is Bun-only by design.

**EMPIRICAL PROBE — 2026-04-22 (same day, post-blocker):** Investigated whether migrating swarm-coder to Bun is viable. Results:

| Probe | Result | Notes |
|---|---|---|
| `bun src/cli.ts --help` | ✅ | Full CLI help prints; all imports resolve under Bun. |
| `bun src/cli.ts doctor` | ✅ | Real code paths (auth, config discovery, install, workspace) all pass. |
| `bun src/ui/repl-solid/bun-smoke.tsx` (OpenTUI + preload) | ✅ | Renders `<box><text>hello opentui</text></box>` via `bun:ffi` + Zig core. Frame captured. |
| `bun build src/cli.ts --target=bun` | ⚠️ | Fails on `react-devtools-core` (Ink's optional dep). Moot once Ink is removed. |
| `bun x vitest run <non-TUI tests>` | ✅ | Existing vitest tests pass under Bun-launched vitest. |

**Conclusion:** swarm-coder's existing TypeScript is **already Bun-compatible without code changes**. The migration is tooling + distribution, not a rewrite. Estimated migration effort drops from 3–6w to **2–3w**.

**DECISION — 2026-04-22 (resolved):** Migrate swarm-coder from Node → Bun runtime **and** Ink/React → OpenTUI/Solid as combined Phase 0. Distribution strategy: single compiled binary via `bun build --compile` so end users don't install Bun separately. Test strategy: mixed — keep vitest for the 1171 non-TUI tests; use `bun test` for OpenTUI-touching tests. Both coexist in the repo.

**Tradeoff owned:** Pinning to Bun 1.x as a first-class runtime. Bun 1.3.8 is production-mature; distribution via compiled binary removes the user-facing install requirement. We accept Bun's `bun:ffi` and plugin system as load-bearing infrastructure.
