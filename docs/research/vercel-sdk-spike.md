# Vercel AI SDK Spike — Phase 0.5 Findings

Date: 2026-04-21  
Branch: mvp

---

## 1. Installed Versions (exact, pinned)

| Package | Version |
|---------|---------|
| `ai` | `6.0.168` |
| `@ai-sdk/openai` | `3.0.53` |

Both are now pinned without `^` or `~` in `package.json`.

`npx tsc --noEmit` — **clean, zero errors** after install.

---

## 2. `streamText().fullStream` — Canonical `TextStreamPart<TOOLS>` Union

The type is `TextStreamPart<TOOLS>` (generic over `ToolSet`). Every `part.type` discriminator value, in emission order:

### Lifecycle / framing

| `part.type` | Fields | Notes |
|-------------|--------|-------|
| `'start'` | _(none)_ | Stream opened |
| `'start-step'` | `request: LanguageModelRequestMetadata`, `warnings: CallWarning[]` | Per-step open |
| `'finish-step'` | `response: LanguageModelResponseMetadata`, `usage: LanguageModelUsage`, `finishReason: FinishReason`, `rawFinishReason: string \| undefined`, `providerMetadata: ProviderMetadata \| undefined` | Per-step close |
| `'finish'` | `finishReason: FinishReason`, `rawFinishReason: string \| undefined`, `totalUsage: LanguageModelUsage` | Stream closed |
| `'abort'` | `reason?: string` | Stream aborted |
| `'error'` | `error: unknown` | Error event |
| `'raw'` | `rawValue: unknown` | Raw provider chunk (passthrough) |

### Text streaming

| `part.type` | Fields | Notes |
|-------------|--------|-------|
| `'text-start'` | `id: string`, `providerMetadata?` | New text block begins |
| `'text-delta'` | `id: string`, `text: string`, `providerMetadata?` | **Field is `text`, NOT `textDelta`** |
| `'text-end'` | `id: string`, `providerMetadata?` | Text block complete |

### Reasoning (available for o-series models)

| `part.type` | Fields | Notes |
|-------------|--------|-------|
| `'reasoning-start'` | `id: string`, `providerMetadata?` | Reasoning block begins |
| `'reasoning-delta'` | `id: string`, `text: string`, `providerMetadata?` | Reasoning token delta |
| `'reasoning-end'` | `id: string`, `providerMetadata?` | Reasoning block complete |

### Tool call streaming (SDK handles arg accumulation)

| `part.type` | Fields | Notes |
|-------------|--------|-------|
| `'tool-input-start'` | `id: string`, `toolName: string`, `providerMetadata?`, `providerExecuted?: boolean`, `dynamic?: boolean`, `title?: string` | Tool call begins |
| `'tool-input-delta'` | `id: string`, `delta: string`, `providerMetadata?` | Partial JSON args delta |
| `'tool-input-end'` | `id: string`, `providerMetadata?` | Args accumulation done |
| `'tool-call'` | `type: 'tool-call'` + `TypedToolCall<TOOLS>`: `{ toolCallId: string, toolName: string, input: <typed> }` | **Fully assembled tool call** |
| `'tool-result'` | `type: 'tool-result'` + `TypedToolResult<TOOLS>`: `{ toolCallId, toolName, input, output }` | Tool execution result |
| `'tool-error'` | `type: 'tool-error'` + `TypedToolError<TOOLS>`: `{ toolCallId, toolName, input, error }` | Tool execution error |
| `'tool-output-denied'` | Human-approval denied | Approval workflow |

### Source / file

| `part.type` | Fields |
|-------------|--------|
| `'source'` | `& Source` (url/document union) |
| `'file'` | `file: GeneratedFile`, `providerMetadata?` |

---

## 3. Plan Assumptions vs Reality — Mismatch Table

### §10 `ProviderEvent` — Required Adjustments

| Plan assumed | SDK reality | Action |
|---|---|---|
| `type: "text-delta"` | `type: 'text-delta'` | **Matches** |
| `text: part.textDelta` | `text: part.text` | **MISMATCH** — field is `text`, not `textDelta` |
| `type: "tool-call-end"` (single event) | `type: 'tool-call'` (after `tool-input-start/delta/end`) | **MISMATCH** — SDK emits `'tool-call'` not `'tool-call-end'` |
| `id: part.toolCallId` | `part.toolCallId` | **Matches** |
| `input: part.input` | `part.input` | **Matches** (not `args`) |
| `type: "finish"` | `type: 'finish'` | **Matches** |
| `type: "error"` | `type: 'error'`, field `error: unknown` | **Matches** |
| `reasoning-delta` assumed absent or unknown | `type: 'reasoning-delta'` **exists**, field `text: string` | **Reasoning IS supported** |
| `type: "done"` (if assumed) | Does not exist | Use `'finish'` |

### §2.4 Stream Translation Switch — Required Adjustments

The plan's switch statement in `OpenAITransportProvider.stream()` needs these corrections:

```ts
// WRONG (plan):
case "text-delta": yield { type: "text-delta", text: part.textDelta }; break;

// CORRECT:
case "text-delta": yield { type: "text-delta", text: part.text }; break;

// WRONG (plan):
case "tool-call": yield { type: "tool-call-end", ... }; break;

// CORRECT — SDK uses 'tool-call' (already assembled), our ProviderEvent should use 'tool-call' not 'tool-call-end':
case "tool-call": yield { type: "tool-call", id: part.toolCallId, name: part.toolName, input: part.input }; break;

// Reasoning (not in plan, needs adding):
case "reasoning-delta": yield { type: "reasoning-delta", text: part.text }; break;
```

Also note: `'start-step'` and `'finish-step'` exist (multi-step / agentic loops). The plan only mentions `'finish'`. For the initial MVP single-step case, only `'finish'` is needed — but the switch must handle or ignore `'start-step'`/`'finish-step'` to avoid unhandled cases.

---

## 4. `FinishReason` → `StopReason` Mapping

SDK type: `type FinishReason = 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other'`

Note: **no `'unknown'`** — the plan assumed `'unknown'` as a possible value. It is absent from the SDK union.

| `FinishReason` (SDK) | Recommended `StopReason` (our type) |
|---|---|
| `'stop'` | `'stop'` |
| `'length'` | `'max_tokens'` |
| `'tool-calls'` | `'tool_use'` |
| `'content-filter'` | `'content_filtered'` |
| `'error'` | `'error'` |
| `'other'` | `'other'` |

Raw string is also available as `rawFinishReason: string | undefined` on both `'finish-step'` and `'finish'` parts.

---

## 5. Message Type Names

- **`CoreMessage` does NOT exist** in `ai@6`. The exported type is `ModelMessage` (re-exported from `@ai-sdk/provider-utils`).
- Plan §2.1 import `import { streamText, type LanguageModel, type ToolSet } from "ai"` — all three names **exist and match**.
- `LanguageModel` in v6 is: `type LanguageModel = GlobalProviderModelId | LanguageModelV3 | LanguageModelV2` (union type, not a simple interface).
- Messages in `streamText()` params use `messages: Array<ModelMessage>`, `system?: string | SystemModelMessage | ...`.
- `convertToModelMessages()` is exported — useful for converting from our internal format.

---

## 6. Prompt Cache / Token Metadata

Cache metadata **is surfaced** via `LanguageModelUsage.inputTokenDetails`:

```ts
type LanguageModelUsage = {
  inputTokens: number | undefined;
  inputTokenDetails: {
    noCacheTokens: number | undefined;     // non-cached prompt tokens
    cacheReadTokens: number | undefined;   // cached tokens read (cache hit)
    cacheWriteTokens: number | undefined;  // cached tokens written
  };
  outputTokens: number | undefined;
  outputTokenDetails: { ... };
}
```

Available on `'finish-step'` and `'finish'` parts as `usage` / `totalUsage`.

The `@ai-sdk/openai` provider also exposes `promptCacheKey?: string` and `promptCacheRetention?: "in_memory" | "24h"` as **request options** (per-message in the provider options schema). The raw OpenAI response `cached_tokens` count surfaces in `inputTokenDetails.cacheReadTokens`.

There is a deprecated `cacheReadTokens` top-level field on `LanguageModelUsage` — use `inputTokenDetails.cacheReadTokens` instead.

---

## 7. Reasoning Parts

Reasoning is fully supported in the SDK part stream:

- `'reasoning-start'`: `{ id: string }`
- `'reasoning-delta'`: `{ id: string, text: string }` — the delta text (not `textDelta`)
- `'reasoning-end'`: `{ id: string }`

The `@ai-sdk/openai` provider surfaces `OpenaiResponsesReasoningProviderMetadata` for o-series models via `providerMetadata`.

The plan's `ProviderEvent` should include a `reasoning-delta` variant.

---

## 8. ToolSet Type

`type ToolSet = Record<string, Tool<never, never> | Tool<any, any> | ...>` — exported from `ai`. The `Tool` type has `execute`, `onInputAvailable`, `onInputStart`, `onInputDelta`, `needsApproval` fields. For our use (external dispatch), we do NOT set `execute` — the SDK will emit `'tool-call'` parts and wait. This matches the plan's intent.

---

## 9. `tsc --noEmit` Result

**Clean — zero errors, zero warnings** after installing both packages.

---

## 10. Summary of Required Plan Adjustments

1. **`text-delta` field**: `part.text` not `part.textDelta` — fix §2.4 switch and §10 `ProviderEvent` shape.
2. **`tool-call` discriminator**: SDK emits `'tool-call'` (not `'tool-call-end'`) once args are fully assembled — rename in `ProviderEvent` and switch.
3. **`CoreMessage` → `ModelMessage`**: Update all references in the plan to use `ModelMessage` from `ai`.
4. **`FinishReason` has no `'unknown'`**: Remove from plan's assumed values; map `'other'` as the catch-all.
5. **Reasoning IS present**: Add `'reasoning-delta'` (field: `text: string`) to `ProviderEvent` union.
6. **`'finish-step'` / `'start-step'`**: Must be handled (or explicitly `default:`-ignored) in the switch for multi-step safety.
7. **Cache tokens**: Access via `usage.inputTokenDetails.cacheReadTokens` (not a top-level `promptCache` object).
