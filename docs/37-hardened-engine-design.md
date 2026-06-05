# 37 — Hardened NativeEngine Design

Port of production-hardened loop mechanics from OpenAI Codex (Rust) into
swarm-harness's NativeEngine (TypeScript). Goal: Codex-level resilience
while preserving swarm-harness's provider flexibility, swarmkit integration,
and composable architecture.

## 1  Motivation

NativeEngine (M4a, `src/engine/native.ts`, 280 lines) is a clean, composable
agent loop — but it lacks resilience features that production harnesses ship:

| Gap | Impact | Codex reference |
|-----|--------|-----------------|
| No retry on stream errors | Transient API failures kill the turn | `responses_retry.rs:22-79` |
| Tools dispatched after streaming | Wall-clock waste on multi-tool turns | `turn.rs:1830-2214` |
| No mid-turn compaction | Context overflow during long turns is fatal | `turn.rs:268-321` |
| No transport fallback | Single transport path, no recovery | `client.rs:1577-1628` |

## 2  Scope

### In scope

1. **Retry engine** — exponential backoff with configurable max retries
2. **Eager tool dispatch** — start tool execution during streaming
3. **Mid-turn compaction** — compact between tool dispatch and next provider call
4. **Provider retry decorator** — composable wrapper with transport fallback
5. **Tests** — behavioral parity tests derived from Codex test patterns
6. **1:1 tracking map** — every ported mechanism traces back to Codex source

### Out of scope

- OpenAI Responses API format (we keep ProviderEvent abstraction)
- WebSocket transport (Vercel AI SDK manages transport)
- Codex-specific features: Realtime/WebRTC, Guardian review, thread persistence,
  memory consolidation, telemetry/OTEL, MCP elicitation
- Submission loop (NativeEngine stays one-shot + snapshot resume)
- Plan mode / proposed plan segments (future consideration)

## 3  Architecture

### 3.1  Engine variants after this work

```
AgentEngine (interface)
  ├─ ClaudeAgentSdkEngine  (M0 — SDK owns loop, Anthropic-only)
  ├─ NativeEngine           (M4a — current, minimal loop)
  └─ HardenedNativeEngine   (M5 — this work, Codex-grade resilience)
```

HardenedNativeEngine replaces NativeEngine for production use.
NativeEngine stays as the reference/test baseline (simple, predictable).

### 3.2  Component diagram

```
HardenedNativeEngine
  ├─ RetryPolicy          (config: maxRetries, backoffBase, retryable classifier)
  ├─ EagerToolDispatcher  (dispatch during streaming, drain at finish)
  ├─ MidTurnCompactor     (check + compact after tool results)
  └─ Provider             (unchanged — stream() interface)
       └─ RetryingProvider (optional decorator — transport fallback)
```

## 4  Codex-to-swarm-harness 1:1 Mapping

### 4.1  Core loop (PORTABLE — logic maps 1:1)

| Codex function | File:Lines | swarm-harness target | Status |
|----------------|-----------|---------------------|--------|
| `run_turn` | `turn.rs:136-422` | `HardenedNativeEngine.run()` outer loop | TODO |
| `run_sampling_request` | `turn.rs:999-1087` | `streamWithRetry()` private method | TODO |
| `try_run_sampling_request` | `turn.rs:1830-2214` | `streamAndDispatch()` private method | TODO |
| `drain_in_flight` | `turn.rs:1739-1763` | `drainInFlight()` private method | TODO |
| `auto_compact_token_status` | `turn.rs:732-782` | Reuse `shouldCompact()` from compactor.ts | TODO |
| `run_auto_compact` | `turn.rs:862-917` | `compactMidTurn()` private method | TODO |
| `handle_retryable_response_stream_error` | `responses_retry.rs:22-79` | `handleRetryableError()` private method | TODO |
| `SamplingRequestResult` | `turn.rs:1202-1206` | `TurnResult` type | TODO |
| `AutoCompactTokenStatus` | `turn.rs:718-730` | Reuse `estimateSessionTokens()` | TODO |

### 4.2  Tool execution (PORTABLE — needs ToolScheduler adaptation)

| Codex function | File:Lines | swarm-harness target | Status |
|----------------|-----------|---------------------|--------|
| `ToolCallRuntime.handle_tool_call` | `parallel.rs:62-79` | Eager dispatch in streaming loop | TODO |
| `handle_tool_call_with_source` | `parallel.rs:81-178` | `ToolScheduler.add()` per tool during stream | TODO |
| `failure_response` | `parallel.rs:186-211` | Error ToolResult → tool_result event | TODO |
| `aborted_response` | `parallel.rs:213-222` | Abort ToolResult on signal | TODO |

### 4.3  Retry engine (PORTABLE — direct translation)

| Codex function | File:Lines | swarm-harness target | Status |
|----------------|-----------|---------------------|--------|
| `handle_retryable_response_stream_error` | `responses_retry.rs:22-79` | `RetryPolicy.handleError()` | TODO |
| `log_retry` | `responses_retry.rs:81-105` | Yield `info` NormalizedEvent | TODO |
| `try_switch_fallback_transport` | `client.rs:1636-1646` | `RetryingProvider` fallback logic | TODO |

### 4.4  Streaming delta handling (ADAPT — different event types)

| Codex function | File:Lines | swarm-harness equivalent | Notes |
|----------------|-----------|-------------------------|-------|
| `ResponseEvent::OutputItemDone` match | `turn.rs:1871-1950` | `ProviderEvent "tool-call"` handler | Codex queues tool immediately; we do same |
| `ResponseEvent::OutputTextDelta` | `turn.rs:1990-2010` | `ProviderEvent "text-delta"` handler | Already implemented |
| `ResponseEvent::ToolCallInputDelta` | `turn.rs:2050-2070` | `ProviderEvent "tool-input-delta"` handler | Already implemented |
| `ResponseEvent::Completed` | `turn.rs:2100-2180` | `ProviderEvent "finish"` handler | Add drain_in_flight |

### 4.5  Context management (ADAPT — different compaction strategy)

| Codex function | File:Lines | swarm-harness target | Notes |
|----------------|-----------|---------------------|-------|
| `run_pre_sampling_compact` | `turn.rs:784-804` | Existing pre-turn compaction (line 177) | Already implemented |
| Mid-turn compaction check | `turn.rs:268-321` | New: check after tool results | Uses existing compactor |
| `auto_compact_token_status` | `turn.rs:732-782` | `shouldCompact()` + `estimateSessionTokens()` | Mechanical (no LLM) |

### 4.6  SKIP — Codex-specific, not ported

| Codex function | File:Lines | Reason |
|----------------|-----------|--------|
| `submission_loop` | `handlers.rs:738-887` | swarm-harness uses one-shot run() |
| `build_skills_and_plugins` | `turn.rs:456-611` | swarm-harness has own skill/plugin system |
| `mirror_user_text_to_realtime` | `handlers.rs:298-318` | Realtime/WebRTC not applicable |
| `handle_plan_segments` | `turn.rs:1464-1525` | Plan mode deferred to future work |
| `realtime_conversation_list_voices` | `handlers.rs:76-86` | Realtime not applicable |
| `thread_rollback` | `handlers.rs:494-592` | Different persistence model |
| `set_thread_memory_mode` | `handlers.rs:612-624` | No memory system yet |
| `approve_guardian_denied_action` | `handlers.rs:889-927` | No Guardian system |
| `review` | `handlers.rs:702-736` | Different review model |
| All telemetry/OTEL | various | Out of scope |
| WebSocket transport | `client.rs:1344-1478` | Vercel AI SDK owns transport |
| Responses API request building | `client.rs:736-792` | Provider abstraction handles this |
| Auth recovery (401 flows) | `client.rs:1969-2083` | Provider handles auth |

## 5  Interface Changes

### 5.1  New types

```typescript
/** Retry policy for stream errors. */
export interface RetryPolicy {
  /** Max retry attempts per provider stream call. Default: 3. */
  readonly maxRetries: number;
  /** Base backoff in ms. Actual delay: base * 2^attempt. Default: 100. */
  readonly backoffBaseMs: number;
  /** Classify whether an error is retryable. Default: code !== context_overflow && code !== invalid_request */
  readonly isRetryable?: (error: ProviderError) => boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  backoffBaseMs: 100,
};
```

### 5.2  RunConfig additions

```typescript
export interface RunConfig {
  // ... existing fields unchanged ...

  /** Retry policy for provider stream errors. When absent, no retry (current behavior). */
  readonly retryPolicy?: RetryPolicy;

  /** When true, tool calls are dispatched during streaming (eager).
   *  When false, dispatched after stream completes (batch). Default: false. */
  readonly eagerToolDispatch?: boolean;

  /** When true, compaction is checked after tool results mid-turn.
   *  Default: false (pre-turn compaction only). */
  readonly midTurnCompaction?: boolean;
}
```

### 5.3  New NormalizedEvent variants

```typescript
// Added to NormalizedEvent union:
| { readonly type: "retry"; readonly attempt: number; readonly maxRetries: number;
    readonly error: ProviderError; readonly delayMs: number }
```

### 5.4  New EngineCapabilities field

```typescript
export interface EngineCapabilities {
  // ... existing fields unchanged ...
  /** Engine supports retry on transient stream errors. */
  readonly retry?: boolean;
  /** Engine dispatches tools eagerly during streaming. */
  readonly eagerToolDispatch?: boolean;
}
```

### 5.5  Unchanged interfaces

These interfaces require NO modifications:

- `AgentEngine` (run signature unchanged)
- `Provider` / `ProviderEvent` / `ProviderRequest` / `ProviderMessage`
- `ToolImpl` / `ToolResult` / `ToolRequest` / `ToolExecutionContext`
- `ToolDispatcher` / `ToolScheduler` / `ToolAccesses`
- `CompactionConfig` / `shouldCompact` / `compactSession` / `estimateTokens`
- `PermissionGate` / `PermissionDecision`
- `SessionSnapshot` (engineId: "hardened-native", data: HardenedNativeSnapshot)
- `Usage` / `StopReason` / `ProviderError`

## 6  Detailed Design

### 6.1  Retry engine

Wraps the provider stream call in a retry loop. Maps to Codex's
`run_sampling_request` (turn.rs:999-1087) + `handle_retryable_response_stream_error`
(responses_retry.rs:22-79).

```
streamWithRetry(request, retryPolicy):
  for attempt in 0..maxRetries:
    try:
      yield* streamAndDispatch(request)
      return  // success
    catch (err):
      providerError = classifyError(err)
      if !retryPolicy.isRetryable(providerError):
        yield error event
        return
      if attempt === maxRetries:
        yield error event
        return
      delayMs = retryPolicy.backoffBaseMs * 2^attempt
      yield retry event (attempt, delay, error)
      await sleep(delayMs)  // interruptible via abort signal
      continue
```

**Error classification** (maps to Codex's error hierarchy):

| ProviderError.code | Retryable | Codex equivalent |
|--------------------|-----------|------------------|
| `transport` | Yes | Stream disconnection |
| `rate_limit` | Yes | 429 response |
| `provider_unavailable` | Yes | 500/503 response |
| `context_overflow` | No | ContextWindowExceeded |
| `invalid_request` | No | UsageLimitReached |
| `auth` | No | 401 (no credential pool) |
| `unknown` | Yes (1 retry) | Defensive retry |

### 6.2  Eager tool dispatch

Changes the streaming loop from "buffer all, then batch" to "dispatch each
tool as it arrives." Maps to Codex's `try_run_sampling_request`
(turn.rs:1830-2214) with `FuturesOrdered` pattern.

```
streamAndDispatch(request):
  inFlight = new Map<string, Promise<ToolResult>>()
  needsFollowUp = false

  for await (ev of provider.stream(request)):
    switch ev.type:
      "text-delta":     yield text_delta
      "tool-input-start": yield tool_use_start
      "tool-input-delta": yield tool_use_input
      "tool-call":
        yield tool_use_end
        decision = await canUseTool(ev.name, ev.input)
        if decision.allow:
          promise = dispatcher.dispatch(ev.name, decision.updatedInput ?? ev.input, ctx)
          inFlight.set(ev.id, promise)
        else:
          inFlight.set(ev.id, Promise.resolve({ status: "error", message: decision.reason }))
        needsFollowUp = true
      "finish":
        stopReason = ev.stopReason
        turnUsage = ev.usage
      "error":
        yield error; streamErrored = true

  // Drain all in-flight tools (maps to Codex drain_in_flight)
  for (const [id, promise] of inFlight):
    result = await promise
    yield tool_result(id, result)
    messages.push(tool_result_message)

  return { needsFollowUp, stopReason, turnUsage }
```

**Interaction with ToolScheduler**: Each `dispatcher.dispatch()` call goes
through the scheduler's conflict graph internally. Non-conflicting tools
start immediately; conflicting tools queue. This is strictly better than
Codex's binary RwLock (parallel vs serial).

**Abort handling**: Each `dispatch()` call receives a child abort signal.
On abort during drain, pending promises are settled with error results.

### 6.3  Mid-turn compaction

After tool results are appended to messages, check token budget before
the next provider call. Maps to Codex's mid-turn compaction check
(turn.rs:268-321).

```
// After tool results appended, before continuing turn loop:
if midTurnCompaction && shouldCompact({ messages }, compactionConfig):
  yield compaction(phase: "begin", trigger: "mid-turn")
  result = compactSession({ messages }, compactionConfig)
  messages = result.compactedSession.messages.slice()
  yield compaction(phase: "end", trigger: "mid-turn")
  compactionCount++
```

Uses the existing mechanical compactor. No new compactor interface needed.
LLM-based compaction (like Codex's remote compact) is a future enhancement.

### 6.4  Provider retry decorator

Composable wrapper around any Provider that handles transport-level failures.
Maps to Codex's WebSocket → HTTPS fallback (client.rs:1636-1646).

```typescript
export class RetryingProvider implements Provider {
  constructor(
    private readonly primary: Provider,
    private readonly fallback?: Provider,
    private readonly policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  ) {}

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    for (let attempt = 0; attempt <= this.policy.maxRetries; attempt++) {
      try {
        const provider = attempt > this.policy.maxRetries / 2 && this.fallback
          ? this.fallback
          : this.primary;
        yield* provider.stream(request);
        return;
      } catch (err) {
        if (attempt === this.policy.maxRetries) throw err;
        if (!isRetryableTransportError(err)) throw err;
        await sleep(this.policy.backoffBaseMs * Math.pow(2, attempt));
      }
    }
  }
}
```

### 6.5  Snapshot format

```typescript
export interface HardenedNativeSnapshot {
  readonly messages: readonly ProviderMessage[];
  readonly turnCount: number;
  readonly compactionCount: number;
  readonly cumulativeUsage: Usage;
  /** Retry statistics for observability. */
  readonly retryStats: {
    readonly totalRetries: number;
    readonly retriesThisTurn: number;
  };
}
```

## 7  Invariants

Carried over from Codex and swarm-harness, verified by tests:

1. **Tool results returned in original order** — even with eager dispatch and
   out-of-order completion, results are yielded in the order the model
   emitted tool_use blocks.

2. **Permission gate invoked once per tool call** — not per retry attempt.
   Retries replay the same approved input.

3. **Compaction never orphans tool_use/tool_result pairs** — boundary walk-back
   ensures pairs are kept together (existing invariant from compactor.ts).

4. **Non-retryable errors exit immediately** — context_overflow, invalid_request,
   and auth errors never retry.

5. **Abort signal respected during backoff** — retry sleep is interruptible.

6. **Cumulative usage is monotonically increasing** — retried turns add to
   cumulative, not replace.

7. **Snapshot is atomic** — written via temp + rename (existing invariant).

8. **Eager dispatch does not change tool semantics** — tools see the same input
   regardless of eager vs batch dispatch.

## 8  Migration

- `NativeEngine` stays as-is (280 lines, reference implementation)
- `HardenedNativeEngine` is a new class in `src/engine/hardened-native.ts`
- CLI flag `--engine hardened-native` selects the new engine
- Default engine for swarm workers: `hardened-native` (once stable)
- Default engine for interactive CLI: `claude-agent-sdk` (unchanged)
