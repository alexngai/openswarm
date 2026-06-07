# 41 — TUI Redesign: Progressive-Disclosure Terminal Interface

## 1. Motivation

swarm-harness's current TUI is a functional single-agent REPL: streaming markdown, Emacs keybindings, slash commands, a braille spinner, and a y/N permission prompt. It is roughly 6 components and ~1,000 lines of UI code.

This is adequate for simple sessions but falls short in three areas:

1. **Tool call visibility** — Tool calls render as one-line summaries (`[read_file] — ok: src/index.ts`). There is no diff preview, no bash output display, no expand/collapse. Users cannot see what the agent actually did without reading raw JSON.

2. **Multi-agent awareness** — During swarm runs (fanout, pipeline, peer-team, coordinator), there is no visibility into worker agents, their status, or their individual tool activity. The TUI was designed for single-agent interaction.

3. **Approval UX** — The permission prompt shows raw JSON input truncated to 500 characters. For file edits and bash commands, this is nearly useless — users need to see a diff or the actual command being run.

### Reference implementations

- **Kimi Code** (MoonshotAI/kimi-code) — A TypeScript TUI built on `pi-tui` that achieves feature-richness through progressive disclosure: single-column layout, one-line tool chips that expand on demand, smart grouping of related calls, compact diff previews. The design philosophy is "scannable at a glance, drill down when needed."

- **OpenSwarm** (alexngai/openswarm) — A Solid.js + OpenTUI TUI built for multi-agent interaction. Has per-tool renderers, agent tree hierarchy, task boards, and a plugin system. Rich but complex — 44 components, 24 context providers, multi-panel layout.

- **Codex** (openai/codex) — A Rust/Ratatui TUI with approval overlays, unified diff rendering, session fork/resume, and streaming intelligence.

This design takes Kimi Code's interaction model (progressive disclosure, single column, smart defaults) and combines it with OpenSwarm's multi-agent capabilities (agent tree, task tracking), adapted to swarm-harness's existing engine and protocol.

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

Accessible via keybinds or slash commands, not always visible. These draw from OpenSwarm's component library but rendered in the single-column paradigm:

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

- Maps to swarm-harness task graph (`task_create`, `task_update` IPC)
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

### OpenSwarm component reuse

Specific components worth pulling from OpenSwarm (adapting from MAP/ACP protocol to NormalizedEvent):
- `agent-tree.tsx` / `agent-node.tsx` — hierarchical agent rendering (Phase 5)
- Tool renderer patterns from `tools/bash.tsx`, `tools/edit.tsx` — though these need adaptation from ACP stream format to NormalizedEvent tool results (Phase 1)

The bulk of the implementation is new code following Kimi Code patterns, not OpenSwarm transplants. OpenSwarm's value is primarily in the multi-agent views (Phase 5) and as a reference for the Solid.js + OpenTUI component patterns.

### What we intentionally skip

- **Multi-panel layout** — OpenSwarm's sidebar + main + details layout adds complexity without proportional value for the common case. If a user needs persistent agent visibility, the agent tree view (Ctrl+A) covers it.
- **Plugin system** — OpenSwarm's 10-extension-point plugin architecture is over-engineered for swarm-harness. Swarm-harness already has its own plugin and MCP systems.
- **View tabs** — OpenSwarm's 11 views (tasks, teams, topology, timeline, streams, environments, federation, settings, etc.) are macro-agent-specific. We add only 2 views (agents, tasks) that map to swarm-harness concepts.
