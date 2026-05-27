# Phase 4 — TUI polish: plan + design lock

Companion to [16-parity-plan.md § Phase 4](16-parity-plan.md). This file is the execution plan + pre-implementation design lock for Phase 4 (gaps T1, T6, T7 from [15-parity-gaps.md](15-parity-gaps.md)). Written 2026-04-30, post-Phase-3 ship.

**Status:** shipped 2026-04-30 (commits f4d35ad..1df9547 + Stage D — see git log).

---

## Goal

Bring the OpenTUI/Solid REPL up to a "daily-driver" bar by closing three friction items:

- **T1** — multi-line input with paste preservation
- **T6** — persistent prompt history across sessions
- **T7** — full Emacs keybinding set (word motions + yank)

None of these are deep architectural work. The substrate exists from Phase 0: `TextareaRenderable` already has a `TextareaAction` enum covering every keystroke we need ([Textarea.d.ts:8](node_modules/@opentui/core/renderables/Textarea.d.ts)), `handlePaste` already preserves newlines for the multi-line variant ([index-*.js:27315-27317](node_modules/@opentui/core/index-*.js)), and the reducer already tracks `state.history` + `state.input.killBuffer`. Phase 4 wires the missing edges.

---

## Audit: what's already built

Before breaking into stages, confirm what's *already shipped* so we don't redo it. Reading [src/ui/repl-solid/input.tsx](src/ui/repl-solid/input.tsx) and [src/ui/repl/state.ts](src/ui/repl/state.ts) at HEAD:

| Item | State | Source |
|---|---|---|
| `TextareaRenderable` mounted (multi-line capable) | ✅ | [input.tsx:144-155](src/ui/repl-solid/input.tsx) |
| Enter → submit | ✅ | KEY_BINDINGS line 87 |
| Shift+Enter → newline | ✅ | line 89 |
| Ctrl+J → newline | ✅ | line 90 |
| Ctrl+A / Ctrl+E (line-home/end) | ✅ | KEY_BINDINGS |
| Ctrl+K (kill-to-EOL) | ✅ | KEY_BINDINGS |
| Ctrl+U (kill-to-BOL) | ✅ | KEY_BINDINGS |
| Ctrl+W (kill-word-back) | ✅ | KEY_BINDINGS |
| Up/Down arrow → history nav | ✅ | reducer + onKey wiring |
| Ctrl+P / Ctrl+N → history nav | ✅ | reducer ([state.ts:465-470](src/ui/repl/state.ts)); wired via onKey |
| In-memory `state.history` per session | ✅ | [state.ts:281-290](src/ui/repl/state.ts) |
| `state.input.killBuffer` (single-slot kill ring) | ✅ | reducer fills on K/U/W |
| Paste preserves newlines | ✅ (free from OpenTUI) | bundled `TextareaRenderable.handlePaste` UTF-8-decodes + strips ANSI; **does not strip newlines** |
| **Persistent history** (`~/.swarm-harness/history`) | ❌ | nothing on disk |
| **CRLF normalization on paste** | ❌ | `decodePasteBytes` is just `TextDecoder.decode`; Windows `\r\n` survives raw |
| **Word motions** (Alt+B / Alt+F / Alt+D / Alt+Backspace) | ❌ | TextareaActions exist (`word-forward`, `word-backward`, `delete-word-forward`); zero KEY_BINDINGS entries |
| **Yank (Ctrl+Y)** | ❌ | killBuffer fills but nothing reads it |
| **Buffer motions** (Ctrl+Home / Ctrl+End) | ❌ | `buffer-home`, `buffer-end` actions exist; no bindings |
| **Undo / Redo** (Ctrl+/ / Ctrl+_) | ❌ | `undo`, `redo` actions exist; no bindings |

The bar of "match claw" is mostly hit. Persistent history is the one thing claw *doesn't* have (rustyline `DefaultHistory` is in-memory; see [input.rs:111-117](references/claw-code/rust/crates/rusty-claude-cli/src/input.rs)) — we ship it because doc 16 calls for it and it's table-stakes for daily use.

---

## Design lock — Phase 4 (2026-04-30)

Numbers are Phase-4-local (distinct from the Q1–Q18 parity questions in [17-parity-design-questions.md](17-parity-design-questions.md), Phase 2's P2.Q1–10, and Phase 3's P3.Q1–6).

### P4.Q1 — History persistence: file format + path

**Decision: newline-delimited UTF-8 at `~/.swarm-harness/history`. 10,000-entry cap. Truncate-from-front on overflow.**

- **Path:** `~/.swarm-harness/history` (matches doc 16 scope text and the existing `~/.swarm-harness/plugins/` namespace from Phase 1).
- **Format:** plain newline-delimited UTF-8. One entry per line. No JSON wrapping — this is human-readable and matches `bash`/`zsh` history conventions. Entries are submitted prompts only (slash commands included).
- **Cap:** 10,000 entries, truncate-from-front on overflow (oldest entries drop). Bounded file size; predictable read cost on startup.
- **Multi-line entries:** for now, **flatten on save** by replacing `\n` with `` (SOH control char) so each entry stays on one file line. Restore on load. (Rationale: simpler than a JSONL-per-entry format; preserves the "one line per entry" mental model for `tail`/`grep`. SOH is unlikely to appear in real prompts.)

**Claw reference.** Claw's history is `rustyline::DefaultHistory::new()` — in-memory only ([input.rs:111-117](references/claw-code/rust/crates/rusty-claude-cli/src/input.rs)). No `load_history` / `save_history` calls. claw users lose their history every restart. We diverge here intentionally — daily-driver UX requires persistence.

**Opencode reference.** Submodule was removed from `references/` after the rename, so direct citation isn't possible. The OpenTUI primitives we use don't ship persistence themselves — file I/O is consumer responsibility.

### P4.Q2 — History scope: per-cwd or global?

**Decision: global.**

- One file at `~/.swarm-harness/history`, shared across all projects.
- Up-arrow recalls anything you typed before, regardless of which directory you ran swarm-harness from.

**Rationale.** Two camps in the wild:
- **Global** (bash, zsh default): users want the same Up-arrow story everywhere. Easier mental model.
- **Per-cwd** (Claude Code, claw's `record_prompt_history` for sessions): keeps prompts contextual; a "fix the test" prompt from project A doesn't pollute Up-arrow in project B.

We pick global because: (1) doc 16 wrote the path as a single global file; (2) claw's session-prompt-history is *separate* from rustyline's editor history (the Up-arrow line editor is global; per-session is a `/history` slash command). swarm-harness does the same separation: persistent file = line editor; session-scoped is a future `/history` command.

### P4.Q3 — Dedup: store every entry or skip consecutive duplicates?

**Decision: skip consecutive duplicates. Skip blank entries (whitespace-only).**

- If user submits `foo` then `foo` again, only one `foo` ends up in history.
- If user submits `   ` (all whitespace), it's not recorded.
- Non-consecutive duplicates ARE kept (`foo`, `bar`, `foo` becomes 3 entries).

**Claw reference.** Claw's `push_history` ([input.rs:125-131](references/claw-code/rust/crates/rusty-claude-cli/src/input.rs)) explicitly skips blank entries: `if entry.trim().is_empty() { return; }`. Then calls `editor.add_history_entry(entry)` which delegates to rustyline's default behavior. Rustyline's default `Config::history_duplicates` is `IgnoreConsecutive` (the rustyline crate's `History` doc) — same as our decision. Behavior parity.

### P4.Q4 — Submit failure: write history before or after the engine call?

**Decision: append to the file synchronously *before* dispatching to the engine. Even if the engine fails / errors, the prompt stays in history.**

- Up-arrow recalls a prompt that errored out so the user can edit and retry.
- Append is fast (a single `appendFileSync` call) so it doesn't block the perceived submit latency.

### P4.Q5 — Paste-newline normalization

**Decision: normalize `\r\n` and bare `\r` to `\n` before insertion. ANSI strip is already free from OpenTUI.**

- Wire `onPaste` on the `<textarea>` to intercept paste events.
- Decode bytes via UTF-8, strip ANSI (already done by OpenTUI's `stripAnsiSequences`), then `.replace(/\r\n?/g, "\n")` before inserting.
- Don't override the renderable's default `handlePaste` — instead, add a wrapper that does the normalization first.

**OpenTUI reference.** The bundled `TextareaRenderable.handlePaste` ([index-*.js:27315-27317](node_modules/@opentui/core)) does:
```js
this.insertText(stripAnsiSequences(decodePasteBytes(event.bytes)));
```
where `decodePasteBytes` is just `PASTE_TEXT_DECODER.decode(bytes)` — UTF-8 decode, no normalization. So the renderable preserves newlines (good — multi-line paste works) but doesn't normalize line endings. We wrap to add the normalization.

**Claw reference.** Claw has *no* paste detection (rustyline doesn't expose bracketed-paste; pasted bytes arrive as a long stream of `KeyEvent`s). Pasted multi-line text in claw enters as a single line with literal `\n` characters consumed by the editor as Newline keystrokes. We're better than claw here.

### P4.Q6 — Yank (Ctrl+Y): single-slot or kill-ring?

**Decision: single-slot. Yanks the most recent kill from `state.input.killBuffer`. No ring rotation.**

- Pressing Ctrl+Y inserts `state.input.killBuffer` at the cursor.
- Subsequent kills overwrite (already true).
- No `Alt+Y` (rotate-and-replace) — that's full kill-ring territory and unnecessary for v0.

**Rationale.** The reducer already maintains a single-slot `killBuffer` populated by Ctrl+K, Ctrl+U, Ctrl+W. Adding yank as a reducer handler is ~10 lines. A real ring would require a new field, a tracker, and Alt+Y rotation logic — not worth the surface area for the friction it solves.

### P4.Q7 — Word motions: bind directly to TextareaActions or route through reducer?

**Decision: bind directly to the TextareaActions, mirroring the existing Ctrl+A/E/K/U/W pattern.**

- Add KEY_BINDINGS entries: `Alt+B → word-backward`, `Alt+F → word-forward`, `Alt+D → delete-word-forward`, `Alt+Backspace → delete-word-backward` (alternative to Ctrl+W).
- The reducer doesn't see these — TextareaRenderable handles them natively, then `onContentChange` fires, then the reducer syncs from the textarea's `plainText`/`cursorOffset`. Same pattern as the existing Ctrl bindings.
- The reducer's `applyKey` handler (state.ts:424-526) doesn't gain new branches; the textarea owns the cursor.

**Why match the existing pattern.** The Ctrl+A/E/K/U/W bindings are in KEY_BINDINGS at the textarea layer, not in the reducer. The reducer's Ctrl+A/E/K/U/W handlers ([state.ts:428-464](src/ui/repl/state.ts)) exist for tests but never fire in practice — TextareaRenderable swallows the keystroke first via KEY_BINDINGS. Word motions follow the same pattern: bind at the textarea, leave the reducer untouched. (Optional follow-up: dead-code the reducer's never-firing Emacs handlers in a separate cleanup pass.)

### P4.Q8 — Out of scope deliberately

- **Bracketed paste detection refinement** — OpenTUI handles this; we only normalize line endings.
- **Undo / Redo** (`Ctrl+/`, `Ctrl+_`) — actions exist in OpenTUI, but no demand. Defer to v0.2 if requested.
- **Buffer motions** (Ctrl+Home / Ctrl+End) — same. Up-arrow at line 0 already does the obvious thing.
- **Per-cwd `/history` slash command** — separate feature; not part of T6.
- **History search** (Ctrl+R) — separate feature; not parity with claw (claw doesn't have it via its `LineEditor`).
- **History compression / migration** — file is plaintext newline-delimited; no schema versioning needed for v0.

---

## Stage breakdown

Four stages, each independently shippable. Sequenced so the highest-impact item lands first and the rest stack additively.

### Stage A — Persistent history (T6) · ~0.5d

**Files:**
- New: `src/ui/history.ts` — load/save/append/normalize. Pure logic, no UI deps. Easy to unit-test.
- Edit: `src/ui/repl-solid/app.tsx` — load history on mount, append on submit.
- Edit: `src/ui/repl/state.ts` — `submit` reducer takes an injected initial history (so the store hydrates from disk).

**Module API (sketch):**
```ts
// src/ui/history.ts
export function loadHistory(filePath?: string): string[];
export function appendHistoryEntry(entry: string, filePath?: string): void;
export const HISTORY_CAP = 10_000;
export const DEFAULT_HISTORY_PATH = path.join(os.homedir(), ".swarm-harness", "history");
```

Behavior:
- `loadHistory` reads file → splits by `\n` → unescapes `` → returns array. Missing file → `[]`. Malformed lines → skip silently.
- `appendHistoryEntry` skips blanks (`entry.trim() === ""`); skips consecutive duplicate (reads last line of existing file, compares); escapes `\n` to ``; appends; if file exceeds cap, rewrites with `tail`-style truncation.
- All file ops use `mkdirSync(dirname(file), { recursive: true })` to ensure `~/.swarm-harness/` exists.

**Wiring:**
- `app.tsx` `onMount`: call `loadHistory()`, dispatch a `hydrate-history` reducer event.
- `app.tsx` submit path: call `appendHistoryEntry(line)` synchronously *before* `dispatch({ type: "submit", text: line })`. Even if the dispatch errors, history is durable.
- New reducer event `{ type: "hydrate-history", history: string[] }` — replaces `state.history` once on mount.

**Tests:**
- `src/ui/history.test.ts` (vitest, pure-Node) — covers load, append, dedup, cap-overflow, blank-skip, multi-line escape/unescape, missing-file.
- `src/ui/repl-solid/e2e.test.tsx` — bun:test that mounts App with a temp HOME, verifies hydrated history appears via Up-arrow.

**Acceptance:**
- Submit "hello" → exit → re-launch → Up-arrow shows "hello".
- Submit `   ` → not recorded.
- Submit "hello" twice → only one entry.
- File never exceeds 10k lines after sustained use.

### Stage B — Word motions + yank (T7) · ~0.25d

**Files:**
- Edit: `src/ui/repl-solid/input.tsx` — add KEY_BINDINGS entries for word motions.
- Edit: `src/ui/repl/state.ts` — add `key` handler for Ctrl+Y (yank from killBuffer).

**Bindings to add:**
```ts
{ name: "b", meta: true, action: "word-backward" },
{ name: "f", meta: true, action: "word-forward" },
{ name: "d", meta: true, action: "delete-word-forward" },
{ name: "backspace", meta: true, action: "delete-word-backward" },
```

**Yank in reducer:**
```ts
if (key.ctrl && key.name === "y" && buf.killBuffer.length > 0) {
  return replaceInput(state, {
    ...buf,
    value: buf.value.slice(0, buf.cursor) + buf.killBuffer + buf.value.slice(buf.cursor),
    cursor: buf.cursor + buf.killBuffer.length,
  });
}
```

**Tests:**
- Extend `state.test.ts` — yank inserts killBuffer at cursor; yank with empty killBuffer is a no-op.
- Extend `input.test.tsx` — Alt+F advances cursor by a word; Alt+B retreats.

**Acceptance:**
- Type "foo bar baz", Ctrl+W kills "baz", Ctrl+Y restores it.
- Alt+B / Alt+F move by word.
- Alt+D deletes the word forward.

### Stage C — Paste-newline normalization (T1 polish) · ~0.25d

**Files:**
- Edit: `src/ui/repl-solid/input.tsx` — wrap the textarea ref's `handlePaste` to normalize CRLF/CR → LF before delegating to the renderable's default.

**Approach:**
```tsx
function handleRef(r: TextareaRenderable) {
  textareaRef = r;
  r.focus();
  // Wrap handlePaste to normalize line endings before the renderable inserts.
  const original = r.handlePaste.bind(r);
  r.handlePaste = (event: PasteEvent) => {
    const normalized = new Uint8Array(
      Buffer.from(
        Buffer.from(event.bytes).toString("utf8").replace(/\r\n?/g, "\n"),
      ),
    );
    original({ ...event, bytes: normalized } as PasteEvent);
  };
}
```

(Cleaner: subclass `TextareaRenderable` or use the Solid `onPaste` prop if exposed at the JSX layer. Investigate during implementation; the wrapping pattern above is the fallback.)

**Tests:**
- Bun-native test: simulate a paste with CRLF bytes, assert the buffer content has only `\n`.

**Acceptance:**
- Paste a multi-line snippet with Windows line endings → buffer shows `\n`-separated lines, no `\r` artifacts.

### Stage D — Documentation + cleanup · ~0.25d

- Update [docs/16-parity-plan.md § Phase 4](16-parity-plan.md) with a "see Phase 4 plan" cross-reference (mirror what we did to the Phase 3 scope text).
- Update [docs/15-parity-gaps.md](15-parity-gaps.md): mark T1, T6, T7 as ✅ shipped.
- Update README.md "Not in M0" / status section: persistent history is now a feature.
- (Optional) Dead-code-remove the reducer's never-firing Emacs handlers (state.ts:428-464) — they exist for tests, but the textarea owns the cursor. Defer if it expands the diff too much.

---

## Acceptance criteria (Phase 4 as a whole)

From [docs/16-parity-plan.md:197-200](16-parity-plan.md), refined:

- ✅ Shift+Enter (and Ctrl+J) insert a newline; Enter submits.
- ✅ Pasted multi-line text is preserved with line breaks normalized to `\n` (no stray `\r`).
- ✅ Restart the CLI; Up arrow recalls prior prompts.
- ✅ Emacs motions covered: Ctrl-A/E/K/U/W (already shipped) + Alt-B/F/D/Backspace + Ctrl-Y yank.
- ✅ Full vitest + bun:test suites green.

---

## Estimate

**~1.25 days** total. Reduced from doc 16's vague "Phase 4 polish" because the substrate already exists.

| Stage | Estimate |
|---|---|
| A — persistent history | 0.5d |
| B — word motions + yank | 0.25d |
| C — paste normalization | 0.25d |
| D — docs + optional cleanup | 0.25d |

---

## Risks

- **CRLF normalization at the wrapping layer may not work** if OpenTUI's textarea doesn't expose `handlePaste` as a settable property. Fallback: subclass `TextareaRenderable`. Cost: +0.25d.
- **History file race** if the user runs two swarm-harness instances simultaneously and both append. Atomicity is per-`appendFileSync` call; concurrent writes can interleave but won't corrupt at the file-system level. We accept this — multi-instance history merging is v0.2 territory.
- **Path expansion edge case**: `~` in `process.env.HOME` works, but a user with a non-standard HOME or running under `sudo` may write to the wrong place. Use `os.homedir()` not raw `~`. Already the pattern elsewhere in the repo.

---

## Out of scope (defer to v0.2 or later)

- Per-cwd `/history` slash command (separate feature).
- History search via Ctrl+R (claw doesn't have it either).
- Multi-instance history merge / lock.
- Undo / Redo bindings (Ctrl+/ / Ctrl+_) — actions exist in OpenTUI but no demand.
- Buffer motions (Ctrl+Home / Ctrl+End) — same.
- Full kill-ring with Alt+Y rotation — single-slot is enough.
- History compression / schema versioning — not needed for v0.

---

## Definition of done

1. All four stages merged and passing CI.
2. `npm test` (vitest) and `bun test` (Solid TUI) both green.
3. Phase 4 acceptance criteria met (manual smoke: type → submit → exit → relaunch → Up-arrow).
4. Doc 15 (parity gaps) updated to mark T1, T6, T7 as ✅.
5. Doc 18 (this file) gets a "✅ shipped" header at the top with the commit hash range.

---

## Definition of done — final state

Confirmed shipped 2026-04-30. Each criterion from the acceptance criteria section is met:

- [x] **T6 — Persistent history (Stage A):** `src/ui/history.ts` ships `loadHistory` / `appendHistoryEntry`; app hydrates on mount, appends before dispatch. File at `~/.swarm-harness/history`, 10k-entry cap, consecutive-dedup, blank-skip, multi-line SOH encoding. Unit tests in `src/ui/history.test.ts` cover all edge cases. Commits in range f4d35ad..1df9547.
- [x] **T7 — Word motions + yank (Stage B):** `src/ui/repl-solid/input.tsx` gains KEY_BINDINGS for Alt+B/F/D/Backspace; reducer gains Ctrl+Y yank from `killBuffer`. Tests extend `state.test.ts` and `input.test.tsx`. Same commit range.
- [x] **T1 polish — CRLF normalization (Stage C):** `src/ui/repl-solid/input.tsx` wraps `handlePaste` to normalize `\r\n` and bare `\r` to `\n` before insertion. Bun-native test confirms no `\r` artifacts after Windows-style paste. Same commit range.
- [x] **Docs + cleanup (Stage D):** `docs/15-parity-gaps.md` marks T1/T6/T7 ✅; `docs/16-parity-plan.md` § Phase 4 gains implementation note cross-referencing this file; `docs/18-phase-4-plan.md` status updated to shipped. Commit immediately follows 1df9547.
- [x] **Test suites green:** `npm test` (vitest, 1171+ tests) and `bun test src/ui/repl-solid/` both pass with zero failures at Stage D commit.
