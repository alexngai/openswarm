# Experimental Backlog

Catalogue of features that were built but never wired into a live path, then
archived here during the Jul 2026 remediation pass (see
`openswarm-remediation-plan.md`, Phase 3). Everything in this directory:

- is **excluded from the shipped build** (`tsconfig.build.json` only includes
  `src/**`),
- **may import from `../src`**, but `src/` must never import from
  `experimental/`,
- stays **type-checked in CI** (`npx tsc -p experimental/tsconfig.json`) and
  its **tests keep running** under the normal vitest suite, so any module here
  can be revived without archaeology.

To revive a feature: move the files back under `src/` (imports were only
adjusted mechanically, so the reverse move is mechanical too), re-add any
barrel exports noted below, and wire the entry point described in each entry.

## Archived modules

### `context/` — ContextBuilder (`context/index.ts`)
- **What:** Assembles per-turn agent context (system prompt sections, curated
  memory fragment, exec-policy summary) into a structured prompt.
- **Why archived:** No live caller ever invoked `ContextBuilder`; the engine
  builds its prompt directly. Was also one half of the
  `context ↔ memory/fragment` circular dependency.
- **Revival:** Wire into the engine's prompt-assembly path; re-export from a
  barrel if desired. Moves together with `memory/fragment.ts`.

### `memory/fragment.ts` — curated memory fragment
- **What:** `curatedMemoryFragment` renders curated memory into a prompt
  fragment for ContextBuilder.
- **Why archived:** Only consumer was the archived ContextBuilder. Its
  re-export was removed from `src/memory/index.ts`.
- **Revival:** Restore alongside `context/`; re-add the `src/memory/index.ts`
  export.

### `memory/agent-scope.ts` — shared agent-scoped memory
- **What:** In-process publish/subscribe store for sharing memory entries
  between agents in a swarm (`publishSharedMemory` / `getSharedMemory` /
  `formatSharedMemory`).
- **Why archived:** Exported from `src/memory/index.ts` but no live code ever
  published or read entries.
- **Revival:** Re-add the barrel export and call `publishSharedMemory` from
  the swarm host when agents produce shareable facts.

### `memory/state-store.ts` — StateDB-backed memory stores
- **What:** `StateDBCuratedStore` / `StateDBArchiveStore` adapt the SQLite
  StateDB to the `CuratedMemoryStore` / `ArchiveStore` interfaces.
- **Why archived:** The live defaults are the file-based curated store and the
  in-memory archive store; nothing ever selected the StateDB variants.
  Archive persistence is planned to go through minimem instead (Phase 3 B2).
- **Revival:** Re-add the barrel export and select these stores where the
  memory coordinator is assembled.

### `core/goal.ts` — Goal / GoalRegistry state machine
- **What:** In-memory goal lifecycle (`active → paused/blocked/... →
  complete`) with budget tracking, checkpoints, and serialization
  (`GoalRecordData`).
- **Why archived:** Nothing constructed a `Goal` or consulted the registry.
  The parallel StateDB persistence (goals table DDL + `createGoal`/`getGoal`/
  `updateGoal`/`listGoals` CRUD and the `GoalRecord`/`GoalStatus` types) was
  removed from `src/state/index.ts` in the same pass — restore from git
  history or write a fresh migration if goals come back.
- **Revival:** Decide where goals attach (session? task?), wire registry
  updates into the turn loop, and add a persistence migration.

### `swarm/git/stale-branch.ts` — stale-branch freshness policy
- **What:** Detects stale/diverged agent branches and maps freshness × policy
  (`AutoRebase`/`AutoMergeForward`/`WarnOnly`/`Block`) to an action intent
  (`applyPolicy`).
- **Why archived:** Never called from the live git cascade. The
  `scripts/smoke-m3b.sh` O3 check that imported it from `dist/` now records a
  skip.
- **Revival:** Call the freshness check from the worktree/landing flow before
  merging agent branches.

### `tools/tier0/guardian.ts` — guardian pre-execution review
- **What:** Heuristic "guardian" gate that scores risky tool calls before
  execution.
- **Why archived:** Not registered in `buildTier0Tools()` and no dispatcher
  hook invoked it.
- **Revival:** Invoke from the permission gate (`src/permissions/gate.ts`)
  as an additional reviewer before allow/deny.

### `tools/tier0/network-proxy.ts` — network proxy enforcement
- **What:** Local HTTP(S) proxy scaffold intended to enforce
  `network-policy.ts` rules at the transport level.
- **Why archived:** The live enforcement path uses `network-policy.ts`
  directly (which stays in `src/`); the proxy was never started anywhere.
- **Revival:** Start the proxy in sandboxed exec flows and point subprocess
  env (`HTTP_PROXY`/`HTTPS_PROXY`) at it.

### `tools/tier0/exec-policy.ts` — exec policy summary
- **What:** `getExecPolicy` renders a summary of the exec approval policy for
  inclusion in agent context.
- **Why archived:** Only consumers were the archived ContextBuilder and
  ApprovalPolicy.
- **Revival:** Restore together with whichever consumer comes back. Note the
  live banned-broad-prefix work (Phase 3 B4) lives in
  `src/tools/tier0/banned-prefixes.ts`, not here.

### `tools/tier1/mention-syntax.ts` — @-mention parsing
- **What:** Parses `@file` / `@agent` mention syntax out of prompts into
  structured references.
- **Why archived:** No REPL or engine path called the parser.
- **Revival:** Call from REPL input processing before prompt submission.

### `tools/tier1/image-gen-instructions.ts` — image-generation guidance
- **What:** Prompt-fragment builder with instructions for image-generation
  tool use.
- **Why archived:** No tool or prompt assembler referenced it.
- **Revival:** Attach to the system prompt when an image-generation tool is
  registered.

### `permissions/approval-policy.ts` — ApprovalPolicy
- **What:** Codex-style approval policy object (`untrusted`/`on-failure`/
  `on-request`/`never`) mapping tool calls to approval decisions.
- **Why archived:** The live gate (`src/permissions/gate.ts`) implements its
  own allow/ask/deny flow; nothing constructed an `ApprovalPolicy`.
- **Revival:** Either adapt the gate to consult an `ApprovalPolicy`, or fold
  the useful policy names into the gate's config surface.

### `providers/quirks.ts` — centralized model-family quirks
- **What:** Table-driven per-model-family request quirks (temperature
  stripping, `max_completion_tokens` renames, etc.).
- **Why archived:** The live transports apply quirks locally (e.g.
  `openai-quirks.ts`); this centralized registry was a parallel system with
  no importers. `scripts/smoke-m4b.sh` O7 now runs its test from
  `experimental/`.
- **Revival:** Replace the per-transport quirk code with lookups into this
  table — do it transport-by-transport to avoid regressions.

### `providers/retrying-provider.ts` — RetryingProvider decorator
- **What:** Provider wrapper adding retry-with-backoff around `chat()`.
- **Why archived:** Transports implement their own retry loops; the decorator
  was never applied at provider construction.
- **Revival:** Apply in the provider factory (`routing.ts`) and delete the
  per-transport retry code it supersedes.

## Deleted outright (not archived — recover from git history)

- **`inbox()` async iterator** — removed from the `SwarmHost` interface, both
  host implementations, the tier2 fake host, and the now-unused `InboxEvent`
  type (`src/swarm/host.ts`). Both implementations were empty generators; the
  live path is `drainInbox()` + `sub_agent_event` IPC delivery.
- **`sub_agent_result` IPC notification** — removed from
  `src/swarm/ipc/protocol.ts`. Stub-only method name; no sender or handler
  ever existed. Extend `sub_agent_event`'s `eventKind` instead if
  orchestrator→worker results are needed.
- **`src/host/index.ts` barrel** — removed; nothing imported it. The host
  modules themselves (`boot.ts`, `health.ts`, map-* etc.) are all live and
  imported directly.
- **StateDB goal persistence** — `goals` table DDL, goal CRUD, and
  `GoalRecord`/`GoalStatus` types removed from `src/state/index.ts`, along
  with the unused `getStateDB`/`setStateDB`/`resetStateDB` singleton.
- **`createStubSlashRegistry`** — moved out of `src/ui/repl/state.ts` into
  its only consumer, `state.test.ts`.

## Explicitly NOT archived

- **`src/tools/tier0/secrets.ts`** — the audit initially flagged it as
  stranded, but `redactSecrets` is live via `output-cleanse.ts` (bash/shell
  output redaction), and `detectSecrets`/`containsSecrets` are its engine.
  The module stays in `src/`.
- **`src/tools/tier0/network-policy.ts`** — live policy checks; only the
  proxy enforcement scaffold moved here.
- **`src/tools/tier0/banned-prefixes.ts`** — staying in `src/`; being wired
  in Phase 3 B4.

## Proposed (not yet built)

Unlike the archived modules above (built then shelved), these are scoped ideas
with no code yet. Captured here so the design isn't lost. Build under
`experimental/` first (type-checked + tested, out of the shipped surface),
then follow the revival path into `src/`.

### `tools/tier0/lsp-diagnostics` — read-only LSP diagnostics enrichment
- **What:** A `lsp_diagnostics` tier-0 tool (`{ path, waitMs? }` →
  formatted diagnostics) giving agents a type-aware "did my edit break
  anything?" signal that ripgrep/bash can't. **Diagnostics only** — no
  definition/hover/rename/completion in phase 1.
- **Why (value):** Highest-leverage open item from the MiMoCode checklist (#4):
  N agents in parallel worktrees currently only discover cross-file breakage at
  build/test; per-edit diagnostics compound across the swarm and raise
  merge-queue quality. Most of the value is in diagnostics + (later)
  definition/references; hover/completion are low-value for agents.
- **Sketch:**
  - `lsp-client.ts` — minimal JSON-RPC-over-stdio client: `Content-Length`
    framing, `initialize`/`initialized`, per-call
    `textDocument/didOpen` → collect `publishDiagnostics` until quiescent or
    `waitMs` → `didClose`. No incremental `didChange` (agents call after a
    write, so open-fresh is correct + simpler).
  - `lsp-server-registry.ts` — extension→server map; phase 1
    `.ts/.tsx/.js/.jsx → typescript-language-server --stdio`. Discovery via
    `node_modules/.bin` then PATH.
  - Server **pool** keyed by `(rootUri, languageId)`: lazy-spawn, reuse,
    idle-timeout + LRU shutdown, re-spawn on crash. Per-worktree `rootUri` so
    each parallel agent gets its own instance.
  - Tool: `requiredPermission: "none"`, `concurrencySafe: true`. Server
    absent/timeout → `status:"ok"` + "diagnostics unavailable" (a missing
    server is not an agent-actionable failure, so never `error`).
- **Gating:** `OPENSWARM_LSP_DIAGNOSTICS=1` opt-in; fully degradable.
- **Bun note:** spawning an external node-based server from the `bun --compile`
  binary is fine (child process, not an embedded native addon — unlike
  better-sqlite3); only requires the server installed on the host.
- **Testing:** mock stdio server fixture (canned `publishDiagnostics`) for
  deterministic unit tests; optional live smoke gated on
  `typescript-language-server` being installed.
- **Revival:** move to `src/tools/tier0/`, register in `buildTier0Tools()`
  (keep env-gated), add live smoke. Later, separate work: automatic post-edit
  enrichment (engine hook after `edit_file`/`apply_patch`) and
  `lsp_definition`/`lsp_references` for cross-file navigation.
- **Cheaper alternative if this proves too heavy:** a `typecheck` tool running
  `tsc --noEmit` scoped to a worktree — ~80% of the diagnostics value, no
  stateful client/pool, but no cross-file navigation.
