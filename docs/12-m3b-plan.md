# M3b Git Coordination + Performance + Niche Tools — Implementation Plan

**Status:** draft (rev 3)
**Owner:** alex
**Created:** 2026-04-20
**Prereq:** M3a complete (`3240a43`, 739 tests passing).
**Refines:** the six remaining items from §"Milestone M3 — orchestration depth + Claude Max subscription" in `docs/07-implementation-plan.md` that are not covered by `docs/11-m3a-plan.md`.

## Scope

M3a delivered the coordination primitives (messaging, policies, retry, roles). M3b builds on that foundation with git + perf + niche tools, picking up the six M3 items that are **valuable but structurally isolated** from messaging/roles:

1. **Git coordination** (`branch_lock`, `stale_base`, `stale_branch`): port `detect_branch_lock_collisions` (pure collision detection logic, ~100 LOC) near-verbatim from claw; BUILD a new atomic filesystem lock on top of it (not present in claw).
2. **Prompt caching** (Anthropic): declare cache boundary via SDK's `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` marker, fingerprint the prefix, and surface cache-delta analytics (cacheReadInputTokens is already threaded through Phase 5 of M2).
3. **Parallel tool execution** when `ProviderCapabilities.parallelToolUse === true` — dispatch concurrent `tool_use` blocks from the same turn via `Promise.all`, with per-tool permission gating before fan-out.
4. **`notebook_edit` tool** (Tier 1) — .ipynb JSON-preserving edits with schema validation.
5. **`ask_user_question`** routed through `SwarmHost` (never stdin-blocking from threads/headless — anti-pattern #8).
6. **Server-side token preflight** (`count_tokens`) with silent local-estimate fallback; surfaced via `/status`.

**In scope:**

- `src/swarm/git/branch-lock.ts` — ports `detect_branch_lock_collisions` (pure collision detection, ~100 LOC) near-verbatim from `references/claw-code/rust/crates/runtime/src/branch_lock.rs`; BUILDS a new atomic `.lock` file enforcer on top (acquire via `O_EXCL`, NFS-safe on acquire; stale-PID reclaim; release-on-crash via `finally`). The atomic lock is new design work not present in claw.
- `src/swarm/git/stale-base.ts` — compare HEAD to a declared base (flag or `.swarm-base` file), returns `Matches | Diverged | NoExpectedBase | NotAGitRepo`.
- `src/swarm/git/stale-branch.ts` — compare a branch against a main ref (`Fresh | Stale{commitsBehind, missingFixes} | Diverged{ahead, behind, missingFixes}`) + policy `apply` (`Noop | Warn | Block | Rebase | MergeForward`).
- Integration with `BranchPolicy`: when `kind === "reuse" | "create"`, orchestrator acquires a branch lock before dispatch and releases on task exit; `stale_base` is checked at acquire.
- `src/engine/prompt-cache.ts` — declare cache boundary; emit `cache_hit` / `cache_miss` lane events with token deltas; expose cumulative cache savings.
- `/cost` slash command extension — show cumulative `cacheReadInputTokens`, `cacheCreateInputTokens`, est. savings %.
- `src/tools/dispatcher.ts` parallel-batch path — when a turn emits N `tool_use` blocks and the engine reports `parallelToolUse: true`, dispatch concurrently via `Promise.all`; per-tool permission check fires before fan-out; per-tool context is isolated.
- `src/tools/tier1/notebook_edit.ts` — insert/replace/delete cell operations; JSON-preserving rewrite with kernelspec language detection; rejects non-`.ipynb` paths.
- `src/tools/tier2/ask_user_question.ts` — routes via `SwarmHost.askUser()`:
  - Standalone + TTY → ink modal prompt (short-timeout, user cancels → `{ status: "cancelled" }`).
  - Standalone + headless → `{ status: "error", message: "ask_user_question requires a TTY or orchestrator bridge" }`.
  - Worker mode → IPC notification `{ method: "ask_user_question", params: { question, options? } }` to orchestrator; orchestrator routes to its own `askUser()`; response returned over IPC.
- `src/engine/token-preflight.ts` — Anthropic `count_tokens` endpoint wrapper; silent fallback to `bytes/4 + 1` local estimate on failure; surfaced via `engine.countTokens(prompt, tools)`.
- `/status` slash command extension — show preflight token count + context-window utilization %.
- `scripts/smoke-m3b.sh` live + offline (≥3 live scenarios).

**Out of scope (explicit):**

- Tier 2 messaging (`send_message`, `check_inbox`, `task_stop`, `task_output`) — M3a.
- TaskPacket policy enums (discriminated unions) — M3a (M3b consumes them via `BranchPolicy`).
- Orchestrator retry / dead-letter — M3a.
- Team roles — M3a.
- `FrameworkProvider` / `ClaudeAgentSDKProvider` subscription auth — **already in place** via M0 `ClaudeAgentSdkEngine`; the FrameworkProvider concept only matters when `NativeEngine` arrives in M4, so M3b does not touch it.
- Per-worker git worktree isolation (i.e. `git worktree add` per task) — deferred to M4 bundled with `NativeEngine` parallelism.
- Automatic rebase / merge-forward execution on `stale_branch` — M3b emits intents only; callers choose to act (same as claw).
- Cross-provider prompt caching (xAI, OpenAI) — Anthropic only in M3b; other providers when their TransportProviders land in M4.
- LLM-driven compaction — still delegated to SDK; our compaction observer (M2 Phase 5) remains in place.
- Streaming `task_output` via AsyncIterable — deferred from M3a's open items; not part of M3b scope either. Revisit in M4.

## Decision context

Six scope/mechanism choices need locking before implementation starts. Default picks below; each has a one-line rationale.

1. **`notebook_edit` is Tier 1, not Tier 2.**
   Rationale: claw classifies it as user-facing productivity alongside `read_file` / `write_file` (workspace-write permission, single-user intent). Tier 2 is reserved for swarm/coordination primitives (`agent`, `task_*`, messaging). Placing `notebook_edit` in Tier 2 would conflate "productivity on notebook files" with "coordinate other agents" and would force it through `SwarmHost` for no reason. Ship as `src/tools/tier1/notebook_edit.ts`, required permission `"write"`.

2. **`ask_user_question` worker-mode IPC shape: notification + response.**
   Rationale: a request/response IPC call blocks the worker's tool execution until the orchestrator answers, which is exactly what `ask_user_question` semantically requires. Use the existing request/response protocol (`src/swarm/ipc/protocol.ts`) with a new `"ask_user_question"` method. Worker sends `{ method: "ask_user_question", params: { question, options? }, id }`; orchestrator's `WorkerTransport` dispatches to its own `SwarmHost.askUser()` (standalone host's TTY path); orchestrator replies `{ id, result: { answer, status } }`. Default timeout: 10 min (configurable via `SWARM_HARNESS_ASK_TIMEOUT_MS`). Timeout → `{ status: "timed-out" }` result (worker continues with a fallback).

3. **Prompt-cache boundary mechanism: SDK's `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` marker, not a per-block `cacheControl` field.**
   Rationale: The SDK (`@anthropic-ai/claude-agent-sdk` v0.2.x) does NOT expose a per-content-block `cacheControl` property. Inspection of `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (lines 1595–1640, 4958–4966) shows the public surface is: `systemPrompt: string | string[] | { type: "preset", preset: "claude_code", excludeDynamicSections?: boolean }`, and a marker constant `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` that splits a `string[]` systemPrompt into a cacheable prefix and a dynamic suffix. M3b uses this API exactly as documented — splitting `RunConfig.systemPrompt` at a boundary we place after the static system instructions + CLAUDE.md contents, before per-run context. Cross-check this doc claim at implementation time (the SDK version pinned in `package.json` is the source of truth).
   Alternative considered: reach into the underlying `Messages API` directly and attach `cache_control: { type: "ephemeral" }` to content blocks. Rejected: bypasses the SDK's query loop, requires reimplementing streaming, and conflicts with the `--framework claude-agent-sdk` mode the plan already uses. If the SDK version bumps and exposes a block-level `cacheControl`, we re-visit in M4.
   **SDK version pin (N1):** `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` export verified at `sdk.d.ts:4966` at commit `3b17fbd`. Pin SDK version in `package.json` at end of M3b so upgrades are intentional and the export can be re-verified.

4. **Parallel tool execution policy: per-tool permission check before fan-out, then `Promise.all`.**
   Rationale: `EngineCapabilities.parallelToolUse === true` is already set in `ClaudeAgentSdkEngine` (line 75 of `src/engine/claude-agent-sdk.ts`), but the dispatcher currently serializes tool calls via a `for await` loop (see `src/tools/dispatcher.ts`). The SDK itself may dispatch multiple `tool_use` blocks from one assistant turn; we accept them concurrently. Gating sequence: (a) for each `tool_use`, run the permission engine's `canUseTool` synchronously; (b) any deny short-circuits the ENTIRE batch with a `permission_denied` result for the denied tool AND does not start the others (prevents partial side-effects). Alternative "gate per-tool, allow siblings to proceed" was rejected — if one tool in a batch gets denied, the model's plan is already invalid and proceeding wastes turn budget.
   Race safety: each tool's `execute` gets its own `ToolContext` (new object per call, no shared mutable state). Verified by grep; the existing `ToolContext` is value-only (no shared refs). If a tool uses global state internally (e.g. `todo_write`'s in-memory list), that remains a tool-level concern.

5. **Branch lock granularity: per branch, not per module.**
   Rationale: claw's `detect_branch_lock_collisions` reports `(branch, module, laneIds)` tuples — module overlap is a *detection* signal for humans reviewing lane history, not an acquire-time gate. For M3b we gate on BRANCH only: two tasks that declare `branchPolicy: { kind: "reuse", branch: "feature/x" }` serialize on `.swarm-harness/branch-locks/feature-x.lock`. Module-level collision detection (port of `detect_branch_lock_collisions`) ships as a **read-only diagnostic** — `scripts/branch-lock-report` emits a JSON report — but does not enforce. Serializing on module would require a declared `modules:` field per TaskPacket which M3a did not ship; adding it now expands M3b scope for marginal gain. Revisit in M4 if two concurrent tasks on the same branch prove to be a real usage pattern.

6. **`count_tokens` failure policy: silent fallback, warn on repeated misses.**
   Rationale: claw's convention (research/01-api.md §8). If the first `count_tokens` call fails, fall back to local estimate and emit a single `preflight_degraded` lane event. If 3 consecutive preflights fail, emit `preflight_disabled` and cease calling for the rest of the session (cost-avoidance; preflight is best-effort). Re-enable on next session. Alternative "retry with backoff" rejected: preflight is cheap-failure — the local estimate is already the correctness path; `count_tokens` is a precision upgrade we skip gracefully.

**Policy shape assumed throughout M3b:** `BranchPolicy`, `CommitPolicy`, and `EscalationPolicy` are discriminated unions (M3a Phase 2 migrated all callers). No legacy flat-string handling is needed anywhere in M3b.

7. **M3b does NOT implement real handoff dispatch — keeps M3a's dead-letter shortcut.**
   Rationale: M3a's `EscalationPolicy.handoff` variant is wired but simplified — `orchestrator.handleHandoff()` always routes to dead-letter with `lastStatus: "handoff_not_supported"`. Real handoff (redispatch to `targetRole`) requires role-based scheduling, which is M4 territory. If M3b wants the feature, add a new Phase 9. Otherwise leave the simplified path as-is and defer to M4.

The plan below assumes all seven default picks; flip any before implementation starts if needed.

## Relationship to M3a

M3a is shipped (`3240a43`). M3a delivered the coordination primitives — messaging, policies (discriminated-union `BranchPolicy` / `CommitPolicy` / `EscalationPolicy`), retry, dead-letter, and team roles. M3b builds directly on that foundation with git coordination, performance, and niche tools.

Concrete integration points:

- **Phase 2 (git coord)** uses `BranchPolicy.kind` directly — `"reuse"` reads `.branch`; `"create"` reads `.from` and optional `.name`. No legacy enum handling needed; M3a Phase 2 already migrated all callers.
- **Phase 5 (`notebook_edit`)** composes with M3a's `ToolDispatcher.allowedTools` filter — reviewer role hides it automatically via the existing allowlist mechanism.
- **Phase 6 (`ask_user_question`)** uses M3a's IPC protocol extension pattern (same `IpcRequestMethod` union, same request/response framing).
- **`TaskRecord.owner`** is populated by `StandaloneHost.spawn` (post-audit fix in `3240a43`). Any M3b work referencing task ownership can rely on this invariant.

M3a's `EscalationPolicy.handoff` variant is wired but simplified: `orchestrator.handleHandoff()` always routes to dead-letter with `lastStatus: "handoff_not_supported"`. M3b leaves this as-is; real handoff dispatch defers to M4 (requires role-based scheduling).

## Acceptance criteria

Each is executable with a one-line test harness or manual smoke step.

1. `branch_lock.acquire("feature/x", { timeoutMs: 5000 })`: first caller succeeds (creates `.swarm-harness/branch-locks/feature-x.lock` atomically); second concurrent caller blocks; after first releases (via `finally`), second acquires; both eventually succeed.
2. Lock file format: JSON with `{ ownerAgentId, acquiredAt, pid, branch }`; on stale-lock detection (pid dead + age > 30s), forcibly reclaim with `lock_reclaimed` lane event. Otherwise timeout → reject.
3. Lock acquire uses `fs.open(path, 'wx')` (O_EXCL-equivalent in Node) — verified by unit test that tries to open twice with 'wx' and asserts `EEXIST` on second call.
4. `stale_base`: given cwd with committed HEAD `abc123` and a `.swarm-base` file containing `def456`, `check()` returns `{ kind: "diverged", expected: "def456", actual: "abc123" }`. When HEAD matches, returns `{ kind: "matches" }`. Non-git cwd returns `{ kind: "not-a-git-repo" }`. Missing `.swarm-base` and no `--base-commit` arg returns `{ kind: "no-expected-base" }`.
5. `stale_branch`: given a branch 3 commits behind `main` with 0 ahead and 2 of those commits having `[fix]`-ish subjects, returns `{ kind: "stale", commitsBehind: 3, missingFixes: ["...", "..."] }`. Ahead + behind → `{ kind: "diverged", ahead, behind, missingFixes }`. Same commit → `{ kind: "fresh" }`.
6. `stale_branch.applyPolicy("stale", "AutoRebase")` returns intent `{ kind: "Rebase" }`; `"Block"` returns `{ kind: "Block", reason }`; `"WarnOnly"` returns `{ kind: "Warn", message }`. No rebase/merge is actually performed — intent only.
7. Orchestrator integration: dispatching two tasks with `branchPolicy.branch === "feature/x"` serializes — second task's `branch_lock_acquired` lane event is emitted only after first task's `branch_lock_released`. Verified via integration test with 2 in-process task runs.
7a. Branch name resolution: when `branchPolicy: { kind: "create", from: "main" }` is supplied WITHOUT an explicit `.name`, the lock key is derived from the post-checkout `git symbolic-ref --short HEAD` (the actual branch the worker checked out), NOT from the advisory `.name` field. Verified via unit test mocking the post-checkout `symbolic-ref` return value.
7b. Git worktree serialization: two git worktrees of the same repo checked out to the same branch both attempt to acquire a branch lock and serialize — second worktree's `branch_lock_acquired` event fires only after the first worktree's `branch_lock_released`. Lock directory is shared via `git rev-parse --git-common-dir`. Verified via integration test with two in-process worktree path fixtures pointing to the same git common dir.
8. Orchestrator integration: on `branch_lock_acquired`, orchestrator runs `stale_base.check()` and emits `stale_base_diverged` lane event if diverged; the task is still dispatched (non-blocking), but the event is observable.
9. Prompt cache: running the SAME prompt against the SAME base system prompt twice within 5 minutes produces a `cache_hit` lane event on the second run; `cacheReadInputTokens` on the `message_stop` usage is > 0; the first run emits `cache_miss`.
10. Prompt cache boundary: `RunConfig.systemPrompt` (string) is wrapped into `[basePromptPrefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, sessionContext]` before being passed to SDK's `query()`. Verified by inspecting the SDK call args in a unit test (mock `query`).
11. `/cost` extension: after N turns, `/cost` output shows four distinct counters — `input`, `output`, `cacheRead`, `cacheWrite` — plus a derived `cacheHitRatio = cacheRead / (cacheRead + input)` rounded to 1 decimal.
12. Parallel tool execution: scripted SDK emission of a single assistant turn containing 3 concurrent `tool_use` blocks → all 3 tool `execute()` calls start within 50 ms of each other (verified via `Date.now()` timestamps in a test fixture; relaxed from 5 ms for CI stability); total wall-clock ≈ max(individual tool latencies), not sum.
12a. HookRuntime reentrancy: parallel tool execution of 3 tools each with a PreToolUse hook fires — each hook's `updatedInput` affects only its own tool; no cross-contamination between concurrently running hooks. Verified by a test fixture where each hook appends a unique tag to its tool's input and asserts no tag appears in a sibling's input.
12b. `todo_write` serialization: two concurrent `todo_write` calls dispatched via `dispatchBatch` serialize deterministically (no interleaved writes); final todo list reflects both writes in submission order.
13. Parallel tool execution permission gating: same scripted emission but with one of the 3 tools denied by the permission engine → zero of the 3 tool `execute()` calls run; the whole batch returns a single `permission_denied` tool_result for the denied tool; the other two tool_uses return `{ status: "skipped", reason: "batch_denied_by_sibling_deny" }`.
14. `notebook_edit`: given a fixture `.ipynb` with 3 cells, `{ edit_mode: "insert", new_source: "print(1)", cell_type: "code" }` without `cell_id` appends a new code cell at index 3 with synthetic id `cell-3`; file's `nbformat`/`nbformat_minor`/`metadata` are preserved byte-for-byte outside the `cells` array.
15. `notebook_edit` validation: a non-`.ipynb` path returns `{ status: "error", message: "notebook_edit requires a .ipynb file" }`; a file whose JSON is not a valid notebook shape (missing `cells` array) returns `{ status: "error", message: "invalid notebook: missing cells array" }`.
16. `notebook_edit` permission: the tool declares `required_permission: "write"`; invoking it under `--permission-mode read-only` returns `permission: denied`.
17. `ask_user_question` standalone+TTY: invoking from the root CLI in an interactive terminal prompts the user (ink modal) and returns `{ answer }` after the user responds.
18. `ask_user_question` standalone+headless: invoking from `--headless` mode without TTY returns `{ status: "error", message: "ask_user_question requires a TTY or orchestrator bridge" }` immediately.
19. `ask_user_question` worker mode: a worker (scripted-test-engine fixture) calls the tool → `"ask_user_question"` IPC notification is sent to parent → parent's ScriptedTestEngine answers via the host's `answerUserQuestion()` method → worker's `execute()` resolves with `{ answer: "scripted" }`.
20. `ask_user_question` timeout: worker sends IPC, parent never answers → after `SWARM_HARNESS_ASK_TIMEOUT_MS` (default 10 min; test sets 100ms), worker receives `{ status: "timed-out" }`.
21. Token preflight: before dispatching a turn, `engine.countTokens(prompt, tools)` is called. The implementation uses local estimation only (2.5 chars/token heuristic: `Math.ceil(bytes / 2.5)`), as the Anthropic `count_tokens` REST endpoint requires API-key auth and would 401 under Claude Max subscription users. If the SDK exposes a `query().count_tokens` method at implementation time (verify against `sdk.d.ts`), use it; otherwise fall back to the local estimate exclusively — do NOT implement a separate REST call to `https://api.anthropic.com/v1/messages/count_tokens`. Token preflight is best-effort: exact count requires API-key auth (not available under Claude Max); we default to local estimate to support all auth paths uniformly.
22. `/status` extension: shows `preflight: <N> tokens (<X>% of 200k context window)` when preflight succeeded; shows `preflight: ~<N> tokens (local estimate; count_tokens unavailable)` after fallback.
23. `npx tsc --noEmit` passes strict mode.
24. `npm test` baseline 739 (76 test files, M3a complete) → target `739 + 30..50` for M3b; all passing.
25. `scripts/smoke-m3b.sh --offline` covers: branch-lock contention, stale_base detection, stale_branch detection, notebook_edit round-trip, ask_user_question scripted answer, parallel-tool-use scripted batch, preflight-with-fallback.
26. `scripts/smoke-m3b.sh` (live) covers: (L1) prompt-cache hit on repeat prompt (verify `cacheReadInputTokens > 0`); (L2) parallel tool execution on a real "read these 3 files in parallel" prompt (verify all 3 `tool_use` blocks execute within 5 ms of each other); (L3) `ask_user_question` from standalone TTY mode round-trip.
27. `scripts/smoke.sh --all` invokes `smoke-m3b.sh` alongside `smoke.sh`, `smoke-swarm.sh`, `smoke-repl.sh`, and `smoke-m3a.sh` (if present).

## Implementation phases

### Phase 0 — Interface refinements (~0.3 day)

0.1. `src/swarm/host.ts` — add `askUser` to the `SwarmHost` surface:
```ts
export interface SwarmHost {
  // ... existing ...
  askUser(question: string, options?: readonly string[]): Promise<AskUserResponse>;
}

export type AskUserResponse =
  | { readonly status: "answered"; readonly answer: string }
  | { readonly status: "cancelled" }
  | { readonly status: "timed-out" }
  | { readonly status: "error"; readonly message: string };
```

0.2. `src/swarm/events.ts` — add lane event types: `branch_lock_acquired`, `branch_lock_released`, `branch_lock_reclaimed`, `branch_lock_timeout`, `stale_base_diverged`, `stale_base_ok`, `cache_hit`, `cache_miss`, `parallel_tool_batch`, `preflight_degraded`, `preflight_disabled`, `ask_user_question_sent`, `ask_user_question_answered`, `ask_user_question_timeout`.

0.3. `src/swarm/ipc/protocol.ts` — add `"ask_user_question"` to the `IpcRequestMethod` union and define its payload shapes:
```ts
// Request
{ method: "ask_user_question", params: { question: string; options?: readonly string[]; timeoutMs?: number } }
// Response
{ ok: true, result: { answer: string } } | { ok: false, error: { code: "timeout" | "transport_closed" | "no_operator"; message: string } }
```

0.4. `src/engine/index.ts` — extend `AgentEngine` with an optional preflight method:
```ts
export interface AgentEngine {
  // ... existing ...
  countTokens?(input: CountTokensInput): Promise<CountTokensResult>;
}
export interface CountTokensInput {
  readonly systemPrompt?: string | readonly string[];
  readonly messages: readonly AnyMessage[]; // reuse SDK's shape or our NormalizedEvent equivalent
  readonly tools?: readonly ToolSpec[];
  readonly model?: string;
}
export interface CountTokensResult {
  readonly inputTokens: number;
  readonly source: "server" | "local-estimate";
}
```

0.5. `src/tools/types.ts` — no change expected; `notebook_edit` uses the existing `ToolImpl` shape.

0.6. `src/tools/dispatcher.ts` — extend the batch-dispatch signature. Current signature dispatches a single `(name, input)`; add `dispatchBatch(requests: readonly ToolRequest[]): Promise<readonly ToolResult[]>` that returns results in the same order. Single-dispatch remains as-is and calls `dispatchBatch([req])` internally (default path for legacy callers).

### Phase 1 — Dependencies (~0.1 day)

1.1. No new runtime deps. Git coordination uses `child_process.execFile("git", …)` (already used elsewhere); lock files use `fs/promises`. Token preflight uses `fetch` (global). Notebook edit uses `JSON.parse` / `JSON.stringify` with `null, 2` indent.

1.2. No new dev deps.

### Phase 2 — Git coordination (~1.5 days)

2.1. `src/swarm/git/branch-lock.ts` (new) — port claw's `branch_lock.rs` collision detection as a pure helper:
```ts
export interface BranchLockIntent { readonly laneId: string; readonly branch: string; readonly modules: readonly string[]; }
export interface BranchLockCollision { readonly branch: string; readonly module: string; readonly laneIds: readonly string[]; }
export function detectCollisions(intents: readonly BranchLockIntent[]): readonly BranchLockCollision[];
```
Plus the **actual atomic lock** (enforcement layer, claw does not have this — it's claw's diagnostic; our orchestrator needs an enforcer):
```ts
export interface LockHandle { readonly branch: string; release(): Promise<void>; }
export async function acquire(branch: string, opts: { agentId: string; timeoutMs: number; lockDir?: string }): Promise<LockHandle>;
```
- Lock dir: anchored to `git rev-parse --git-common-dir` output (the shared `.git` directory). This ensures git worktrees on the same repo share the same lock space — two worktrees checked out to the same branch will acquire from the same lock directory and serialize correctly. Monorepos with separate `.git` directories get separate lock spaces (intentional — they are independent repos from a git-locking perspective).
- Lock dir path: `<git-common-dir>/swarm-harness/branch-locks/` (inside `.git`, not the worktree root).
- File name: `${branch.replace(/[^A-Za-z0-9._-]/g, '-')}-${shortHash(branch)}.lock` where `shortHash` is a 4-char hex FNV-1a suffix (e.g. `feature-x-a3b9.lock`). Always append the hash — do not attempt collision detection via filesystem read.
- Atomic open: `await fs.open(path, 'wx')` — throws `EEXIST` if another writer holds it. NFS-safe on acquire (O_EXCL semantics).
- File content: `{ ownerAgentId, acquiredAt: isoTimestamp, pid: process.pid, branch }`.
- Contention: on `EEXIST`, read existing lock; if `pid` is dead (kill -0 check) AND age > 30s, forcibly unlink and retry (emit `branch_lock_reclaimed`); else poll every 100 ms until timeout. Note: stale-PID reclaim is single-host only — cross-host NFS stale reclaim is deferred to M4.
- Release: unlink the file; emit `branch_lock_released`. Idempotent on double-release.

2.2. `src/swarm/git/stale-base.ts` (new) — port claw's `stale_base.rs`:
```ts
export type StaleBaseResult =
  | { kind: "matches" }
  | { kind: "diverged"; expected: string; actual: string }
  | { kind: "no-expected-base" }
  | { kind: "not-a-git-repo" };
export async function check(opts?: { cwd?: string; expectedBase?: string }): Promise<StaleBaseResult>;
export function formatWarning(result: StaleBaseResult): string | null;
```
- Expected base source priority: `opts.expectedBase` > `${cwd}/.swarm-base` file > none.
- `actual` = `git rev-parse HEAD` (via `execFile`); non-zero exit → `not-a-git-repo`.

2.3. `src/swarm/git/stale-branch.ts` (new) — port claw's `stale_branch.rs`:
```ts
export type Freshness =
  | { kind: "fresh" }
  | { kind: "stale"; commitsBehind: number; missingFixes: readonly string[] }
  | { kind: "diverged"; ahead: number; behind: number; missingFixes: readonly string[] };
export async function check(branch: string, mainRef?: string): Promise<Freshness>;

export type PolicyKind = "AutoRebase" | "AutoMergeForward" | "WarnOnly" | "Block";
export type PolicyIntent =
  | { kind: "Noop" }
  | { kind: "Warn"; message: string }
  | { kind: "Block"; reason: string }
  | { kind: "Rebase" }
  | { kind: "MergeForward" };
export function applyPolicy(freshness: Freshness, policy: PolicyKind): PolicyIntent;
```
- `mainRef` default: try `origin/main`, then `main`, then `origin/master`, then `master`.
- Behind count: `git rev-list --count ${branch}..${mainRef}`.
- Ahead count: `git rev-list --count ${mainRef}..${branch}`.
- MissingFixes: `git log --format=%s ${branch}..${mainRef}` filtered by subjects matching a regex. **Do not invent the regex** — verify the exact pattern by reading `references/claw-code/rust/crates/runtime/src/stale_branch.rs` at implementation time and port it faithfully.

2.4. `src/swarm/orchestrator.ts` — wire into task dispatch. Before `host.spawn`:
- Consult `BranchPolicy.kind` directly:
  - `"reuse"` → `.branch` IS the lock key (the branch already exists; no checkout needed).
  - `"create"` → perform the git checkout first using `.from` and optional `.name` (advisory — git's own naming rules apply if `.name` is absent); then read back `git symbolic-ref --short HEAD` in the worktree and use THAT as the lock key. This avoids the pre-creation ambiguity flagged in Open Item M6 and keeps the lock key tied to the real branch that the worker is operating on.
  - `"none"` → skip lock acquisition entirely.
  No legacy enum fallback needed.
- `await branchLock.acquire(key, { agentId: orchestratorId, timeoutMs: 60_000 })`.
- Emit `branch_lock_acquired`.
- Run `staleBase.check({ cwd, expectedBase })`; if `diverged`, emit `stale_base_diverged` (warning only — do not block).
- Pass lock handle into the task's `finally`: release on task terminal transition (succeeded/failed/stopped).

2.5. `scripts/branch-lock-report.ts` (new, optional CLI diag) — reads `.swarm-harness/branch-locks/*.lock` + takes a list of active tasks, runs `detectCollisions`, prints JSON. Not wired into the main CLI; invoked manually.

2.6. Tests (`src/swarm/git/*.test.ts`):
- `branch-lock.test.ts` (≥ 8): FIFO acquire order under contention; stale-reclaim; timeout; release idempotent; path sanitization; collision detector pure cases.
- `stale-base.test.ts` (≥ 5): matches, diverged, no-expected-base, not-a-git-repo, mixed with `.swarm-base` file fixture.
- `stale-branch.test.ts` (≥ 6): fresh, stale-with-fixes, stale-no-fixes, diverged, `applyPolicy` for each kind, fallback mainRef resolution.
- Integration test in `test/integration/swarm.test.ts`: 2 tasks contending for the same branch serialize; lane events match.

### Phase 3 — Prompt caching (~0.75 day)

3.1. `src/engine/prompt-cache.ts` (new) — fingerprint + analytics helpers.
```ts
export interface PromptCacheFingerprint { readonly hash: string; readonly version: "v1"; }
export function fingerprintSystemPrompt(prefix: string, tools: readonly ToolSpec[]): PromptCacheFingerprint;
// FNV-1a hash over JSON.stringify({ prefix, tools: tools.map(t => ({ name: t.name, schema: t.inputSchema })) })
```

3.2. `src/engine/claude-agent-sdk.ts` — modify systemPrompt assembly before `query()`:
```ts
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";
const systemPrompt = assembleSystemPrompt(config);
// systemPrompt = [staticPrefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, dynamicSuffix]
```
- `staticPrefix` includes: base instructions + CLAUDE.md contents + tool specs summary.
- `dynamicSuffix` includes: per-run transient context (cwd state, recent lane events, session-specific hints).
- If `config.systemPrompt` is already a `string[]`, respect it (user-supplied boundary wins).
- If `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` is absent from exported symbols (SDK version mismatch at implementation time), fall back to passing systemPrompt as a plain string and log a `prompt_cache_unavailable` lane event. **Verify the export against `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` at implementation time.**

3.3. `src/engine/event-translator.ts` — at `message_stop` with `usage.cacheReadInputTokens > 0`, emit an additional lane event `cache_hit` with `{ tokens: cacheReadInputTokens, fingerprint }`; `= 0` with `cache_creation > 0` → `cache_miss` with `{ tokens: cacheCreationInputTokens, fingerprint }`.

3.4. `src/cli/slash/commands/cost.ts` (modify) — extend formatter to show cache counters + derived savings percent.

3.5. Tests:
- `prompt-cache.test.ts` (≥ 5): fingerprint stability, fingerprint version prefix, `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` boundary assembly (mock `query` and assert args), fallback when marker missing, **`structuredOutput` + `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` regression** — run a structured-output request with a cache-boundary systemPrompt and assert both the parsed JSON result on `message_stop` AND the `cache_hit` lane event both fire (neither suppresses the other).
- `event-translator.test.ts` addition (≥ 2): `cache_hit` / `cache_miss` emission on scripted usage deltas.
- Live: `smoke-m3b.sh` [L1] runs the same prompt twice, asserts `cacheReadInputTokens > 0` on 2nd run.

Budget: +0.1d on Phase 3 for the structuredOutput regression test.

### Phase 4 — Parallel tool execution (~0.4 day)

**Scope decision (rev 2):** Phase 4 ships dispatcher infrastructure for parallel execution (`dispatchBatch` API, `concurrencySafe` flag, HookRuntime reentrancy contract, `todo_write` serialization). Actual observable parallelism gates on M4 `NativeEngine` — the SDK's MCP bridge likely serializes tool dispatch internally, so end-to-end parallel start times may not be measurable until M4. Acceptance criterion 12 remains the gate: if live scripted emission of 3 `tool_use` blocks shows sequential start times, the infrastructure ships with a documented caveat and real parallelism defers to M4. Phase 4 effort reflects infrastructure-only work (0.4d); no investigation budget for SDK internals beyond what's already discoverable by inspection.

4.1. **HookRuntime reentrancy contract** — before enabling `Promise.all` fan-out, verify that `src/hooks/runtime.ts`'s `HookRuntime.invoke()` is reentrancy-safe:
- Inspect `HookRuntime` for shared mutable state (timers, counters, per-call buffers). If `invoke()` creates per-call state exclusively (the expected pattern given the JS-callback wrapper from Phase 9), document as reentrancy-safe in a JSDoc comment. If shared mutable state is found, refactor to per-call state before enabling parallel dispatch.
- **Conservative fallback**: if reentrancy status is uncertain at implementation time, run parallel tool execution SERIALLY through the HookRuntime (dispatch tools in `Promise.all` but sequence hook invocations with a per-HookRuntime mutex). Document the caveat.
- Add AC: "parallel tool execution of 3 tools with PreToolUse hooks: each hook's `updatedInput` affects only its own tool; no cross-contamination between hooks running concurrently." (See AC 12a below.)

4.2. `src/tools/dispatcher.ts` — add `dispatchBatch(requests)`:
```ts
export async function dispatchBatch(
  requests: readonly ToolRequest[],
  deps: DispatcherDeps,
): Promise<readonly ToolResult[]> {
  // 1. Synchronous pass: resolve each request's ToolImpl + run canUseTool.
  // 2. If any → `deny`, short-circuit the whole batch:
  //     - Return deny for the denied index; return skipped-stubs for siblings.
  // 3. Otherwise: const promises = requests.map(req => runOne(req, ctxClone(req)));
  //     return Promise.all(promises).
}
```
- `ctxClone` returns a fresh `ToolContext` per call (no shared refs); existing ToolContext is already value-only.
- Lane event: emit one `parallel_tool_batch` with `{ size, toolNames, denies }` when size > 1.

4.3. `src/engine/claude-agent-sdk.ts` — when the SDK surfaces a turn with multiple `tool_use` blocks simultaneously (observable via the MCP bridge path), route them through `dispatchBatch` instead of individual `dispatch` calls. Investigate during implementation: the MCP server SDK binding may auto-serialize; if it does, we need to override at the tool-registration layer or accept that SDK-mode stays serial (and defer parallelism to M4 `NativeEngine`).
**Risk flag**: this is the only phase whose actual parallelism depends on an SDK-internal behavior we don't fully control. Acceptance criterion 12 is the gate — if live scripted emission of 3 `tool_use` blocks still shows sequential start times, open a ticket to M4 and ship parallel-ready dispatcher machinery now with a documented caveat.

4.4. **`todo_write` concurrency-safety annotation** — extend `ToolSpec` with `concurrencySafe: boolean` (default `true`). Mark `todo_write` as `concurrencySafe: false` (evidence: `src/tools/tier0/todo_write.ts` has `let currentTodos: Todo[] = []` at module scope — a global that races under concurrent calls). Parallel dispatcher serializes any tool with `concurrencySafe: false`; only tools explicitly marked (or defaulting to) `true` run in `Promise.all`. Add AC: two concurrent `todo_write` calls serialize deterministically (no interleaved writes). (See AC 12b below.)

4.5. Tests (`src/tools/dispatcher.test.ts` extension, ≥ 6):
- Two concurrent tools: both start within 5 ms window (mock tools with `await sleep(100)`).
- Three concurrent tools including one denied: none run; results shape correct.
- Error in one tool: the other completes; batch returns per-index results.
- Single-request dispatch still works (backwards-compat).
- ToolContext isolation: tool that mutates `ctx.foo` in tool A does not affect ctx in tool B.

### Phase 5 — `notebook_edit` tool (~0.5 day)

5.1. `src/tools/tier1/notebook_edit.ts` (new). Zod schema mirrors claw's shape:
```ts
z.object({
  notebook_path: z.string().endsWith(".ipynb"),
  cell_id: z.string().optional(),
  new_source: z.string().optional(),
  cell_type: z.enum(["code", "markdown"]).optional(),
  edit_mode: z.enum(["replace", "insert", "delete"]).default("replace"),
})
```
Execute:
- Read file; `JSON.parse`; validate `Array.isArray(parsed.cells)` (reject else).
- Resolve cell index by `cell_id`:
  - Replace/delete: require resolvable index.
  - Insert without `cell_id`: append to end.
  - Insert with `cell_id`: insert AFTER that cell.
- New cells get id `cell-${cells.length}` (synthetic, matches claw's `make_cell_id`).
- Language read from `parsed.metadata?.kernelspec?.language ?? "python"`.
- Rewrite with `JSON.stringify(parsed, null, 1) + "\n"` (1-space indent + trailing newline — matches Jupyter canonical form; preserves `nbformat`, `nbformat_minor`, `metadata` untouched outside the `cells` array).
- Return `{ new_source, cell_id, cell_type, language, edit_mode, notebook_path, original_file, updated_file }`.

5.2. `src/tools/tier1/index.ts` — add `notebookEditTool` to `buildTier1Tools()`.

5.3. Tests (`src/tools/tier1/notebook_edit.test.ts`, ≥ 7):
- Insert append, insert after id, replace by id, delete by id, non-.ipynb rejection, invalid notebook JSON rejection, language detection from kernelspec.
- Fixture: `test/fixtures/notebooks/simple.ipynb` with 3 cells.

### Phase 6 — `ask_user_question` via SwarmHost (~0.75 day)

6.1. `src/swarm/standalone-host.ts` — implement `askUser(question, options?)`:
- If `process.stdout.isTTY` AND ink REPL is active: publish an `awaiting-user-question` state; the ink app subscribes and renders a modal; user answer resolves the promise.
- If TTY but no REPL (non-interactive Node with TTY stdin): simple `readline` prompt (same as claw's pattern, but only in this narrow path — the non-blocking default for all other paths).
- If `!process.stdout.isTTY` (headless): return `{ status: "error", message: "ask_user_question requires a TTY or orchestrator bridge" }`.

6.2. `src/swarm/worker-host.ts` — implement `askUser`:
- Send IPC request `{ method: "ask_user_question", params: { question, options } }`.
- Await response with `SWARM_HARNESS_ASK_TIMEOUT_MS` (default `600_000`; override via env var `SWARM_HARNESS_ASK_TIMEOUT_MS`).
- On timeout: return `{ status: "timed-out" }`.
- On orchestrator disconnect while question is pending: return `{ status: "transport_closed" }` (transport close event fires before timeout).
- On compaction boundary while question is pending (SDK may discard the pending `tool_use_id`): emit `{ status: "compacted" }` explicitly so the worker can surface a clear error rather than a silent hang.
- Add AC: worker sends `ask_user_question` IPC; orchestrator process exits before answering → worker receives `{ status: "transport_closed" }` within 1s of the disconnect (not after the full timeout).

6.3. `src/swarm/ipc/worker-transport.ts` — dispatch `"ask_user_question"` from worker → parent → `parent.host.askUser(q, opts)` → reply.

6.4. `src/tools/tier2/ask_user_question.ts` (new):
- Zod: `z.object({ question: z.string().min(1), options: z.array(z.string()).optional() })`.
- Execute: `ctx.host.askUser(question, options)` → return the `AskUserResponse` JSON as tool output.
- Required permission: `"read"` (no side-effects outside the interaction itself).

6.5. `src/tools/tier2/index.ts` — add `askUserQuestionTool` to `buildTier2Tools()`.

6.6. Tests:
- `standalone-host.test.ts` (≥ 3): TTY-mocked path, headless path, option-numeric-parse path.
- `worker-host.test.ts` (≥ 2): round-trip via mock parent transport; timeout.
- `ask_user_question.test.ts` (≥ 3): scripted answer, timeout, unknown-option fallback.

### Phase 7 — Server-side token preflight (~0.4 day)

7.1. `src/engine/token-preflight.ts` (new):
```ts
export async function countTokens(
  input: CountTokensInput,
): Promise<CountTokensResult> {
  // 1. If SDK exposes query().count_tokens (verify against sdk.d.ts at implementation time), call it.
  // 2. Otherwise, fall back to localEstimate exclusively.
  // Do NOT implement a direct REST call to https://api.anthropic.com/v1/messages/count_tokens —
  // that endpoint requires API-key auth and will 401 under Claude Max subscription users.
  return localEstimate(input);
}
export function localEstimate(input: CountTokensInput): CountTokensResult {
  const json = JSON.stringify({ system: input.systemPrompt, messages: input.messages, tools: input.tools });
  // 2.5 chars/token heuristic (conservative; rounds up)
  return { inputTokens: Math.ceil(json.length / 2.5), source: "local-estimate" };
}
```
Token preflight is best-effort. Exact server-side count requires API-key auth, unavailable under Claude Max subscription. We default to local estimate to support all auth paths uniformly. If the SDK exposes a native count method, prefer it; do not add a separate REST dependency.

7.2. `src/engine/claude-agent-sdk.ts` — implement optional `countTokens()` method. Internal counter: on 3 consecutive server failures, flip `this._preflightDisabled = true` and emit `preflight_disabled`. On first failure, emit `preflight_degraded` with the error class. Re-enable at next `run()` call (new turn loop resets).

7.3. `src/cli/slash/commands/status.ts` (modify) — call `engine.countTokens?` if available; format as described in acceptance criterion 22.

7.4. Tests (`token-preflight.test.ts`, ≥ 4): server-success, server-403 → fallback, network-timeout → fallback, localEstimate correctness (sanity: known JSON → expected ±10% token count).

### Phase 8 — Tests + smoke + docs (~0.6 day)

**M3a carry-over items (folded here):**

8.0a. **Clear per-attempt `setTimeout` on race-win in `orchestrator.ts` retry loop** — 1-line fix: call `clearTimeout` on the per-attempt timer when the wait-promise wins the race, preventing event-loop delay at task end. Add test asserting process can exit within 50ms after the wait-promise wins. Budget: +0.1d.

8.0b. **Real-subprocess integration test for per-attempt wall-clock timeout** — M3a's per-attempt timeout is unit-tested with a fake host; a real-subprocess integration test is an M3a open item. Add 1 integration test that spawns an actual subprocess and asserts the timeout fires within the expected window. Budget: +0.1d.

8.1. `scripts/smoke-m3b.sh` — mirrors `smoke-m3a.sh` format (offline + live scenarios):
- **Offline** (ScriptedTestEngine + fixtures):
  - [O1] `branch-lock` contention: 2 concurrent acquires, one waits.
  - [O2] `stale_base` detection on a fixture repo with a mismatched `.swarm-base`.
  - [O3] `stale_branch` detection on a fixture repo with a behind branch.
  - [O4] `notebook_edit` round-trip: insert, replace, delete.
  - [O5] `ask_user_question` scripted answer via ScriptedTestEngine.
  - [O6] Parallel tool batch: 3 concurrent tool_uses start within 5 ms.
  - [O7] Preflight with fallback: simulated `count_tokens` 403 → local estimate returned.
- **Live** (real API):
  - [L1] Prompt cache hit: same prompt run twice → `cacheReadInputTokens > 0` observable in `/cost`.
  - [L2] Parallel tool execution: prompt "read a.txt, b.txt, c.txt in parallel" → 3 `tool_use` blocks with start timestamps within 5 ms.
  - [L3] `ask_user_question` from standalone TTY mode round-trip (interactive; manual driver).

8.2. Extend `scripts/smoke.sh --all` to invoke `smoke-m3b.sh` alongside existing smoke scripts.

8.3. `docs/05-swarm-model.md` — add brief section on branch-lock semantics + stale-base/branch intents.

8.4. `docs/04-tool-tiers.md` (if exists) — mark `notebook_edit` (Tier 1), `ask_user_question` (Tier 2) as landed in M3b.

8.5. `docs/03-interfaces.md` — update `SwarmHost` section with the new `askUser` method; add prompt-cache boundary to `RunConfig` note.

8.6. `docs/07-implementation-plan.md` — move the six M3b bullets from §"Milestone M3" into a "shipped in M3b" marker (or strike them through) to avoid ambiguity.

## File layout after M3b

```
src/
  swarm/
    events.ts                          # MODIFIED — new lane event types
    host.ts                            # MODIFIED — askUser method on SwarmHost
    standalone-host.ts                 # MODIFIED — askUser impl (TTY/ink/headless paths)
    worker-host.ts                     # MODIFIED — askUser IPC proxy + timeout
    orchestrator.ts                    # MODIFIED — branch-lock acquire/release; stale_base check
    ipc/
      protocol.ts                      # MODIFIED — ask_user_question method
      worker-transport.ts              # MODIFIED — ask_user_question dispatcher
    git/                               # NEW directory
      branch-lock.ts                   # NEW — atomic lock + collision detector
      branch-lock.test.ts
      stale-base.ts                    # NEW — base-divergence check
      stale-base.test.ts
      stale-branch.ts                  # NEW — branch-freshness + policy intents
      stale-branch.test.ts
  engine/
    claude-agent-sdk.ts                # MODIFIED — systemPrompt boundary, countTokens, parallel batch
    event-translator.ts                # MODIFIED — cache_hit / cache_miss emission
    prompt-cache.ts                    # NEW — fingerprint + analytics helpers
    prompt-cache.test.ts
    token-preflight.ts                 # NEW — count_tokens wrapper + fallback
    token-preflight.test.ts
    index.ts                           # MODIFIED — countTokens on AgentEngine
  tools/
    dispatcher.ts                      # MODIFIED — dispatchBatch for parallel tool_use
    dispatcher.test.ts                 # MODIFIED — new parallel-batch cases
    tier1/
      notebook_edit.ts                 # NEW
      notebook_edit.test.ts
      index.ts                         # MODIFIED — export notebookEditTool
    tier2/
      ask_user_question.ts             # NEW
      ask_user_question.test.ts
      index.ts                         # MODIFIED — export askUserQuestionTool
  cli/
    slash/
      commands/
        cost.ts                        # MODIFIED — cache counters
        status.ts                      # MODIFIED — preflight info
scripts/
  smoke-m3b.sh                         # NEW
  smoke.sh                             # MODIFIED — --all includes smoke-m3b.sh
  branch-lock-report.ts                # NEW (optional diag CLI)
test/
  fixtures/
    notebooks/
      simple.ipynb                     # NEW
    git-repos/
      stale-base-fixture/              # NEW (pre-initialized bare repo tarball)
      stale-branch-fixture/
  integration/
    swarm.test.ts                      # MODIFIED — add branch-lock contention scenario
docs/
  12-m3b-plan.md                       # NEW (this file)
  05-swarm-model.md                    # MODIFIED — branch-lock + stale intents
  03-interfaces.md                     # MODIFIED — askUser on SwarmHost; prompt-cache note
  04-tool-tiers.md                     # MODIFIED (if exists) — mark tools landed
  07-implementation-plan.md            # MODIFIED — mark M3b items shipped
```

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| SDK's `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` export name changes between SDK versions | Medium | Medium | At implementation time, verify export against `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`. Fall back to string systemPrompt on import failure with `prompt_cache_unavailable` lane event. Pin SDK version in `package.json` at the end of M3b so upgrades are intentional. |
| Parallel tool dispatch doesn't actually run in parallel because the SDK's MCP bridge serializes internally | High | Medium | Phase 4's acceptance criterion 12 is the gate — if live scripted emission of 3 `tool_use` blocks still shows sequential start times, ship the dispatcher's parallel-ready code path but document the caveat; real parallelism lands with `NativeEngine` in M4. No behavioral regression either way. |
| Branch lock file left behind after orchestrator crash | Medium | High | Stale-lock reclaim on `pid` dead + age > 30s; startup cleanup sweep (optional — remove locks whose `pid` is not alive and whose age > 5 min) at orchestrator boot. Emit `branch_lock_reclaimed` for observability. |
| Path sanitization for lock filenames loses distinguishing info (two branches → same lock file) | Low | Medium | Always append a 4-char FNV-1a hash suffix (e.g. `feature-x-a3b9.lock`) — no collision detection via filesystem read needed. Test covers `feature/a/b` vs `feature-a-b` edge case. |
| `count_tokens` latency adds to first-turn time | Medium | Low | Run in parallel with other turn-setup work (no `await` blocking on the critical path); on error, silent local fallback (already the plan). Measure: if first-turn latency increases > 200ms on average, gate preflight behind `--preflight` flag. |
| `ask_user_question` deadlocks a worker when orchestrator has no TTY and no human operator | Medium | High | Timeout default 10 min; on timeout worker gets `{ status: "timed-out" }` and continues. Headless orchestrator path explicitly errors rather than hangs. Operator-mode docs call this out. |
| Prompt-cache fingerprint collision (different prompts hash same) | Low | Low | FNV-1a over JSON is collision-resistant enough for this use; version prefix `v1-` enables bumping if we ever need SHA-256. Tests cover stability only, not cryptographic collision resistance (unrealistic). |
| `notebook_edit` reformats unrelated cells when rewriting JSON | Medium | Low | Use `JSON.stringify(parsed, null, 1) + "\n"` (1-space indent + trailing newline, matching Jupyter canonical form); acceptance criterion 14 asserts `nbformat`/`metadata` preserved byte-for-byte outside `cells`. Diff test on a reference fixture. |
| Parallel tool execution races on shared context (e.g. two tools writing the same file) | High | High | ToolContext is per-call (no shared state in dispatcher path). Race between TOOLS (both writing `foo.ts`) is the model's responsibility — log a `parallel_tool_batch` lane event with tool names so operators can audit. Future: per-tool conflict detection in M4. |
| Lock reclaim races between two orchestrators on the same repo (rare: two `swarm run` invocations simultaneously) | Low | Medium | Lock file contains `pid`; acquire is NFS-safe via O_EXCL. Stale-PID reclaim is single-host only: `kill -0` requires same-host context; cross-host NFS stale reclaim deferred to M4. Same-host double-orchestrator: both pids alive → second sees a valid lock and waits. Cross-host NFS: unsupported in M3b; operators must not run concurrent swarm instances from separate hosts against the same repo until M4. |
| `stale_branch.applyPolicy` returns `Rebase` intent but caller forgets to act | Low | Low | Intents are advisory (same as claw). Documented prominently in `stale-branch.ts` JSDoc. Audit left to operators. Future: M4 can ship an "auto-rebase" executor that honors intents. |
| Test count exceeds budget (CI time bump) | Low | Low | Estimate +30 to +50; mostly pure unit tests (<10ms each). Full suite already at ~15s; +50 tests at 50ms/test is +2.5s, still well under 30s CI target. |
| `ask_user_question` tool allowlist mismatch (reviewer-role worker gets the tool but has nowhere to display) | Medium | Low | Role allowlists (M3a) handle this — reviewer role should not include `ask_user_question`. M3b ships the tool; role allowlists in M3a control availability per-worker. If M3a is not merged, M3b's tool is universally available; operators can set `RunConfig.allowedTools` to filter. |

## Verification steps

Run after each phase:

- **Phase 0:** `npx tsc --noEmit` clean.
- **Phase 1:** no-op.
- **Phase 2:** `npx vitest run src/swarm/git/` green; integration test with 2 concurrent tasks on the same branch serialize (emitted events observable in JSONL log).
- **Phase 3:** `npx vitest run src/engine/prompt-cache.test.ts src/engine/event-translator.test.ts` green; manual: run `swarm-harness prompt "hi"` twice with `/cost` in between; second run shows non-zero `cacheRead`.
- **Phase 4:** `npx vitest run src/tools/dispatcher.test.ts` green; live: scripted 3-parallel-read prompt shows `parallel_tool_batch` event.
- **Phase 5:** `npx vitest run src/tools/tier1/notebook_edit.test.ts` green; manual: run tool against `test/fixtures/notebooks/simple.ipynb`, diff before/after.
- **Phase 6:** `npx vitest run src/tools/tier2/ask_user_question.test.ts src/swarm/standalone-host.test.ts src/swarm/worker-host.test.ts` green; manual: invoke tool in TTY REPL, answer the modal, verify tool result.
- **Phase 7:** `npx vitest run src/engine/token-preflight.test.ts` green; manual: run `/status` before first turn, assert preflight line appears.
- **Phase 8:** `scripts/smoke-m3b.sh --offline` all pass; `scripts/smoke-m3b.sh` (live) all pass with valid auth; `scripts/smoke.sh --all` passes.

**End-of-M3b gate:** all 27 acceptance criteria verified, tagged `m3b-complete`.

## Estimated effort

| Phase | Effort |
|---|---|
| 0 Interface refinements | 0.3 d |
| 1 Dependencies | 0.1 d |
| 2 Git coordination (branch-lock + stale-base + stale-branch + wiring) | 2.0 d |
| 3 Prompt caching (boundary marker + fingerprint + /cost) | 0.85 d |
| 4 Parallel tool execution (dispatcher infrastructure + concurrencySafe flag) | 0.4 d |
| 5 `notebook_edit` tool | 0.5 d |
| 6 `ask_user_question` via SwarmHost | 0.75 d |
| 7 Server-side token preflight + /status | 0.4 d |
| 8 Smoke + docs + integration glue (incl. M3a carry-overs) | 0.6 d |
| Buffer | 0.55 d |

**Total: ~6.45 engineer-days.** Phase 2 increased from 1.5d → 2.0d to account for the new atomic-lock design (NFS-safe acquire, stale-PID reclaim, release-on-crash, worktree git-common-dir anchoring) which is new work not present in claw. Phase 3 increased +0.1d for the structuredOutput regression test. Phase 4 reduced from 0.75d → 0.4d (infrastructure only; actual parallelism defers to M4 NativeEngine — acceptance criterion 12 is the gate). Phase 8 increased from 0.4d → 0.6d for two M3a carry-over items (real-subprocess per-attempt timeout test; clear setTimeout on race-win).

If a phase slips, drop order: `scripts/branch-lock-report` diagnostic (Phase 2.5) → `/status` preflight extension (Phase 7.3; keep countTokens API) → `ask_user_question` TTY-ink modal path (ship worker-mode IPC only; standalone falls back to error-on-headless and readline-on-TTY).

## Open items to revisit during implementation

- **Parallel tool execution in SDK mode. [RESOLVED]** Phase 4 ships the `dispatchBatch` API, `concurrencySafe` flag, and HookRuntime reentrancy contract as infrastructure. Actual observable parallelism defers to M4 `NativeEngine` — the SDK's MCP bridge likely serializes internally. Acceptance criterion 12 is the gate; if live test shows sequential start times, ship with caveat documented. No further scope ambiguity.
- **`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` export name.** Current constant at `sdk.d.ts:4966`. If a minor SDK bump renames this (or deprecates it), the fallback path kicks in. Detect at construction time.
- **Lock file TTL on NFS.** Documented as unsupported. Revisit if operators report shared-NFS usage.
- **Notebook reformat surface.** M3b uses `JSON.stringify(null, 1)`. If users report undesired reformats on cells we didn't touch, switch to a minimal-diff rewriter (string-replace the specific cell payload only). Open.
- **`count_tokens` cost.** Preflight calls are free on Anthropic (no token charge), but latency is real. If profiling shows > 200ms overhead per turn, gate behind `--preflight` flag.
- **`ask_user_question` non-TTY-orchestrator bridge.** M3b errors in standalone+headless mode. A future design could route to a web-socket / HTTP callback server the operator runs; defer to M4+.
- **`branch_lock` / M3a `BranchPolicy.kind === "create"` name generation. [RESOLVED]** `BranchPolicy.name` is ADVISORY input to the checkout command, not the lock key. After checkout, the lock key is the POST-checkout actual branch name obtained via `git symbolic-ref --short HEAD`. The orchestrator owns this resolution (see Phase 2.4 and "Branch name resolution precedence" in Decision context). The lock module itself only receives the final resolved branch string.
- **Cache hit ratio accuracy.** Renamed `cacheSavingsPct` → `cacheHitRatio` (formula: `cacheRead / (cacheRead + input)`). This measures cache hit fraction, not actual dollar savings. Alternatives: `cacheRead / totalInputEverSeen`. Open; revise when we have live usage data.
- **Parallel tool execution + `notebook_edit`.** Two concurrent `notebook_edit` calls on the SAME notebook race — last writer wins. Document this; future: per-file write lock at the tool layer (like branch-lock but per path).

## Cross-references

- Prereq scope: `docs/07-implementation-plan.md` §M3 (the six M3b items + explicit M3a out-of-scope enumeration).
- Swarm model: `docs/05-swarm-model.md` (TaskPacket; SwarmHost contract; branch-lock semantics added by M3b).
- Interface contracts: `src/swarm/host.ts` (`askUser`), `src/swarm/events.ts` (new lane events), `src/swarm/ipc/protocol.ts` (`ask_user_question` method), `src/engine/index.ts` (`countTokens`).
- Prior milestones: `docs/10-m2-plan.md` (UI depth + Tier 1 baseline; compaction observer; /cost + /status slash commands we extend), `docs/11-m3a-plan.md` (BranchPolicy discriminated union we consume).
- Research: `docs/research/05-swarm.md` §6 (branch_lock, stale_base, stale_branch ports), §9 (ask_user_question anti-pattern), `docs/research/01-api.md` §7 (prompt caching), §8 (token preflight), `docs/research/02-tools.md` §2.10 (notebook_edit patterns), §5 (tool-tier mapping).
- Anti-patterns refused: `docs/07-implementation-plan.md` §"What we explicitly refuse to copy from claw" item #8 (stdin-blocking AskUserQuestion — M3b ships the SwarmHost-routed replacement).

## Revision history

- **rev 1 (2026-04-20):** initial draft. Six scope/mechanism decisions locked: (1) `notebook_edit` classified Tier 1 (user-facing productivity, permission `write`); (2) `ask_user_question` worker-mode IPC uses existing request/response protocol with a new `"ask_user_question"` method + 10-min default timeout; (3) prompt-cache boundary via SDK's `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` string[] marker (the only caching surface the SDK exposes publicly — verified against `sdk.d.ts:4958–4966`), not a per-block `cacheControl`; (4) parallel tool execution gates permissions pre-fan-out with batch-wide deny on any sibling deny; (5) branch-lock granularity is per-branch (module-level is a diagnostic only — ship as separate CLI); (6) `count_tokens` failure policy is silent fallback with 3-fail disable. M3b can ship independently of M3a — only soft seam is consuming `TaskPacket.branchPolicy` which Phase 2 handles either shape. Total effort 6d, sits at high end of 4-6 day target. Biggest risk: Phase 4 parallel tool execution depends on SDK-internal behavior that may serialize dispatch — acceptance criterion 12 is the gate; fallback ships machinery with caveat documented.

- **rev 3 (2026-04-21):** post-M3a refresh. Prereq updated from M2 to M3a complete (3240a43). Dropped "branch name resolution precedence" fallback path — BranchPolicy is discriminated-union shape throughout (M3a Phase 2 migrated callers; no legacy handling needed). Added two M3a carry-over items to Phase 8 (real-subprocess per-attempt timeout test; clear setTimeout on race-win). Total effort 6.25d → 6.45d.

- **rev 4 (2026-04-21):** execution complete. All 8 phases shipped on `mvp` (Phase 0+1 commit `910c283` through Phase 8 commit `<this-commit>`). See m3b-complete tag.

- **rev 2 (2026-04-21):** critic REVISE (3 critical + 8 major + 6 minor). All findings addressed. Key changes: **(C1)** `BranchPolicy` enum vs branch name — `"main"|"worktree"|"feature-branch"|"detached"` are strategy identifiers, not branch names; Phase 2.4 and new "Branch name resolution precedence" subsection mandate `git symbolic-ref --short HEAD` resolution for legacy enum values; lock key is always the real git branch. New AC 7a confirms `branchPolicy:"main"` on `feature/x` checkout → lock key `feature-x`. M3b independence from M3a preserved via git-resolve path (option b). **(C2)** Scope corrected: `branch_lock.rs` in claw is 100 LOC pure collision detection only — no atomic lock. Wording changed throughout to "port `detect_branch_lock_collisions` near-verbatim; BUILD atomic filesystem lock (new design work)." Phase 2 effort bumped 1.5d → 2.0d. **(C3)** Phase 4.1 added: HookRuntime reentrancy contract (inspect shared mutable state; conservative serial fallback if uncertain; AC 12a for cross-tool isolation). **(M1)** Phase 4.4: `concurrencySafe: boolean` on `ToolSpec`; `todo_write` marked `false`; AC 12b for serialization. **(M2)** Phase 2.1: lock dir anchored to `git rev-parse --git-common-dir` (shared across worktrees); NFS wording clarified (O_EXCL safe on acquire; stale-PID reclaim single-host only; cross-host deferred to M4); AC 7b for worktree serialization. **(M3)** Phase 0.3: full `IpcRequestMethod` union update + request/response payload shapes. **(M4)** Phase 6.2: `transport_closed` and `compacted` status variants; orchestrator-disconnect AC; `SWARM_HARNESS_ASK_TIMEOUT_MS` env var documented. **(M6)** Open item resolved: `BranchPolicy.name` is advisory to checkout; lock key is POST-checkout `git symbolic-ref` result. **(M7)** Phase 3.5: `structuredOutput` + `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` regression test; +0.1d budget. **(M8)** Phase 7.1 / AC 21: local-estimate-only path (2.5 chars/token); no REST call to `count_tokens` endpoint (would 401 under Claude Max); SDK native method preferred if exposed. **(N1)** SDK version verified at `3b17fbd`; pin `package.json` at M3b end. **(N2)** Lock filename always includes 4-char FNV-1a hash suffix; no filesystem-read collision detection. **(N3)** `stale_branch` missing-fixes regex: read from `stale_branch.rs` at implementation time; not invented. **(N4)** AC 12 timing relaxed 5ms → 50ms for CI stability. **(N5)** Notebook indent: `JSON.stringify(null, 1) + "\n"` (1-space + trailing newline, Jupyter canonical). **(N6)** `cacheSavingsPct` renamed → `cacheHitRatio` throughout. **Phase 4 scope:** downscoped to infrastructure-only (0.4d); actual parallelism defers to M4 NativeEngine. **New total: ~6.25d.**
