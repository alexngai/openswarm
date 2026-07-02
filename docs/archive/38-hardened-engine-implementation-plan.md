# 38 — Hardened NativeEngine Implementation Plan

Phased delivery plan for the Codex-to-openswarm core loop port.
Design rationale in `docs/37-hardened-engine-design.md`.

## Phase 0  Scaffolding (1 day)

### P0.1  Create HardenedNativeEngine skeleton

**File:** `src/engine/hardened-native.ts`

- [x] Copy NativeEngine as starting point
- [x] Change `id` to `"hardened-native"`
- [x] Add `RetryPolicy` to constructor options
- [x] Add `eagerToolDispatch` and `midTurnCompaction` boolean options
- [x] Wire into CLI via `--engine hardened-native` flag in `src/cli/argv.ts`
- [x] Wire into `src/cli/runtime.ts` engine selection

### P0.2  Add new types

**File:** `src/engine/retry-policy.ts`

- [x] `RetryPolicy` interface
- [x] `DEFAULT_RETRY_POLICY` constant
- [x] `isRetryableError(error: ProviderError): boolean` default classifier

**File:** `src/core/types.ts`

- [x] Add `"retry"` variant to `NormalizedEvent` union
- [x] Add `retry?: boolean` and `eagerToolDispatch?: boolean` to `EngineCapabilities`

**File:** `src/engine/index.ts`

- [x] Add `retryPolicy?: RetryPolicy` to `RunConfig`
- [x] Add `eagerToolDispatch?: boolean` to `RunConfig`
- [x] Add `midTurnCompaction?: boolean` to `RunConfig`

### P0.3  Add snapshot type

**File:** `src/engine/hardened-native-snapshot.ts`

- [x] `HardenedNativeSnapshot` interface (extends NativeSnapshot with retryStats)
- [x] `makeHardenedSnapshot()` factory
- [x] `extractHardenedSnapshot()` extractor

**Codex mapping:** `SamplingRequestResult` (turn.rs:1202-1206)

### P0.4  Baseline test file

**File:** `src/engine/hardened-native.test.ts`

- [x] Import mock provider pattern from existing `native.test.ts`
- [x] Verify skeleton passes same tests as NativeEngine (copy baseline suite)

**Acceptance:** `npm test -- hardened-native` passes, all NativeEngine baseline tests pass.

---

## Phase 1  Retry Engine (3 days)

### P1.1  Implement retry loop

**File:** `src/engine/hardened-native.ts`

**Codex mapping:** `run_sampling_request` (turn.rs:1025-1087)

- [x] Extract streaming into `streamProviderTurn()` private method
- [x] Wrap in retry loop with `RetryPolicy`
- [x] On retryable error: compute delay (`backoffBaseMs * 2^attempt`), yield `retry` event, sleep
- [x] On non-retryable error: yield `error` event, return
- [x] On abort during sleep: return immediately
- [x] On success: break retry loop

**Control flow (maps 1:1 to Codex):**
```
Codex: run_sampling_request → try_run_sampling_request → handle_retryable_error
Ours:  streamWithRetry()    → streamProviderTurn()     → handleRetryableError()
```

### P1.2  Error classifier

**File:** `src/engine/retry-policy.ts`

**Codex mapping:** `CodexErr` hierarchy + `is_retryable()` method

- [x] `classifyProviderError(err: unknown): ProviderError` — normalize caught exceptions
- [x] Default `isRetryable`: transport, rate_limit, provider_unavailable → true; rest → false
- [x] Allow override via `RetryPolicy.isRetryable`

### P1.3  Abort-aware sleep

**File:** `src/engine/hardened-native.ts`

**Codex mapping:** Backoff sleep with interrupt checking (responses_retry.rs:58-72)

- [x] `abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean>`
- [x] Returns `true` if slept full duration, `false` if aborted
- [x] On abort: resolve immediately (do not throw)

### P1.4  Retry tests

**File:** `src/engine/hardened-native.test.ts`

**Codex test mapping:** Integration tests for retry paths

- [x] **T1.1** Provider fails once with `transport` error, succeeds on retry → turn completes
- [x] **T1.2** Provider fails with `context_overflow` → no retry, error event emitted
- [x] **T1.3** Provider fails `maxRetries+1` times → final error event emitted
- [x] **T1.4** Exponential backoff timing: 100ms, 200ms, 400ms verified
- [x] **T1.5** Abort during backoff sleep → exit immediately, no further attempts
- [x] **T1.6** Cumulative usage includes retried turns
- [x] **T1.7** `retry` NormalizedEvent emitted with correct attempt/delay/error
- [x] **T1.8** Eager dispatch inFlight reset on retry prevents stale results
- [x] **T1.9** Thrown context_overflow triggers emergency compaction + retry
- [x] **T1.10** In-stream context_overflow triggers emergency compaction + retry
- [x] **T1.11** Context_overflow without compactable context fails immediately

**Acceptance:** All T1.x tests pass. Retry loop matches Codex behavior.

---

## Phase 2  Eager Tool Dispatch (4 days)

### P2.1  Restructure streaming loop for eager dispatch

**File:** `src/engine/hardened-native.ts`

**Codex mapping:** `try_run_sampling_request` (turn.rs:1830-2214) streaming loop

- [x] Replace `toolUseBuffer: PendingToolUse[]` with `inFlight: Map<string, Promise<ToolResult>>`
- [x] On `tool-call` event:
  - Call `config.canUseTool()` immediately
  - If allowed: `dispatcher.dispatch()` → store promise in `inFlight`
  - If denied: store `Promise.resolve({ status: "error", message: reason })` in `inFlight`
  - Yield `tool_use_end` event
- [x] On `finish` event: capture usage, break stream loop
- [x] After stream: drain `inFlight` in insertion order (Map preserves order)
- [x] Yield `tool_result` events in original order

**Key difference from Codex:** Codex uses `FuturesOrdered` (preserves push order).
We use `Map<string, Promise>` iterated in insertion order (ES2015 guarantee).

### P2.2  Integrate with ToolScheduler

**Codex mapping:** `ToolCallRuntime.handle_tool_call_with_source` (parallel.rs:81-178)

- [x] Each eager `dispatcher.dispatch()` goes through `ToolScheduler` internally
- [x] Conflicting tools queue automatically (existing scheduler behavior)
- [x] Non-conflicting tools run concurrently (existing scheduler behavior)
- [x] No changes to `ToolScheduler` or `ToolAccesses` interfaces

**Key difference from Codex:** Codex uses binary RwLock (parallel vs serial).
Our ToolScheduler is strictly more granular (per-resource conflict graph).

### P2.3  Abort during drain

**Codex mapping:** Cancellation handling in `handle_tool_call_with_source` (parallel.rs:115-178)

- [x] Pass child abort signal to each `dispatch()` call via `ToolExecutionContext.abort`
- [x] On abort during drain: settle pending promises as error results
- [x] Yield error tool_results for aborted tools
- [x] Do not re-invoke permission gate on abort

### P2.4  Fallback to batch mode

- [x] When `config.eagerToolDispatch === false` (default): preserve current batch behavior
- [x] Conditional: `if (eagerDispatch) { eagerPath() } else { batchPath() }`
- [x] Both paths yield identical NormalizedEvent sequences for same inputs

### P2.5  Eager dispatch tests

**File:** `src/engine/hardened-native.test.ts`

**Codex test mapping:** `parallel.rs` tests + session integration tests

- [x] **T2.1** Single tool call dispatched during streaming, result available at finish
- [x] **T2.2** Three non-conflicting tools: all start during streaming (verify timing < 200ms apart)
- [x] **T2.3** Two conflicting tools (same file write): second waits for first to complete
- [x] **T2.4** Permission denied during streaming: error result yielded in correct position
- [x] **T2.5** Abort during tool execution: pending tools receive error results
- [x] **T2.6** Eager vs batch mode: same final event sequence for same inputs
- [x] **T2.7** Tool result order matches tool_use emission order (not completion order)
- [x] **T2.8** `updatedInput` from permission gate flows to dispatch (not original input)

**Acceptance:** All T2.x tests pass. Eager dispatch matches Codex wall-clock behavior.

---

## Phase 3  Mid-Turn Compaction (2 days)

### P3.1  Add mid-turn compaction check

**File:** `src/engine/hardened-native.ts`

**Codex mapping:** Mid-turn compaction in `run_turn` (turn.rs:268-321)

- [x] After tool results appended to `messages`, before `continue`:
  ```
  if (midTurnCompaction && shouldCompact({ messages }, compactionConfig)) {
    yield compaction(begin, trigger: "mid-turn")
    result = compactSession({ messages }, compactionConfig)
    messages = result.compactedSession.messages.slice()
    yield compaction(end, trigger: "mid-turn")
    compactionCount++
    // post-compaction health probe (same as pre-turn)
  }
  ```
- [x] Trigger value: `"mid-turn"` (distinct from `"auto"` for pre-turn)
- [x] Uses same `compactSession()` — no new compaction logic

### P3.2  Mid-turn compaction tests

**File:** `src/engine/hardened-native.test.ts`

**Codex test mapping:** Compaction integration in turn loop

- [x] **T3.1** Tool results push tokens above threshold → mid-turn compaction fires
- [x] **T3.2** Compaction events emitted with `trigger: "mid-turn"`
- [x] **T3.3** Turn continues after mid-turn compaction (model sees compacted context)
- [x] **T3.4** Boundary walk-back preserved during mid-turn compaction
- [x] **T3.5** `midTurnCompaction: false` (default) → no mid-turn compaction
- [x] **T3.6** Pre-turn + mid-turn compaction in same turn (both fire)

**Acceptance:** All T3.x tests pass. Context overflow during long turns is recoverable.

---

## Phase 4  Provider Retry Decorator (2 days)

### P4.1  RetryingProvider wrapper

**File:** `src/providers/retrying-provider.ts`

**Codex mapping:** Transport fallback in `try_switch_fallback_transport` (client.rs:1636-1646)

- [x] `class RetryingProvider implements Provider`
- [x] Constructor: `primary: Provider`, `fallback?: Provider`, `policy?: RetryPolicy`
- [x] `stream()`: try primary, on transport error after threshold → switch to fallback
- [x] Capabilities: union of primary and fallback
- [x] `id`: `"retrying(" + primary.id + ")"`

### P4.2  RetryingProvider tests

**File:** `src/providers/retrying-provider.test.ts`

- [x] **T4.1** Primary succeeds → fallback never called
- [x] **T4.2** Primary fails all retries → fallback used
- [x] **T4.3** Primary fails once → retried on primary (not immediately fallback)
- [x] **T4.4** No fallback configured → error after max retries
- [x] **T4.5** Fallback also fails → error propagated

**Acceptance:** All T4.x tests pass.

---

## Phase 5  Integration & Parity (3 days)

### P5.1  End-to-end integration tests

**File:** `src/engine/hardened-native.integration.test.ts`

- [x] **T5.1** Flaky provider (random failures) → engine recovers, turn completes
- [x] **T5.2** Multi-tool turn with eager dispatch + retry → correct results
- [x] **T5.3** Context overflow mid-turn → compaction + continuation
- [x] **T5.4** Snapshot persist → resume → continue with compacted context
- [x] **T5.5** All features combined: retry + eager + mid-turn compaction in one turn
- [x] **T5.6** Abort at every phase: during stream, during retry sleep, during eager dispatch, during drain

### P5.2  Parity matrix validation

Verify behavioral parity with NativeEngine for non-hardened scenarios:

- [x] **T5.7** With retry disabled + batch dispatch + no mid-turn compaction: identical event sequence to NativeEngine
- [x] **T5.8** Same tool_result ordering for batch vs eager (content identical, timing differs)
- [x] **T5.9** Same compaction output for pre-turn vs mid-turn (same compactor, same algorithm)

### P5.3  Swarm worker integration

**File:** `src/cli/worker-entry.ts`

- [x] Wire `HardenedNativeEngine` as default for swarm subprocess workers
- [x] Pass `retryPolicy` from team-spec or CLI flags
- [x] Verify worker lifecycle (spawn → run → snapshot → resume) works with hardened engine

### P5.4  Documentation

- [x] Update `docs/02-architecture.md` with HardenedNativeEngine
- [x] Update `docs/archive/13-m4a-plan.md` with reference to hardened engine
- [x] Add engine selection docs (CLI flags in argv.ts, design doc §6.3 trigger clarification)

**Acceptance:** All T5.x tests pass. Swarm workers use hardened engine by default.

---

## Test Summary

| Phase | Tests | Codex behavior verified |
|-------|-------|------------------------|
| P0 | Baseline (copy from native.test.ts) | Basic turn loop |
| P1 | T1.1-T1.11 (11 tests) | Retry with exponential backoff + context_overflow recovery |
| P2 | T2.1-T2.8 (8 tests) | Eager tool dispatch during streaming |
| P3 | T3.1-T3.6 (6 tests) | Mid-turn compaction |
| P4 | T4.1-T4.5 (5 tests) | Provider-level retry/fallback |
| P5 | T5.1-T5.9 (9 tests) | Integration + parity |
| **Total** | **~35 new tests** | |

## Timeline

| Phase | Duration | Dependencies |
|-------|----------|-------------|
| P0 Scaffolding | 1 day | None |
| P1 Retry Engine | 3 days | P0 |
| P2 Eager Dispatch | 4 days | P0 |
| P3 Mid-Turn Compaction | 2 days | P0 |
| P4 Provider Retry | 2 days | P0 |
| P5 Integration | 3 days | P1 + P2 + P3 + P4 |
| **Total** | **~3 weeks** | |

P1 through P4 can be parallelized (all depend only on P0). P5 integrates.

## Tracking

Each task above has a checkbox. Track progress by updating this file.
Each ported mechanism references its Codex source (file:lines) in the
implementation as a code comment for future auditing.

### 1:1 Integrity Checks

After each phase, verify the mapping:

| Check | Method |
|-------|--------|
| Retry semantics match Codex | Compare backoff timing, error classification, retry count |
| Eager dispatch matches Codex wall-clock | Benchmark: N tool calls, measure total time vs batch |
| Mid-turn compaction matches Codex trigger | Token threshold + needs_follow_up → compact |
| Snapshot resume works across restarts | Persist → kill → resume → verify context intact |
| Tool result ordering is deterministic | Property test: random completion order → same output order |
