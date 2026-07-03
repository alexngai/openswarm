# 41 — TUI Redesign: Progressive-Disclosure Terminal Interface

## 1. Motivation

openswarm's current TUI is a functional single-agent REPL: streaming markdown, Emacs keybindings, slash commands, a braille spinner, and a y/N permission prompt. It is roughly 6 components and ~1,000 lines of UI code.

This is adequate for simple sessions but falls short in three areas:

1. **Tool call visibility** — Tool calls render as one-line summaries (`[read_file] — ok: src/index.ts`). There is no diff preview, no bash output display, no expand/collapse. Users cannot see what the agent actually did without reading raw JSON.

2. **Multi-agent awareness** — During swarm runs (fanout, pipeline, peer-team, coordinator), there is no visibility into worker agents, their status, or their individual tool activity. The TUI was designed for single-agent interaction.

3. **Approval UX** — The permission prompt shows raw JSON input truncated to 500 characters. For file edits and bash commands, this is nearly useless — users need to see a diff or the actual command being run.

### Reference implementations

- **Kimi Code** (MoonshotAI/kimi-code) — A TypeScript TUI built on `pi-tui` that achieves feature-richness through progressive disclosure: single-column layout, one-line tool chips that expand on demand, smart grouping of related calls, compact diff previews. The design philosophy is "scannable at a glance, drill down when needed."

- **Swarm Runner** (alexngai/swarm-runner, formerly OpenSwarm) — A Solid.js + OpenTUI TUI built for multi-agent interaction. Has per-tool renderers, agent tree hierarchy, task boards, and a plugin system. Rich but complex — 44 components, 24 context providers, multi-panel layout.

- **Codex** (openai/codex) — A Rust/Ratatui TUI with approval overlays, unified diff rendering, session fork/resume, and streaming intelligence.

This design takes Kimi Code's interaction model (progressive disclosure, single column, smart defaults) and combines it with Swarm Runner's multi-agent capabilities (agent tree, task tracking), adapted to openswarm's existing engine and protocol.

## 2. Design Principles

Drawn from Kimi Code's approach:

1. **Single column by default.** No sidebars, no split panes in normal operation. Scroll area is the transcript; everything else is fixed. Multi-agent views are opt-in screens, not always-visible panels.

2. **Chip headers, expand on demand.** Every tool call renders as a single-line chip: `● Bash exit:0 src/deploy.sh` or `● Edit +5 -3 src/main.ts`. Press Ctrl+O to expand to full output. The transcript reads like a changelog.

3. **Smart grouping.** Multiple Read calls from the same turn collapse into a ReadGroup (`Read 3 files · 156 lines`). Multiple Agent spawns collapse into an AgentGroup with phase badges. Reduces noise without hiding information.

4. **Color restraint.** Extend the existing 9-token theme with a few additions (diff green/red, agent phase colors). No random colors per tool.

5. **Context in the footer.** Replace raw token count with `context: 45% (90k/200k)` and rotate tips for discoverability.

6. **Approval shows the actual change.** File edits show a compact diff. Bash commands show the command with a danger label. Not raw JSON.

## 3. Architecture

### 3.1 What stays

The existing architecture is sound and stays:

- **Pure reducer** (`src/ui/repl/state.ts`) — Framework-agnostic state machine with `ReplState` + `ReplEvent` + `reduce()`. Extended with new event types.
- **Solid store binding** (`src/ui/repl-solid/store.ts`) — `createStore` + `reconcile` wrapper.
- **Async iterable engine events** — App consumes `AsyncIterable<NormalizedEvent>` and translates to `ReplEvent[]`.
- **OpenTUI/Solid rendering** — `box`, `scrollbox`, `text`, `markdown` primitives.
- **Slash command system** — Registry + dispatcher + dropdown autocomplete.
- **Theme centralization** — All colors in `theme.ts` with semantic mappings.

### 3.2 What changes

```
src/ui/repl-solid/
├── app.tsx                    # Extended: new event routing, Ctrl+O/E keybinds
├── store.ts                   # Unchanged
├── theme.ts                   # Extended: diff colors, agent phase colors
├── index.ts                   # Unchanged
├── mount.tsx                  # Unchanged
├── input.tsx                  # Extended: @file mention, message queue display
├── transcript.tsx             # Refactored: delegates to entry renderers
├── status.tsx                 # Replaced by footer.tsx
├── spinner.tsx                # Stays (used within tool chips)
├── permission-prompt.tsx      # Replaced by approval-panel.tsx
├── dropdown.tsx               # Extended: file mention candidates
│
├── entries/                   # NEW — per-entry-kind renderers
│   ├── user-entry.tsx         #   User message with ✨ bullet
│   ├── assistant-entry.tsx    #   Markdown response
│   ├── tool-chip.tsx          #   Collapsed tool call header + expand body
│   ├── tool-group.tsx         #   Groups multiple tool calls (Read, Agent)
│   ├── system-entry.tsx       #   Hook events, errors, compaction markers
│   └── agent-status.tsx       #   Swarm worker status card
│
├── tools/                     # NEW — per-tool renderers (chip + expanded body)
│   ├── registry.ts            #   Tool name → { chip, summary, body } dispatch
│   ├── bash.tsx               #   Command + exit code + output
│   ├── edit.tsx               #   Diff preview (compact + full)
│   ├── write.tsx              #   File creation + syntax highlight
│   ├── read.tsx               #   File path + line count
│   ├── grep.tsx               #   File matches glance
│   ├── glob.tsx               #   File list glance
│   ├── generic.tsx            #   Fallback: JSON args + result truncation
│   └── agent.tsx              #   Subagent phase tracking
│
├── diff/                      # NEW — diff computation + rendering
│   ├── compute.ts             #   LCS-based line diff algorithm
│   └── render.tsx             #   Color-coded unified diff display
│
├── approval-panel.tsx         # NEW — replaces permission-prompt.tsx
├── footer.tsx                 # NEW — replaces status.tsx
├── message-queue.tsx          # NEW — queued messages display
│
└── views/                     # NEW — opt-in full-screen views
    ├── agent-tree.tsx          #   Hierarchical agent browser (swarm runs)
    └── task-board.tsx          #   Task status overview (swarm runs)
```

### 3.3 State machine extensions

New events added to `ReplEvent` union:

```typescript
// Tool call lifecycle (replaces flat "tool-entry")
| { type: "tool-start"; id: string; name: string; step: number }
| { type: "tool-args-delta"; id: string; jsonDelta: string }
| { type: "tool-result"; id: string; content: string; isError: boolean }

// Expand/collapse
| { type: "toggle-expand"; id?: string }       // Ctrl+O: specific tool or global
| { type: "toggle-full-preview" }              // Ctrl+E: full-screen approval diff

// Message queue
| { type: "queue-message"; text: string }      // Ctrl+S steering or typed-while-streaming
| { type: "dequeue-message" }                  // After turn ends, auto-dequeue

// Multi-agent
| { type: "agent-status"; agentId: string; phase: AgentPhase; meta: AgentMeta }
```

New state fields:

```typescript
interface ReplState {
  // ... existing fields ...

  // Tool call tracking (replaces flat tool transcript entries)
  toolCalls: Record<string, ToolCallState>
  toolGroups: ToolGroup[]           // auto-grouped read/agent calls

  // Expand state
  globalExpand: boolean             // Ctrl+O toggles all
  expandedTools: Set<string>        // individually expanded tool IDs

  // Message queue
  messageQueue: string[]            // messages queued during streaming

  // Active view
  activeView: "transcript" | "agents" | "tasks"
}
```

### 3.4 NormalizedEvent → ReplEvent mapping changes

Current mapping loses tool call structure (tool_use_start → one-line "tool-entry", tool_use_input → ignored, tool_result → one-line "system-entry"). The new mapping preserves the full lifecycle:

```typescript
function translateEngineEvent(evt: NormalizedEvent): ReplEvent[] {
  switch (evt.type) {
    case "tool_use_start":
      return [{ type: "tool-start", id: evt.id, name: evt.name, step: currentStep }]
    case "tool_use_input":
      return [{ type: "tool-args-delta", id: evt.id, jsonDelta: evt.jsonDelta }]
    case "tool_result":
      return [{ type: "tool-result", id: evt.id, content: evt.content, isError: evt.isError }]
    // ... text_delta, message_stop, etc. unchanged
  }
}
```

## 4. Component Design

### 4.1 Tool Chips

Inspired by Kimi Code's `chip.ts` + `summary.ts` pattern. Each tool gets a one-line header and an optional expanded body.

**Chip header format:**
```
● {verb} {toolLabel} {keyArg}  {chip}
```

- **Bullet:** `●` (in-progress), `✓` (success), `✗` (error)
- **Verb:** "Using" (streaming) → "Used" (complete)
- **Tool label:** Bold tool name
- **Key arg:** Primary argument, truncated (file path for read/edit/write, command for bash, pattern for grep)
- **Chip:** Numeric summary suffix — line count, `+N -M` diff stats, exit code, byte size

**Per-tool chip specifications:**

| Tool | Key Arg | Chip | Expanded Body |
|------|---------|------|---------------|
| `bash` | First line of command | `exit:0` or `exit:1` (red) | Full command + stdout/stderr |
| `read_file` | File path | `{N} lines` | File content (syntax highlighted) |
| `edit_file` | File path | `+{a} -{d}` | Unified diff (color-coded) |
| `write_file` | File path | `{N} lines` | File content (syntax highlighted) |
| `multi_edit` | File path | `+{a} -{d} ({n} edits)` | Unified diff per edit |
| `grep` | Pattern | `{N} files` | 3 sample file:line matches, `+N more` |
| `glob` | Pattern | `{N} files` | 3 sample paths, `+N more` |
| `web_fetch` | URL | `{size}` | Response body (truncated) |
| `web_search` | Query | `{N} results` | Result titles + URLs |
| `agent` | Agent name/task | Phase badge | Subagent activity summary |
| *(other)* | First arg value | — | JSON args + result (truncated) |

**Expand/collapse (Ctrl+O):**

Following Kimi Code's pattern — `setExpanded()` rebuilds the body portion while the header stays static. A global `toolOutputExpanded` flag toggles all tool calls, or individual IDs can be toggled.

### 4.2 Tool Grouping

Following Kimi Code's `read-group.ts` and `agent-group.ts` patterns:

**ReadGroup** — When 2+ `read_file` calls occur in the same agent step:
```
● Read 3 files · 156 lines
  ├─ src/main.ts · 51 lines
  ├─ src/cli.ts · 68 lines
  └─ src/util.ts · 37 lines
```

**AgentGroup** — When 2+ `agent` tool calls occur in the same step (swarm spawns):
```
● 3 Agents running…
  ├─ architect · ✓ done · 4 tools · 2.1k tok
  ├─ implementer · ↻ running · 2 tools
  └─ reviewer · ◌ spawning…
```

Grouping is determined in the reducer: consecutive tool-start events with the same tool name in the same step get assigned to a group. The transcript stores group IDs alongside individual tool call IDs.

### 4.3 Diff Rendering

Following Kimi Code's LCS-based diff computation:

```
+5 -3 src/server.ts
    4  const app = express()
+   5  app.use(cors())
+   6  app.use(helmet())
-   5  app.use(bodyParser())
    7  app.listen(3000)
       … 2 more changes (ctrl+o to expand)
```

- **Algorithm:** LCS dynamic programming over old/new line arrays
- **Streaming-aware:** Suppress trailing deletes while `tool_use_input` is still arriving (partial `new_string` causes false negatives)
- **Compact mode (default):** 3 context lines, max 10 change lines, `… N more` footer
- **Full mode (Ctrl+O / Ctrl+E):** All changes with full context
- **Colors:** Added lines in green (`#4ade80`), deleted in red (`#f87171`), gutter in muted

### 4.4 Approval Panel

Replaces the current `permission-prompt.tsx` (which shows raw JSON). Inspired by Kimi Code's `approval-panel.ts` with display blocks:

```
┌─ Approval Required ─────────────────────────┐
│                                              │
│  edit_file  src/server.ts                    │
│                                              │
│  +5 -3 src/server.ts                         │
│      4  const app = express()                │
│  +   5  app.use(cors())                      │
│  -   5  app.use(bodyParser())                │
│      6  app.listen(3000)                     │
│                                              │
│  mode: workspace-write                       │
│  [y] approve  [n] deny  [ctrl+e] full diff   │
└──────────────────────────────────────────────┘
```

**Display block types** (by tool):
- **edit_file / multi_edit / write_file:** Compact diff preview
- **bash:** `$ command` with danger label if destructive
- **Other:** Tool name + key argument + truncated input

**Ctrl+E:** Full-screen diff expansion (replaces transcript temporarily with full diff view, Esc to return).

### 4.5 Footer

Replaces `status.tsx`. Two-line layout inspired by Kimi Code's `footer.ts`:

```
Line 1: [state-badge] model · permission-mode · session {id}   [tip]
Line 2: context: 45% (90k/200k) · cost: $0.12
```

- **State badge:** Color-coded (`idle`, `streaming`, `awaiting-permission`, `compact`)
- **Context %:** `cacheReadTokens + inputTokens` / model context window, always visible
- **Cost:** Running estimated cost (using pricing from `/cost` command)
- **Tips rotation:** Cycle helpful keybind hints every 10s: `ctrl+o expand tools`, `ctrl+s steer`, `shift+enter newline`, `/help for commands`

### 4.6 Message Queue

When the user types during streaming, messages queue visibly above the input (Kimi Code pattern):

```
  ❯ also check the test file         ↑ to edit
───────────────────────────────────────────────
  > Type a message…
```

- Messages queued via Ctrl+S (steering) or typing + Enter during streaming
- Arrow up edits the queued message
- Auto-dequeued as next turn when current turn completes

### 4.7 Multi-Agent Views (Opt-In)

Accessible via keybinds or slash commands, not always visible. These draw from Swarm Runner's component library but rendered in the single-column paradigm:

**Agent Tree** (`/agents` or Ctrl+A during swarm run):
```
Agents (3 active, 1 done)
  ├─ root (coordinator) · idle
  │  ├─ worker-1 (implementer) · ↻ streaming · 12 tools
  │  ├─ worker-2 (reviewer) · ◌ waiting
  │  └─ worker-3 (tester) · ✓ done · 24 tools · 4.2k tok
```

- Replaces transcript temporarily (Esc to return)
- Shows agent hierarchy from `SwarmHost` state
- j/k navigation, Enter to view agent's transcript
- Phase colors: spawning=muted, running=accent, done=success, failed=error

**Task Board** (`/tasks` or Ctrl+T during swarm run):
```
Tasks (2 done, 1 active, 3 pending)
  ✓ Parse CLI arguments          worker-1  2m ago
  ✓ Add validation logic         worker-1  1m ago
  ↻ Write unit tests             worker-3  running
  ◌ Update documentation         —         pending
  ◌ Run integration tests        —         pending
  ◌ Final review                 —         pending
```

- Maps to openswarm task graph (`task_create`, `task_update` IPC)
- j/k navigation, Enter to view task details

Both views are rendered as full-screen replacements of the transcript (like Kimi Code's session picker or help panel), not as persistent sidebars.

### 4.8 Input Enhancements

**File mentions (`@`):**
- Typing `@` triggers file completion dropdown (git ls-files or fd)
- Selected file path inserted into input
- Mentioned files attached to the prompt as context

**Plan mode (`Shift+Tab`):**
- Toggles plan mode flag
- Agent creates a multi-step plan before executing
- Plan displayed in a bordered box in transcript
- User approves/rejects before execution proceeds

## 5. Implementation Plan

### Phase 1: Tool Chips + Diff Rendering (core upgrade)

**Goal:** Replace flat tool-entry lines with rich chip headers and expandable bodies.

**Changes:**
1. Extend `ReplEvent` with `tool-start`, `tool-args-delta`, `tool-result` events
2. Add `toolCalls` record and `expandedTools` set to `ReplState`
3. Update `translateEngineEvent()` to preserve tool call lifecycle
4. Create `src/ui/repl-solid/entries/tool-chip.tsx` — chip header + expand body
5. Create `src/ui/repl-solid/tools/registry.ts` — tool name → renderer dispatch
6. Create tool renderers: `bash.tsx`, `edit.tsx`, `write.tsx`, `read.tsx`, `grep.tsx`, `glob.tsx`, `generic.tsx`
7. Create `src/ui/repl-solid/diff/compute.ts` — LCS diff algorithm
8. Create `src/ui/repl-solid/diff/render.tsx` — color-coded diff display
9. Refactor `transcript.tsx` to delegate tool entries to `tool-chip.tsx`
10. Add Ctrl+O keybind in `app.tsx` for expand/collapse

**Validates:** Tool calls show actionable summaries; diffs are visible without expanding.

### Phase 2: Approval Panel + Footer

**Goal:** Replace raw-JSON permission prompt with contextual approval UI. Replace status bar with informative footer.

**Changes:**
1. Create `src/ui/repl-solid/approval-panel.tsx` — display-block-based approval with diff/command preview
2. Wire approval panel to permission bridge (same y/N flow, better display)
3. Add Ctrl+E keybind for full-screen diff preview during approval
4. Create `src/ui/repl-solid/footer.tsx` — two-line footer with context %, cost, tips rotation
5. Extend `theme.ts` with diff colors and approval border colors
6. Remove `status.tsx` and `permission-prompt.tsx`

**Validates:** Users can review file edits and bash commands before approving.

### Phase 3: Tool Grouping + Message Queue

**Goal:** Reduce transcript noise for multi-tool turns. Support message queuing during streaming.

**Changes:**
1. Create `src/ui/repl-solid/entries/tool-group.tsx` — ReadGroup and AgentGroup renderers
2. Add grouping logic to reducer: consecutive same-tool calls in same step → group
3. Add `messageQueue` to `ReplState`
4. Create `src/ui/repl-solid/message-queue.tsx` — queued message display above input
5. Wire Ctrl+S and Enter-during-streaming to `queue-message` event
6. Auto-dequeue on `stream-end`

**Validates:** 5 sequential reads show as one grouped entry; queued messages are visible and editable.

### Phase 4: Streaming Args Preview

**Goal:** Show live tool call arguments as they stream in (before result arrives).

**Changes:**
1. Accumulate `tool-args-delta` events into `toolCalls[id].streamingArgs` buffer
2. Extract partial JSON fields for live preview in chip header (e.g., file path appears as soon as `file_path` field streams)
3. For edit tools: compute partial diff from streaming `old_string`/`new_string` with trailing-delete suppression
4. Show "Preparing changes…" progress indicator for long-running tool args

**Validates:** User sees which file is being edited before the edit completes.

### Phase 5: Multi-Agent Views

**Goal:** Add opt-in agent tree and task board for swarm runs.

**Changes:**
1. Create `src/ui/repl-solid/views/agent-tree.tsx` — hierarchical agent display
2. Create `src/ui/repl-solid/views/task-board.tsx` — task status list
3. Add `activeView` to `ReplState` (`"transcript" | "agents" | "tasks"`)
4. Wire `/agents` slash command + Ctrl+A keybind
5. Wire `/tasks` slash command + Ctrl+T keybind (extend existing `/tasks`)
6. Add `agent-status` event to reducer for swarm worker state updates
7. Create `src/ui/repl-solid/tools/agent.tsx` — subagent phase tracking in tool chip
8. Connect to `SwarmHost` events (agent spawn, status change, task updates) via new NormalizedEvent variants or IPC bridge

**Validates:** During a swarm run, user can see all agents and their phases; can drill into individual agent transcripts.

### Phase 6: Input Enhancements

**Goal:** File mentions and plan mode.

**Changes:**
1. Add `@` trigger to input for file mention completion
2. Create file completion provider (git ls-files, cached)
3. Extend dropdown to support both `/` and `@` completion modes
4. Add `Shift+Tab` plan mode toggle
5. Wire plan mode to engine (system prompt modifier or tool constraint)

**Validates:** `@src/main.ts` inserts file context; Shift+Tab produces a plan before execution.

## 6. Key Patterns from Kimi Code

### 6.1 Chip + Glance + Expanded (Three-Layer Rendering)

Every tool call has three rendering levels:

| Layer | What | When |
|-------|------|------|
| **Chip** (header) | `● Edit +5 -3 src/main.ts` | Always visible |
| **Glance** (summary) | 3-line compact diff or file list | Collapsed, below chip |
| **Expanded** (full) | Complete diff / output / content | After Ctrl+O |

The chip is computed once on result arrival. The glance is optional (some tools like Read skip it — the chip says enough). The expanded body is rendered on demand.

This maps to a `ToolRenderer` interface:

```typescript
interface ToolRenderer {
  chip(name: string, args: unknown, result: string, isError: boolean): string
  glance?(args: unknown, result: string): string[] | null  // null = no glance
  body(args: unknown, result: string, expanded: boolean): JSX.Element
}
```

### 6.2 Snapshot-Listener Grouping

Groups (ReadGroup, AgentGroup) don't own their children's state. Instead, each child tool call exposes a snapshot, and the group subscribes with throttled refresh:

- Normal updates (latest activity, token count): 200ms coalesce
- Phase transitions (spawning → running → done): immediate flush

In the Solid.js context, this maps to derived signals:

```typescript
const groupSnapshot = createMemo(() => {
  return groupToolIds.map(id => computeSnapshot(state.toolCalls[id]))
})
```

Solid's fine-grained reactivity handles the "only re-render when snapshot changes" automatically.

### 6.3 Streaming-Aware Diff

When computing diffs from streaming tool args:
1. Parse partial JSON to extract `old_string` and `new_string` fields
2. Run LCS diff on available content
3. Suppress trailing delete lines (the `old_string` may be complete but `new_string` is still streaming — trailing deletes are artifacts)
4. Snap to final diff when `tool_result` arrives

### 6.4 Footer Tip Rotation

Tips are weighted entries rotated every 10 seconds:

```typescript
const tips = [
  { text: "ctrl+o expand tools", weight: 2 },
  { text: "ctrl+s steer mid-turn", weight: 1 },
  { text: "/help for commands", weight: 1 },
  { text: "shift+enter for newline", weight: 1 },
]
```

Higher weight = shown more frequently. Long tips marked `solo: true` are never paired. Two short tips can share a line separated by ` · `.

## 7. Theme Extensions

```typescript
const theme = {
  // ... existing 9 tokens ...

  // Diff
  diffAdd: "#4ade80",        // green — added lines
  diffRemove: "#f87171",     // red — removed lines
  diffGutter: "#6b7280",     // gray — line numbers

  // Agent phases
  phaseSpawning: "#9ca3af",  // muted — initializing
  phaseRunning: "#60a5fa",   // accent — active
  phaseDone: "#4ade80",      // success — completed
  phaseFailed: "#f87171",    // error — failed

  // Approval
  approvalBorder: "#fbbf24", // warning — approval box border

  // Tool chip bullets
  bulletPending: "#a78bfa",  // streaming indicator — in progress
  bulletSuccess: "#4ade80",  // green — completed
  bulletError: "#f87171",    // red — failed
}
```

## 8. Keybinds Summary

| Key | Context | Action |
|-----|---------|--------|
| `Ctrl+O` | Any | Toggle tool output expansion (global or focused) |
| `Ctrl+E` | Approval | Full-screen diff preview |
| `Ctrl+S` | Streaming | Steer (queue follow-up message) |
| `Ctrl+A` | Idle (swarm) | Open agent tree view |
| `Ctrl+T` | Idle (swarm) | Open task board view |
| `Shift+Tab` | Idle | Toggle plan mode |
| `Esc` | View/Approval | Return to transcript |
| `j/k` | Views | Navigate items |
| `Enter` | Views | Drill into selected item |

## 9. Migration Notes

### Backward compatibility

- The pure reducer in `src/ui/repl/state.ts` gains new event types but existing events remain unchanged. Old tests continue to pass.
- `TranscriptEntry` gains an optional `toolCallId` field linking to the `toolCalls` record. Entries without it render as before.
- Headless mode (`src/ui/headless.ts`) is unaffected — it emits raw NormalizedEvents as JSONL regardless of TUI changes.

### Swarm Runner component reuse

Specific components worth pulling from Swarm Runner (adapting from MAP/ACP protocol to NormalizedEvent):
- `agent-tree.tsx` / `agent-node.tsx` — hierarchical agent rendering (Phase 5)
- Tool renderer patterns from `tools/bash.tsx`, `tools/edit.tsx` — though these need adaptation from ACP stream format to NormalizedEvent tool results (Phase 1)

The bulk of the implementation is new code following Kimi Code patterns, not Swarm Runner transplants. Swarm Runner's value is primarily in the multi-agent views (Phase 5) and as a reference for the Solid.js + OpenTUI component patterns.

### What we intentionally skip

- **Multi-panel layout** — Swarm Runner's sidebar + main + details layout adds complexity without proportional value for the common case. If a user needs persistent agent visibility, the agent tree view (Ctrl+A) covers it.
- **Plugin system** — Swarm Runner's 10-extension-point plugin architecture is over-engineered for openswarm. Swarm-harness already has its own plugin and MCP systems.
- **View tabs** — Swarm Runner's 11 views (tasks, teams, topology, timeline, streams, environments, federation, settings, etc.) are macro-agent-specific. We add only 2 views (agents, tasks) that map to openswarm concepts.

## 10. Implementation & Test Plan

### Testing strategy

Three test layers, matching existing patterns in the repo:

| Layer | Framework | What it tests | Pattern |
|-------|-----------|---------------|---------|
| **Reducer unit** | `vitest` (`store.test.ts`) | State transitions — pure `reduce(state, event) → state` | State-in/state-out, no rendering |
| **Component render** | `bun:test` + `testRender()` from `@opentui/solid` | Visual output — `captureCharFrame()` contains expected text | Mount component, `renderOnce()`, assert frame |
| **E2E integration** | `bun:test` + `makeEventChannel()` | Full loop — synthetic events pump through App → store → transcript | Push `NormalizedEvent`s, flush, assert frames |

The `testRender()` API provides `captureCharFrame()` (text buffer as string), `renderOnce()` (async render cycle), and `mockInput` (typeText, pressEnter, pressArrow). Tests use `bun:test` because vitest's Node worker cannot resolve `@opentui/core`'s `bun:ffi` imports. Pure logic tests (reducer, diff algorithm, chip functions) use `vitest`.

### NormalizedEvent extensions (for Phase 5)

New event types added to `src/core/types.ts` for multi-agent awareness:

```typescript
| {
    readonly type: "agent_spawned";
    readonly agentId: AgentId;
    readonly name: string;
    readonly role?: string;
    readonly parentId?: AgentId;
  }
| {
    readonly type: "agent_status";
    readonly agentId: AgentId;
    readonly phase: "spawning" | "running" | "idle" | "done" | "failed";
    readonly toolCount?: number;
    readonly tokenUsage?: Usage;
  }
| {
    readonly type: "task_update";
    readonly taskId: string;
    readonly title: string;
    readonly status: "pending" | "active" | "done" | "failed";
    readonly assignee?: string;
  }
```

These are emitted by the orchestrator/SwarmHost and consumed by the TUI event translator. Headless mode passes them through as JSONL.

### Phase 1a: Reducer Extensions + Tool Chip Shell

**Goal:** Get the expand/collapse mechanics working with all tools rendering as generic chips.

**Implementation:**
1. Extend `ReplEvent` with `tool-start`, `tool-args-delta`, `tool-result`, `toggle-expand`
2. Add `ToolCallState` interface and `toolCalls` record to `ReplState`
3. Add `globalExpand` boolean to `ReplState`
4. Update reducer: `tool-start` creates entry in `toolCalls` + appends transcript entry with `toolCallId`; `tool-args-delta` accumulates `streamingArgs`; `tool-result` finalizes; `toggle-expand` flips state
5. Update `translateEngineEvent()` to emit new events instead of flat `tool-entry`/`system-entry`
6. Create `src/ui/repl-solid/entries/tool-chip.tsx` — chip header + conditional expanded body
7. Create `src/ui/repl-solid/tools/registry.ts` with `generic.tsx` fallback
8. Refactor `transcript.tsx` to delegate `tool` entries to `ToolChip` when `toolCallId` is present
9. Wire Ctrl+O in `app.tsx` to dispatch `toggle-expand`
10. Extend `theme.ts` with bullet colors

**Tests:**
- **store.test.ts** (vitest): `tool-start` creates entry in `toolCalls`; `tool-args-delta` accumulates; `tool-result` sets content + isError; `toggle-expand` flips `globalExpand`; existing tests pass unchanged
- **tool-chip.test.tsx** (bun:test): mount ToolChip with mock ToolCallState, assert collapsed frame shows chip header (`●` bullet + tool name), expanded shows body content
- **e2e.test.tsx** (bun:test): push `tool_use_start` → `tool_use_input` → `tool_use_end` → `tool_result` → `message_stop` through event channel, assert frame contains chip header text; verify old `[tool] — summary` format no longer appears

### Phase 1b: Per-Tool Renderers + Diff Algorithm

**Goal:** Each tool gets its specialized chip summary and expanded body.

**Implementation:**
1. Create `src/ui/repl-solid/diff/compute.ts` — LCS-based line diff, pure function
2. Create `src/ui/repl-solid/diff/render.tsx` — color-coded unified diff component
3. Create tool renderers: `bash.tsx`, `edit.tsx`, `write.tsx`, `read.tsx`, `grep.tsx`, `glob.tsx`
4. Each exports `{ chip, glance, body }` conforming to `ToolRenderer` interface
5. Register in `tools/registry.ts`

**Tests:**
- **diff/compute.test.ts** (vitest): pure function tests — old/new text pairs → expected diff lines. Cases: additions only; deletions only; mixed changes; empty files; single-line edits; no changes; large files; Unicode content
- **tools/chips.test.ts** (vitest): each tool's `chip()` function tested independently. E.g. bash chip with exit 0 → `"exit:0"`; edit chip → `"+5 -3"`; read chip → `"42 lines"`; grep chip → `"3 files"`
- **diff/render.test.tsx** (bun:test): mount DiffView with computed diff lines, assert frame contains green added lines and red deleted lines
- **tools/edit.test.tsx** (bun:test): mount edit renderer with mock edit_file args/result, assert compact diff appears in collapsed mode, full diff in expanded
- **e2e.test.tsx**: push edit_file tool cycle, assert frame shows `● Edit +N -M path` chip header

### Phase 2: Approval Panel + Footer

**Goal:** Replace raw-JSON permission prompt with contextual approval UI. Replace status bar with informative footer.

**Implementation:**
1. Create `src/ui/repl-solid/approval-panel.tsx` — renders display blocks per tool type (diff for edit_file, `$ command` for bash, key arg for others)
2. Wire to permission bridge (same y/N key flow, app.tsx routing unchanged)
3. Add Ctrl+E keybind for full-screen diff preview (sets state flag, transcript replaced by full diff, Esc returns)
4. Create `src/ui/repl-solid/footer.tsx` — two-line layout with context %, cost, tip rotation
5. Extend `theme.ts` with `approvalBorder` color
6. Replace `<Status>` with `<Footer>` and `<PermissionPrompt>` with `<ApprovalPanel>` in app.tsx
7. Delete `status.tsx` and `permission-prompt.tsx`

**Tests:**
- **approval-panel.test.tsx** (bun:test): mount with edit_file `PendingPermission`, assert frame shows diff preview not raw JSON; mount with bash, assert frame shows `$ command`; mount with unknown tool, assert shows tool name + key arg
- **footer.test.tsx** (bun:test): mount with mock token getter + model context window size, assert `context:` percentage line appears; test tip rotation with fake timers (advance 10s, assert tip text changes)
- **e2e.test.tsx**: push `permission_request` event for edit_file during streaming, assert frame shows diff in approval box not raw JSON; simulate `y` keypress, assert state returns to streaming
- **Regression**: all existing permission e2e tests (y/N flow) must still pass — only the display changes, not the interaction model

### Phase 3: Tool Grouping + Message Queue

**Goal:** Reduce transcript noise for multi-tool turns. Support message queuing during streaming.

**Implementation:**
1. Add `ToolGroup` type and grouping logic to reducer: consecutive `tool-start` events with the same tool name and adjacent transcript positions get a `groupId`; `TranscriptEntry` gains optional `groupId` field
2. Create `src/ui/repl-solid/entries/tool-group.tsx` — ReadGroup and AgentGroup renderers with tree-line formatting (├─ / └─)
3. Add `messageQueue: string[]` to `ReplState`
4. Add `queue-message` and `dequeue-message` events to `ReplEvent`
5. Create `src/ui/repl-solid/message-queue.tsx` — renders queued messages with `❯` prefix above input
6. Wire Ctrl+S during streaming to `queue-message` (replaces current `steer` event); wire Enter-during-streaming to `queue-message`
7. On `stream-end`, auto-dispatch `dequeue-message` which pops first item and fires `submit`
8. Refactor transcript.tsx: when rendering consecutive tool entries sharing a `groupId`, render a single `ToolGroup` component wrapping them

**Tests:**
- **store.test.ts** (vitest): dispatch 3 consecutive `tool-start` for `read_file` → assert `groupId` is set and shared; dispatch `queue-message` → assert `messageQueue` grows; dispatch `stream-end` → assert auto-dequeue pops first message
- **tool-group.test.tsx** (bun:test): mount ReadGroup with 3 read tool call states, assert `Read 3 files · N lines` header; mount AgentGroup with 2 agents, assert grouped header with phase badges
- **message-queue.test.tsx** (bun:test): mount with 2 queued messages, assert `❯` prefix and hint text visible
- **e2e.test.tsx**: push 3 read_file tool cycles in same turn, assert frame shows grouped header instead of 3 separate chips; type during streaming + Enter, assert queue pane appears above input

### Phase 4: Streaming Args Preview

**Goal:** Show live tool call arguments as they stream in before result arrives.

**Implementation:**
1. In reducer, accumulate `tool-args-delta` jsonDelta into `toolCalls[id].streamingArgs` string
2. Create `src/ui/repl-solid/tools/streaming.ts` — `extractPartialJsonField(buffer, fieldName)` parser that extracts string values from incomplete JSON
3. In `ToolChip`, when tool call has `streamingArgs` but no `result`, render live chip header with extracted key arg (e.g., file path appears as `tool_use_input` streams `{"file_path": "src/main.ts"`)
4. For edit tools: compute partial diff from extracted `old_string`/`new_string` with trailing-delete suppression (`isIncomplete: true` flag to `computeDiff`)
5. Show streaming indicator (braille spinner from existing `Spinner`) on chip while args are arriving

**Tests:**
- **tools/streaming.test.ts** (vitest): `extractPartialJsonField('{"file_path": "src/main.ts", "old_str', "file_path")` → `"src/main.ts"`; incomplete field → `undefined`; nested JSON → extracts top-level only; escaped quotes in values handled correctly
- **diff/compute.test.ts** (vitest): add cases with `isIncomplete: true` — trailing delete lines suppressed; same input with `isIncomplete: false` shows them
- **e2e.test.tsx**: push `tool_use_start` for edit_file, then push `tool_use_input` deltas with partial JSON incrementally, assert chip header updates with file path before `tool_result` arrives; after `tool_result`, assert final diff replaces streaming preview

### Phase 5: Multi-Agent Views + NormalizedEvent Extensions

**Goal:** Add opt-in agent tree and task board for swarm runs. Add new NormalizedEvent types.

**Implementation:**
1. Add `agent_spawned`, `agent_status`, `task_update` to `NormalizedEvent` union in `src/core/types.ts`
2. Add `AgentState` record and `TaskState` record to `ReplState`; add `activeView` field
3. Add `agent-spawned`, `agent-status`, `task-update`, `set-view` events to `ReplEvent`
4. Update `translateEngineEvent()` to map new NormalizedEvents to ReplEvents
5. Create `src/ui/repl-solid/views/agent-tree.tsx` — hierarchical agent display with phase badges and tree lines; j/k navigation with `selectedAgentIndex` state
6. Create `src/ui/repl-solid/views/task-board.tsx` — task list with status icons, assignee, timestamps
7. Create `src/ui/repl-solid/tools/agent.tsx` — subagent tool chip renderer with phase tracking
8. Wire `/agents` slash command and Ctrl+A to dispatch `set-view: "agents"`; `/tasks` and Ctrl+T to `set-view: "tasks"`; Esc to `set-view: "transcript"`
9. In app.tsx, render active view: `<Show>` switches between Transcript, AgentTree, TaskBoard based on `state.activeView`
10. Bridge SwarmHost events: orchestrator emits `agent_spawned`/`agent_status` NormalizedEvents when workers spawn/transition; `task_update` when task graph changes

> **Status (GitHub #15 — producer landed):** Steps 1–9 shipped with the original Phase 5 work, but step 10 (the producer) was never wired — the views were dead scaffolding because nothing in production emitted the three events. This is now implemented:
> - `src/swarm/swarm-view-events.ts` — `SwarmViewTranslator` maps `StandaloneHost` lane events (`worker_spawned` → `agent_spawned` + `task_update(active)`; `worker_lifecycle_changed`/child `tool_use_start`/`message_stop` → `agent_status` with live phase/tool/token metrics; `worker_exited` → `agent_status(done|failed)` + `task_update(done|failed)`). `subscribeSwarmViewEvents(host, sink)` wires it onto a live host; `StandaloneHost.onLaneEvent()` / `peekTaskTitle()` are the public seams.
> - `src/ui/repl-solid/merge-swarm-events.ts` — `mergeTurnWithSwarm()` interleaves the swarm projection into each REPL turn's engine-event stream (merged outside the memory observer). `runRepl` gained an optional `swarmEvents` source.
> - `src/cli/main.ts` (interactive path only) now constructs a `StandaloneHost`, threads it as `RunConfig.host` (so the `agent`/`task_*` Tier 2 tools resolve a host), and passes `swarmEvents`. So `npx openswarm` → prompt that spawns sub-agents populates AgentTree (Ctrl+A) / TaskBoard (Ctrl+T) live.
> - **Deferred:** a dedicated "REPL attaches to an already-running detached team/daemon" UX, cross-turn persistence of long-lived members, and `task_*` lane-event emission from the default spawn path (task lifecycle is currently synthesized from worker lifecycle).

**Tests:**
- **store.test.ts** (vitest): dispatch `agent-spawned` → assert agent record created; dispatch `agent-status` with phase change → assert updated; dispatch `task-update` → assert task record; dispatch `set-view` → assert `activeView` changes; Esc dispatches `set-view: "transcript"`
- **views/agent-tree.test.tsx** (bun:test): mount with mock agent hierarchy (parent → 3 children), assert tree structure renders with correct phase badges (✓/↻/◌); test j/k navigation updates selected index
- **views/task-board.test.tsx** (bun:test): mount with mock tasks in various states, assert status icons (✓/↻/◌) and assignee names render correctly
- **tools/agent.test.tsx** (bun:test): mount agent tool chip, assert phase transitions render (spawning → running → done with elapsed time)
- **e2e.test.tsx**: push `agent_spawned` + `agent_status` events, dispatch Ctrl+A, assert agent tree view renders; Esc returns to transcript

### Phase 6: Input Enhancements

**Goal:** File mentions and plan mode.

**Implementation:**
1. Create `src/ui/repl-solid/file-mention.ts` — `getFileCandidates(prefix)` backed by `git ls-files` (cached, debounced); returns `{path, relativePath}[]`
2. Extend dropdown.tsx to support `mode: "slash" | "mention"` — slash mode filters by `/` prefix, mention mode filters by `@` prefix
3. In app.tsx, detect `@` trigger in input value and switch dropdown to mention mode with file candidates
4. On mention accept, insert file path into input buffer and track mentioned files in state for prompt attachment
5. Add `planMode` boolean to `ReplState`; `Shift+Tab` toggles it
6. When `planMode` is true, prepend plan-mode instruction to system prompt via engine config
7. Create plan display component: bordered box in transcript showing agent's plan with approve/reject keybinds

**Tests:**
- **file-mention.test.ts** (vitest): mock `git ls-files` output, assert `getFileCandidates("src/m")` returns matching files; empty prefix returns all; no git repo returns empty
- **input.test.tsx** (bun:test): extend existing tests — type `@`, assert dropdown appears with file candidates; type `/`, assert slash commands; test mode switching between the two
- **store.test.ts** (vitest): dispatch `toggle-plan-mode` → assert `planMode` flips; mentioned files tracked in state
- **e2e.test.tsx**: type `@src/m` in input, assert file completion dropdown appears with matching files; select one, assert path inserted

### Verification protocol

After each phase:
1. Run `bun test src/ui/repl-solid/` — all component and e2e tests pass
2. Run `vitest run src/ui/repl-solid/store.test.ts` — reducer tests pass
3. Run any new phase-specific test files
4. Run `bun run typecheck:ui` — no type errors introduced
5. Commit with descriptive message referencing the phase
