# Research: claw-code API / provider / auth / streaming

Scope: `references/claw-code/rust/crates/api/**` + `crates/runtime/src/oauth.rs` + `crates/runtime/src/sse.rs`. Feeds the **Provider** section of `docs/03-interfaces.md`.

## 1. Summary

claw-code ships a provider abstraction that is thin by design: an `enum ProviderClient { Anthropic, Xai, OpenAi }` dispatch wrapper over two real implementations — an Anthropic-native client and a shared OpenAI-compatible client (with `xai` / `openai` / `dashscope` configs). Routing is by model-name prefix with env-var sniffing as a fallback, and streaming is normalized through an Anthropic-shaped `StreamEvent` enum (OpenAI's chat-completion chunks are translated on the fly). Prompt caching, request preflight (context-window + body-size), retry-with-exponential-backoff+jitter, OAuth refresh, and a rich `ApiError` taxonomy are already productionized — those shape the requirements for swarm-harness's TypeScript port more than any specific data type does.

## 2. Provider abstraction — trait shape, types, lifecycle

**Trait** (`crates/api/src/providers/mod.rs:16-29`):

```rust
pub trait Provider {
    type Stream;
    fn send_message<'a>(&'a self, request: &'a MessageRequest) -> ProviderFuture<'a, MessageResponse>;
    fn stream_message<'a>(&'a self, request: &'a MessageRequest) -> ProviderFuture<'a, Self::Stream>;
}
```

It's `#[allow(dead_code)]` — the trait exists but live dispatch goes through `enum ProviderClient` (`crates/api/src/client.rs:10-107`) with `send_message` / `stream_message` / `provider_kind` / `with_prompt_cache` / `prompt_cache_stats` / `take_last_prompt_cache_record`. `MessageStream` is also a wrapper enum with `request_id()` and `async next_event() -> Result<Option<StreamEvent>, ApiError>` (`crates/api/src/client.rs:109-130`).

**Core request type** (`crates/api/src/types.rs:5-34`) is Anthropic-shaped: `model`, `max_tokens`, `messages`, `system` (flat `Option<String>`, not a block array), `tools`, `tool_choice`, `stream`, plus OpenAI-only tuning fields (`temperature`, `top_p`, `frequency_penalty`, `presence_penalty`, `stop`, `reasoning_effort`) — all `skip_serializing_if = "Option::is_none"` so the same struct serializes cleanly for both backends. Message content is `InputContentBlock::{Text, ToolUse, ToolResult}`; output is `OutputContentBlock::{Text, ToolUse, Thinking, RedactedThinking}`.

**Lifecycle** (`crates/api/src/client.rs:16-47`): `ProviderClient::from_model(model)` → `resolve_model_alias` → `detect_provider_kind` → construct one of three concrete clients from env. An alternative `from_model_with_anthropic_auth(model, Option<AuthSource>)` lets callers inject an OAuth-sourced `AuthSource` instead of env lookup. Prompt cache is attached post-construction (`with_prompt_cache`) and only wired into the Anthropic branch.

## 3. Auth & credentials

**Anthropic `AuthSource`** (`crates/api/src/providers/anthropic.rs:32-96`) is an enum with four variants: `None`, `ApiKey(String)`, `BearerToken(String)`, `ApiKeyAndBearer { api_key, bearer_token }`. `apply()` sends `x-api-key` for API key and `Authorization: Bearer …` for bearer — both when both are present (which is the Anthropic-proxy pattern for gateways that require both a customer key and an edge bearer token).

**Env vars**:
- Anthropic: `ANTHROPIC_API_KEY` (primary), `ANTHROPIC_AUTH_TOKEN` (bearer), `ANTHROPIC_BASE_URL` (`crates/api/src/providers/anthropic.rs:25, 765-767`).
- xAI: `XAI_API_KEY`, `XAI_BASE_URL` → `https://api.x.ai/v1`.
- OpenAI: `OPENAI_API_KEY`, `OPENAI_BASE_URL` → `https://api.openai.com/v1`.
- DashScope: `DASHSCOPE_API_KEY`, `DASHSCOPE_BASE_URL` → `https://dashscope.aliyuncs.com/compatible-mode/v1`.
- OAuth credential file: `$CLAW_CONFIG_HOME/credentials.json` (default `$HOME/.claw/credentials.json`) per `crates/runtime/src/oauth.rs:266-346`.
- `.env` fallback: `read_env_non_empty` falls back to a local `.env` in cwd via `super::dotenv_value(key)` (`providers/mod.rs:408-456`, `providers/anthropic.rs:740-746`). The parser strips `export `, single/double quotes, and treats empty values as unset.

**Empty strings count as unset** across all credential readers. The `from_env_or_saved` path on `AuthSource` **ignores** saved OAuth credentials when env is absent — i.e. env wins over disk even when both exist; saved OAuth is only used via `resolve_saved_oauth_token` which also auto-refreshes expired tokens using the saved refresh token and persists the result (`providers/anthropic.rs:644-713`). Notably, `AuthSource::from_env_or_saved` just errors when no env auth is present even if saved OAuth exists — callers must explicitly choose to read saved OAuth.

**401 hints**:

1. `enrich_bearer_auth_error` (`providers/anthropic.rs:905-979`) — when a 401 comes back and the bearer token starts with `sk-ant-`, append the hint _"sk-ant-* keys go in ANTHROPIC_API_KEY (x-api-key header), not ANTHROPIC_AUTH_TOKEN (Bearer header). Move your key to ANTHROPIC_API_KEY."_ Only applied for pure `BearerToken` auth; suppressed when `x-api-key` is also present.
2. `anthropic_missing_credentials_hint` (`providers/mod.rs:340-401`) — when Anthropic credentials are missing but `OPENAI_API_KEY` / `XAI_API_KEY` / `DASHSCOPE_API_KEY` is present, suggest the right model prefix (`openai/`, `grok`, `qwen-`) to route there instead. OpenAI is checked first (common OpenRouter pattern).

**OAuth** (`crates/runtime/src/oauth.rs`): PKCE S256 flow. `OAuthAuthorizationRequest::build_url` constructs the browser URL; `OAuthTokenExchangeRequest` and `OAuthRefreshRequest` provide form params. Random bytes come from `/dev/urandom` (`generate_random_token` at line 327; **Unix-only** — Windows support is undeclared). Tokens persist to a JSON object under key `"oauth"` in `credentials.json` (atomic write via `.json.tmp` + rename). `OAuthTokenSet` = `{ access_token, refresh_token?, expires_at?, scopes: Vec<String> }`. Expiry is `expires_at <= now_unix_seconds`. `resolve_saved_oauth_token_set` auto-refreshes and preserves the old refresh token when the refresh response omits one (tested at `providers/anthropic.rs:1252-1282`).

## 4. Streaming semantics

**Canonical event shape** (`crates/api/src/types.rs:257-266`) mirrors Anthropic's stream vocabulary: `MessageStart`, `MessageDelta` (carries stop_reason + cumulative usage), `ContentBlockStart`, `ContentBlockDelta`, `ContentBlockStop`, `MessageStop`. Block-level deltas are `TextDelta`, `InputJsonDelta { partial_json }`, `ThinkingDelta`, `SignatureDelta` (`types.rs:240-247`).

**SSE parser** (`crates/api/src/sse.rs`): frame splitter on `\n\n` or `\r\n\r\n`, chunks buffered across reads. Comments (`:` prefix) and `event: ping` are dropped; `data: [DONE]` ends the stream. Data from multiple `data:` lines is joined with `\n` before JSON parse. JSON parse errors are wrapped with `ApiError::json_deserialize(provider, model, body_snippet, source)` so diagnostics carry provider+model+first-200-chars context.

**Tool-use block assembly**: for Anthropic this is straight passthrough. For OpenAI-compat (`providers/openai_compat.rs:435-669`), the client owns a `StreamState` that:
- Emits `MessageStart` on the first chunk.
- Emits `ContentBlockStart { index: 0, text }` the first time a content delta arrives, then `ContentBlockDelta { text }` per chunk.
- For tool calls, keeps a `BTreeMap<openai_index, ToolCallState>` and lifts each to Anthropic-shaped blocks with `block_index = openai_index + 1` (leaving slot 0 for the text block). Arguments arrive as partial JSON strings; the state tracks `emitted_len` so every accumulated chunk is re-emitted as `InputJsonDelta { partial_json }`.
- `finish()` drains any unstarted tool calls, closes open blocks, and synthesizes a final `MessageDelta { stop_reason, usage }` + `MessageStop`.

**Stop reasons**: Anthropic values pass through. OpenAI's `finish_reason` is normalized (`normalize_finish_reason` at `openai_compat.rs:1389-1396`): `"stop" → "end_turn"`, `"tool_calls" → "tool_use"`, everything else passes through verbatim. Fallback when absent: `"end_turn"`.

**Usage accounting**: `Usage { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens }`. Anthropic reports all four natively. OpenAI-compat maps `prompt_tokens → input_tokens`, `completion_tokens → output_tokens`, leaves cache fields zero. Stream usage requires `stream_options: { include_usage: true }` — **only sent to OpenAI** (not xAI, not DashScope), per `should_request_stream_usage` at `openai_compat.rs:1169-1171`. `Usage::total_tokens()` includes cache-creation + cache-read token counts. `Usage::estimated_cost_usd(model)` routes through `runtime::pricing_for_model`.

## 5. Error & retry

**`ApiError` variants** (`crates/api/src/error.rs:20-73`): `MissingCredentials { provider, env_vars, hint? }`, `ContextWindowExceeded { model, estimated_input_tokens, requested_output_tokens, estimated_total_tokens, context_window_tokens }`, `ExpiredOAuthToken`, `Auth(String)`, `InvalidApiKeyEnv(VarError)`, `Http(reqwest::Error)`, `Io(io::Error)`, `Json { provider, model, body_snippet, source }`, `Api { status, error_type?, message?, request_id?, body, retryable, suggested_action? }`, `RetriesExhausted { attempts, last_error }`, `InvalidSseFrame(&'static str)`, `BackoffOverflow { attempt, base_delay }`, `RequestBodySizeExceeded { estimated_bytes, max_bytes, provider }`.

**Classification helpers**:
- `is_retryable()` — http connect/timeout/request errors, and `Api { retryable: true, .. }`.
- `is_context_window_failure()` — either the typed variant or `Api` with status in `{400, 413, 422}` and message containing any of: `"maximum context length"`, `"context window"`, `"context length"`, `"too many tokens"`, `"prompt is too long"`, `"input is too long"`, `"request is too large"` (case-insensitive).
- `is_generic_fatal_wrapper()` — matches Anthropic's canned `"Something went wrong while processing your request. Please try again, or use /new to start a fresh session."` so retry-exhausted versions can be labeled `provider_retry_exhausted`.
- `safe_failure_class()` — returns a stable string class: `"provider_auth"`, `"context_window"`, `"provider_rate_limit"`, `"provider_retry_exhausted"`, `"provider_internal"`, `"provider_error"`, `"provider_transport"`, `"runtime_io"`, `"request_size"`.
- `request_id()` — surfaces Anthropic's `request-id` (with `x-request-id` fallback) through nested `RetriesExhausted`.

**Retry policy** (`providers/anthropic.rs:28-30, 401-464, 569-617` and `providers/openai_compat.rs:23-26, 234-300`): default 8 retries, initial backoff 1s, max backoff 128s. Backoff = `initial << (attempt-1)`, capped at `max_backoff`. Jitter = additive random in `[0, base]` using a splitmix64 finalizer over `SystemTime::now().nanos ^ monotonic_counter`. Retryable HTTP statuses: **408, 409, 429, 500, 502, 503, 504** (`is_retryable_status`). `Api { retryable }` is set by the per-provider `expect_success`. Tracing hooks fire on each attempt (`record_http_request_started`/`succeeded`/`failed`) via an optional `SessionTracer`.

**Error envelope parsing**: Anthropic uses `{ error: { type, message } }` (`providers/anthropic.rs:1000-1010`). OpenAI uses `{ error: { type?, message? } }` (`providers/openai_compat.rs:761-770`). For OpenAI-compat, there's a special non-2xx-but-200 path (`providers/openai_compat.rs:177-205`) that catches backends returning `{"error": ...}` in a 200 body and synthesizes an `ApiError::Api` from it rather than failing with a cryptic JSON parse error.

**Suggested action per status** (`openai_compat.rs:1377-1387`): 401 → "Check API key…", 403 → "Verify API key has required permissions…", 413 → "Reduce prompt size…", 429 → "Wait before retrying…", 500 → "Provider server error…", 502-504 → "Provider gateway error…".

## 6. Multi-provider routing

**`ProviderKind`** = `{ Anthropic, Xai, OpenAi }` (DashScope reuses `OpenAi` because it speaks OpenAI's wire format — only base URL and auth env differ). Routing is layered (`providers/mod.rs:166-251`):

1. **`metadata_for_model(canonical)`** — prefix check on the alias-resolved name:
   - `claude*` → Anthropic
   - `grok*` → xAI
   - `openai/` or `gpt-` → OpenAI (explicit-prefix guarantees correctness even if `ANTHROPIC_API_KEY` is set)
   - `qwen/` or `qwen-` → OpenAI kind, DashScope config
   - `kimi/` or `kimi-` → OpenAI kind, DashScope config
2. **`OPENAI_BASE_URL` override** — if set with `OPENAI_API_KEY`, route to OpenAI (handles Ollama / LM Studio / vLLM local servers where the model name doesn't match any prefix, e.g. `qwen2.5-coder:7b`).
3. **Auth sniffer order** — Anthropic env → OpenAI env → xAI env.
4. **Last resort** — `OPENAI_BASE_URL` set without key (for Ollama-style no-auth servers).
5. **Default** — Anthropic.

**`ProviderClient::from_model`** (`client.rs:17-47`) resolves alias → detects kind → for the `OpenAi` branch, re-checks `metadata_for_model().auth_env == "DASHSCOPE_API_KEY"` to pick `OpenAiCompatConfig::dashscope()` vs `::openai()` (tested at `client.rs:207-237` as a regression guard).

**Wire-format per-provider tweaks**:
- Anthropic request rendering (`providers/anthropic.rs:985-998`) strips `betas` (goes in `anthropic-beta` header), drops `frequency_penalty`/`presence_penalty`, and renames `stop` → `stop_sequences` (only when non-empty).
- OpenAI request rendering (`providers/openai_compat.rs:845-927`) strips routing prefix from model (`openai/gpt-4` → `gpt-4`), switches `max_tokens` → `max_completion_tokens` for `gpt-5*` models, silently drops tuning params for reasoning models (`is_reasoning_model`: `o1*`, `o3*`, `o4*`, `grok-3-mini`, `qwen-qwq*`, `qwq*`, `*thinking*`), and drops `is_error` on tool results for Kimi models (which 400 on that field).
- OpenAI `translate_message` (`openai_compat.rs:946-1010`) flattens assistant text + tool_use into one message with `tool_calls[]`; user tool_result becomes `{ role: "tool", tool_call_id, content }`. Includes `sanitize_tool_message_pairing` (`openai_compat.rs:1027-1081`) that drops orphaned `role:"tool"` messages whose preceding assistant turn lacks a matching `tool_calls[].id`.

**Model aliases** (`providers/mod.rs:52-163`):

| Alias | Canonical | Provider | Env |
|---|---|---|---|
| `opus` | `claude-opus-4-6` | Anthropic | `ANTHROPIC_API_KEY` |
| `sonnet` | `claude-sonnet-4-6` | Anthropic | `ANTHROPIC_API_KEY` |
| `haiku` | `claude-haiku-4-5-20251213` | Anthropic | `ANTHROPIC_API_KEY` |
| `grok` / `grok-3` | `grok-3` | xAI | `XAI_API_KEY` |
| `grok-mini` / `grok-3-mini` | `grok-3-mini` | xAI | `XAI_API_KEY` |
| `grok-2` | `grok-2` | xAI | `XAI_API_KEY` |
| `kimi` | `kimi-k2.5` | OpenAI (DashScope) | `DASHSCOPE_API_KEY` |

Alias lookup is ASCII-lowercased. Unknown names pass through unchanged.

**Proxy support** (`crates/api/src/http_client.rs`): `ProxyConfig { http_proxy?, https_proxy?, no_proxy?, proxy_url? }`. `from_env()` reads uppercase then lowercase spellings of `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (uppercase wins when both set). Empty strings count as unset. The unified `proxy_url` field overrides both per-scheme entries and is registered as both HTTP and HTTPS proxy. Invalid proxy URLs bubble up as `ApiError::Http`. `build_http_client_or_default` swallows build errors and returns a vanilla client so construction never fails (failure surfaces on first request). `reqwest::NoProxy::from_string` parses the no-proxy filter.

## 7. Prompt caching

Only wired for Anthropic (`client.rs:59-64, 67-80`). Two responsibilities:

**Completion cache** (full response-level, in-session): on `send_message`, a fingerprint of the request is computed (FNV-1a over serialized JSON of `model` + `system` + `tools` + `messages`), keyed as `v1-{16-hex-chars}`. `lookup_completion` reads `$CLAUDE_CONFIG_HOME/cache/prompt-cache/{session-id}/completions/{hash}.json` and returns the cached `MessageResponse` if `now - cached_at < completion_ttl` (default 30s). Fingerprint version mismatch invalidates. Session-id is path-sanitized (non-alphanumeric → `-`, capped at 80 chars).

**Usage-level cache-break detection**: tracks previous request's `cache_read_input_tokens`. If the tokens drop by more than `cache_break_min_drop` (default 2,000) while the fingerprint is stable (model/system/tools/messages hashes all unchanged), reports an `unexpected` break with reason `"cache read tokens dropped while prompt fingerprint remained stable"`. If elapsed > `prompt_ttl` (default 5min), labeled `possible prompt cache TTL expiry after Ns`. If any fingerprint field changed, returns an *expected* break with specific reason (`"model changed"`, `"system prompt changed"`, etc.).

Per-session files: `session-state.json` (previous `TrackedPromptState`), `stats.json` (`PromptCacheStats` with counters for hits/misses/writes/expected-invalidations/unexpected-breaks/total-cache-{creation,read}-input-tokens/last-*).

Cache keys (from `base_cache_root`): `CLAUDE_CONFIG_HOME/cache/prompt-cache/...` → falls back to `$HOME/.claude/cache/prompt-cache/` → `temp_dir/claude-prompt-cache`. Note: **`CLAUDE_CONFIG_HOME` for cache vs. `CLAW_CONFIG_HOME` for OAuth credentials** — two different env vars rooted in different directories.

Prompt cache declarations (Anthropic's `cache_control` block markers) are **not** visible in this slice — they'd be in the `AnthropicRequestProfile` / beta rendering layer in the `telemetry` crate. Flag this as a gap.

## 8. Preflight & limits

**Context-window preflight** runs in two layers:

1. **Local byte estimate** (`providers/mod.rs:302-334`) — serialize `messages`, `system`, `tools`, `tool_choice` to JSON, sum `bytes/4 + 1` as a token estimate, add `max_tokens`, compare to `model_token_limit(model).context_window_tokens`. Unknown models skip the check.
2. **Anthropic `count_tokens` endpoint refinement** (`providers/anthropic.rs:489-547`) — on success, use the server's exact `input_tokens`; on any failure (network / parse / auth) fall back silently to the byte estimate that already passed. Only runs for Anthropic.

Known model limits (`providers/mod.rs:277-300`):
- `claude-opus-4-6`: max 32k out, 200k ctx
- `claude-sonnet-4-6`, `claude-haiku-4-5-20251213`: max 64k out, 200k ctx
- `grok-3`, `grok-3-mini`: max 64k out, 131,072 ctx
- `kimi-k2.5`, `kimi-k1.5`: max 16,384 out, 256,000 ctx
- Unknown: default max-out = 32k (if `opus` in name) or 64k; no preflight guard.

Plugin override: `max_tokens_for_model_with_override(model, Option<u32>)` — lets a plugin config override the per-model default.

**Request-body-size preflight** (OpenAI-compat only, `openai_compat.rs:815-841`): serialize the wire-format payload and compare against `config.max_request_body_bytes`:
- OpenAI: 100 MB
- xAI: 50 MB
- DashScope: **6 MB** (observed limit in dogfood)

Overflow → `ApiError::RequestBodySizeExceeded { estimated_bytes, max_bytes, provider }` (non-retryable). Anthropic has no equivalent guard.

## 9. Requirements for swarm-harness

Each bullet tagged by scope target.

**Provider interface**
- [v0] Define `Provider` interface as in `docs/03-interfaces.md` (already drafted). Keep the provider-specific fields (`temperature`, `top_p`, `reasoning_effort`, etc.) **off** `MessageRequest` and expose them via `ProviderCapabilities` or provider-owned config instead. claw-code conflates them on the type but then strips per-provider — we can do better by separating concerns.
- [v0] Canonical `StreamEvent` shape: keep Anthropic's vocabulary as the normalized form. Translate OpenAI-compat chunks inside the provider.
- [v0] `MessageStream` exposes `request_id()` and async iterator of events; stream returns an error variant for transport failures mid-stream.
- [v0] Provider selection by model prefix, with env-var sniffing as fallback. Surface a **routing explain** output for debugging.
- [v1] Optional `sendMessage(non-streaming)` path per provider (claw-code has both; v0 could start stream-only since streaming subsumes non-stream).

**Auth**
- [v0] `AuthSource` equivalent: API-key, bearer, both-together, none.
- [v0] Env → `.env` fallback with empty-as-unset semantics.
- [v0] "401 with sk-ant-* bearer" hint — high-signal fix for a common mistake.
- [v0] Missing-credentials hint that sniffs foreign provider env vars and recommends the right model prefix.
- [v0] Anthropic env vars: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`.
- [v1] OAuth PKCE flow with on-disk `credentials.json`, auto-refresh with preserved-old-refresh-token-on-omission behavior. Key: cross-platform random (Node's `crypto.randomBytes` replaces `/dev/urandom`).
- [later] Masked-header rendering for logs (`masked_authorization_header`).
- [skip] `from_env_or_saved` that ignores saved OAuth when env is absent — surprising behavior; swarm-harness should make env-vs-saved precedence explicit at call sites.

**Streaming**
- [v0] SSE parser handling `\n\n` and `\r\n\r\n` frame separators, `:`-comments, `event: ping` drop, `data: [DONE]` terminator, multi-line `data:` joining with `\n`.
- [v0] OpenAI-compat chunk-to-normalized-event translator, including tool-call `index+1` remapping and `emitted_len`-tracked `InputJsonDelta` partial emission.
- [v0] `finish_reason` normalization: `stop → end_turn`, `tool_calls → tool_use`.
- [v0] `stream_options: { include_usage: true }` only for OpenAI (not xAI / DashScope).
- [v1] Thinking / signature deltas (`ThinkingDelta`, `SignatureDelta`, `RedactedThinking` output block).
- [v1] Per-frame JSON-deserialize failure that carries provider + model + first-200-char body snippet.

**Error & retry**
- [v0] Strongly-typed error union matching claw-code's `ApiError` classes. At minimum: missing-credentials, context-window, expired-oauth, http, api, json, retries-exhausted, invalid-sse-frame, request-body-too-large.
- [v0] `isRetryable` helper + retry policy (default 8 retries, 1s→128s exponential, additive `[0, base]` jitter).
- [v0] Retryable HTTP statuses: 408, 409, 429, 500, 502, 503, 504.
- [v0] `safeFailureClass()` that stable-strings errors into `provider_auth` / `context_window` / `provider_rate_limit` / `provider_retry_exhausted` / `provider_internal` / `provider_error` / `provider_transport` / `runtime_io` / `request_size` for telemetry pipelines.
- [v0] `suggestedActionForStatus` mapping (401/403/413/429/5xx → human-readable hint).
- [v1] OpenAI "200 OK with `{error}` body" special case — synthesize an `Api` error instead of JSON-parse failure.
- [later] Generic-fatal-wrapper detection (`"Something went wrong while processing your request…"`).

**Multi-provider routing**
- [v0] Anthropic + OpenAI-compat (the shared client covers OpenAI, xAI, DashScope, and any compatible endpoint). Three engines total at launch.
- [v0] Model-prefix routing with `claude*` / `grok*` / `openai/` / `gpt-` / `qwen*` / `kimi*`. Explicit prefix overrides env-based sniffing.
- [v0] Env-sniffer fallback order: OPENAI_BASE_URL override → Anthropic auth → OpenAI → xAI → OpenAI-base-url-no-auth (Ollama) → Anthropic default.
- [v0] Aliases: `opus`/`sonnet`/`haiku` → concrete Anthropic model IDs; `grok`/`grok-mini`/`kimi` likewise. Table should live in code, not config, so tests lock it down.
- [v0] Per-provider wire-format adapter: strip routing prefix, route tuning params correctly, rename `stop → stop_sequences` for Anthropic, `max_tokens → max_completion_tokens` for `gpt-5*`, drop `is_error` for Kimi, drop tuning params for reasoning models (`o1*`/`o3*`/`o4*`/`grok-3-mini`/`*qwq*`/`*thinking*`).
- [v0] `sanitizeToolMessagePairing` for OpenAI-compat: drop `role:"tool"` messages not preceded by an assistant turn with matching `tool_calls[].id`.
- [v1] DashScope as a first-class config alongside OpenAI (it's too common in practice to gate behind env-override). Kimi needs the `is_error`-strip behavior.

**Prompt caching**
- [v0] On-disk completion cache keyed by request fingerprint (FNV-1a over JSON of `model + system + tools + messages`), TTL-bounded (default 30s). Default root: `$XDG_CONFIG_HOME/...` or platform-equivalent.
- [v0] Stats struct: hits / misses / writes / expected-invalidations / unexpected-breaks / total-cache-{creation,read}-input-tokens.
- [v0] Cache-break detection based on `cache_read_input_tokens` delta vs. fingerprint stability; mark `unexpected=true` when tokens drop > threshold (default 2k) with identical fingerprint.
- [v0] Session-state persistence at `{root}/{session-id}/session-state.json` and `stats.json`; path-sanitized session IDs.
- [v1] Fingerprint versioning (`v1-` prefix) so format bumps invalidate rather than miscompare.
- [skip] `cache_control` block declaration — not visible in this slice; defer to a later cross-reference pass once `telemetry::AnthropicRequestProfile` is analyzed.

**Preflight & limits**
- [v0] Local byte-estimate context-window preflight (`bytes/4 + 1` token approximation) that short-circuits before any network call.
- [v0] `ModelTokenLimit { max_output_tokens, context_window_tokens }` registry for known models; unknown models skip preflight.
- [v0] Request-body-size preflight with per-provider max bytes (DashScope 6 MB / xAI 50 MB / OpenAI 100 MB). Non-retryable error.
- [v1] Anthropic `count_tokens` endpoint refinement with silent fallback to byte-estimate on any failure.
- [v1] Plugin-level `max_output_tokens` override.

**Proxy & HTTP**
- [v0] `ProxyConfig` with `http_proxy`, `https_proxy`, `no_proxy`, `proxy_url` (unified). Support both uppercase and lowercase env spellings; upper wins. Empty string = unset.
- [v0] `build_http_client_or_default` pattern — invalid proxy URL fails construction gracefully, defers surface to first request if caller opts for the infallible variant.

**Miscellaneous**
- [v0] Request-id extraction from `request-id` header with `x-request-id` fallback; plumbed through errors and stream handles.
- [v0] `.env` parser: strip `export `, single/double quotes; skip blanks, comments, and lines missing `=`; empty values treated as unset.
- [v0] Telemetry hooks: record http-request-started / succeeded / failed per attempt; record analytics events with total-tokens + estimated-cost-usd. Needs a Node-ecosystem equivalent — OpenTelemetry bridge is the obvious fit.
- [later] Jitter using splitmix64 over nanos+counter — Node's `crypto.randomInt` is probably fine instead.

## 10. Open questions

1. **Prompt caching `cache_control` block declaration** — not visible in this slice; lives in `telemetry::AnthropicRequestProfile::render_json_body`. Need a follow-up pass on the telemetry crate to understand how `cache_control` is attached to blocks and how the beta header (`anthropic-beta`) is threaded.
2. **Beta header handling** — `anthropic-beta` is mentioned but not rendered in this slice. `with_beta` builder exists; actual wire emission is in telemetry.
3. **Tool parallelism** — no explicit flag in `MessageRequest` for parallel tool use. Is that implied by model + client defaults, or is there a capability bit we need to discover?
4. **Thinking/reasoning content blocks** — `OutputContentBlock::Thinking` / `RedactedThinking` exist and stream deltas are parsed, but the emit-side (how the request asks for them, what `extra_body` fields are involved) isn't in this slice.
5. **OpenAI-compat stream usage for xAI/DashScope** — `should_request_stream_usage` only returns true for OpenAI. Does this mean streaming from xAI and DashScope never reports token usage? If so, swarm-harness should document that limitation explicitly for downstream cost accounting.
6. **OAuth login flow UX** — `oauth.rs` exposes the primitives but the orchestration (browser launch, local callback listener, scope negotiation, UX on refresh failure) is presumably in a higher crate. Worth a separate research slice.
7. **OAuth random-token source** — `generate_random_token` reads `/dev/urandom` directly. Windows support is undefined. Swarm-coder must use `crypto.randomBytes` (cross-platform) unconditionally.
8. **`CLAW_CONFIG_HOME` vs `CLAUDE_CONFIG_HOME`** — claw-code uses different env vars for OAuth credentials vs. prompt cache (`.claw/` vs `.claude/`). swarm-harness needs to pick one canonical root (proposed: `$XDG_CONFIG_HOME/swarm-harness/`).
9. **`preflight_message_request` token estimate accuracy** — `bytes/4+1` is a rough heuristic. Anthropic's `count_tokens` gives exact counts but is network-bound. Do we need a tiktoken-based offline estimator for OpenAI-compat providers, or is the heuristic good enough when body-size preflight catches the extreme cases?
10. **`AuthSource::from_env_or_saved` ignoring saved OAuth** — the current behavior (test at `anthropic.rs:1157-1177`) feels buggy but is intentional. Confirm which precedence swarm-harness wants.
11. **Model registry table** — claw-code hard-codes model IDs and limits in source. Should swarm-harness make this loadable from a config file, or keep it in code for lock-down-via-tests?

## 11. File references

- `references/claw-code/rust/crates/api/src/lib.rs:1-43` — public surface; what's re-exported.
- `references/claw-code/rust/crates/api/src/client.rs:10-107` — `ProviderClient` enum dispatch.
- `references/claw-code/rust/crates/api/src/client.rs:17-47` — `from_model` routing logic + DashScope regression guard.
- `references/claw-code/rust/crates/api/src/client.rs:109-130` — `MessageStream` enum wrapper.
- `references/claw-code/rust/crates/api/src/error.rs:20-73` — `ApiError` variants.
- `references/claw-code/rust/crates/api/src/error.rs:126-241` — classification (`is_retryable`, `is_context_window_failure`, `is_generic_fatal_wrapper`, `safe_failure_class`).
- `references/claw-code/rust/crates/api/src/error.rs:383-415` — text markers for context-window and generic-fatal patterns; body snippet truncation.
- `references/claw-code/rust/crates/api/src/http_client.rs:13-113` — `ProxyConfig` + `build_http_client_with`.
- `references/claw-code/rust/crates/api/src/prompt_cache.rs:19-43` — `PromptCacheConfig` TTL defaults.
- `references/claw-code/rust/crates/api/src/prompt_cache.rs:45-73` — `PromptCachePaths` layout.
- `references/claw-code/rust/crates/api/src/prompt_cache.rs:75-106` — `PromptCacheStats`, `CacheBreakEvent`, `PromptCacheRecord`.
- `references/claw-code/rust/crates/api/src/prompt_cache.rs:145-243` — lookup + record flows.
- `references/claw-code/rust/crates/api/src/prompt_cache.rs:295-382` — fingerprints + break detection.
- `references/claw-code/rust/crates/api/src/prompt_cache.rs:435-499` — hashing + path sanitization + base cache root.
- `references/claw-code/rust/crates/api/src/sse.rs:4-80` — `SseParser` frame splitter.
- `references/claw-code/rust/crates/api/src/sse.rs:82-128` — `parse_frame` logic (`ping` drop, `[DONE]` terminator, multi-line data join).
- `references/claw-code/rust/crates/api/src/types.rs:5-34` — `MessageRequest`.
- `references/claw-code/rust/crates/api/src/types.rs:44-76` — `InputMessage` builders.
- `references/claw-code/rust/crates/api/src/types.rs:78-118` — input content blocks + `ToolChoice`.
- `references/claw-code/rust/crates/api/src/types.rs:120-206` — `MessageResponse`, output blocks, `Usage`.
- `references/claw-code/rust/crates/api/src/types.rs:208-266` — streaming events.
- `references/claw-code/rust/crates/api/src/providers/mod.rs:16-29` — `Provider` trait.
- `references/claw-code/rust/crates/api/src/providers/mod.rs:31-45` — `ProviderKind`, `ProviderMetadata`, `ModelTokenLimit`.
- `references/claw-code/rust/crates/api/src/providers/mod.rs:52-163` — `MODEL_REGISTRY` and `resolve_model_alias`.
- `references/claw-code/rust/crates/api/src/providers/mod.rs:166-251` — `metadata_for_model`, `detect_provider_kind`, routing priority.
- `references/claw-code/rust/crates/api/src/providers/mod.rs:277-300` — `model_token_limit` table.
- `references/claw-code/rust/crates/api/src/providers/mod.rs:302-334` — `preflight_message_request` + byte-estimate.
- `references/claw-code/rust/crates/api/src/providers/mod.rs:340-401` — foreign-provider credential hint logic.
- `references/claw-code/rust/crates/api/src/providers/mod.rs:408-456` — `.env` parsing.
- `references/claw-code/rust/crates/api/src/providers/anthropic.rs:32-96` — `AuthSource`.
- `references/claw-code/rust/crates/api/src/providers/anthropic.rs:98-111` — `OAuthTokenSet`.
- `references/claw-code/rust/crates/api/src/providers/anthropic.rs:113-281` — `AnthropicClient` construction + builders.
- `references/claw-code/rust/crates/api/src/providers/anthropic.rs:283-359` — `send_message` / `stream_message`.
- `references/claw-code/rust/crates/api/src/providers/anthropic.rs:401-464` — retry loop.
- `references/claw-code/rust/crates/api/src/providers/anthropic.rs:466-487` — `send_raw_request` + header build (`x-api-key`, bearer, content-type).
- `references/claw-code/rust/crates/api/src/providers/anthropic.rs:489-547` — `preflight` + `count_tokens`.
- `references/claw-code/rust/crates/api/src/providers/anthropic.rs:569-617` — `backoff_for_attempt` / `jittered_backoff_for_attempt`.
- `references/claw-code/rust/crates/api/src/providers/anthropic.rs:619-713` — OAuth resolution + refresh.
- `references/claw-code/rust/crates/api/src/providers/anthropic.rs:795-864` — `MessageStream` with prompt-cache usage observation.
- `references/claw-code/rust/crates/api/src/providers/anthropic.rs:866-894` — `expect_success` + `is_retryable_status`.
- `references/claw-code/rust/crates/api/src/providers/anthropic.rs:896-979` — `enrich_bearer_auth_error` for sk-ant-* hint.
- `references/claw-code/rust/crates/api/src/providers/anthropic.rs:985-998` — `strip_unsupported_beta_body_fields`.
- `references/claw-code/rust/crates/api/src/providers/openai_compat.rs:19-97` — `OpenAiCompatConfig` + per-provider body limits.
- `references/claw-code/rust/crates/api/src/providers/openai_compat.rs:99-232` — `OpenAiCompatClient` + send/stream.
- `references/claw-code/rust/crates/api/src/providers/openai_compat.rs:234-300` — retry loop.
- `references/claw-code/rust/crates/api/src/providers/openai_compat.rs:265-281` — `send_raw_request` with body-size check.
- `references/claw-code/rust/crates/api/src/providers/openai_compat.rs:361-669` — `MessageStream` + `StreamState` + `ToolCallState` (OpenAI-to-normalized translation).
- `references/claw-code/rust/crates/api/src/providers/openai_compat.rs:779-812` — `is_reasoning_model`, `strip_routing_prefix`.
- `references/claw-code/rust/crates/api/src/providers/openai_compat.rs:815-841` — request-body-size preflight.
- `references/claw-code/rust/crates/api/src/providers/openai_compat.rs:843-927` — `build_chat_completion_request` including `gpt-5*` max-tokens rename and reasoning-model param stripping.
- `references/claw-code/rust/crates/api/src/providers/openai_compat.rs:934-1010` — `model_rejects_is_error_field`, `translate_message`.
- `references/claw-code/rust/crates/api/src/providers/openai_compat.rs:1027-1081` — `sanitize_tool_message_pairing`.
- `references/claw-code/rust/crates/api/src/providers/openai_compat.rs:1169-1171` — `should_request_stream_usage` (OpenAI-only).
- `references/claw-code/rust/crates/api/src/providers/openai_compat.rs:1173-1223` — `normalize_response`.
- `references/claw-code/rust/crates/api/src/providers/openai_compat.rs:1226-1270` — `next_sse_frame`, `parse_sse_frame`.
- `references/claw-code/rust/crates/api/src/providers/openai_compat.rs:1343-1396` — `expect_success`, `suggested_action_for_status`, `normalize_finish_reason`.
- `references/claw-code/rust/crates/runtime/src/oauth.rs:14-96` — `OAuthTokenSet`, PKCE types.
- `references/claw-code/rust/crates/runtime/src/oauth.rs:120-239` — `OAuthAuthorizationRequest::build_url`, `OAuthTokenExchangeRequest::form_params`, `OAuthRefreshRequest::form_params`.
- `references/claw-code/rust/crates/runtime/src/oauth.rs:241-380` — PKCE/state generation, credentials load/save/clear, callback query parsing.
- `references/claw-code/rust/crates/runtime/src/sse.rs:3-101` — generic `IncrementalSseParser` (note: duplicate of api-crate parser but line-based rather than frame-based; appears unused by the api crate).
