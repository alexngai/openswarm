# 48 — Compaction Mechanism Design (Claude Code-aligned)

Status: **implemented** (phases 1–6 shipped 2026-07-03; follow-ups F1/F2 open)
Owner: engine
Prereqs: [39 §11 compaction comparison](./39-codex-parity-gap-analysis.md#11-compaction-behavior-comparison-claude-code-v21198--codex--openswarm), [04 tool-tiers Claude Code schema alignment](./04-tool-tiers.md#claude-code-schema-alignment)

## Goal

Rebuild openswarm's compaction to match Claude Code v2.1.198's mechanism as
closely as our architecture allows, so Claude-family models (and models trained
on CC-style trajectories) see the compaction signals they were trained on:
the exact continuation preamble, the 9-section summary shape, the
`[Old tool result content cleared]` placeholder, and the attachment-based
post-compact context. Where CC's mechanism has gaps or depends on
Anthropic-server features, borrow from MiMoCode (OpenCode fork) and Codex.

Ground truth sources:

- Claude Code v2.1.198 binary extraction (byte-exact strings + logic; see 39 §11).
- MiMoCode `packages/opencode/src/session/{compaction,overflow,prune}.ts`.
- Codex `codex-rs/core/src/compact*.rs` + `codex-rs/prompts/templates/compact/`.

## Architecture: five layers

Compaction becomes five cooperating layers, replacing today's single
`shouldCompact → compactSession/compactSessionRemote` pipeline. All layers
live in `src/engine/` and are engine-owned (NativeEngine + HardenedNativeEngine;
the Claude SDK engine keeps delegating to the SDK's built-in compaction).

```
turn loop
  ├─ L1 trigger:      usage-token thresholds (ok → warn → microcompact → compact → blocked)
  ├─ L2 microcompact: clear old tool_result contents (cheap, no model call)
  ├─ L3 summarize:    in-session summary request to the main model
  ├─ L4 rebuild:      boundary + continuation + re-injected attachments
  └─ L5 safety:       circuit breakers, PTL retry, mechanical fallback
```

### L1 — Trigger: real token counts, absolute reserve (CC)

Replace the char/4 estimate trigger with the provider's reported usage.

- **Signal**: `contextTokens = usage.inputTokens + cacheReadInputTokens +
  cacheWriteInputTokens` from the most recent `finish` event (engines already
  track `cumulativeUsage`; we need the *last-turn* usage, which is the true
  context occupancy — not the cumulative sum). Persisted in engine snapshots.
- **Thresholds** (CC exact):
  - `autoCompactThreshold = contextWindow − 13_000`
  - `warn = autoCompactThreshold − 20_000` (surface a `context_low` engine event;
    UI shows "Context low (N% remaining)")
  - `blocked = contextWindow − 3_000` (refuse to start a new turn; force compact)
  - Guard for small windows: `autoCompactThreshold = max(⌊window/2⌋, window − 13_000)`.
- **Fallback**: providers that never report usage (or before the first finish
  event) fall back to the current `estimateSessionTokens` char/4 path with the
  existing 10k floor. The estimator stays as the emergency-overflow sizing tool.
- **Check points**: pre-turn (existing site) and mid-turn on `context_overflow`
  errors (existing hardened path → becomes the "reactive" flavor, L4).

MiMoCode corroboration: same design (usage tokens ≥ `usable = window − reserve`,
reserve 20k). CC's 13k reserve wins because Claude models were RLVR-trained
against CC's cadence; the difference is marginal.

Dropped: the `maxEstimatedTokens = 0.8 × window` ratio (strands 193k tokens on
a 967k window) and `DEFAULT_COMPACTION.maxEstimatedTokens = 10_000` as a
runtime trigger (stays as test/emergency floor).

### L2 — Microcompaction: clear old tool results (CC, corroborated by MiMoCode prune)

New module `src/engine/microcompact.ts`. Runs when usage crosses an
intermediate threshold (CC triggers it off context hints; we run it at
`warn` level, before full compaction is needed) and as a first attempt when
`autoCompactThreshold` is crossed — if it saves enough, full compaction is
deferred.

Algorithm (CC semantics, MiMoCode guards):

1. Walk `tool_result` blocks newest → oldest.
2. Protect: the **5 most recent** tool results (CC `keepRecent = 5`); everything
   in the **last 2 user turns** (MiMoCode `turns < 2` guard — protects the
   active exchange even when it has >5 results); results already cleared.
3. Candidates: every older completed tool_result. Compute savings with the
   char/4 estimator.
4. **Only act when savings ≥ 20_000 tokens** (CC `wpo = 20000`; MiMoCode
   `PRUNE_MINIMUM = 20_000` — both agree). Otherwise no-op.
5. Replace each cleared block's content with the CC placeholder, byte-exact:
   `[Old tool result content cleared]`
   When the original content is non-trivial (> ~2k chars), first persist it to
   `<stateDir>/cleared-tool-results/<tool_use_id>.txt` and use CC's persisted
   variant instead: `Tool result saved to: <path>\n\nUse read_file to view`.
   Image/document blocks always become the bare placeholder (CC rule).
6. Emit a `compaction` engine event with `phase: "micro"` metadata
   (`toolsCleared`, `tokensSaved`, `toolsKept`).

Message identity is preserved (only block contents change), so provider replay
and prompt-cache prefixes stay valid up to the first cleared block.

### L3 — Summarization: in-session request to the main model (CC)

Replaces `compact-remote.ts`'s side-channel call (re-serialized text transcript,
tool I/O truncated at 500 chars) with CC's approach: append a user message to
the **live message array** and run one no-tools turn. The model sees the
full-fidelity history it has been working with — nothing re-serialized, nothing
truncated — and prompt caching covers the shared prefix.

- **Request message** = CC prompt, byte-exact, in this order:
  1. The no-tools guard: `CRITICAL: Respond with TEXT ONLY. Do NOT call any
     tools.\n\n- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other
     tool.\n- You already have all the context you need in the conversation
     above.\n- Tool calls will be REJECTED and will waste your only turn — you
     will fail the task.\n- Your entire response must be plain text: an
     <analysis> block followed by a <summary> block.\n\n`
  2. The main prompt ("Your task is to create a detailed summary of the
     conversation so far…") with CC's **9 sections**: 1. Primary Request and
     Intent · 2. Key Technical Concepts · 3. Files and Code Sections ·
     4. Errors and fixes · 5. Problem Solving · 6. All user messages ·
     7. Pending Tasks · 8. **Work Completed** · 9. **Context for Continuing
     Work** — including both "preserve security-relevant instructions verbatim"
     passages and the `<example>` block.
  3. When the user supplied custom instructions (`/compact <text>`):
     `\n\nAdditional Instructions:\n<text>` (CC format).
- **Call**: same provider, `tools: []`, model = main session model by default;
  `OPENSWARM_COMPACTION_MODEL` still pins a cheaper summarizer (openswarm
  extension, kept).
- **Reactive variant** (used by L4's keep-recent path): CC's "RECENT portion"
  prompt — "Your task is to create a detailed summary of the RECENT portion of
  the conversation — the messages that follow earlier retained context…", with
  sections ending 8. Current Work · 9. Optional Next Step.
- **Validation**: keep openswarm's section validation + one corrective retry
  (our extension — CC doesn't have it, it's cheap and catches truncation), with
  the section list updated to the CC names above. Full-path list checks
  sections 1–9 (Work Completed / Context for Continuing Work); reactive list
  checks the RECENT-variant names.
- **Tool-call rejection**: if the summarizer response contains `tool_use`
  blocks despite the guard, treat as a failed attempt (goes through L5).

`REMOTE_COMPACTION_SYSTEM_PROMPT` (Codex-style summarizer persona) is retired.
Codex's third-person handoff framing ("Another language model started to solve
this problem…") is deliberately *not* adopted — CC's first-person continuity
framing is what Claude models expect.

### L4 — Post-compact history rebuild (CC shape)

Today: `[system continuation message, …last 4 messages verbatim]`.
New (full path): **no verbatim tail** — CC's full compaction keeps zero
messages and re-injects working state as attachments instead:

```
[ compact boundary marker (engine event / snapshot metadata),
  continuation user message (isCompactSummary),
  attachment: re-read files (≤ 5),
  attachment: todo list snapshot,
  attachment: re-read CLAUDE.md / AGENTS.md context  ← deferred, follow-up F1 ]
```

- **Continuation message**, byte-exact CC template:
  - `This session is being continued from a previous conversation that ran out
    of context. The summary below covers the earlier portion of the
    conversation.\n\n` + formatted summary (strip `<analysis>`, rewrite
    `<summary>…</summary>` → `Summary:\n…`, collapse blank lines — existing
    `formatCompactSummary` already does this)
  - `\n\nIf you need specific details from before compaction (like exact code
    snippets, error messages, or content you generated), read the full
    transcript at: <path>` — path = the session-recorder `events.jsonl`
    transcript when recording is active; paragraph omitted otherwise.
  - Auto-compact only: `\nContinue the conversation from where it left off
    without asking the user any further questions. Resume directly — do not
    acknowledge the summary, do not recap what was happening, do not preface
    with "I'll continue" or similar. Pick up the last task as if the break
    never happened.` (fixes current wording drift; manual `/compact` omits it.)
  - Role: **user** (CC ships it as a user message; today we use `system` —
    switch, so providers that reorder/merge system messages don't break it).
- **File re-injection**: extend `read-state.ts` to track recency + byte size
  per read/written file. After summarization, clear read state (CC clears
  `readFileState`) and re-inject the **5 most recently read files** (CC
  `H$n = 5`) as one attachment block per file (`<file path="…">…cat-n
  content…</file>` inside a `<system-reminder>` explaining they were re-read
  after compaction), within a **50k-token total budget** (CC `Z1m = 50000`),
  truncating any single file at ~25k tokens (CC `nNm = 25000`). Re-injected
  files re-populate read-state so the read-before-edit contract keeps working
  seamlessly across the boundary.
- **Todo re-injection**: the latest `todo_write` snapshot becomes its own
  attachment block (CC re-attaches todos) instead of being folded into the
  summary text. `withTodoProgress` summary-folding is retired.
- **Reactive path** (context_overflow mid-turn, hardened engine): CC's group
  compaction — split history into user-turn groups, summarize the oldest
  groups with the RECENT-portion prompt variant, keep the newest groups
  verbatim, and append `\n\nRecent messages are preserved verbatim.` to the
  continuation message. Group step sizing is gap-guided when the provider
  reports how many tokens over budget we are (CC `w_a`: drop groups until the
  reported gap is covered, else halve). Verbatim-tail sizing borrows MiMoCode's
  budget: keep whole turns newest-first within
  `min(8_000, max(2_000, ⌊usable × 0.25⌋))` tokens.
- **Boundary hygiene**: the existing tool_use/tool_result walk-back stays as a
  final guard for both paths (never split a pair).

### L5 — Safety valves (CC + existing openswarm fallbacks)

- **Prompt-too-long retry** (summarization itself overflows): drop oldest
  messages and retry, up to **3 attempts** (CC `VNl = 3`), inserting the marker
  `[earlier conversation truncated for compaction retry]` at the cut. Drop-size
  is gap-guided like the reactive path.
- **Rapid-refill breaker**: if a compaction lands and the *next* compaction
  triggers within < 3 turns, count a rapid refill; **3 consecutive** rapid
  refills trip the breaker → stop auto-compacting, emit an error event advising
  a fresh session (CC `l2n`).
- **Consecutive-failure breaker**: repeated summarization failures (same
  session) → skip future auto-attempts, log
  `autocompact: circuit breaker tripped after N consecutive failures` (CC).
- **Mechanical fallback**: the existing `summarizeMessages` stats summary
  remains the terminal fallback when summarization fails/aborts after retries
  (openswarm extension — CC just errors; keeping it costs nothing and saves
  headless runs). Emergency `context_overflow` recovery with
  `maxEstimatedTokens: 0` stays mechanical for speed.
- **Not enough messages**: error string `Not enough messages to compact.`
  (CC `WEt`, byte-exact).

## `/compact` command rework

Today `/compact` is an engine-hint prompt ("Please compact the conversation
history now…"), which merely *suggests* compaction. New behavior:

- Native/hardened engines: a real `compact` control request on the engine —
  runs L3+L4 immediately with `trigger: "manual"` (no resume-instruction
  sentence in the continuation message, matching CC).
- `/compact <instructions>` forwards the text as Additional Instructions (L3).
- SDK engine: unchanged (`/compact` already round-trips through the SDK).

## Config surface

| Knob | Default | Notes |
|---|---|---|
| `OPENSWARM_COMPACTION_MODEL` | main model | kept — pins summarizer model |
| `OPENSWARM_REMOTE_COMPACTION=0` | on | kept — forces mechanical-only (CI/test) |
| `OPENSWARM_COMPACT_RESERVE` | 13000 | new — override the L1 reserve |
| `OPENSWARM_MICROCOMPACT=0` | on | new — disable L2 |
| `CompactionConfig.preserveRecentMessages` | — | retired from the full path (reactive tail is token-budgeted); kept only for the mechanical fallback |

## What deliberately stays openswarm / diverges from CC

- **Mechanical fallback summarizer** — CC has no equivalent; we keep it as the
  terminal safety net (headless multi-agent runs must not die on a failed
  summarization call).
- **Self-exclusion note in the summary request** (`COMPACT_SELF_EXCLUSION`) —
  CC doesn't need it (Claude models are trained on the request), but live
  testing with gpt-5.5 showed non-Claude summarizers treating the request as
  part of the conversation: quoting it under "All user messages" and carrying
  its TEXT-ONLY constraint forward as the user's latest intent, which derailed
  the resumed session (the post-compact model produced an `<analysis>` block
  instead of resuming work). The note tells the summarizer the request itself
  is not part of the conversation being summarized.
- **Section validation + corrective retry** — cheap robustness CC lacks.
- **Snapshot persistence** of compaction state (counts, breakers) — required
  for our resumable engines.
- **Codex third-person handoff prompt** — rejected (see L3).
- **Codex 64k retained-user-message budget** — rejected in favor of CC's
  attachment re-injection; partially reflected in the reactive tail budget.

## Implementation phases

Each phase is independently shippable and testable; strings must be byte-exact
against the v2.1.198 extraction (39 §11).

1. **String/prompt parity** (S): resume-instruction wording, 9-section names
   (Work Completed / Context for Continuing Work), transcript-path paragraph,
   Additional Instructions plumbing, `Not enough messages to compact.`,
   continuation message role system → user. Update compactor tests.
2. **Trigger rework** (M): last-turn usage tracking in both engines + snapshot
   schema bump, `window − 13k` threshold with warn/blocked levels,
   `context_low` event, estimator fallback. Retire the 0.8 ratio in
   `defaultCompactionConfig`.
3. **In-session summarization** (M): L3 request construction, no-tools guard,
   tool-call rejection, PTL retry ×3, validation-list update; retire
   `REMOTE_COMPACTION_SYSTEM_PROMPT` + conversation re-serialization.
4. **Microcompaction** (M): L2 module + persistence of cleared outputs +
   engine wiring + events.
5. **Post-compact rebuild** (L): read-state recency/size tracking, file +
   todo re-injection, no-verbatim-tail full path, reactive group-compaction
   path with gap-guided stepping, boundary walk-back retained. Memory/CLAUDE.md
   re-injection is follow-up F1 — ship this phase with the gap documented and
   a TODO marker at the re-injection site.
6. **Safety valves + `/compact`** (M): breakers, manual-compact control
   request, custom instructions end-to-end.

Verification per phase: unit tests (vitest) + a live headless run against a
non-Claude flow (Azure `azureoai/gpt-5.5` and Bedrock via the LiteLLM
transport) with a low `OPENSWARM_COMPACT_RESERVE` to force compaction inside a
short session, asserting the continuation message and placeholders byte-match
the CC templates.

**Live verification (2026-07-03, azureoai/gpt-5.5):** HardenedNativeEngine
with the provider's context window clamped to 30k (threshold 17k), a tool
returning ~20k-token outputs. Observed per big tool result: usage-based
trigger fired mid-turn, full remote compaction ran (begin/end events,
`removedMessageCount` correct), the in-session summarizer produced a
conforming nine-section summary (first attempt fell back to mechanical —
`summarizerFailed: true` — subsequent ones succeeded), the rapid-refill
circuit breaker tripped after 3 consecutive rapid refills exactly as designed,
and the model completed the original task after compaction. Bedrock via the
LiteLLM gateway not exercised (no `LITELLM_API_KEY` in the environment); the
transport path is identical (OpenAI-compat), so Azure coverage is considered
sufficient.

**Live agent verification (2026-07-03, real CLI headless):** end-to-end
`openswarm prompt --headless --model azureoai/gpt-5.5` in a scratch workspace,
`OPENSWARM_COMPACT_RESERVE=185000` (threshold = window/2 = 100k), agent asked
to run a ~15k-token noise command 10 times. Default engine: two auto full
compactions fired mid-run, the agent kept an accurate count across both
boundaries and finished with the exact expected reply. Hardened engine
(`--framework hardened-native --eager-tool-dispatch --mid-turn-compaction`):
mid-turn compactions fired with `midTurn: true` metadata and the task
completed. This run also surfaced the summarizer self-inclusion failure that
motivated `COMPACT_SELF_EXCLUSION` (see divergences above); re-verified green
after the fix. Note the tool-output cleanser collapses single lines > 500
chars — forcing context growth in tests requires many short lines, not one
long one.

## Resolved questions (2026-07-03)

1. **Reactive path scope** — hardened-engine-only first; NativeEngine keeps
   emergency mechanical recovery. (Decided.)
2. **CLAUDE.md/context re-injection** — **resolved (F1, 2026-07-03).** CLAUDE.md
   / AGENTS.md are now loaded into the system prompt at startup and re-injected
   as attachments after compaction via the `recontextualize()` hook. Curated
   memory needs no re-injection: it already lives in the system prompt, which
   survives compaction. See "F1 — how it landed" below.
3. **Transcript path** — **resolved (F2, 2026-07-03).** Single-agent
   REPL/headless sessions now emit `events.jsonl` (when recording is enabled)
   and set the transcript path, so the continuation message includes the
   transcript-path paragraph. See "F2 — how it landed" below.

## Follow-ups (post-implementation)

| # | Item | Why it matters | Status |
|---|---|---|---|
| F1 | `recontextualize()` runtime callback: post-compact re-read of CLAUDE.md / AGENTS.md as attachments | CC parity — compacted sessions must not drop project instructions (resolved question 2) | **done (2026-07-03)** |
| F2 | Session-recorder single-agent support: emit `events.jsonl` for non-swarm REPL/headless sessions, so the continuation message can always include the transcript-path paragraph | CC always has a transcript to point at; models are trained to consult it for pre-compaction details (resolved question 3) | **done (2026-07-03)** |

### F1 — how it landed (and where it diverged from the plan)

The original plan assumed compaction "silently loses project-memory context."
Investigation showed that is only half true for openswarm:

- **Curated memory already survives compaction.** `enrichTurnInputs` folds
  curated memory into the **system prompt**, which is resent on every request
  and never touched by compaction (compaction only rewrites the messages
  array). So curated memory is *not* re-injected by `recontextualize()` —
  doing so would duplicate it. This is a deliberate divergence from CC's
  "re-read memory" behavior.
- **The real gap was CLAUDE.md / AGENTS.md**, which native/hardened engines
  never loaded at all (only the Claude SDK path did, via its own
  `settingSources`). F1 therefore ships two pieces:
  1. **Startup load** — `src/engine/project-instructions.ts` walks CWD → root,
     reads `CLAUDE.md` / `CLAUDE.local.md` / `AGENTS.md` at each level (root
     first, deepest scope last), dedupes by content hash, and clamps to
     `4k`/file, `12k` total (parity). `main.ts` and `worker-entry.ts` fold
     the result into the system prompt via `buildSystemPrompt({ extensions })`.
  2. **Post-compact re-injection** — `makeProjectInstructionsRecontextualizer(cwd)`
     produces a `RecontextualizeFn` that re-reads the same files and returns
     them as a `<system-reminder>` user attachment. Threaded
     engine option → `CompactionDeps.recontextualize` → `compactSessionRemote`
     (full + reactive paths), placed immediately after the continuation
     message. The hook is defensive: a throwing callback never breaks
     compaction.

### F2 — how it landed

`startSessionRecorder` (previously worker-only) is now started for single-agent
REPL/headless runs in `main.ts` whenever recording is enabled
(`OPENSWARM_RECORD_SESSIONS=1` or `OPENSWARM_SESSION_DIR`). One recorder spans
the whole process (REPL is multi-turn); `engine.setTranscriptPath(...)` wires
the transcript into the continuation message's "read the full transcript at: …"
paragraph. `recordTurnEvents` maps each `NormalizedEvent` → `LaneEvent` and
appends it, mirroring the worker loop; the recorder is flushed in
`finishMemorySession`. Live-verified: a headless run writes
`.swarm/openswarm/sessions/<id>/events.jsonl` with `turn_start` + streamed
events.
