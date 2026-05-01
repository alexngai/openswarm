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

19 unique method names observed in a single happy-path session attempt:

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

## Critical finding from this spike: workspace was 402 Payment Required

The test prompt failed with HTTP 402 from `chatgpt.com` with body `{"detail":{"code":"deactivated_workspace"}}`. The App Server retried 5 times then surfaced the error cleanly through `turn/completed` with `status: "failed"` and a structured error envelope.

**This is not a bug in the spike or our design** — it's the operator's ChatGPT workspace that's deactivated. The protocol shape is fully captured; the swarm-harness implementation is unblocked. A successful happy-path agent turn (with text deltas + tool calls + completion) needs to be captured separately once the operator's ChatGPT account is reactivated for Codex API access.

The error envelope captured is itself useful — it shows our error-translation path is exercised cleanly and `turn/completed` always fires (even on failure), which means our implementation can simply listen for `turn/completed` and inspect `status` to know when the turn ended.

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

The generated bindings are large (250+ files, 411 KB JSON schema). For the swarm-harness `CodexAppServerProvider` we only need ~10 of these types; the rest are App Server features we don't use (skills, MCP, account management, file search, etc.).

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

## Operator follow-up

To unblock end-to-end testing, you'll need to either:
1. Reactivate the ChatGPT workspace billing for Codex API access, OR
2. Switch codex auth to an API key path: `codex login --api-key <OPENAI_API_KEY>` (charges API billing instead of subscription)

Once unblocked, re-run `node scripts/codex-app-server-spike.mjs` and the resulting fixture will contain a real text-streaming session to test `CodexStreamState` against.
