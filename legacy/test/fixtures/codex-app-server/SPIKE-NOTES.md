# Codex App Server — Stage 3.0 Spike Notes

**Date:** 2026-05-01
**Codex CLI:** 0.98.0
**Spike script:** [scripts/codex-app-server-spike.mjs](../../../scripts/codex-app-server-spike.mjs)
**Captured fixtures:**
- `protocol.ts` + 250 sibling `.ts` files — generated TS bindings (`codex app-server generate-ts --out`)
- `codex_app_server_protocol.schemas.json` — full JSON schema
- `handshake-and-turn.jsonl` — captured live JSON-RPC trace of one full session

---

## Protocol confirmation

App Server speaks **JSON-RPC 2.0 over stdio**, line-delimited (one JSON message per line).

Both v1 (legacy flat methods like `newConversation`) and v2 (slash-namespaced like `thread/start`) coexist. We target **v2**.

## Captured method vocabulary

**Updated 2026-05-01:** captured a real successful turn after operator reactivated auth + we worked around the `gpt-5.2-codex` model limitation. The current fixture is a **happy path** with `gpt-5.4`. 23 unique method names total (4 more than the failure trace).

**Important model finding:** `gpt-5.2-codex` is `isDefault: true` in the App Server's `model/list` response BUT returns HTTP 400 "not supported when using Codex with a ChatGPT account" when actually invoked. ChatGPT-account integrations must explicitly pass a supported model in `thread/start` — `gpt-5.4` works; the codex-prefixed variants do not. This is a Codex API limitation specific to subscription-quota auth (paid API keys can use the codex models).

| Method | Direction | Purpose |
|---|---|---|
| `initialize` | client → server | handshake; returns user-agent |
| `thread/start` | client → server | create new thread; returns thread metadata + model + cwd + sandbox |
| `thread/started` | server → client | notification mirror of thread/start |
| `turn/start` | client → server | send user message; begin agent run |
| `turn/started` | server → client | notification mirror |
| `turn/completed` | server → client | terminal — turn ended (status: success/failed) |
| `thread/archive` | client → server | clean shutdown |
| `item/started` | server → client | new item entering the turn (user message, tool call, etc.) |
| `item/completed` | server → client | item finished |
| `error` | server → client | JSON-RPC error notification |
| `codex/event/task_started` | server → client | wrapped legacy v1 task lifecycle |
| `codex/event/task_complete` | server → client | wrapped legacy v1 task lifecycle |
| `codex/event/item_started` | server → client | wrapped legacy item event |
| `codex/event/item_completed` | server → client | wrapped legacy item event |
| `codex/event/user_message` | server → client | echo of the user message |
| `codex/event/stream_error` | server → client | streaming error (e.g. retry attempts) |
| `codex/event/error` | server → client | terminal error |
| `codex/event/mcp_startup_complete` | server → client | App Server's MCP subsystem ready |
| `codex/event/shutdown_complete` | server → client | server shutting down |

Both v2 namespace (`thread/*`, `turn/*`, `item/*`) and v1 wrapper (`codex/event/*`) fire on the same session. Our integration should subscribe to v2 and treat v1 wrappers as duplicates / legacy fallbacks.

## Auth status flow

```jsonc
// Request
{"jsonrpc":"2.0","id":2,"method":"getAuthStatus","params":{}}
// Response (with valid ChatGPT login)
{"id":2,"result":{"authMethod":"chatgpt","authToken":null,"requiresOpenaiAuth":true}}
```

- `authMethod` reports the active auth path (`chatgpt`, `apiKey`, etc.)
- `authToken` is intentionally null — App Server doesn't expose tokens to clients
- `requiresOpenaiAuth: true` means the session needs OAuth-backed auth

For our doctor check: call `getAuthStatus` after `initialize`; if `authMethod` is null/missing or empty, message: "Run `codex login`."

## Successful happy-path turn (2026-05-01)

After operator reactivated auth + we passed `model: "gpt-5.4"` (the default `gpt-5.2-codex` is rejected on ChatGPT accounts), the spike captured a complete agent run end-to-end:

- `turn/started` fires immediately after `turn/start` request
- `codex/event/task_started` carries `model_context_window: 258400` and `collaboration_mode_kind`
- `codex/event/token_count` and `account/rateLimits/updated` fire EARLY (before any model output) — our integration can use these as quota / context-window observations without waiting for completion
- A `reasoning` item is emitted (started + completed) with empty summary/content arrays — gpt-5.4 has reasoning capability; the `summary` was suppressed
- `agentMessage` item is emitted as: `item/started` (with empty `text`) → repeated `item/agentMessage/delta` (incremental text) → `item/completed` (with full `text`)
- Final `thread/tokenUsage/updated` carries `{totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, modelContextWindow}` — the canonical accounting
- `codex/event/task_complete` carries `last_agent_message: "DONE"` for convenience
- `turn/completed` finalizes with `status: "completed"` (not "failed")

Token cost for "Reply with the single word DONE.": **8141 total** (8121 input, 7040 cached, 20 output, 13 reasoning output). The cached input is the model's system prompt / Codex's tool surface, indicating the App Server does aggressive prompt caching.

For our openswarm translation to NormalizedEvent:

| Codex event | NormalizedEvent equivalent |
|---|---|
| `item/started` (type=`agentMessage`) | (synthesize) `text_delta` start signal |
| `item/agentMessage/delta` | `text_delta` with the delta text |
| `item/completed` (type=`agentMessage`) | (synthesize) end of message; do NOT re-emit text |
| `item/started/completed` (type=`reasoning`) | optional: emit as `info` events; not in our base NormalizedEvent vocabulary |
| `thread/tokenUsage/updated` | feed into `getCumulativeUsage()` |
| `account/rateLimits/updated` | optional: emit as lane event for orchestrator visibility |
| `turn/completed` | `message_stop` with `stopReason` derived from `turn.status` |
| `error` | `error` with structured `failureClass: "provider"` + reason |

## Earlier capture: 402 deactivated workspace (overwritten)

Before re-auth, an earlier capture surfaced `HTTP 402: deactivated_workspace`. The error envelope path is well-exercised — `codex/event/stream_error` fires N retries (default 5), then `codex/event/error` + `turn/completed` with `status: "failed"` and an error object. Our integration treats this as `error` NormalizedEvent + early termination. The 402 fixture was overwritten by the success run; if needed for tests, the failure path is easy to re-capture (override `model` to a non-existent name).

## Default model + provider

`thread/start` returned:
```json
{
  "model": "gpt-5.2-codex",
  "modelProvider": "openai",
  "approvalPolicy": "never",
  "sandbox": {"type": "dangerFullAccess"},
  "reasoningEffort": null
}
```

Model is selected by codex's local config (`~/.codex/config.toml`) unless the `thread/start` request overrides it. Our integration can either accept the codex-chosen model (simpler) or pass `model` in `thread/start` to override (more control).

## Key types from generated bindings

- `ClientRequest.ts` — discriminated union of all 60+ client→server methods
- `ServerNotification.ts` — discriminated union of all server→client notifications
- `ServerRequest.ts` — server→client requests (e.g. approval prompts during turns)
- `EventMsg.ts` — event vocabulary inside the `codex/event/*` wrapper (190 KB JSON schema!)
- `Thread.ts`, `Turn.ts` — entity shapes
- `UserInput.ts` — input items (text, image, etc.)
- `SandboxMode.ts`, `AskForApproval.ts` — turn-level policy
- `RateLimitSnapshot.ts`, `RateLimitWindow.ts` — quota reporting

The generated bindings are large (250+ files, 411 KB JSON schema). For the openswarm `CodexAppServerProvider` we only need ~10 of these types; the rest are App Server features we don't use (skills, MCP, account management, file search, etc.).

## Implementation notes for Stage 3A

1. **Spawn:** `codex app-server` (no args = stdio mode).
2. **Framing:** line-delimited JSON. Reuse `src/swarm/ipc/framing.ts` if it supports `\n`-delimited mode; else minimal one-liner reader.
3. **Lifecycle:** initialize → getAuthStatus → thread/start (cache threadId per RunConfig) → turn/start per `engine.run()` call → listen for events until `turn/completed`.
4. **Cleanup:** `thread/archive` on engine dispose.
5. **Event translation:** map v2 `item/started` + `item/completed` to our `tool_use_*` + `text_delta` events. v1 `codex/event/*` is duplicate — ignore unless the v2 stream is missing data.
6. **Error path:** `turn/completed` with `status === "failed"` → emit `error` NormalizedEvent. JSON-RPC `error` responses → emit `error` NormalizedEvent + abort.
7. **Approval prompts:** when the agent wants to run a destructive command, App Server emits a `ServerRequest` (e.g. `ApplyPatchApprovalParams`) — we'd respond. For v0.3 with `approvalPolicy: "never"`, the App Server auto-approves; we can skip implementing the approval response path.

## Open questions surfaced by spike

- **Q (deferred):** Does `turn/start` emit incremental token-usage notifications, or only on `turn/completed`? Need a successful turn capture to confirm. Affects how we update `engine.getCumulativeUsage()`.
- **Q (deferred):** Does App Server support cancellation via `turn/interrupt` mid-stream? The `TurnInterruptParams` exists; needs verification under load.
- **Q (resolved):** Are server→client notifications interleaved with response IDs? **Yes** — the trace shows `id`-bearing responses and `method`-bearing notifications in the same line stream. Our reader must dispatch on presence of `method` vs `id`.

## Operator follow-up — RESOLVED

ChatGPT auth was reactivated 2026-05-01 and the spike re-run (with the `gpt-5.4` model override) captured a successful streaming session. Fixture is the canonical reference for Stage 3A/3B.

**Stage 3E live smoke** can now use the same script with default args; expected output is "DONE" via the user's ChatGPT subscription, with `turn/completed` status `completed`.
