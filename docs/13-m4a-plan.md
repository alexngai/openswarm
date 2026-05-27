# M4a NativeEngine foundation + OpenAI TransportProvider — Implementation Plan

**Status:** draft (rev 2)
**Owner:** alex
**Created:** 2026-04-20
**Prereq:** M3b complete (`250456b`, 841 tests / 85 files passing on `mvp`).
**Refines:** the `NativeEngine` + `Provider` + model-prefix routing slice of §"Milestone M4 — provider breadth + ChatGPT subscription" in `docs/07-implementation-plan.md`. M4a establishes the engine + one TransportProvider (OpenAI) and the routing table. M4b adds xAI / Google / DashScope, the ChatGPT Plus/Pro `FrameworkProvider`, and the plugin install/enable/disable surface.

## Scope

M0–M3 runs every turn through `ClaudeAgentSdkEngine` — a thin wrapper over `@anthropic-ai/claude-agent-sdk`. That engine owns the turn loop, MCP, compaction, cache, session. M4a stands up a **second** `AgentEngine` implementation — `NativeEngine` — that composes our own turn loop with the Vercel AI SDK as transport and our M2 MCP client + a ported mechanical compactor. It proves the `Provider` interface against a real non-Anthropic model (OpenAI) end-to-end, yielding the **same** `NormalizedEvent` stream the rest of the system already consumes. M4b then slots in additional transports (xAI, Google, DashScope) by dropping new `TransportProvider` classes behind the same interface.

**In scope:**

1. **Dependencies + pinned versions** — add `ai` (Vercel AI SDK core) and `@ai-sdk/openai` to `package.json` at pinned versions; no other new runtime deps. Dev: no changes.
2. **`Provider` interface promotion** — `src/providers/index.ts` moves from stub → real interface. Keeps the shape already documented in `docs/03-interfaces.md §2`, plus a new `stream(request): AsyncIterable<ProviderEvent>` method and a `ProviderEvent` union that NativeEngine consumes. Adds a `TransportProvider` sub-interface marker (in contrast to the future `FrameworkProvider` used by Claude-Agent-SDK / Codex paths).
3. **`OpenAITransportProvider`** (`src/providers/openai-transport.ts`) — wraps `@ai-sdk/openai` via Vercel AI SDK's `streamText()`. Implements `Provider.stream()` by translating Vercel's part stream (`text-delta`, `tool-call`, `tool-call-delta`, `finish`, `error`, etc.) to our `ProviderEvent`. Handles the known model-family quirks from `docs/research/01-api.md §6`:
   - `gpt-5*` → use `max_completion_tokens` (`maxOutputTokens` → passes through under the new name)
   - Reasoning models (`o1*`, `o3*`, `o4*`, anything matching `*-thinking*`) → strip `temperature`, `topP`, `topK`, `presencePenalty`, `frequencyPenalty`
   - Tool schemas translated from our Zod/JSON-Schema → Vercel AI SDK `tools` map; tool calls surface via provider tool calling (NOT MCP-via-SDK)
   - `ProviderCapabilities.promptCache` — verify whether `@ai-sdk/openai` surfaces OpenAI's `prompt_cache_key` / `cached_tokens` at implementation time; ship `false` if unsupported and open a follow-up ticket. M4a's correctness path does not depend on OpenAI caching.
4. **`NativeEngine`** (`src/engine/native.ts`) — an `AgentEngine` that **composes**, not wraps. Responsibilities:
   - Owns its turn loop (while not stopped and not over `maxTurns`: call `provider.stream()`, stream deltas up as `NormalizedEvent`s, collect tool_use blocks, run them through our `ToolDispatcher` (reusing M3b's `dispatchBatch` for parallel tool use, gated by `ProviderCapabilities.parallelToolUse`), loop).
   - Runs **our** `Compactor` (see §7 below) — tool-use/tool-result boundary-guarded, mechanical, triggered by token estimate. Emits `compaction` NormalizedEvent begin/end and runs the post-compaction `glob` health probe already present in the SDK engine.
   - Binds to **our** M2 MCP client (`src/mcp/client.ts`) for first-class MCP tool registration — each MCP tool is already a `ToolImpl` in the dispatcher, so NativeEngine sees them at `config.tools` parity with the SDK path.
   - Reuses M0 `SessionStore`, M0 `PermissionEngine` via `canUseTool` (identical contract to SDK engine), M3a role allowlists, M3a BranchPolicy/EscalationPolicy (orchestrator layer — transparent to the engine), M2 HookRuntime.
   - `EngineCapabilities`: `{ streaming: true, promptCache: <provider>.capabilities.promptCache, parallelToolUse: <provider>.capabilities.parallelToolUse, mcp: false, compaction: false, resume: true, maxContextTokens / maxOutputTokens from provider }`. Note `mcp: false` and `compaction: false` — outer code must NOT assume the engine owns these; that's the correct signal.
5. **Model-prefix routing** (`src/providers/routing.ts`) — pure function `resolveProvider(modelId, authRegistry, frameworkPref): ResolvedProvider`. Priority matches `docs/research/01-api.md §6`:
   - `claude*` → (see scope decision §A below) ClaudeAgentSdkEngine by default; NativeEngine + `@ai-sdk/anthropic` is deferred to M4b.
   - `gpt*` / `o1*` / `o3*` / `o4*` → `OpenAITransportProvider` via NativeEngine.
   - `openai/*` → strip prefix, then OpenAI as above (supports OpenRouter-style prefixed routing for M4b hand-off).
   - Unmatched → `{ kind: "error", message: "unknown model prefix — known: claude*, gpt*, o1*, o3*, o4* (M4a). xAI/Google/Qwen land in M4b." }`
   - Env-var sniffing fallback (from claw's `anthropic_missing_credentials_hint`) → M4b.
6. **Model alias table** (`src/providers/aliases.ts`) — read from `~/.swarm-harness/settings.json` under `aliases: { [alias: string]: modelId }`. Built-in defaults ship in code:
   - `sonnet` → `claude-sonnet-4-6`, `haiku` → `claude-haiku-4-5`, `opus` → `claude-opus-4-7` (Anthropic)
   - `gpt-4o` → `gpt-4o-2024-11-20`, `gpt-5` → `<pin at implementation time against OpenAI's actual model list; current value is illustrative>` (pin at implementation time against OpenAI's current published model ids)
   - `o3` → `o3-mini-2025-01-31`
   User aliases in settings override built-ins. CLI `--model <alias-or-id>` resolves via aliases first, then routes.
7. **CLI flag `--framework <native|claude-agent-sdk|auto>`** — `src/cli/argv.ts` picks up a new flag. `auto` (default) consults routing to pick the right engine per resolved model; `native` forces NativeEngine regardless of model prefix (errors clearly if the provider doesn't exist yet — e.g. `--framework native --model claude-...` in M4a returns an error suggesting M4b); `claude-agent-sdk` forces ClaudeAgentSdkEngine regardless of model (errors if the model isn't Anthropic).
8. **Cross-provider stream translation** — fully delegated to Vercel AI SDK's normalized part stream. Our translation layer is ONLY `ProviderEvent` → `NormalizedEvent` inside NativeEngine. We explicitly do NOT port claw's OpenAI→Anthropic translator (research/01-api.md §6 — Vercel subsumes it).
9. **Compactor** (`src/engine/compactor.ts`) — port the mechanical compactor from `references/claw-code/rust/crates/runtime/src/compact.rs` (entire file excluding `#[cfg(test)]` module, L1–L553) adapted to our `NormalizedEvent` session shape:
   - `CompactionConfig { preserveRecentMessages: 4, maxEstimatedTokens: 10_000 }` (defaults from claw; expose to `RunConfig`).
   - `shouldCompact(session, config): boolean` — token-estimate over the tail beyond any existing summary prefix.
   - `compactSession(session, config): CompactionResult` — emits summary, preserves tail, **walks the keep boundary back if the first preserved message starts with a `ToolResult` block** (the load-bearing boundary guard — claw/compact.rs L118–L157). Our adaptation: our session stores `NormalizedEvent`s, so "message whose first block is ToolResult" maps to "a sequence ending at a `tool_use_end` whose next event is a tool_result with no matching tool_use before it in the kept window".
   - `summarize()` is claw's template summary (scope counters + tool-name dedup + recent-user-requests snippet). No LLM call — mechanical only, per Q14.
   - Exported surface includes: `shouldCompact`, `compactSession`, `estimateTokens`, `estimateSessionTokens`, `summarize_messages` / `summarizeMessages`, `mergeCompactSummaries`, `extractExistingCompactedSummary`, `formatCompactSummary`, `getCompactContinuationMessage`, `compactedSummaryPrefixLen`. See §3.1 for the full API.
10. **`ProviderRequest` / `ProviderEvent`** — defined once in `src/providers/index.ts`; shape:
    - `ProviderRequest { messages, tools, systemPrompt, model, maxOutputTokens?, temperature?, topP?, topK?, stop?, abort?, tool_choice?, promptCacheHint? }`
    - `ProviderEvent` union: `"text-delta" { text }` | `"tool-call-start" { id, name, input? }` | `"tool-call-delta" { id, inputDelta }` | `"tool-call-end" { id, name, input }` | `"finish" { stopReason, usage }` | `"error" { code, message, retryable }` | `"reasoning-delta" { text }` (for thinking models; surfaced verbatim).
11. **Worker-entry + argv wiring** — `src/cli/worker-entry.ts` reads `--framework` + model; constructs the right engine. Swarm workers (M3a) propagate `SWARM_HARNESS_FRAMEWORK` so subprocess workers inherit the parent's choice.

**Explicitly OUT of M4a (M4b or later):**

- **xAI** (`@ai-sdk/xai`) TransportProvider — M4b.
- **Google** (`@ai-sdk/google`) TransportProvider — M4b.
- **DashScope / Qwen via OpenAI-compat** — M4b (including the 6 MB request-body cap from research/01-api.md §8).
- **ChatGPT Plus/Pro subscription auth** (`CodexChatGPTProvider` / `OpenAIOAuthAuth`) — M4b (per Q17; requires custom Vercel provider against `chatgpt.com/backend-api/codex/responses`).
- **Plugin install / enable / disable / update / uninstall** — M4b.
- **GitHub Copilot** — permanently out (Q18).
- **NativeEngine against Claude** — deferred to M4b or later. M4a's NativeEngine targets OpenAI only; `claude*` stays on ClaudeAgentSdkEngine. Rationale in decision §A.
- **Our own MCP client implementation** — already landed in M2 (`src/mcp/client.ts` + `src/mcp/bridge.ts`); M4a reuses as-is.
- **Cross-engine resume** (start on SDK, resume on native) — out per Q3 stability policy; `SessionSnapshot.engineId` already gates this.
- **Kimi-specific `is_error` drop** — not needed in M4a (OpenAI only); revisit in M4b's DashScope path if Kimi lands there.
- **Env-var sniffing fallback** for missing credentials hint — M4b.
- **`OpenAIApiKeyAuth`** `AuthSource` implementation — see decision §G; M4a wires a minimal `reads OPENAI_API_KEY` auth source; polished `--provider openai login/logout` flows land in M4b with `OpenAICompatApiKeyAuth`.
- **`OpenAICompatApiKeyAuth`** for Ollama / LM Studio / OpenRouter via `OPENAI_BASE_URL` — M4b.
- **Routing "explain" debug output** (research/01-api.md §6) — M4b niceity.

## Decision context

Eight scope/mechanism choices lock before implementation starts. Defaults below; each has a one-line rationale.

**A. `claude*` routing default in M4a: keep ClaudeAgentSdkEngine; do NOT add NativeEngine-via-Anthropic path.**
Rationale: the ClaudeAgentSdkEngine already works for both API-key and Claude Max subscription users (M0 + M3 Claude Max note). Adding a second Anthropic path (NativeEngine + `@ai-sdk/anthropic`) in M4a doubles surface area for zero user-visible win — subscription users MUST stay on the SDK path (Q16) and API-key users have no reason to switch. Deferring keeps M4a's 5–8 day budget defensible and leaves the decision to M4b when a real driver exists (e.g. wanting parallel tool execution that bypasses the SDK's MCP bridge serialization observed in M3b Phase 4). Alternative "default NativeEngine for `claude*` + API key, SDK only for Max" considered and rejected: no operator benefit for 2× code path maintenance. Flag it in the routing error message so testers know to use `--framework claude-agent-sdk` for Claude.

**B. `Provider.stream()` surface shape: mirrors Vercel AI SDK part stream 1:1 as `ProviderEvent`, not a thinner abstraction.**
Rationale: Vercel already normalizes across providers; re-normalizing in our layer adds a second drift surface with no benefit. Our `ProviderEvent` union is a semantic rename of the subset we consume, translated once inside NativeEngine to `NormalizedEvent`. If M4b's xAI/Google providers surface new part kinds we don't yet consume, we extend the union — we don't re-shape it.

**C. Tool call plumbing: Vercel AI SDK's `tools` parameter, NOT MCP registration through the provider.**
Rationale: NativeEngine binds tools directly via `streamText({ tools: zodShapes })`. Each ToolImpl's Zod schema converts to Vercel's expected tool shape; when a `tool-call-end` event fires, NativeEngine dispatches through our `ToolDispatcher` (with `canUseTool` → `PermissionEngine` → tool execution → tool_result back into the next turn's messages). MCP tools are just ToolImpls in the dispatcher already (M2 bridge), so they work identically. This is strictly different from the SDK path, where MCP is registered via `createSdkMcpServer` and the SDK owns the call round-trip.

**D. Compactor adaptation: port claw's `compact.rs` entire file (L1–L553, excluding `#[cfg(test)]`) verbatim in logic, adapted to `NormalizedEvent`.**
Rationale: the load-bearing correctness piece is the tool-use/tool-result boundary guard (claw L118–L157). Any looser implementation 400s on OpenAI-compat when a tool_result lands without its matching tool_use (research/01-api.md §6 — `tool message must follow assistant with tool_calls`). Port the boundary walk-back logic faithfully; the summary template is claw's verbatim (scope counters + dedup tool names + recent user requests). No LLM-driven summary. Preserve the 4-recent-messages / 10k-token defaults for parity. Token estimation uses 4 chars/token (matching claw's `text.len() / 4 + 1`) — intentionally diverges from M3b's `countTokens` which uses 2.5 chars/token for a different surface.

**E. Session representation for compaction: NativeEngine maintains an internal `NormalizedEvent[]` message buffer alongside the session store's JSONL log.**
Rationale: our session store (M0 `src/session/store.ts`) is append-only JSONL — not a structured message array. The compactor operates on structured messages (role, blocks). NativeEngine materializes a working message array from the event stream in-memory; on `SessionSnapshot.save`, we serialize this buffer (plus turn count + cumulative usage) under `data: { messages, turnCount, usage, compactionCount }`. This is the native engine's snapshot; `engineId: "native"` blocks cross-engine resume per Q3.

**F. `OPENAI_API_KEY` reading: minimal `OpenAIEnvAuth` in M4a; full `OpenAIApiKeyAuth` + login/logout polish in M4b.**
Rationale: M4a proves the end-to-end path. `OpenAIEnvAuth` just reads `process.env.OPENAI_API_KEY` and implements `headers()` / `isAuthenticated()` — enough for the engine to work. Matches the pattern of M0's `AnthropicApiKeyAuth` in spirit (simplicity). M4b adds `swarm-harness login --provider openai` with token persistence. If `OPENAI_API_KEY` is missing at engine construction, NativeEngine returns a friendly error with the env var name mentioned.

**G. Parallel tool execution in NativeEngine: inherit M3b's `dispatchBatch`; `ProviderCapabilities.parallelToolUse: true` for OpenAI.**
Rationale: M3b shipped `dispatchBatch` as infrastructure; SDK-mode parallelism was gated on SDK internals (ticket Phase 4 open item, resolved with caveat). NativeEngine has no such constraint — when OpenAI emits multiple tool_use blocks in one turn, we fan them out with `Promise.all` directly. This is the first real test of M3b's parallel infrastructure; we expect `concurrencySafe: false` serialization (e.g. `todo_write`) and HookRuntime reentrancy contracts (M3b §4.1) to just work. Add a smoke test case exercising 3 parallel reads on OpenAI to close M3b's Phase 4 caveat.

**H. Alias collision policy: user aliases in `settings.json` override built-ins; warn on shadowing.**
Rationale: users should be able to repoint `sonnet` → `claude-sonnet-5-0` when a new model ships without waiting for us to bump defaults. At engine construction, if a user alias shadows a built-in, emit a one-time `alias_shadowed` lane event with the overridden name. Validation: an alias whose value is itself an alias is rejected (one level of indirection; avoid cycles).

The plan below assumes all eight default picks; flip any before implementation starts if needed.

## Relationship to M3b

M3b shipped git coordination, prompt caching (Anthropic), `dispatchBatch` infrastructure, `notebook_edit`, `ask_user_question`, and token preflight. M4a builds on top without touching any of M3b's surface area — zero modifications to M3a/M3b files are expected except:

- `src/providers/index.ts` (stub → real; strictly additive in shape; M3b didn't consume it).
- `src/tools/dispatcher.ts` — **no changes**. `dispatchBatch` remains a single-arg method `dispatchBatch(requests: readonly ToolRequest[])`. `canUseTool` gating lives in NativeEngine's turn loop, immediately before `dispatchBatch`, to preserve M3b's dispatcher contract.
- `src/mcp/bridge.ts`, `src/mcp/client.ts` — no changes (consumed as-is).
- `src/engine/index.ts` — `EngineCapabilities` unchanged; RunConfig unchanged; we add a new field `providerId?` under `RunConfig` only if NativeEngine needs it for observability (decide during Phase 0 — leaning no, since `engine.id` carries the info).
- `src/cli/argv.ts` — new `--framework` flag (strictly additive).
- `src/cli/worker-entry.ts` — reads `SWARM_HARNESS_FRAMEWORK` env for inherited choice (strictly additive).
- `package.json` — new deps pinned.

Concrete integration points:

- **BranchPolicy / EscalationPolicy / role allowlists (M3a)** — all live at orchestrator/dispatcher level; NativeEngine sees only `RunConfig.allowedTools` and `config.tools` (filtered already). No changes.
- **HookRuntime (M2 + M3b §4.1 reentrancy)** — NativeEngine passes HookRuntime through to `ToolDispatcher` identically to ClaudeAgentSdkEngine. The SDK's own hooks pipeline doesn't exist in the native path, so hooks are entirely dispatcher-mediated — this simplifies vs. the SDK engine (no SDK `hooks` option to translate).
- **`ToolDispatcher.allowedTools` (M3a)** — the dispatcher filters tools before they reach `config.tools`; NativeEngine never sees disallowed tools. No code change.
- **Prompt caching (M3b Phase 3)** — Anthropic-specific via `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`. NativeEngine's first provider (OpenAI) may support it differently (OpenAI's `prompt_cache_key`); `ProviderCapabilities.promptCache` gates this. If `@ai-sdk/openai` surfaces the key at implementation time, we wire it; otherwise we ship with `promptCache: false` and `/cost` reports zero for OpenAI runs. M4b revisits when other providers land.
- **Parallel tool execution (M3b Phase 4)** — inherited; OpenAI is where real parallelism is first observable. Add one smoke scenario that proves 3-tool fan-out, closing M3b Phase 4's open caveat.

## Acceptance criteria

Each executable with a one-line test harness or manual smoke step.

1. `Provider` interface exports `stream(request): AsyncIterable<ProviderEvent>` and `capabilities: ProviderCapabilities`. Stub `LanguageModel` placeholder removed; real `import type { LanguageModel } from "ai"` used.
2. `ProviderEvent` union covers `text-delta`, `tool-call-start`, `tool-call-delta`, `tool-call-end`, `finish`, `error`, `reasoning-delta`. Verified by exhaustiveness test (a mock switch with `never` default).
3. `OpenAITransportProvider` instantiates from `{ modelId: "gpt-4o-2024-11-20", auth: OpenAIEnvAuth }` and `.capabilities.streaming === true`.
4. `OpenAITransportProvider.stream({ messages: [{role:"user", content:[{type:"text", text:"say hi"}]}] })` yields at least one `text-delta` event and one `finish` event with `usage.inputTokens > 0` against a real OpenAI API key (live smoke).
5. Model-family quirk: `resolveProvider("gpt-5-2026-02-01")` returns a provider whose `stream()` call passes `maxCompletionTokens` (not `maxTokens`) to the Vercel SDK. Verified by spying on the SDK call (unit test with a mock).
6. Model-family quirk: `resolveProvider("o3-mini-2025-01-31")` returns a provider that drops `temperature` / `topP` / `topK` / `presencePenalty` / `frequencyPenalty` from the SDK call — verified by spy test.
7. Model-family quirk: `resolveProvider("o3-mini-2025-01-31")` surfaces `reasoning-delta` events when the provider streams reasoning content (if `@ai-sdk/openai` exposes it at impl time; if not, AC is "no error, reasoning invisible"). Document the outcome in rev-2.
8. `NativeEngine` implements `AgentEngine`. `engine.id === "native"`. `engine.capabilities = { streaming: true, promptCache, parallelToolUse, mcp: false, compaction: false, resume: true, maxContextTokens, maxOutputTokens }` — mcp/compaction explicitly false.
9. `NativeEngine.run({ systemPrompt: "you are terse", prompt: "say hi", model: "gpt-4o", tools: [], auth: OpenAIEnvAuth, canUseTool: allowAll, permissionMode: "workspace-write" })` yields a NormalizedEvent stream ending with `message_stop { stopReason: "end_turn" }` against the real API (live smoke).
10. `NativeEngine` end-to-end with a single tool: `run(...)` with `tools: [read_file]` and a prompt that asks the model to read a fixture file → `tool_use_start` → `tool_use_input` → `tool_use_end { id }` NormalizedEvents → `canUseTool` fires → dispatcher runs `read_file` → `tool_result { toolUseId, content, isError }` flows back → next turn produces a `text_delta` summarizing the file → `message_stop`. (Unit test with scripted provider; live smoke with real API.)
11. `NativeEngine` with 3 parallel tool calls: scripted provider emits 3 `tool-call-end` events in one turn → NativeEngine runs `canUseTool` gate for each → `dispatchBatch(allowedRequests)` fans out → all three tools' `execute()` start within 50 ms of each other (same CI-stable threshold as M3b §12); `parallel_tool_batch` lane event fires; three `tool_use_end { id }` NormalizedEvents emitted before dispatch. **This closes M3b Phase 4's open caveat for the first time with a real concurrent path.**
12. `NativeEngine` compaction: scripted session with 15 messages totaling ~12k estimated tokens → `shouldCompact` returns true → `compactSession` emits a summary system message, preserves 4 recent messages, and **walks the keep boundary back when the 4-message tail would split a tool_use/tool_result pair**. Verified via unit test with a fixture session whose boundary falls inside a tool pair.
13. `NativeEngine` compaction emits `compaction { phase: "begin" }` and `compaction { phase: "end" }` NormalizedEvents, identical shape to what ClaudeAgentSdkEngine already emits.
14. `NativeEngine` post-compaction health probe: after `compaction { phase: "end" }`, the engine dispatches a `glob { pattern: "*" }` through `config.dispatcher`. If it throws, a `transport` error NormalizedEvent is emitted. (Matches ClaudeAgentSdkEngine behavior.)
15. `NativeEngine` resume: `run(...)` → engine writes `SessionSnapshot { engineId: "native", data: { messages, turnCount } }` → resume with same snapshot on a fresh engine → engine continues from message N+1 (verified by inspecting the next turn's message array).
16. Cross-engine resume blocked: `SessionSnapshot { engineId: "claude-agent-sdk" }` passed to `NativeEngine` → engine emits an `error { code: "unsupported_resume", retryable: false }` and does not start the loop. (And vice versa — symmetric.)
17. Routing: `resolveProvider("gpt-4o")` → `{ kind: "native", provider: OpenAITransportProvider }`. `resolveProvider("claude-sonnet-4-6")` → `{ kind: "sdk", engineFactory: ClaudeAgentSdkEngine }`. `resolveProvider("grok-3")` → `{ kind: "error", message: "unknown model prefix — xAI lands in M4b" }`. `resolveProvider("unknown-model")` → `{ kind: "error" }` with the known-prefixes list.
18. Alias resolution: `settings.json { aliases: { "my-fast": "gpt-4o-mini" } }` → `resolveProvider(resolveAlias("my-fast", settings))` → OpenAI provider with `gpt-4o-mini` model id. Built-in `sonnet` → `claude-sonnet-4-6` without user config. Cycle detection: `{ aliases: { a: "b", b: "a" } }` → `resolveAlias("a", settings)` throws with a clear message.
19. Alias shadowing: user alias `sonnet` → `claude-sonnet-5-0` → `resolveAlias("sonnet", settings)` returns `claude-sonnet-5-0`; one-time `alias_shadowed` lane event emitted on engine construction.
20. CLI `--framework auto` (default): `swarm-harness prompt --model gpt-4o "..."` selects NativeEngine + OpenAITransportProvider; `--model claude-sonnet-4-6` selects ClaudeAgentSdkEngine. Verified via `--dump-engine` debug flag (internal; not advertised in `--help`).
21. `swarm-harness --framework native --model claude-sonnet-4-6` exits non-zero with the error message:
    ```
    error: --framework native does not support Claude models in M4a.
    Use `--framework auto` (default) or `--framework claude-agent-sdk`.
    Native-via-@ai-sdk/anthropic is scheduled for M4b.
    ```
    Exit code 2.
22. CLI `--framework claude-agent-sdk --model gpt-4o`: errors with `"--framework claude-agent-sdk requires an Anthropic model; received gpt-4o."` Exit code 2.
23a. `OpenAITransportProvider.create(auth, modelId)` with missing `OPENAI_API_KEY` throws a clear error at construction time with the message `"error: OpenAITransportProvider requires OPENAI_API_KEY env var. Set it and retry."` — not at first stream.
23. Worker inheritance: parent invokes `swarm-harness swarm run --framework native tasks.jsonl` → child workers see `SWARM_HARNESS_FRAMEWORK=native` → children instantiate NativeEngine (not SDK). Verified via subprocess integration test.
24. `npx tsc --noEmit` passes strict mode with no new `any` in public interfaces.
25. `npm test` baseline 841 / 85 files (M3b complete) → target `841 + 40..60` tests for M4a; all passing.
26. `scripts/smoke-m4a.sh --offline` covers: (O1) scripted provider text-only round-trip; (O2) scripted provider with 1 tool call; (O3) scripted provider with 3 parallel tool calls; (O4) compactor with tool-pair boundary walk-back; (O5) compactor post-probe; (O6) routing table completeness; (O7) alias resolution (including cycle detect); (O8) cross-engine resume rejection.
27. `scripts/smoke-m4a.sh` (live) covers: (L1) `swarm-harness --model gpt-4o prompt "say hi"` succeeds; (L2) `swarm-harness --model gpt-4o prompt "read README.md and summarize"` produces a tool-use → tool_result → text turn; (L3) `swarm-harness --model o3-mini prompt "..."` succeeds without errors from unsupported params (reasoning model quirk test); (L4) parallel tool execution on `--model gpt-4o prompt "read a.txt, b.txt, c.txt in parallel"` — 3 `tool_use` starts within 50 ms.
28. `scripts/smoke.sh --all` invokes `smoke-m4a.sh` alongside all prior smoke scripts.
29. **Existing SDK-path acceptance remains intact**: `scripts/smoke.sh` (M0–M3b) still passes unchanged — no regressions in the default ClaudeAgentSdkEngine path.

## Implementation phases

### Phase 0 — Interface refinements (~0.4 day)

0.1. `src/providers/index.ts` (MODIFY, promote from stub → real):
```ts
import type { LanguageModel } from "ai";
import type { ToolSpec } from "../core/types.js";
import type { AuthSource } from "../auth/index.js";

export interface Provider {
  readonly id: string;                      // "openai" | "anthropic" | "xai" | ...
  readonly model: LanguageModel;
  readonly capabilities: ProviderCapabilities;
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>;
}

export interface ProviderCapabilities {
  readonly streaming: boolean;
  readonly promptCache: boolean;
  readonly parallelToolUse: boolean;
  readonly vision: boolean;
  readonly reasoning: boolean;              // NEW for M4a — surfaces thinking-model support
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
}

/** Marker: provider that speaks through Vercel AI SDK (vs. FrameworkProvider). */
export interface TransportProvider extends Provider {
  readonly kind: "transport";
}

export interface ProviderRequest {
  readonly messages: readonly ProviderMessage[];
  readonly tools?: readonly ToolSpec[];     // dispatcher-filtered already
  readonly systemPrompt?: string | readonly string[];
  readonly model: string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly stop?: readonly string[];
  readonly abort?: AbortSignal;
  readonly toolChoice?: "auto" | "required" | "none" | { name: string };
  /** Hint: prefer caching the prefix of systemPrompt. Provider may ignore. */
  readonly promptCacheHint?: boolean;
}

export type ProviderEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call-start"; id: string; name: string }
  | { type: "tool-call-delta"; id: string; inputDelta: string }
  | { type: "tool-call-end"; id: string; name: string; input: unknown }
  | { type: "finish"; stopReason: import("../core/types.js").StopReason; usage: import("../core/types.js").Usage }
  | { type: "error"; code: string; message: string; retryable: boolean };

// ProviderMessage mirrors the subset of NormalizedEvent we replay to the provider
export type ProviderMessage =
  | { role: "system"; content: readonly { type: "text"; text: string }[] }
  | { role: "user"; content: readonly ({ type: "text"; text: string } | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean })[] }
  | { role: "assistant"; content: readonly ({ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown })[] };

export interface ResolvedProvider {
  readonly kind: "native" | "sdk" | "error";
  readonly providerFactory?: (auth: AuthSource, modelId: string) => Provider;
  readonly engineFactory?: () => import("../engine/index.js").AgentEngine;
  readonly modelId?: string;
  readonly message?: string;
}
```

0.2. `src/engine/index.ts` — no changes expected. Confirm `RunConfig.resumeFrom.engineId` is already used for gating. Add JSDoc clarifying NativeEngine expectations.

0.3. `src/core/types.ts` — no changes expected. Confirm `StopReason` union covers what OpenAI emits (`end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `error`). Vercel AI SDK's `finish-reason` values: `stop | length | content-filter | tool-calls | error | other | unknown`. Map at the translator layer (§3).

0.4. `src/providers/aliases.ts` (NEW) — type + loader stubs:
```ts
export interface AliasTable { readonly [alias: string]: string; }
export function loadAliases(settingsPath?: string): Promise<AliasTable>;
export function resolveAlias(nameOrId: string, aliases: AliasTable): string; // throws on cycle
export const BUILTIN_ALIASES: AliasTable;
```

0.5. `src/swarm/events.ts` — add lane event types: `alias_shadowed`, `provider_request_sent`, `provider_stream_error`, `native_compaction_boundary_walked`, `native_resume_rejected`.

### Phase 0.5 — Vercel AI SDK spike (~0.5 day)

Before Phase 1 authors `ProviderEvent`, verify the real Vercel AI SDK part-stream shape against the actual installed version.

0.5.1. Install `ai` and `@ai-sdk/openai` at the latest stable versions (no `~` or `^`).

0.5.2. Write a 30-line scratch script (`scripts/spike-vercel-sdk.ts`, deleted after spike) hitting `streamText` end-to-end against OpenAI with a real `OPENAI_API_KEY`. Log each `part.type` from `result.fullStream`.

0.5.3. Read the real `fullStream` type definitions (in `node_modules/ai/dist` or equivalent). Capture exact part type names: e.g. `text-delta` vs `textDelta`, `tool-call` vs `tool-call-end`, `finish` vs `done`, etc.

0.5.4. Commit a `.omc/research/vercel-sdk-spike.md` recording the exact installed versions and the confirmed part-type names. Phase 0 then authors `ProviderEvent` to match these REAL names, not guesses.

0.5.5. If part names differ from what this plan assumes (§10 ProviderEvent), update §10 and §2.4's stream translation table before Phase 1 starts.

### Phase 1 — Dependencies (~0.15 day)

1.1. `package.json`:
- Add `ai` pinned to the **exact** version captured by the Phase 0.5 spike (no `~` or `^`).
- Add `@ai-sdk/openai` pinned to the **exact** version captured by the Phase 0.5 spike.
- No new dev deps.
- Record exact pinned versions in `docs/13-m4a-plan.md` rev-2 after first successful install.

1.2. `npm install && npx tsc --noEmit` — verify types align. Vercel AI SDK exports `LanguageModel`, `streamText`, `ToolSet`, `CoreMessage` (or equivalent; naming may differ in v5).

### Phase 2 — OpenAITransportProvider (~1.5 days)

2.1. `src/providers/openai-transport.ts` (NEW):
```ts
import { openai } from "@ai-sdk/openai";
import { streamText, type LanguageModel, type ToolSet } from "ai";
import type { TransportProvider, ProviderRequest, ProviderEvent, ProviderCapabilities } from "./index.js";
import type { AuthSource } from "../auth/index.js";

export class OpenAITransportProvider implements TransportProvider {
  readonly kind = "transport" as const;
  readonly id = "openai";
  readonly model: LanguageModel;
  readonly capabilities: ProviderCapabilities;

  constructor(auth: AuthSource, modelId: string) {
    // Verify auth before issuing any streams — fail fast with a clear message.
    // auth.isAuthenticated() is synchronous for OpenAIEnvAuth; await at call site.
    // Callers must use: await OpenAITransportProvider.create(auth, modelId) to run this check.
    // (constructor is sync; async factory pattern used — see create() below.)
    this.model = openai(modelId);
    this.capabilities = computeCapabilities(modelId);
  }

  /** Async factory — validates auth before returning the provider. */
  static async create(auth: AuthSource, modelId: string): Promise<OpenAITransportProvider> {
    const authOk = await auth.isAuthenticated();
    if (!authOk) {
      throw new Error(
        "error: OpenAITransportProvider requires OPENAI_API_KEY env var. " +
          "Set it and retry.",
      );
    }
    return new OpenAITransportProvider(auth, modelId);
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> { /* ... */ }
}
```

2.2. Model-family quirk handling (`src/providers/openai-quirks.ts` NEW, pure functions):
```ts
export function isReasoningModel(modelId: string): boolean {
  // o1*, o3*, o4*, *-thinking*, any future reasoning prefix
  return /^(o[134])|(-thinking)/i.test(modelId);
}
export function isGpt5(modelId: string): boolean { return /^gpt-5/i.test(modelId); }
export function normalizeProviderOptions(req: ProviderRequest, modelId: string): Record<string, unknown> {
  if (isReasoningModel(modelId)) {
    // drop temperature, topP, topK, presencePenalty, frequencyPenalty
    return { maxOutputTokens: req.maxOutputTokens };
  }
  if (isGpt5(modelId)) {
    return { maxCompletionTokens: req.maxOutputTokens, temperature: req.temperature, topP: req.topP };
  }
  return { maxOutputTokens: req.maxOutputTokens, temperature: req.temperature, topP: req.topP, topK: req.topK };
}
```

2.3. Tool translation (`src/providers/tool-translation.ts` NEW): `toolSpecsToVercelTools(tools: readonly ToolSpec[]): ToolSet` — builds a Vercel `ToolSet` from our `ToolSpec.inputSchema` (JSON Schema) and `ToolSpec.description`. Does NOT set `execute` — NativeEngine dispatches externally when `tool-call-end` fires.

2.4. Stream translation (inside `OpenAITransportProvider.stream`):
```ts
const result = streamText({
  model: this.model,
  messages: providerMessagesToVercel(req.messages),
  system: Array.isArray(req.systemPrompt) ? req.systemPrompt.join("") : req.systemPrompt,
  tools: toolSpecsToVercelTools(req.tools ?? []),
  abortSignal: req.abort,
  ...normalizeProviderOptions(req, this.model.modelId),
});
for await (const part of result.fullStream) {
  switch (part.type) {
    case "text-delta": yield { type: "text-delta", text: part.textDelta }; break;
    case "tool-call": yield { type: "tool-call-end", id: part.toolCallId, name: part.toolName, input: part.input }; break;
    // ... etc; exact Vercel v5 names verified at impl time
  }
}
```

2.5. Message replay (`src/providers/message-replay.ts` NEW): `providerMessagesToVercel(messages: readonly ProviderMessage[]): CoreMessage[]` — straightforward translation. Guard: tool_result with missing matching tool_use → throw (the compactor's boundary walk-back should have prevented this; an assertion failure here means a compactor bug).

2.6. `OpenAIEnvAuth` (`src/auth/openai-env.ts` NEW, decision §F):
```ts
export class OpenAIEnvAuth implements AuthSource {
  readonly kind = "api-key" as const;
  readonly providerId = "openai";
  async isAuthenticated() { return !!process.env.OPENAI_API_KEY; }
  async headers() { return { Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}` }; }
}
```
(Note: `@ai-sdk/openai` reads the env directly; `headers()` is for symmetry / future direct-HTTP fallback. Leave it simple.)

2.7. Tests (`src/providers/openai-transport.test.ts`, ≥ 10):
- Construction with `OpenAIEnvAuth` when env is set; without → `isAuthenticated() === false`.
- `isReasoningModel` covers `o1*`, `o3*`, `o4*`, `gpt-4-thinking-*`; does not match `gpt-4o`.
- `isGpt5` covers `gpt-5-turbo`, `gpt-5-2026-02-01`; does not match `gpt-4.5`.
- `normalizeProviderOptions` for reasoning drops temperature/topP/topK/penalties; gpt-5 renames `maxOutputTokens` → `maxCompletionTokens`.
- `toolSpecsToVercelTools` produces a ToolSet with the right names + JSON Schema.
- `stream()` with a mocked `streamText` yields `text-delta` → `finish` mapping.
- `stream()` with a mocked `streamText` yields `tool-call-end` on `tool-call` part.
- `stream()` propagates `error` parts as `ProviderEvent { type: "error" }`.
- Message replay: user text + assistant tool_use + user tool_result → round-trips correctly.
- Capabilities shape matches what NativeEngine reads.

### Phase 3 — Compactor (~1.0 day)

3.1. `src/engine/compactor.ts` (NEW). Port `references/claw-code/rust/crates/runtime/src/compact.rs` **entire file excluding `#[cfg(test)]` module (L1–L553)**. M4a ships the full mechanical compactor including merge-summaries and existing-summary-detection; merge-summaries and existing-summary-detection deferred to M4b is NOT the chosen path — ship complete. Exported surface:

```ts
export interface CompactionConfig { preserveRecentMessages: number; maxEstimatedTokens: number; }
export const DEFAULT_COMPACTION: CompactionConfig = { preserveRecentMessages: 4, maxEstimatedTokens: 10_000 };

export interface Session { readonly messages: readonly SessionMessage[]; }
export type SessionMessage = ProviderMessage; // reuse shape

/** claw heuristic: 4 chars/token (text.len() / 4 + 1) — matches claw compact.rs exactly.
 *  Note: countTokens in M3b uses 2.5 chars/token (a different surface, intentionally divergent).
 *  The compactor uses 4 chars/token to match claw for boundary-parity; countTokens uses 2.5
 *  for token-preflight cost-estimation. Both are documented as intentional. */
export function estimateTokens(msg: SessionMessage): number;
export function estimateSessionTokens(session: Session): number;
export function shouldCompact(session: Session, config: CompactionConfig): boolean;

export interface CompactionResult {
  readonly summary: string;
  readonly compactedSession: Session;
  readonly removedMessageCount: number;
  readonly boundaryWalkedBack: boolean;
}
export function compactSession(session: Session, config: CompactionConfig): CompactionResult;

// Additional helpers ported from claw compact.rs L185–L553:
export function summarizeMessages(messages: readonly SessionMessage[]): string;
export function mergeCompactSummaries(existing: string, newSummary: string): string;
export function extractExistingCompactedSummary(messages: readonly SessionMessage[]): string | null;
export function formatCompactSummary(summary: string): string;
export function getCompactContinuationMessage(): string;
export function compactedSummaryPrefixLen(messages: readonly SessionMessage[]): number;
```

Test parity checklist — each claw test at `references/claw-code/rust/crates/runtime/tests/compact_test.rs` (L562–L824) maps to a TS equivalent in `src/engine/compactor.test.ts`:

| claw test | TS equivalent |
|---|---|
| `test_should_compact_empty` | empty session → no-op |
| `test_should_compact_below_threshold` | below threshold → no compaction |
| `test_should_compact_above_threshold` | above threshold → compacts |
| `test_boundary_walk_back_tool_pair` | tool pair spanning boundary → walks back |
| `test_merge_compact_summaries` | mergeCompactSummaries combines both summaries |
| `test_extract_existing_summary` | extractExistingCompactedSummary finds prefix block |
| `test_format_compact_summary` | formatCompactSummary wraps in `<summary>` tags |
| `test_continuation_message` | getCompactContinuationMessage returns expected string |
| `test_prefix_len_no_summary` | compactedSummaryPrefixLen returns 0 for clean session |
| `test_prefix_len_with_summary` | compactedSummaryPrefixLen returns N for summary-prefixed session |
```

3.2. The load-bearing part — boundary walk-back. Port claw L118–L157 literally, adapted to our message shape:
- If `rawKeepFrom`'s first message is `user` whose first content block is `tool_result`, look at the preceding message (index `rawKeepFrom - 1`). If it's an assistant whose content includes a `tool_use`, walk `keepFrom` back by 1 (include the assistant). Otherwise walk back by 1 anyway (the orphan state is already broken; we're trying to fix it).
- Emit `native_compaction_boundary_walked` lane event when walk-back actually modifies `keepFrom`.

3.3. Summary template — port claw's `summarize_messages` literally:
- Count user/assistant/tool messages.
- Dedup tool names seen.
- Collect up to 3 recent user-message text snippets.
- Emit `<summary>...</summary>` block plus the preamble strings from `compact.rs` L3–L6.

3.4. Tests (`src/engine/compactor.test.ts`, ≥ 10):
- Below threshold → no compaction.
- Above threshold with clean boundary → compacts; tail of 4 preserved.
- Above threshold with tool pair spanning boundary → walks back; tail is now 5 messages; `boundaryWalkedBack === true`.
- Pre-existing summary prefix → merges; doesn't double-count prefix in threshold eval.
- Summary contains `<summary>` tags, scope counters match message counts.
- Tool-name dedup: 3 instances of `read_file` in removed messages → shows "read_file" once.
- Recent user requests section: up to 3 lines, in order of recency.
- Empty session → no-op.
- Session with only assistant messages → compacts without tool-pair concerns.
- Estimation accuracy: synthetic 10_000-char message → `estimateTokens` returns ~2500 (4 chars/token per claw: `text.len() / 4 + 1`).

### Phase 4 — Routing + aliases (~0.5 day)

4.1. `src/providers/routing.ts` (NEW):
```ts
export function resolveProvider(modelId: string): ResolvedProvider {
  if (/^claude/i.test(modelId)) {
    return { kind: "sdk", engineFactory: () => new ClaudeAgentSdkEngine(), modelId };
  }
  if (/^(gpt|o[134]|openai\/)/i.test(modelId)) {
    const cleanId = modelId.replace(/^openai\//, "");
    return { kind: "native", providerFactory: (auth, _id) => new OpenAITransportProvider(auth, cleanId), modelId: cleanId };
  }
  if (/^(grok|gemini|qwen|kimi)/i.test(modelId)) {
    return { kind: "error", message: `model "${modelId}" — xAI/Google/DashScope/Moonshot land in M4b. Known prefixes in M4a: claude*, gpt*, o1*, o3*, o4*.` };
  }
  return { kind: "error", message: `unknown model prefix "${modelId}". Known prefixes: claude*, gpt*, o1*, o3*, o4* (M4a).` };
}
```

4.2. `src/providers/aliases.ts` (NEW, completes Phase 0.4 stubs):
- `loadAliases(settingsPath?: string): Promise<AliasTable>` — read `~/.swarm-harness/settings.json`, extract `aliases` field; return `BUILTIN_ALIASES` merged with user aliases (user wins, emit `alias_shadowed` on collision).
- `BUILTIN_ALIASES`: `{ sonnet: "claude-sonnet-4-6", haiku: "claude-haiku-4-5", opus: "claude-opus-4-7", "gpt-4o": "gpt-4o-2024-11-20", "gpt-5": "<pin at implementation time against OpenAI's actual model list; current value is illustrative>", o3: "o3-mini-2025-01-31" }` (verify all ids against live model lists at impl time; current values are illustrative placeholders only).
- `resolveAlias`: one level of indirection; throw on cycle.

4.3. Tests (`src/providers/routing.test.ts` + `src/providers/aliases.test.ts`, ≥ 10):
- `resolveProvider` for each known prefix → correct kind.
- Unknown prefix → helpful error.
- `openai/gpt-4o` prefix strip → `gpt-4o` returned.
- `resolveAlias` with built-in → returns the model id.
- `resolveAlias` with user override → user wins + `alias_shadowed`.
- `resolveAlias` cycle → throws.
- `resolveAlias` unknown name → returns input unchanged (treat as direct model id).
- `loadAliases` with missing settings file → returns built-ins only.
- `loadAliases` with malformed JSON → throws with a clear message.
- Settings file user-extension round-trip.

### Phase 5 — NativeEngine (~2.0 days)

5.1. `src/engine/native.ts` (NEW), skeleton:
```ts
export class NativeEngine implements AgentEngine {
  readonly id = "native" as const;
  readonly capabilities: EngineCapabilities;
  private cumulativeUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  private readonly provider: Provider;
  private readonly compactionConfig: CompactionConfig;

  constructor(opts: { provider: Provider; compactionConfig?: CompactionConfig }) {
    this.provider = opts.provider;
    this.compactionConfig = opts.compactionConfig ?? DEFAULT_COMPACTION;
    this.capabilities = {
      streaming: opts.provider.capabilities.streaming,
      promptCache: opts.provider.capabilities.promptCache,
      parallelToolUse: opts.provider.capabilities.parallelToolUse,
      mcp: false,
      compaction: false,       // we own it; outer code does not
      resume: true,
      maxContextTokens: opts.provider.capabilities.maxContextTokens,
      maxOutputTokens: opts.provider.capabilities.maxOutputTokens,
    };
  }

  async *run(config: RunConfig): AsyncIterable<NormalizedEvent> { /* §5.2 */ }
  getCumulativeUsage(): Usage { return this.cumulativeUsage; }
}
```

5.2. Turn loop (core of `run()`):
```ts
// 1. Build or restore the working message array.
let messages: ProviderMessage[] = config.resumeFrom?.engineId === "native"
  ? (config.resumeFrom.data as NativeSnapshot).messages.slice()
  : [];
if (config.resumeFrom != null && config.resumeFrom.engineId !== "native") {
  yield { type: "error", error: { code: "unsupported_resume", message: "...", retryable: false } };
  return;
}

// 2. Seed with user prompt.
messages.push({ role: "user", content: [{ type: "text", text: config.prompt }] });

for (let turn = 0; turn < (config.maxTurns ?? 100); turn++) {
  // 2a. Compaction check + execution.
  if (shouldCompact({ messages }, this.compactionConfig)) {
    yield { type: "compaction", payload: { phase: "begin", ... } };
    const result = compactSession({ messages }, this.compactionConfig);
    messages = result.compactedSession.messages.slice();
    yield { type: "compaction", payload: { phase: "end", removedMessageCount: result.removedMessageCount, ... } };
    // Post-compaction health probe — mirror ClaudeAgentSdkEngine.
    if (config.dispatcher != null) {
      try { await config.dispatcher.dispatch("glob", { pattern: "*" }, { cwd: process.cwd() }); }
      catch { yield { type: "error", error: { code: "transport", message: "post-compaction probe failed", retryable: false } }; }
    }
  }

  // 2b. Stream one turn from the provider.
  const toolUseBuffer: ToolRequest[] = [];
  const assistantContent: AssistantBlock[] = [];
  let turnUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: StopReason = "end_turn";

  for await (const ev of this.provider.stream({ messages, tools: config.tools.map(t => t.spec), systemPrompt: config.systemPrompt, model: config.model, abort: config.abort, /* normalized params from RunConfig */ })) {
    switch (ev.type) {
      // ProviderEvent → NormalizedEvent translation.
      // Event names MUST match src/core/types.ts NormalizedEvent variants exactly.
      case "text-delta":
        yield { type: "text_delta", text: ev.text };
        assistantContent.push({ type: "text", text: ev.text });
        break;
      case "reasoning-delta":
        // Drop reasoning pass-through for M4a — NormalizedEvent has no reasoning_delta variant.
        // TODO(M4b): extend NormalizedEvent with reasoning_delta and re-enable here.
        break;
      case "tool-call-start":
        // Emit tool_use_start per NormalizedEvent canonical shape.
        yield { type: "tool_use_start", id: ev.id, name: ev.name };
        break;
      case "tool-call-delta":
        yield { type: "tool_use_input", id: ev.id, jsonDelta: ev.inputDelta };
        break;
      case "tool-call-end":
        // Emit tool_use_end — the three-event sequence is: tool_use_start / tool_use_input / tool_use_end.
        yield { type: "tool_use_end", id: ev.id };
        assistantContent.push({ type: "tool_use", id: ev.id, name: ev.name, input: ev.input });
        toolUseBuffer.push({ id: ev.id, name: ev.name, input: ev.input, ctx: { cwd: process.cwd() } });
        break;
      case "finish":
        stopReason = ev.stopReason;
        turnUsage = ev.usage;
        break;
      case "error":
        yield { type: "error", error: { code: ev.code, message: ev.message, retryable: ev.retryable } };
        return;
    }
  }

  this.cumulativeUsage = { inputTokens: this.cumulativeUsage.inputTokens + turnUsage.inputTokens, outputTokens: this.cumulativeUsage.outputTokens + turnUsage.outputTokens };
  messages.push({ role: "assistant", content: assistantContent });

  // 2c. If tool calls: canUseTool gate (NativeEngine-owned, NOT in dispatchBatch), then dispatch.
  // dispatchBatch does NOT change — it remains a single-arg method. canUseTool gating lives here,
  // immediately before dispatchBatch, to preserve M3b's dispatcher contract.
  if (toolUseBuffer.length > 0) {
    const allowedRequests: ToolRequest[] = [];
    const denials: ToolResult[] = [];
    for (const req of toolUseBuffer) {
      const decision = await config.canUseTool(req.name, req.input);
      if (decision.allow) {
        allowedRequests.push({
          name: req.name,
          input: decision.updatedInput ?? req.input,
          ctx: { cwd: process.cwd() },
        });
      } else {
        // Synthesize a tool_result error for denied tools.
        denials.push({
          toolUseId: req.id,
          status: "error",
          message: decision.reason,
        });
      }
    }

    // Use dispatchBatch — parallel-safe, respects concurrencySafe flag (M3b §4.4).
    const results = await config.dispatcher!.dispatchBatch(allowedRequests);
    // Merge denials + results in original tool-use order.
    const allResults = toolUseBuffer.map((req) => {
      const denial = denials.find((d) => d.toolUseId === req.id);
      if (denial) return { req, content: denial.message, isError: true };
      const r = results.find((res) => res.requestId === req.id) ?? results.shift()!;
      return { req, content: r.status === "ok" ? r.output : r.message, isError: r.status !== "ok" };
    });
    for (const { req, content, isError } of allResults) {
      yield { type: "tool_result", toolUseId: req.id, content, isError };
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: req.id, content, is_error: isError }] });
    }
    continue; // next turn
  }

  // 2d. Terminal turn — emit message_stop with cumulative usage for this turn.
  yield { type: "message_stop", stopReason, usage: turnUsage };
  break;
}
```

5.3. Snapshot/resume serialization (`src/engine/native-snapshot.ts` NEW):
```ts
export interface NativeSnapshot { readonly messages: readonly ProviderMessage[]; readonly turnCount: number; readonly compactionCount: number; readonly cumulativeUsage: Usage; }
export function makeSnapshot(engine: NativeEngine, messages: readonly ProviderMessage[], turn: number, compactions: number): SessionSnapshot;
```

5.4. NativeSnapshot persistence:

On turn boundary, NativeEngine writes the serialized `NativeSnapshot` to `<session-dir>/native-snapshot.json` atomically (temp-file + rename). `SessionStore` on `--resume` detects `engineId: "native"` and loads the snapshot from this path. The JSONL event log remains the append-only primary record; `native-snapshot.json` is the resume-optimized blob.

```ts
// On each turn boundary inside run():
const snapshotPath = path.join(config.sessionDir, "native-snapshot.json");
const tmpPath = snapshotPath + ".tmp";
await fs.writeFile(tmpPath, JSON.stringify(makeSnapshot(this, messages, turn, compactions)));
await fs.rename(tmpPath, snapshotPath);
```

AC: engine writes `native-snapshot.json` after the first turn completes; a second `swarm-harness --resume <session-id> --framework native` invocation reads it and materializes the message buffer without replaying the full JSONL.

5.5. `NativeEngine.countTokens?` — optional local-estimate path matching M3b's approach (`bytes / 2.5`). Not wired to a server endpoint in M4a; may move to server via Vercel AI SDK's tokenizer in M4b.

5.6. Tests (`src/engine/native.test.ts`, ≥ 15) using a scripted `MockProvider`:
- Text-only turn: prompt → `text_delta` → `message_stop { end_turn }`.
- One tool call: prompt → `tool_use` → `canUseTool` fires → dispatcher runs → `tool_result` → next turn `text_delta` → `message_stop`.
- Permission denied: `canUseTool` returns deny → `tool_result { is_error: true, content: "<reason>" }` → next turn continues.
- Three parallel tool calls: 3 `tool-call-end` events in one turn → `dispatchBatch` fan-out → 3 `tool_result`s → AC 11 timing check.
- `maxTurns` exceeded: emits `message_stop { stopReason: "max_turns" }` or equivalent error.
- Compaction triggers at threshold.
- Compaction boundary walk-back path.
- Post-compaction health probe fires.
- Post-compaction health probe failure → `transport` error event.
- Resume from `NativeSnapshot` continues turn count + messages.
- Resume rejection for wrong `engineId`.
- Capabilities shape.
- Cumulative usage accumulation across multiple `run()` invocations.
- Reasoning-delta events pass through without entering the message array.
- Abort signal fires → loop exits cleanly with no `message_stop`.
- Mid-stream provider `error` event → `error` NormalizedEvent → loop exits.

### Phase 6 — CLI + worker-entry integration (~0.5 day)

6.1. `src/cli/argv.ts` (MODIFY):
- Add `--framework <native|claude-agent-sdk|auto>` to `CommonOpts`.
- Default: `auto`.
- Add validation: `--framework native` with Anthropic model → error per AC 21.
- Add validation: `--framework claude-agent-sdk` with non-Anthropic model → error per AC 22.

6.2. `src/cli/main.ts` (MODIFY):
- After argv parse + alias resolve, call `resolveProvider(modelId)` respecting `--framework` override.
- Construct engine: NativeEngine or ClaudeAgentSdkEngine as dictated.
- Wire to the rest of the flow unchanged.
- Add (unadvertised) `--dump-engine` to print `{ engineId, providerId, modelId }` as JSON and exit 0 — for smoke tests.

6.3. `src/cli/worker-entry.ts` (MODIFY):
- Read `SWARM_HARNESS_FRAMEWORK` env var; default to `auto`.
- Thread through to engine construction identically to main.

6.4. `src/swarm/spawner.ts` (or wherever subprocess env is built — find via grep on `SWARM_HARNESS_`): propagate `SWARM_HARNESS_FRAMEWORK` from orchestrator to workers.

6.5. Tests:
- `argv.test.ts` extension (≥ 4): `--framework native`, `--framework claude-agent-sdk`, `--framework auto`, cross-combo error paths.
- `main.test.ts` extension (≥ 2): engine selection based on routing.
- Integration test: orchestrator spawn with `--framework native` → worker sees env var, uses NativeEngine.

### Phase 7 — Smoke + docs (~0.75 day)

7.1. `scripts/smoke-m4a.sh` (NEW). Mirrors `smoke-m3b.sh` format:
- **Offline** (MockProvider + ScriptedTestEngine fixtures):
  - [O1] Scripted provider text-only round-trip → `message_stop`.
  - [O2] Scripted provider with 1 tool call → tool_use → dispatcher → tool_result → next turn.
  - [O3] Scripted provider with 3 parallel tool calls → `dispatchBatch` fan-out.
  - [O4] Compactor with tool-pair boundary walk-back fixture session.
  - [O5] Compactor post-probe success + failure paths.
  - [O6] Routing: all known prefixes + unknown + `openai/` prefix strip.
  - [O7] Alias resolution: built-in, user override, cycle detect.
  - [O8] Cross-engine resume rejection.
- **Live** (requires `OPENAI_API_KEY`):
  - [L1] `swarm-harness --framework native --model gpt-4o prompt "say hi"` succeeds.
  - [L2] `swarm-harness --framework native --model gpt-4o prompt "read README.md and summarize"` runs a tool turn.
  - [L3] `swarm-harness --framework native --model o3-mini prompt "..."` reasoning-model smoke (no param errors).
  - [L4] `swarm-harness --framework native --model gpt-4o prompt "read a.txt, b.txt, c.txt in parallel"` 3-tool parallel timing.

7.2. `scripts/smoke.sh --all` — extend to invoke `smoke-m4a.sh` alongside existing smoke scripts.

7.3. Docs:
- `docs/03-interfaces.md` — update `Provider` section: removes "stub" wording, documents `stream()` + `ProviderEvent` + `TransportProvider` marker. Add cross-ref to `docs/13-m4a-plan.md`.
- `docs/07-implementation-plan.md` — mark the M4a scope items as shipped; leave xAI/Google/DashScope/Codex-ChatGPT as M4b todos.
- `docs/06-open-questions.md` — resolve the last open item (SDK-mode parallel tool execution): NativeEngine now proves real concurrency via OpenAI; append to Q14 decision log or open a new resolved entry Q19 "NativeEngine concurrency: proven in M4a."
- `docs/04-tool-tiers.md` — note that Tier 2 tools work identically under NativeEngine (SwarmHost is engine-agnostic).
- `docs/README.md` — add `13-m4a-plan.md` to the index.

### Phase 8 — Final verification + buffer (~0.35 day)

8.1. Full suite: `npx tsc --noEmit` clean, `npm test` green (target 881–901 tests), `npm run test:integration` green.

8.2. Run `scripts/smoke.sh --all` offline + `scripts/smoke-m4a.sh` live with real `OPENAI_API_KEY`.

8.3. Tag `m4a-complete` on merge to `mvp`.

8.4. Record actual pinned versions of `ai` and `@ai-sdk/openai` in rev-2 revision notes.

## File layout after M4a

```
src/
  providers/
    index.ts                             # MODIFIED — stub → real; ProviderEvent, ProviderRequest, TransportProvider, ResolvedProvider
    openai-transport.ts                  # NEW — OpenAITransportProvider (Vercel AI SDK wrapper)
    openai-transport.test.ts
    openai-quirks.ts                     # NEW — isReasoningModel, isGpt5, normalizeProviderOptions
    openai-quirks.test.ts
    tool-translation.ts                  # NEW — ToolSpec → Vercel ToolSet
    tool-translation.test.ts
    message-replay.ts                    # NEW — ProviderMessage → Vercel CoreMessage
    message-replay.test.ts
    routing.ts                           # NEW — resolveProvider(modelId)
    routing.test.ts
    aliases.ts                           # NEW — loadAliases, resolveAlias, BUILTIN_ALIASES
    aliases.test.ts
  engine/
    native.ts                            # NEW — NativeEngine (AgentEngine impl)
    native.test.ts
    native-snapshot.ts                   # NEW — NativeSnapshot serialization
    compactor.ts                         # NEW — mechanical compactor port (claw compact.rs)
    compactor.test.ts
    index.ts                             # (no change — JSDoc only)
  auth/
    openai-env.ts                        # NEW — OpenAIEnvAuth (reads OPENAI_API_KEY)
    openai-env.test.ts
  swarm/
    events.ts                            # MODIFIED — new lane events (alias_shadowed, native_compaction_boundary_walked, ...)
  cli/
    argv.ts                              # MODIFIED — --framework flag + validation
    argv.test.ts                         # MODIFIED — framework flag cases
    main.ts                              # MODIFIED — engine selection via resolveProvider
    main.test.ts                         # MODIFIED — engine selection cases
    worker-entry.ts                      # MODIFIED — read SWARM_HARNESS_FRAMEWORK
scripts/
  smoke-m4a.sh                           # NEW
  smoke.sh                               # MODIFIED — --all invokes smoke-m4a.sh
test/
  fixtures/
    native-sessions/                     # NEW — compactor boundary-walk-back fixtures
docs/
  13-m4a-plan.md                         # NEW (this file; mirror at .omc/plans/m4a-native-engine-openai.md)
  03-interfaces.md                       # MODIFIED — Provider real shape
  07-implementation-plan.md              # MODIFIED — mark M4a items shipped
  06-open-questions.md                   # MODIFIED — M4a closes SDK-concurrency caveat
  README.md                              # MODIFIED — index
package.json                             # MODIFIED — ai + @ai-sdk/openai deps pinned
```

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Vercel AI SDK v5 API surface differs from what this plan assumes (`streamText` part-stream names, `ToolSet` shape, `finish-reason` values) | High | Medium | Phase 1.2 verifies types before Phase 2 starts. If names diverge (`textDelta` vs `text-delta`, etc.), adjust the translator once; shape of our `ProviderEvent` is stable regardless. Pin to a specific minor version at M4a end. |
| `@ai-sdk/openai` does not surface OpenAI's `prompt_cache_key` / `cached_tokens` | Medium | Low | Ship `ProviderCapabilities.promptCache = false` for OpenAI; `/cost` reports zero for OpenAI runs. Open a follow-up ticket. No correctness impact. |
| Compactor boundary walk-back port misses an edge case present in claw but not captured in L118–L157 | Medium | High | Port literally; write 3+ fixture tests covering: clean boundary, boundary inside tool pair, boundary with orphaned tool_result (already broken). Emit `native_compaction_boundary_walked` for observability. Spot-check against claw's test suite at `references/claw-code/rust/crates/runtime/tests/compact_test.rs` if present. |
| NativeEngine's 3-parallel-tool AC times at > 50 ms in CI (AC 11) | Low | Medium | CI-stable threshold per M3b precedent. If still flaky, relax to 100 ms (not 5 ms). The correctness signal is "all three tools complete before any serializes," not exact timing. |
| `dispatchBatch` inherited from M3b hides a bug that only surfaces under real concurrency | Medium | Medium | M4a is the first real test of M3b's concurrent path. If a bug surfaces, fix in `src/tools/dispatcher.ts` — this is exactly the gate we deferred in M3b Phase 4. Add a regression test. |
| OpenAI API rate limits or transient errors flake live smokes | Medium | Low | Live smoke scripts retry once on 429/5xx; offline smokes cover full logic with MockProvider. `smoke-m4a.sh --offline` is the gate for merge; live is required for tag. |
| Reasoning models surface `reasoning-delta` parts Vercel doesn't expose (or exposes differently) | Medium | Low | AC 7 documents the outcome. If not exposed, `reasoning-delta` events simply don't fire for OpenAI; our plumbing is ready for when they do. No behavioral regression. |
| Cross-engine resume attempt silently works instead of erroring (AC 16) | Low | High | Explicit guard at `run()` entry checks `resumeFrom.engineId`; unit test covers both directions. Add an assertion-style throw in dev mode if a NativeSnapshot's `data` shape doesn't match `NativeSnapshot` interface. |
| Model-id drift: built-in aliases point to deprecated OpenAI model ids | Low | Low | Verify live at impl time against OpenAI's model list. User can always override via `settings.json`. Document upgrade cadence in README (we bump aliases on minor releases). |
| Vercel AI SDK v5 minor bump between Phase 1 install and Phase 8 verification | Low | Low | Pinned version locks this; `npm ci` in CI guarantees reproducibility. |
| `npm install` pulls a large transitive deps graph (Vercel AI SDK + `@ai-sdk/openai` + their deps) | Medium | Low | Measure bundle size impact; Vercel packages are tree-shakeable. Document dep size delta in rev-2 if > 5 MB. |
| NativeEngine's session in-memory buffer diverges from session-store JSONL log | Medium | Medium | On every turn-boundary, append the turn's events to both the in-memory buffer AND the JSONL log via existing SessionStore. On resume, hydrate buffer from JSONL (source of truth). Unit test covers divergence scenarios. |
| HookRuntime reentrancy (M3b §4.1) re-emerges under real parallelism | Low | Medium | M3b shipped the contract + conservative serialization fallback. M4a's concurrent path tests it for real. If reentrancy issues surface, enable the M3b serial-fallback mode and open a follow-up ticket. |

## Verification steps

Run after each phase:

- **Phase 0:** `npx tsc --noEmit` clean.
- **Phase 1:** `npm install` succeeds; `npx tsc --noEmit` clean.
- **Phase 2:** `npx vitest run src/providers/` green; live smoke [L1] (text-only gpt-4o) passes.
- **Phase 3:** `npx vitest run src/engine/compactor.test.ts` green.
- **Phase 4:** `npx vitest run src/providers/routing.test.ts src/providers/aliases.test.ts` green.
- **Phase 5:** `npx vitest run src/engine/native.test.ts` green; live smoke [L2] (tool-use gpt-4o) passes.
- **Phase 6:** `npx vitest run src/cli/argv.test.ts src/cli/main.test.ts` green.
- **Phase 7:** `scripts/smoke-m4a.sh --offline` all pass; `scripts/smoke-m4a.sh` (live) all pass with `OPENAI_API_KEY`; `scripts/smoke.sh --all` passes.
- **Phase 8:** `npx tsc --noEmit` + full `npm test` + `scripts/smoke.sh --all` green on `mvp`.

**End-of-M4a gate:** all 29 acceptance criteria verified, tagged `m4a-complete`, `docs/07-implementation-plan.md` §M4 updated.

## Estimated effort

| Phase | Effort |
|---|---|
| 0 Interface refinements | 0.4 d |
| 0.5 Vercel AI SDK spike | 0.5 d |
| 1 Dependencies | 0.15 d |
| 2 OpenAITransportProvider (provider + quirks + tool/message translation + auth) | 1.5 d |
| 3 Compactor (port claw compact.rs L1–L553 + tests) | 1.0 d |
| 4 Routing + aliases | 0.5 d |
| 5 NativeEngine (turn loop + snapshot + persistence + tests) | 2.0 d |
| 6 CLI + worker-entry integration | 0.5 d |
| 7 Smoke + docs | 0.75 d |
| 8 Final verification + buffer | 0.35 d |

**Total: ~7.65 engineer-days.** Upper bound of the 5–8 day target. Real-world first-time Vercel SDK integration may overrun by 0.5–1d; buffer absorbed if so. Buffer of 0.35 d covers `dispatchBatch` regression discovered under real concurrency (M3b §4 caveat resolution).

If a phase slips, drop order: (a) `--dump-engine` internal debug flag in Phase 6 → (b) reasoning-delta pass-through in Phase 2.4 (ship without; OpenAI runs work, reasoning invisible) → (c) Phase 3's `mergeCompactSummaries` merge path for pre-existing prefixes (ship without; first compaction always runs from clean tail — add back in M4b).

## Open items to revisit during implementation

- **Vercel AI SDK v5 part-stream shape.** Verify `text-delta` vs `textDelta`, `tool-call` vs `tool-call-end`, `finish-reason` values. Adjust translator once; all names flow through `ProviderEvent`.
- **OpenAI prompt caching.** If `@ai-sdk/openai` surfaces `prompt_cache_key`, wire `ProviderCapabilities.promptCache = true` and emit our existing `cache_hit` / `cache_miss` lane events (M3b Phase 3) from the NativeEngine path. Otherwise ship `false` and follow up in M4b.
- **Reasoning delta surfacing.** If Vercel exposes reasoning as a distinct part (`reasoning-delta`), wire through. If not, reasoning is absorbed into text output for M4a.
- **Tool `execute`-inside-Vercel-SDK vs external dispatch.** We opted for external dispatch (decision §C). If Vercel's streaming tool-call API requires `execute` callbacks inline, rework Phase 2.3's `toolSpecsToVercelTools` to accept a dispatcher and fire it from within; still route through `canUseTool` + ToolDispatcher for consistency. Decide during Phase 2 implementation.
- **OpenAI model alias freshness.** Built-in aliases will go stale as OpenAI publishes new models. Document in README that users can override via `~/.swarm-harness/settings.json aliases`. Consider a `swarm-harness aliases list` CLI command — deferred to M4b.
- **NativeEngine `countTokens` server path.** Vercel AI SDK may expose a tokenizer per provider. M4a ships local-estimate only (consistent with M3b). Wire server-native count in M4b if available.
- **`NativeEngine` + Anthropic.** Decision §A defers this. If a driver emerges in M4b (e.g. parallel tool execution for Max subscription users hitting SDK serialization), add a `NativeEngine + @ai-sdk/anthropic + AnthropicApiKeyAuth` path. Claude Max users stay on ClaudeAgentSdkEngine regardless (Q16).
- **Dependency size impact.** Measure transitive deps after Phase 1; if `@ai-sdk/openai` pulls > 5 MB of new graph, surface in rev-2 notes. Doesn't block M4a.
- **Session-store migration.** NativeEngine's snapshot shape differs from SDK's. Both get stored in the same per-worktree directory; `engineId` keyed in each snapshot prevents cross-loading. Verify session-list UX (`--resume latest` picks correct snapshot for the current `--framework`). Edge: user changes framework mid-session. Document as "resume only within the same framework."

## Cross-references

- Prereq scope: `docs/07-implementation-plan.md` §M4 (the M4a slice; M4b enumerated in "Explicitly OUT of M4a").
- Interface contracts: `src/providers/index.ts` (Provider, ProviderEvent, ProviderRequest, TransportProvider, ResolvedProvider), `src/engine/index.ts` (AgentEngine, EngineCapabilities, RunConfig, SessionSnapshot).
- Prior milestones: `docs/08-m0-plan.md` (AgentEngine + AuthSource foundation we extend), `docs/10-m2-plan.md` (MCP client we reuse; compaction observer pattern we mirror), `docs/11-m3a-plan.md` (role allowlists, BranchPolicy, subprocess spawn we inherit), `docs/12-m3b-plan.md` (dispatchBatch, concurrencySafe, HookRuntime reentrancy we exercise for real).
- Research: `docs/research/01-api.md` §6 (provider routing, model-family quirks), §7 (prompt caching — Anthropic-specific, M4a's OpenAI path handled separately), §8 (token preflight, 6 MB DashScope cap — M4b).
- Open questions resolved: Q1 (hybrid Vercel + Agent-SDK — M4a ships the Vercel side), Q14 (mechanical compaction — M4a ships our own port), Q16 (Claude Max via Agent SDK only — preserved; M4a doesn't touch it).
- Anti-patterns refused: `docs/07-implementation-plan.md` "What we explicitly refuse to copy from claw" items #1 (thread-based sub-agents — subprocess model preserved), #9 (MCP as generic tool — we keep M2's first-class registration).
- Upstream claw reference: `references/claw-code/rust/crates/runtime/src/compact.rs` L1–L553 (port target — entire file excluding `#[cfg(test)]` module; claw test suite at L562–L824 maps to TS equivalents in `src/engine/compactor.test.ts`), `references/claw-code/rust/crates/api/src/providers/openai_compat.rs` L779–L927 (quirk inspiration, but we let Vercel AI SDK do most of it).

## Revision history

- **rev 1 (2026-04-20):** initial draft. Eight scope/mechanism decisions locked: (A) `claude*` routing stays on ClaudeAgentSdkEngine in M4a; NativeEngine-via-Anthropic deferred to M4b; (B) `ProviderEvent` mirrors Vercel part-stream shape; (C) tool plumbing via Vercel `tools` param + external dispatch (not MCP-through-SDK); (D) compactor ports claw compact.rs L1–L183 literally with tool-pair boundary walk-back; (E) NativeEngine maintains an in-memory message buffer alongside JSONL session store; (F) minimal `OpenAIEnvAuth` in M4a, polished `OpenAIApiKeyAuth` login/logout in M4b; (G) parallel tool execution inherits M3b dispatchBatch; M4a's 3-parallel-tool AC closes M3b Phase 4's caveat; (H) user aliases override built-ins with `alias_shadowed` warning. Total effort 7.15d, inside 5–8d target. Biggest risks: Vercel AI SDK v5 API-surface surprises (highest), compactor boundary walk-back correctness (highest-impact). No hard dependency on anything M4b needs — but M4b inherits: (i) `TransportProvider` marker + `ProviderEvent` union (strictly additive when xAI/Google/DashScope land), (ii) routing table (M4b extends with grok*/gemini*/qwen*/kimi* branches — pure addition), (iii) aliases (no schema change), (iv) `--framework` flag (adds `codex-chatgpt` variant), (v) `FrameworkProvider` for Codex-ChatGPT (M4b) will need a sibling interface to `TransportProvider` — M4a's stubs reserve the name. **M4b does NOT need anything from M4a that isn't in scope here**; all M4a deliverables are final at merge.
- **rev 2 (2026-04-21):** applied critic REVISE feedback. 2 critical (C1 canUseTool-in-NativeEngine-not-dispatcher, C2 NormalizedEvent shape compliance), 6 major (M1 compactor scope expansion L1–L183 → L1–L553 + full exported surface + test parity checklist, M2 Phase 0.5 Vercel spike gate + exact version pinning, M3 CLI error-text AC verbatim, M4 native-snapshot persistence path §5.4, M5 OpenAI auth validation at construction via async factory + AC 23a, M6 effort bump 7.15d → 7.65d). Minor: §7.3 "if exists" hedge removed, gpt-5 alias marked illustrative, 4 chars/token vs 2.5 chars/token divergence documented, §Relationship to M3b dispatcher contract clarified. Total 7.15d → 7.65d. No new scope; fixes only.
