# G2 Memory System Design

## Status: Implemented — all 5 phases complete

## Overview

A 4-layer memory architecture for openswarm that uses **minimem** as the
core storage/retrieval engine and a **Hermes-style provider protocol** for
extensibility. The design lets agents accumulate, curate, and recall knowledge
across sessions while keeping the system pluggable enough to swap or layer
external memory backends.

### Design goals

1. **Immediate value** — curated bounded memory (Layer 1) can ship with zero
   external dependencies and already improves multi-session coherence.
2. **minimem as the default engine** — hybrid vector + BM25 search, knowledge
   graph, and MCP server from the swarmkit ecosystem.
3. **Provider protocol** — any external memory system (Mem0, Hindsight,
   Holographic, etc.) plugs in via a small interface with lifecycle hooks.
4. **Per-agent isolation** — each agent in a swarm gets its own memory scope
   with optional shared-memory publication.
5. **No magic** — the agent decides what to remember (agent-curated), not an
   opaque extraction pipeline.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Agent Turn Loop                       │
│                                                         │
│  ┌──────────┐  enrich   ┌─────────────────────────────┐ │
│  │  Context  │◄─────────│     Memory Coordinator      │ │
│  │  Builder  │          │                             │ │
│  └──────────┘          │  ┌─────┐ ┌─────┐ ┌───────┐ │ │
│                         │  │ L1  │ │ L2  │ │ L3/L4 │ │ │
│                         │  │Crtd │ │Skls │ │Provs  │ │ │
│                         │  └──┬──┘ └──┬──┘ └───┬───┘ │ │
│                         └─────┼───────┼────────┼─────┘ │
│                               │       │        │       │
│  ┌────────────────────────────▼───────▼────────▼─────┐ │
│  │               MemoryProvider[]                     │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐          │ │
│  │  │ minimem  │ │ file-    │ │ external │          │ │
│  │  │ provider │ │ provider │ │ provider │  ...     │ │
│  │  └──────────┘ └──────────┘ └──────────┘          │ │
│  └───────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

---

## Layer 1: Curated Bounded Memory

**Inspiration:** Hermes `MEMORY.md` / `USER.md`

A small, agent-managed document injected at the top of every system prompt.
The agent decides what belongs here via explicit memory actions. A hard size
cap forces prioritization — stale entries get pruned, related facts get
consolidated.

### Storage

Two scopes, each stored as a single text blob:

| Scope       | Key               | Max size  | Persists across |
|-------------|-------------------|-----------|-----------------|
| **Project** | `project:<root>`  | 2,500 chars | Sessions in same repo/project |
| **User**    | `user:<identity>` | 1,500 chars | All sessions for this user |

Backed by the existing `StateDB` — new table `curated_memory`:

```sql
CREATE TABLE curated_memory (
  scope_key  TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Agent interface

The agent interacts with curated memory through a **Tier 0 tool**
(`memory_manage`) that supports three actions:

```typescript
interface MemoryManageInput {
  action: "add" | "replace" | "remove";
  scope: "project" | "user";
  entry: string;              // for add: new entry text
  index?: number;             // for replace/remove: 1-based entry index
  replacement?: string;       // for replace: new text
}
```

Entries are numbered lines. The tool returns the updated memory with line
numbers so the agent can reference them in future actions.

### Context injection

A new `ContextFragment` registered at **priority 5** (before environment at 10)
so it appears first in the system prompt:

```typescript
const memoryFragment: ContextFragment = {
  id: "curated-memory",
  priority: 5,
  generate(state) {
    const project = getCuratedMemory(`project:${state.projectRoot}`);
    const user = getCuratedMemory(`user:${state.userId}`);
    if (!project && !user) return null;
    const sections: string[] = [];
    if (user) sections.push(`## User Memory\n${user}`);
    if (project) sections.push(`## Project Memory\n${project}`);
    return sections.join("\n\n");
  },
};
```

### Self-improvement loop

Every N turns (configurable, default 15), the system prompts the agent with:

> Review your curated memory. Remove entries that are no longer relevant,
> consolidate duplicates, and add anything important you learned in recent
> turns.

This keeps memory fresh without an external extraction pipeline.

---

## Layer 2: Skills (Procedural Memory)

**Inspiration:** Hermes skills directory

Skills capture reusable procedures — "how to deploy," "how to run tests for
module X," "the team's PR conventions." They differ from Layer 1 facts in that
they represent **processes**, not declarations.

### Storage

Skills are files in a `skills/` directory within the project or a shared
config location:

```
~/.openswarm/skills/
  deploy-staging.md
  run-integration-tests.md
  pr-review-checklist.md
```

Each skill is a short Markdown file (< 1,000 chars) with YAML frontmatter:

```markdown
---
name: deploy-staging
tags: [deploy, staging, ci]
created: 2026-06-01
---
1. Ensure all tests pass on the branch.
2. Run `make build-staging`.
3. Push to the `staging` branch — CI auto-deploys.
4. Verify at https://staging.example.com/health.
```

### Retrieval

Skills are retrieved by tag matching or keyword search against the frontmatter
and body. The `MemoryCoordinator` queries skills at `enrich_turn` time and
injects relevant ones as context fragments.

For the initial implementation, retrieval uses simple keyword overlap. When
minimem is integrated, skills can be indexed as documents for hybrid search.

### Agent interface

The agent can create and update skills via a `skill_save` tool (Tier 0):

```typescript
interface SkillSaveInput {
  name: string;          // kebab-case identifier
  tags: string[];        // searchable tags
  content: string;       // Markdown body (the procedure)
}
```

---

## Layer 3: Session Archive

**Inspiration:** Hermes SQLite session archive with FTS5

Completed sessions are archived for long-term recall. The existing `StateDB`
already stores `SessionRecord` and `MemoryRecord` — this layer adds
structured archival and search.

### What gets archived

At session end (via the existing `SessionEnd` hook event):

1. **Session summary** — a short description of what happened (generated by
   the agent or extracted from the final turn).
2. **Key decisions** — any `MemoryRecord` entries created during the session.
3. **Tool usage profile** — which tools were used and how often (from
   `AuditRecord`).
4. **Goal outcomes** — final status of all `GoalRecord` entries.

### Storage

Extends the existing `memories` table with a `session_archive` view or adds a
new `session_summaries` table:

```sql
CREATE TABLE session_summaries (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  summary    TEXT NOT NULL,
  tags       TEXT,            -- JSON array of tags
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE session_summaries_fts USING fts5(
  summary, tags, content=session_summaries, content_rowid=rowid
);
```

### Query interface

A `memory_search` tool (Tier 0) lets the agent query past sessions:

```typescript
interface MemorySearchInput {
  query: string;         // natural-language search
  scope?: "sessions" | "memories" | "all";
  limit?: number;        // default 5
}
```

When minimem is the active provider, queries route through its hybrid
vector + BM25 search for better relevance. Without minimem, queries fall
back to SQLite FTS5.

---

## Layer 4: Provider Protocol

**Inspiration:** Hermes `MemoryProvider` with lifecycle hooks

A pluggable interface that lets external memory systems participate in the
agent's memory lifecycle. Multiple providers can run simultaneously — each
handles the hooks it cares about.

### Interface

```typescript
interface MemoryCapabilities {
  readonly enrichment: boolean;     // can inject context at turn start
  readonly persistence: boolean;    // stores memories durably
  readonly search: boolean;         // supports query-based retrieval
  readonly graph: boolean;          // supports relationship/graph queries
}

interface MemoryProvider {
  readonly name: string;
  readonly capabilities: MemoryCapabilities;

  // Lifecycle
  initialize(config: ProviderConfig): Promise<void>;
  shutdown(): Promise<void>;
  isAvailable(): Promise<boolean>;

  // Hook points
  enrichTurn(context: TurnContext): Promise<MemoryFragment[]>;
  onMemoryWrite(entry: MemoryEntry): Promise<void>;
  onTurnComplete(turn: CompletedTurn): Promise<void>;
  onCompress(summary: CompressionSummary): Promise<void>;
}
```

### Hook points explained

| Hook | When | Purpose | Example |
|------|------|---------|---------|
| `enrichTurn` | Before each agent turn | Retrieve relevant memories and inject as context | minimem returns top-5 semantically similar past entries |
| `onMemoryWrite` | Agent saves a memory (any layer) | Sync/index the entry in external store | Mem0 stores the memory in its cloud |
| `onTurnComplete` | After each turn finishes | Extract learnings, update indices | minimem indexes the turn's tool results |
| `onCompress` | Context window is compacted | Preserve important info before summary | Provider extracts key facts before they're compressed away |

### MemoryCoordinator

The coordinator manages the provider lifecycle and fans out hooks:

```typescript
class MemoryCoordinator {
  private providers: MemoryProvider[] = [];

  register(provider: MemoryProvider): void;
  unregister(name: string): void;

  // Called by the engine at the right lifecycle points
  async enrichTurn(context: TurnContext): Promise<MemoryFragment[]>;
  async onMemoryWrite(entry: MemoryEntry): Promise<void>;
  async onTurnComplete(turn: CompletedTurn): Promise<void>;
  async onCompress(summary: CompressionSummary): Promise<void>;
}
```

Fan-out rules:
- `enrichTurn` — all providers called in parallel, results merged and
  deduplicated by content hash.
- `onMemoryWrite` / `onTurnComplete` / `onCompress` — all providers called in
  parallel, errors logged but don't fail the turn (fire-and-forget with error
  capture).

### Built-in providers

#### FileProvider (Layer 1 + 2)

Handles curated memory and skills using the filesystem and StateDB. Always
active — no external dependencies.

```typescript
class FileMemoryProvider implements MemoryProvider {
  name = "file";
  capabilities = { enrichment: true, persistence: true, search: false, graph: false };

  async enrichTurn(ctx) {
    // Returns curated memory + matching skills as fragments
  }

  async onMemoryWrite(entry) {
    // Writes to curated_memory table or skills directory
  }
}
```

#### MinimemProvider (Layer 3 + 4)

Wraps the minimem package for hybrid search, knowledge graph, and vector
embeddings.

```typescript
class MinimemProvider implements MemoryProvider {
  name = "minimem";
  capabilities = { enrichment: true, persistence: true, search: true, graph: true };

  async enrichTurn(ctx) {
    // Hybrid vector + BM25 search against the turn's context
  }

  async onTurnComplete(turn) {
    // Index completed turn's content and decisions
  }

  async onCompress(summary) {
    // Store pre-compaction knowledge in the graph
  }
}
```

#### External providers (future)

Each external system (Mem0, Hindsight, etc.) gets a thin adapter implementing
`MemoryProvider`. Configuration via environment variables or
`~/.openswarm/config.json`:

```json
{
  "memory": {
    "providers": [
      { "name": "minimem", "enabled": true },
      { "name": "mem0", "enabled": true, "apiKey": "${MEM0_API_KEY}" }
    ]
  }
}
```

---

## Per-Agent Isolation

In multi-agent (swarm) scenarios, each agent gets its own memory scope:

```typescript
interface AgentMemoryScope {
  readonly agentId: AgentId;
  readonly curatedMemory: string;       // agent's own Layer 1
  readonly sharedMemory?: string;       // read-only view of shared entries
}
```

### Isolation model

- **Curated memory (L1):** Each agent has its own project-scoped entries,
  keyed by `project:<root>:agent:<agentId>`. The orchestrator agent's memory
  is separate from worker agents'.
- **Skills (L2):** Shared across agents in the same project — skills are
  project knowledge, not agent-specific.
- **Session archive (L3):** Scoped by `agentId` in the `session_summaries`
  table, but cross-agent search is supported.
- **Providers (L4):** Each agent gets its own `MemoryCoordinator` instance
  with the same providers, but queries are scoped by agent identity.

### Shared memory bus

Agents can publish facts to a shared scope visible to all agents in the swarm:

```typescript
interface SharedMemoryEntry {
  readonly publishedBy: AgentId;
  readonly content: string;
  readonly tags: string[];
  readonly timestamp: string;
}
```

The orchestrator can subscribe to shared memory events for coordination:
"Agent-backend discovered the DB schema changed" becomes visible to
Agent-frontend without explicit message passing.

---

## Integration Points

### Engine integration

The `MemoryCoordinator` hooks into the engine's turn loop at four points:

```
SessionStart
  │
  ├─► MemoryCoordinator.initialize()
  │     └─► All providers: initialize()
  │
  ▼
Turn N
  │
  ├─► MemoryCoordinator.enrichTurn(turnContext)
  │     └─► All providers: enrichTurn() → MemoryFragment[]
  │     └─► Fragments injected via ContextBuilder
  │
  ├─► Agent executes (tool calls, reasoning)
  │     └─► memory_manage tool → MemoryCoordinator.onMemoryWrite()
  │
  ├─► MemoryCoordinator.onTurnComplete(completedTurn)
  │     └─► All providers: onTurnComplete()
  │
  ▼
Compaction event
  │
  ├─► MemoryCoordinator.onCompress(summary)
  │     └─► All providers: onCompress()
  │
  ▼
SessionEnd
  │
  └─► MemoryCoordinator.shutdown()
        └─► All providers: shutdown()
        └─► Archive session summary (Layer 3)
```

### Hook system integration

New hook events for observability (not control flow):

```typescript
type HookEvent =
  | ... // existing events
  | "MemoryEnriched"      // after enrichTurn completes
  | "MemoryWritten"       // after a memory_manage action
  | "SessionArchived";    // after session summary is stored
```

### ContextState extension

```typescript
interface ContextState {
  // ... existing fields
  readonly projectRoot?: string;    // for Layer 1 scoping
  readonly userId?: string;         // for user-scoped memory
  readonly agentId?: AgentId;       // for per-agent isolation
}
```

---

## New Modules

```
src/memory/
  coordinator.ts          # MemoryCoordinator class
  types.ts                # MemoryProvider, MemoryFragment, etc.
  providers/
    file-provider.ts      # Layer 1 + 2 (curated + skills)
    minimem-provider.ts   # Layer 3 + 4 (search + graph)
  curated.ts              # Curated memory CRUD (Layer 1)
  skills.ts               # Skills read/write (Layer 2)
  archive.ts              # Session archive (Layer 3)

src/tools/tier0/
  memory-manage.ts        # memory_manage tool (Layer 1 actions)
  memory-search.ts        # memory_search tool (Layer 3 queries)
  skill-save.ts           # skill_save tool (Layer 2)
```

---

## Implementation Phases

### Phase 1: Curated Memory (Layer 1)

Minimal viable memory. No external dependencies.

1. `curated_memory` table in StateDB (migration)
2. `memory_manage` tool (Tier 0)
3. `curated-memory` context fragment (priority 5)
4. Wire fragment into `ContextBuilder.withDefaults()`
5. Wire `ContextBuilder` into engine's `buildSystemPrompt()`

**Deliverable:** Agent can add/replace/remove memory entries that persist
across sessions and appear in every system prompt.

### Phase 2: Session Archive (Layer 3)

Long-term recall without minimem.

1. `session_summaries` table + FTS5 (migration)
2. Archive logic in `SessionEnd` hook
3. `memory_search` tool (Tier 0) with FTS5 backend
4. Summary generation prompt

**Deliverable:** Agent can search past sessions by keyword.

### Phase 3: Provider Protocol (Layer 4)

Extensibility layer.

1. `MemoryProvider` interface + `MemoryCoordinator`
2. `FileMemoryProvider` wrapping Phase 1 + 2
3. Engine integration (4 hook points in turn loop)
4. Configuration loading from config file / env vars
5. Hook events for observability

**Deliverable:** Memory system is pluggable. FileProvider is the default.

### Phase 4: minimem Integration

Full hybrid search and knowledge graph.

1. `minimem` as optional dependency
2. `MinimemProvider` implementing the protocol
3. Embedding configuration (OpenAI / local llama.cpp)
4. Turn indexing in `onTurnComplete`
5. Semantic retrieval in `enrichTurn`
6. Knowledge graph queries exposed through `memory_search`

**Deliverable:** Agents get semantic recall and relationship-aware memory.

### Phase 5: Skills + Per-Agent Isolation

Multi-agent memory.

1. Skills directory + `skill_save` tool
2. Skill retrieval in `FileMemoryProvider.enrichTurn()`
3. Agent-scoped memory keys
4. Shared memory bus
5. Self-improvement loop (every N turns)

**Deliverable:** Full 4-layer system with swarm support.

---

## Configuration

```jsonc
// ~/.openswarm/config.json
{
  "memory": {
    "enabled": true,
    "curatedMemory": {
      "projectMaxChars": 2500,
      "userMaxChars": 1500
    },
    "selfImprovementInterval": 15,   // turns between self-review
    "skills": {
      "directory": "~/.openswarm/skills"
    },
    "providers": [
      {
        "name": "minimem",
        "enabled": true,
        "config": {
          "embedding": "openai",
          "storePath": "~/.openswarm/minimem-store"
        }
      }
    ]
  }
}
```

Environment variable overrides:

| Variable | Purpose |
|----------|---------|
| `SWARM_MEMORY_ENABLED` | Enable/disable memory system (`true`/`false`) |
| `SWARM_MEMORY_PROVIDERS` | Comma-separated provider names to enable |
| `MINIMEM_EMBEDDING_PROVIDER` | Embedding backend for minimem |
| `MINIMEM_STORE_PATH` | Storage path for minimem data |

---

## Security Considerations

1. **Memory sanitization** — all content written to memory passes through
   sanitization to prevent prompt injection across sessions. A malicious input
   in session N must not be able to plant instructions that execute in
   session N+1.
2. **Scope boundaries** — agent-scoped memory is strictly isolated. An agent
   cannot read another agent's curated memory without going through the shared
   memory bus.
3. **Provider trust** — external providers receive memory content. The
   configuration should clearly indicate which providers are cloud-hosted vs.
   local-only for data sensitivity decisions.
4. **Size limits** — hard caps on curated memory prevent unbounded context
   growth. Skills have per-file and total size limits.

---

## Resolved Questions

1. **Embedding provider default** — **Local by default** (llama.cpp / ONNX).
   OpenAI opt-in via `MINIMEM_EMBEDDING_PROVIDER=openai`. If no embedding
   model is configured at all, the system degrades gracefully — falls back to
   BM25-only search (no vectors), then to SQLite FTS5, then to substring
   matching. Memory never fails because embeddings are unavailable.

2. **Self-improvement trigger** — **Session end only** for the initial
   implementation. Mid-session triggers (every N turns) can be added later
   once we see how session-end-only works in practice. Mid-session reflection
   interrupts the user's task flow.

3. **Shared memory visibility** — **All agents see all entries** with
   tag-based filtering. No orchestrator bottleneck. Agents publish with tags
   (e.g., `["schema-change", "backend"]`); each agent's `enrichTurn` filters
   by relevance. Orchestrator can use `["broadcast"]` tag for high-priority
   entries.

4. **Memory tools tier** — **All Tier 0** (`memory_manage`, `memory_search`,
   `skill_save`). Memory is a core agent capability, not optional. Network
   permission for cloud embeddings is checked inside the provider, not at the
   tool tier level.

5. **ContextBuilder integration timing** — **Wire in during Phase 1**. It's a
   hard dependency for memory injection, not a "nice to have" prerequisite.
   The ContextBuilder is fully implemented but not connected to any engine.
