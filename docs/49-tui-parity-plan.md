# 49 — TUI Parity Plan: Code Rendering & Interaction Gaps

Follow-up to [`41-tui-redesign.md`](41-tui-redesign.md) (Phases 0–6, shipped). This
doc closes the parity gaps against Claude Code / Codex CLI / opencode identified
in the TUI comparison, with a bias toward "keep it simple."

## Implementation status (shipped)

All phases below are implemented. Summary + deviations from the original plan:

| Phase | Status | Notes / deviations |
|-------|--------|--------------------|
| **A1** grammars | ✅ | Runtime registration from `OPENSWARM_GRAMMAR_DIR` (`syntax.ts` `registerExtraGrammars`); assets are **opt-in / not committed** (binary `.wasm`). Populate with `npm run grammars:update` (`scripts/update-grammars.ts` + `scripts/grammar-parsers-config.json`, uses OpenTUI `updateAssets`). Degrades to plain text when absent. |
| **A2** highlight tool bodies | ✅ | `read_file`/`write_file` bodies render via `<code>` in `tool-chip.tsx`. |
| **A3** registry filetype | ✅ | `ToolRenderer.bodyFiletype?()`; path resolution moved to node-safe `filetype.ts` (no `@opentui/core` import → keeps `registry.ts` vitest-safe). |
| **A4** code theme | ✅ | `theme.ts` code tokens + `codeSyntaxStyle()` in `syntax.ts`. |
| **B1** unified diff | ✅ | `toUnifiedDiff()` in `diff/compute.ts` (jsdiff-compatible; `<diff>` uses `parsePatch`). |
| **B2** `<diff>` in chip | ✅ | `edit_file`/`multi_edit` bodies render `<diff>` when expanded (`diffText()` on the renderer). |
| **C1** dump to scrollback | ✅ | Ctrl+R → `transcript-export.ts` serialize + `renderer.suspend()`/write/`resume()` + temp-file copy. |
| **C2** per-chip expand | ⚠️ scoped | Shipped as working **expand-all** (Ctrl+O — now functional after the key-forwarding fix). True per-chip expand deferred: needs a transcript selection cursor; adding an untriggerable toggle would be a dead promise. |
| **D1** @-mentions → engine | ✅ | `mention-context.ts` appends referenced file contents to the submitted prompt (bounded). |
| **D2** approval Ctrl+E | ✅ | `approvalExpanded` state + full `<diff>` / uncapped preview. **Uncovered + fixed a foundational bug:** `input.tsx` only forwarded arrow keys, so *all* global chords (Ctrl+O/S/T, approvals) were dead — now forwards a curated chord allowlist and all keys during a permission prompt. |
| **D3** j/k nav | ✅ | `viewSelectedIndex` + `view-select`; ↑/↓ always, j/k when a view is active. |
| **D4** dead code | ✅ | Deleted `status.tsx`, `permission-prompt.tsx`. **`turndown` KEPT** — it is used by `web_search.ts`/`web_fetch.ts` (only unused in the UI). |
| **D5** bash danger label | ✅ | Reuses `validateDestructive()` from the bash gate; ⚠ tag in the approval panel. |
| **E1** bash mode | ✅ | `!cmd` → `bash-mode.ts` runs a local shell escape, output to transcript (not the model). |
| **E2** external editor | ✅ | Ctrl+G → `external-editor.ts` ($VISUAL/$EDITOR, suspend/resume). Textarea exposed imperatively via `onTextareaReady` (avoids a controlled-input refactor). |
| **F** theming/vim/image | ⏳ deferred | As planned — not started. |

**Testing note:** vitest runs `src/**/*.test.ts` (node); OpenTUI-dependent tests
use `*.test.tsx` + `bun:test`. Node-safe logic tests (`filetype`, `bash-mode`,
`mention-context`, `external-editor`, `transcript-export`, `compute`) are `.ts`
vitest; render + grammar-registration tests (`tool-chip`, `approval-panel`,
`syntax`) are `.tsx` bun. No new npm dependencies were added (grammars download
at runtime), so lockfiles are unchanged.

## 0. Key enabler

OpenTUI **0.1.99 already ships the primitives we lack** — this is mostly wiring,
not building:

| Primitive | Type file | What it gives us |
|-----------|-----------|------------------|
| `<code>` (`CodeRenderable`) | `renderables/Code.d.ts` | Syntax-highlighted code block: `content`, `filetype`, `syntaxStyle`, `treeSitterClient`, `streaming`, `conceal`, `drawUnstyledText` |
| `<diff>` (`DiffRenderable`) | `renderables/Diff.d.ts` | Full diff render: `showLineNumbers`, `view: "unified" \| "split"`, `filetype` + `treeSitterClient` (syntax inside hunks), add/remove bg + sign colors, per-line color API |
| `TreeSitterClient.addFiletypeParser(opts)` | `lib/tree-sitter/client.d.ts` | Register more grammars (`FiletypeParserOptions`: `filetype`, `aliases`, `wasm`, `queries.highlights`) |
| `client.preloadParser(ft)` | same | Warm a grammar before first use |
| `updateAssets(opts)` | `lib/tree-sitter/assets/update.d.ts` | Download `.wasm` + `.scm` for new grammars into an assets dir |

Today only 4 grammars are bundled (`typescript`, `javascript`, `markdown`,
`markdown_inline`, `zig`) and highlighting is applied **only** inside assistant
markdown (`transcript.tsx`). Tool output and diffs are plain text.

---

## Phase A — Broaden syntax highlighting (highest impact)

**Goal:** code looks right regardless of language, in both assistant blocks and
tool output.

### A1. Register more grammars
- New module `src/ui/repl-solid/tools/grammars.ts`: a `registerExtraGrammars(client)`
  that calls `client.addFiletypeParser(...)` for python, go, rust, json, yaml,
  bash/sh, toml, html, css, tsx, c/cpp. Include `aliases` (`py`→python, `sh`→bash,
  `yml`→yaml) so fenced info-strings and file extensions both resolve.
- Ship the `.wasm` + `highlights.scm` assets under `src/ui/repl-solid/assets/grammars/`.
  Generate once with `updateAssets({ configPath, assetsDir, outputPath })` at build
  time (add an npm script `grammars:update`); commit the assets so runtime never
  downloads. Bundle them into the compiled binary (they're static files).
- Call `registerExtraGrammars()` right after `getTreeSitterClient().initialize()`
  in `transcript.tsx` (`treeSitterClient()` lazy-init path). Keep the
  `OPENSWARM_DISABLE_TREE_SITTER=1` escape hatch.
- **Guardrail:** the `treeSitterClient()` singleton stays fire-and-forget; grammar
  registration failures must not throw (wrap each `addFiletypeParser` in try/catch,
  log once).

### A2. Highlight tool output bodies
- Replace the plain `<text>` loop in `tool-chip.tsx` body with `<code>` for tools
  whose body is source: `read_file`, `write_file`.
  - Derive `filetype` from the file path extension (new helper `filetypeFromPath(path)`
    in `grammars.ts`, reusing the alias map).
  - Pass the shared `treeSitterClient` + a `codeSyntaxStyle()` (a second
    `SyntaxStyle.fromTheme` palette keyed for code scopes — keyword/string/comment/
    number/function; extend `theme.ts` with those tokens, see A4).
  - Keep the 30-line cap; pass the capped slice as `content`.
- `bash`/`shell_exec`/`grep`/`glob` output stays plain `<text>` (not source; often
  ANSI/log). Only the `$ cmd` line could optionally use `filetype="bash"`.

### A3. Registry returns filetype
- Extend `ToolRenderer` in `registry.ts` with an optional `bodyFiletype(tc): string | undefined`.
  `readRenderer`/`writeRenderer` return the ext-derived filetype; others return
  `undefined` (→ plain text). `tool-chip.tsx` switches to `<code>` only when
  `bodyFiletype()` is defined.

### A4. Theme tokens for code
- Add to `theme.ts`: `codeKeyword`, `codeString`, `codeComment`, `codeNumber`,
  `codeFunction`, `codeType`, `codePunctuation` (dark palette). Build a
  `codeSyntaxStyle` from these (new `markdownTheme`-style array). Reuse the same
  palette for the `<diff>` `syntaxStyle` in Phase B so code and diffs match.

**Files:** `tools/grammars.ts` (new), `tools/registry.ts`, `entries/tool-chip.tsx`,
`transcript.tsx`, `theme.ts`, `package.json` (script + assets), plus assets dir.
**Tests:** `grammars.test.ts` (alias/ext resolution, no-throw on bad grammar);
extend `tool-chip` test to assert `<code>` used for `read_file` with a `.py` path;
snapshot a highlighted python block.
**Effort:** ~1.5 days (asset generation is the fiddly part).

---

## Phase B — Diff quality (adopt `<diff>`)

**Goal:** line numbers, syntax-highlighted hunks, optional split view — replacing
the hand-rolled `+`/`-` prefix rendering.

### B1. Emit unified-diff text
- `DiffRenderable` consumes a unified-diff **string** (`diff` prop), not our
  `DiffLine[]`. Add `toUnifiedDiff(oldText, newText, filePath): string` to
  `diff/compute.ts` (reuse the existing LCS backtrack; emit `@@` hunk headers +
  `+`/`-`/` ` lines + `---`/`+++` file headers). Keep `computeDiff`/`compactDiff`
  for the approval-panel mini-preview and existing tests.

### B2. Swap the edit body renderer
- In `tool-chip.tsx`, for `edit_file`/`multi_edit`, render `<diff>` instead of the
  prefix loop:
  - `diff={toUnifiedDiff(old, new, path)}`, `filetype={filetypeFromPath(path)}`,
    `treeSitterClient`, `syntaxStyle={codeSyntaxStyle()}`, `showLineNumbers`,
    `view="unified"`, `addedSignColor`/`removedSignColor` from `theme.diffAdd/Remove`.
  - This renders the previously-computed-but-unused line numbers "for free."
- Collapsed vs expanded: when not expanded, keep the compact `compactDiff` prefix
  preview (cheap, fits the chip); when `globalExpand`, render the full `<diff>`.
  (Avoids mounting a heavy renderable per chip in the collapsed changelog view.)

### B3. Intra-line (word-level) diff — optional
- `<diff>` handles line-level highlighting; for changed lines, add word-level
  emphasis by computing an intra-line char diff in `compute.ts`
  (`intraLineDiff(oldLine, newLine)`) and passing per-segment styling. If OpenTUI's
  `<diff>` doesn't expose sub-line spans, defer this — line-level + syntax is
  already a big step up. Mark as stretch.

**Files:** `diff/compute.ts` (+`toUnifiedDiff`, maybe `intraLineDiff`),
`entries/tool-chip.tsx`, `approval-panel.tsx` (optional: same `<diff>` in expanded
approval).
**Tests:** `compute.test.ts` unified-diff golden output; tool-chip renders `<diff>`
when expanded.
**Effort:** ~1 day (B1+B2); B3 stretch +0.5 day.

---

## Phase C — Transcript ergonomics

**Goal:** long sessions are navigable and searchable; drill-down is per-item.

### C1. Dump conversation to native scrollback (Claude Code's `[`)
- New keybind in `app.tsx handleKey` (e.g. Ctrl+P for "print", since `[` is awkward
  in OpenTUI key names — confirm the key name it emits first): write the full
  transcript as plain text to the terminal's real scrollback so `Cmd+F` / tmux copy
  mode work.
- Implementation: serialize `state.transcript` (reuse the headless JSONL→text
  formatting in `src/ui/headless.ts`) and write via the renderer's console/stdout
  passthrough. If OpenTUI's alt-screen swallows it, gate on a brief
  `renderer.suspend()`/write/`resume()` if that API exists; otherwise write on exit.
- **Cheapest win in the doc** — no new rendering, just serialize + write.

### C2. Per-chip expand
- Add `expandedToolIds: ReadonlySet<string>` to `ReplState` (+ `toggle-tool-expand`
  event in `state.ts`). `globalExpand` stays as the master toggle (Ctrl+O);
  a focused chip toggles individually.
- Requires a notion of "focused chip." Minimal version: number the visible chips
  and accept `Ctrl+O` = toggle all (existing), plus a selection cursor (j/k) that
  reuses the same infra as Phase D3. If selection is too much scope, ship C2 as
  "expand all / collapse all" only and defer per-chip to when j/k lands.

**Files:** `src/ui/repl/state.ts`, `app.tsx`, `entries/tool-chip.tsx`,
`entries/tool-group.tsx`.
**Tests:** reducer test for `toggle-tool-expand`; e2e dump-to-scrollback smoke.
**Effort:** C1 ~0.5 day; C2 ~1 day (or 0.25 day for all/collapse-only).

---

## Phase D — Finish half-wired features (cheap correctness wins)

These already have scaffolding; they're bugs more than features.

### D1. `@`-mentions → engine context
- `state.mentionedFiles` is tracked but never consumed. In `app.tsx handleSubmit`,
  read `state.mentionedFiles`, resolve+read each file (bounded size), and prepend
  their contents (or a `@path` reference the engine expands) to the submitted prompt
  before `props.onSubmit(line)`. Clear after submit (already done in reducer).
- Decide contract: inline file contents vs. pass a structured attachment list to
  the engine. Inline is simplest and matches how the prompt is currently a string.

### D2. Approval `ctrl+e` full diff
- `approval-panel.tsx` advertises "ctrl+e full diff" but no handler exists. Add the
  Ctrl+E branch to `app.tsx handleKey` (only when `state.name === "awaiting-permission"`):
  toggle a `state.approvalExpanded` flag; the panel renders the full `<diff>`
  (Phase B) when set, compact preview otherwise. Or remove the copy if we don't want
  it. **Pick one — no dead promises.**

### D3. `j`/`k` navigation in agent/task views
- `agent-tree.tsx`/`task-board.tsx` accept `selectedIndex` but `app.tsx` never wires
  it. Add `viewSelectedIndex` to state + `view-select-up`/`down` events; route j/k
  in `handleKey` when `activeView !== "transcript"`; pass `selectedIndex` to the
  views. Reuses cleanly for C2's chip selection.

### D4. Remove dead code
- Delete unmounted `status.tsx` (superseded by `footer.tsx`) and
  `permission-prompt.tsx` (superseded by `approval-panel.tsx`). Confirm no imports,
  drop their tests. Also `turndown` dep is unused in the UI — verify no other
  consumer, then remove from `package.json` (resync both lockfiles per repo
  convention).

### D5. Bash danger label in approval
- `approval-panel.tsx` has a commented-out danger label for bash. Wire it: flag
  commands matching the bash gate's banned/broad prefixes (reuse the gate's
  classifier if exported) and render a `warning`-colored "⚠ destructive" tag.

**Files:** `app.tsx`, `approval-panel.tsx`, `views/*.tsx`, `src/ui/repl/state.ts`,
`package.json`, delete 2 files.
**Tests:** reducer tests for new selection events; approval expand test.
**Effort:** ~1.5 days total (D1 is the biggest; D4 is minutes).

---

## Phase E — Daily-driver interactions

### E1. Bash mode (`!cmd`)
- In `handleSubmit`: if the line starts with `!`, run the rest as a shell command
  (via the existing tool/exec path, respecting permission mode) and inject the
  output as a system/tool transcript entry — do **not** send to the model unless the
  user references it. Add a `[bash]` indicator in the footer while running.
- Reducer: new `bash-mode-run` / result events, or reuse `tool-*` plumbing with a
  synthetic tool id.

### E2. External editor for the prompt
- New keybind (Ctrl+G, matching Claude Code): write `state.input.value` to a temp
  file, spawn `$VISUAL`/`$EDITOR`, read back on exit, `input-changed` with the
  result. Must `renderer.suspend()` (or drop out of raw/alt-screen) around the
  child process and restore after — confirm the OpenTUI suspend/resume API before
  building. Fallback to no-op with a system message if `$EDITOR` unset.

**Files:** `app.tsx`, `src/ui/repl/state.ts`, small exec helper.
**Tests:** bash-mode reducer test; editor path is integration-only (mock spawn).
**Effort:** E1 ~1 day, E2 ~1 day (suspend/resume is the risk).

---

## Phase F — Lower priority (defer unless requested)

- **Theming** — extract `theme.ts` into named palettes + a `light` variant; select
  via `OPENSWARM_THEME` env or a `/theme` slash command. Codex/Claude/opencode all
  have this, but it's polish. ~1 day.
- **Vim input mode** — OpenTUI's `TextareaRenderable` doesn't provide modal editing;
  we'd implement normal/insert/visual in the reducer (`applyKey`) behind a `/vim`
  toggle. Real work (~3–4 days) for a niche audience. Defer.
- **Image paste** — hook the `handlePaste` wrap in `input.tsx` to detect image bytes
  and attach to the engine (requires multimodal support in the provider layer first).
  Blocked on engine; defer.

---

## Suggested sequencing

1. **Phase A** (syntax highlighting) — biggest visible win, unblocks B's `syntaxStyle`.
2. **Phase B** (diffs) — depends on A's `codeSyntaxStyle` + grammars.
3. **Phase D4/D2** (dead-code + approval ctrl+e) — trivial cleanup, do alongside B.
4. **Phase C1** (dump-to-scrollback) — cheap, high daily value.
5. **Phase D1/D3, C2** (mentions, j/k, per-chip expand) — shared selection infra.
6. **Phase E** (bash mode, editor).
7. **Phase F** as demanded.

## Cross-cutting constraints

- Everything runs in Docker Compose (repo convention) — test via the container.
- After any `package.json` change: `bun install --lockfile-only`, commit **both**
  `package-lock.json` and `bun.lock` (CI fails on stale `bun.lock`).
- UI tests under `src/ui/repl-solid/` run with `bun test`, not vitest.
- Keep the `OPENSWARM_DISABLE_TREE_SITTER=1` fallback intact through A/B; all
  grammar/highlight paths must degrade to plain text without throwing.
- Don't regress the streaming-markdown finalization contract
  (`transcript.tsx` `streaming` prop) when touching the code/diff renderers.
