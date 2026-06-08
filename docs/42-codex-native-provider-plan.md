# 42 — Codex Native Provider (ChatGPT subscription → HardenedNativeEngine)

Power swarm-harness's **in-process** native engine with **ChatGPT subscription
plans** (Plus / Pro / Max) by speaking the Codex backend Responses protocol
directly — no `codex` subprocess. This is the production ("own the protocol")
path, modeled on `references/openclaw`, in contrast to the existing
`--framework codex-chatgpt` path which delegates to the `codex` App Server
binary.

## 1  Motivation

Two ways to reach ChatGPT-subscription billing exist today and after this work:

| Path | Transport | Owner of protocol | Engine features |
|------|-----------|-------------------|-----------------|
| `--framework codex-chatgpt` (shipped, doc 24) | `codex app-server` subprocess (JSON-RPC) | OpenAI `codex` binary | No MCP, no resume, no parallel tools, no hardened loop |
| **`--framework codex-native` (this doc)** | in-process HTTPS + SSE | **us** (ported from openclaw) | Full `HardenedNativeEngine`: retry, eager tool dispatch, mid-turn compaction, swarmkit |

The win: ChatGPT-plan economics with the full native-engine feature set. The
cost: we own an unofficial, codex-CLI-shaped backend protocol and its OAuth.

Key fact: ChatGPT subscription plans are **not** reachable via the OpenAI
platform API (`api.openai.com/v1` + `OPENAI_API_KEY`). They are reachable only
via `https://chatgpt.com/backend-api/codex/responses` with an OAuth bearer
token + `chatgpt-account-id` header. This is why the existing
`OpenAITransportProvider` (`src/providers/openai-transport.ts`, platform API
key only) cannot serve them, and why the Vercel AI SDK path is bypassed
entirely here.

## 2  Scope

### In scope (Phase 1 — working SSE path)

1. **`OpenAICodexOAuth`** — `AuthSource` + `InteractiveAuth`. We **own** the
   OAuth flow (PKCE browser + device-code headless), JWT identity extraction,
   token store, and refresh. No dependency on `codex login`.
2. **`CodexResponsesTransportProvider`** — `TransportProvider` that implements
   `Provider.stream()` with its own `fetch` + SSE parser. Does **not** use
   `LanguageModel` / `streamText`.
3. **Request builder / SSE parser / event mapper / error classifier** — ported
   from openclaw, enforcing the codex backend's quirks (`store:false`,
   `instructions`, encrypted reasoning).
4. **CLI wiring** — `--framework codex-native`, `login`/`logout`, `doctor`.
5. **Model handling** — default `gpt-5.5`, pass-through, surface backend `400`
   verbatim (no hardcoded allowlist — see §6.4).
6. **Tests** — unit (JWT, PKCE, request body, SSE, events, errors) + mocked-SSE
   integration + one live smoke test.

### In scope (Phase 2 — hardening & DX)

7. **TLS preflight** in `doctor` (Homebrew OpenSSL cert hints).
8. **Usage HUD** — `backend-api/wham/usage` rate-limit windows.
9. **WebSocket "cached" transport** — token-efficiency optimization to avoid
   resending full context every turn (see §6.2).

### Out of scope

- Replacing `--framework codex-chatgpt` (subprocess path stays as-is).
- OpenAI platform-API-key behavior (stays in `OpenAITransportProvider`).
- Routing non-gpt models to this provider.

## 3  Architecture

### 3.1  Fit into existing seams

```
HardenedNativeEngine                  (UNCHANGED — src/engine/hardened-native.ts)
  consumes only provider.stream() + provider.capabilities
        │   (verified: native.ts:250, hardened-native.ts:329/142 — never reads .model)
        ▼
CodexResponsesTransportProvider       (NEW — src/providers/codex-responses/)
  implements Provider.stream() with own fetch+SSE; owns no LanguageModel
        ▼
POST https://chatgpt.com/backend-api/codex/responses   (store:false, SSE)
  headers: Authorization, chatgpt-account-id, originator,
           OpenAI-Beta: responses=experimental, accept: text/event-stream
        ▲
OpenAICodexOAuth                      (NEW — src/auth/openai-codex-*.ts)
  AuthSource.headers() → {Authorization, chatgpt-account-id}; refresh on JWT exp
```

### 3.2  The one core-interface change

`src/providers/index.ts:24` — make `Provider.model` optional:

```ts
// Before
readonly model: LanguageModel;
// After
/** Vercel AI SDK handle. Omitted by providers that own their transport
 *  (e.g. CodexResponsesTransportProvider speaks raw HTTPS+SSE). */
readonly model?: LanguageModel;
```

Safe because no engine consumes `provider.model` — engines build a
`ProviderRequest` and call `provider.stream(req)`; the `model` handle is used
only *inside* each Vercel-backed provider's own `stream()`. This is the entire
shared-surface footprint of the feature.

## 4  File manifest

### New — Auth (`src/auth/`)

| File | Ports from | Responsibility |
|------|-----------|----------------|
| `openai-codex-oauth.ts` | opencode `plugin/codex.ts` loader; openclaw identity | `AuthSource`(`kind:"oauth-bearer"`, `providerId:"openai"`) + `InteractiveAuth`. `headers()` → `{Authorization, chatgpt-account-id}`; `refresh()` keyed on JWT `exp`; `isAuthenticated()` |
| `openai-codex-pkce.ts` | opencode `codex.ts:248-358,91-130` | PKCE codes, loopback server (port 1455), `buildAuthorizeUrl`, code→token exchange |
| `openai-codex-device.ts` | opencode `codex.ts:515-595` | device-code flow (`login --device`) |
| `openai-codex-jwt.ts` | openclaw `openai-chatgpt-auth-identity.ts` | `resolveCodexAuthIdentity` (accountId, plan, email), `resolveCodexAccessTokenExpiry` from JWT `exp` |
| `token-store.ts` | — | read/write `~/.swarm-harness/auth.json` (location already named in `src/auth/index.ts:8`); 0600 perms |

OAuth constants (reuse Codex's so the subscription entitlement applies):
`CLIENT_ID = app_EMoamEEZ73f0CkXaXp7hrann`, `ISSUER = https://auth.openai.com`,
scope `openid profile email offline_access`, redirect `http://localhost:1455/auth/callback`.

### New — Provider (`src/providers/codex-responses/`)

| File | Ports from | Responsibility |
|------|-----------|----------------|
| `index.ts` (`CodexResponsesTransportProvider`) | openclaw `openai-chatgpt-responses.ts` | implements `TransportProvider`; `stream()` = build → POST → parse SSE → map → yield `ProviderEvent`; `capabilities`; optional `preflight` |
| `request-builder.ts` | openclaw `convertResponsesMessages` + body builder | `ProviderMessage[]` → Responses body. Enforces: `store:false`, `stream:true`, `instructions`=systemPrompt, `include:["reasoning.encrypted_content"]`, reasoning-effort map, tools→Responses tool shape |
| `headers.ts` | openclaw `buildSSEHeaders` (`:1604`) | `Authorization`, `chatgpt-account-id`, `originator:"swarm-harness"`, `OpenAI-Beta: responses=experimental`, `accept: text/event-stream`, `content-type`, `session_id`/`x-client-request-id` |
| `sse.ts` | openclaw `parseSSE` | SSE line reader → raw codex event objects |
| `events.ts` | openclaw `mapCodexEvents` / `processResponsesStream` | codex event → `ProviderEvent` union (`text-delta`, `reasoning-delta`, `tool-input-*`, `tool-call`, `finish`, `error`) |
| `errors.ts` | openclaw `parseErrorResponse` (`:1521`) | classify `usage_limit_reached`/`rate_limit_exceeded`/429 → friendly "hit ChatGPT limit (plan), retry in ~N min" via `resets_at` |

### Edits — wiring (surgical)

| File:line | Change |
|-----------|--------|
| `src/providers/index.ts:24` | `model` → optional (see §3.2) |
| `src/cli/argv.ts:29` | add `"codex-native"` to `FrameworkChoice` union |
| `src/cli/argv.ts:405,408` | add `"codex-native"` to `--framework` validation + valid-values message |
| `src/cli/runtime.ts:280` | new branch `else if (opts.framework === "codex-native")` → build `OpenAICodexOAuth` + `CodexResponsesTransportProvider` + `HardenedNativeEngine` (mirrors the `codex-chatgpt` branch at `:280-283` and the hardened branch at `:316-323`) |
| `src/cli/runtime.ts:54` | `buildAuthForProvider` (or a sibling `buildCodexAuth`) returns `OpenAICodexOAuth` for the codex-native path |
| `src/cli/login.ts:23` | replace the "run `codex login`" stub with real `case "openai-codex"` → `InteractiveAuth.login({deviceCode})` |
| `src/cli/logout.ts` | add `openai-codex` case |
| `src/cli/doctor.ts` | codex token/expiry/account-id checks; Phase 2: TLS preflight |
| `src/providers/capability-catalog.ts` | `gpt-5.5` entry (`reasoning:true`); **no hardcoded allowlist** — default `gpt-5.5`, pass-through, surface backend `400 detail` (see §6.4) |

Naming: **`--framework codex-native`** (in-process) sits beside the existing
**`codex-chatgpt`** (subprocess). Provider id: **`openai-codex`**.

End-state command:
```
swarm-harness login --provider openai-codex          # our OAuth (browser or --device)
swarm-harness --framework codex-native --model gpt-5.4 "say hi"
```

## 5  Wire protocol (the ported quirks)

The codex backend is **not** spec-compatible with the standard OpenAI Responses
API. The non-obvious rules ported from openclaw:

1. **`store: false` is mandatory** — backend rejects `store:true`
   ("Store must be set to false"; openclaw `:1436,1452`).
2. **System prompt → `instructions`** field, not a system message
   (openclaw `:491`).
3. **`include: ["reasoning.encrypted_content"]`** — required to carry reasoning
   across turns, since `store:false` means no server-side state
   (openclaw `:494`).
4. **Headers** (openclaw `:1594-1619`): `Authorization: Bearer`,
   `chatgpt-account-id`, `originator`, `OpenAI-Beta: responses=experimental`,
   `accept: text/event-stream`, `content-type: application/json`, plus
   `session_id`/`x-client-request-id` for cache affinity.
5. **Identity from JWT** (openclaw `auth-identity.ts`): account id at
   `https://api.openai.com/auth.chatgpt_account_id`, plan at
   `chatgpt_plan_type`, expiry at `exp`.
6. **Limit errors** (openclaw `:1541-1551`): parse `usage_limit_reached` /
   `rate_limit_exceeded` / 429, surface a plan-aware message with reset ETA.

## 6  Known design wrinkles — validated by live spike

A live spike against `backend-api/codex/responses` (using a `codex login`
token, originator `swarm-harness`) resolved all three. Results below.

### 6.1  Reasoning continuity — replay is OPTIONAL (spike-confirmed)

At `reasoning.effort:"high"` the backend returns a `reasoning` output item
carrying `encrypted_content` (~1.5 KB) — keys `id, type, content,
encrypted_content, summary`. **But omitting it on the next turn does not
error:** a follow-up tool round-trip with the reasoning item *removed* returned
`200` and completed normally. So reasoning replay is a **quality/cost
optimization, not a correctness requirement.**

Consequence: **Phase 1 skips reasoning replay entirely** — no change to
`ProviderMessage`, `ProviderEvent`, or the engines. If we later want continuity
for quality, adopt openclaw's mechanism (Option A) in Phase 2:
`openai-responses-shared.ts:699` stores the whole reasoning item as a JSON
signature on the assistant `thinking` block; `:266-273` deserializes and
re-injects it into `input[]` in original order. That's the durable design when
we want it; it is not needed for a correct v1.

### 6.2  Resource conservation — SSE caching works with a pinned session (spike-confirmed)

`store:false` means no `previous_response_id` reuse across SSE requests, so each
turn ships full context. **Prompt caching recovers almost all of it — but only
with a stable session.** Spike: identical 6,099-token prefix sent twice →

- fresh `session_id` per request: `cached_tokens: 0`
- **stable `session_id` + `prompt_cache_key`: `cached_tokens: 5888` (~96%)**

So resource conservation (the Q2 priority) is achieved on plain SSE by pinning
`session_id`/`prompt_cache_key` for the session — which maps directly to the
existing `ProviderRequest.sessionId` already threaded through the engines. This
is a **Phase 1** requirement (cheap, high payoff): keep the message prefix
byte-stable and reuse one session id per run.

This **demotes the WebSocket-"cached" transport to a latency-only optimization**
(it avoids re-uploading the prefix bytes each turn; it does not save tokens that
caching doesn't already save). Keep it as an optional Phase 2 item, prioritized
by measured latency on large sessions — not as a resource necessity.

### 6.3  Originator / endpoint drift — `swarm-harness` accepted (spike-confirmed)

`originator: "swarm-harness"` returned `200` — the field is not allowlisted.
The SSE event schema is standard OpenAI Responses streaming
(`response.created`, `response.in_progress`, `response.output_item.added`,
`response.function_call_arguments.delta`/`done`, `response.content_part.added`,
`response.output_text.delta`/`done`, `response.output_item.done`,
`response.completed`), so openclaw's event mapper ports directly. Drift
mitigation: freeze these as SSE fixtures + a flagged live smoke test.

### 6.4  Model gating — server-side, plan-dependent, and DRIFTING (spike-confirmed)

This is the biggest correction to the original plan. The accepted-model set is
enforced **server-side and depends on the account's plan**, and it has moved.
On the spike account, **only `gpt-5.5` was accepted**; every other id tried —
`gpt-5.4`, `gpt-5.2`, `gpt-5.1`, **and all `-codex` variants** (`gpt-5.5-codex`,
`gpt-5.3-codex`, `gpt-5.2-codex`, `gpt-5-codex`, `codex-mini-latest`,
`gpt-5-codex-mini`) — returned `400 "The '<model>' model is not supported when
using Codex with a ChatGPT account."`

Implications:

- **Do NOT hardcode an allowlist** (reverses the earlier Q7 decision and
  openclaw's `ALLOWED_MODELS`, which is already stale). Instead: **default to
  `gpt-5.5`**, pass the requested model through, and **surface the backend's
  `detail` message verbatim** on `400`. The server is the source of truth and it
  is plan-dependent.
- **Latent bug in the shipped path:** the existing `codex-chatgpt` subprocess
  engine defaults to `gpt-5.4` (`src/engine/codex-framework.ts:79`), which the
  backend now rejects on (at least this) ChatGPT plan. Worth a separate fix —
  bump its default to `gpt-5.5` and/or surface the backend error.

## 7  Test plan

- **Unit:** JWT extraction; PKCE challenge/verifier; request-body builder
  (assert `store:false`, `instructions`, `include` reasoning, tool shape); SSE
  line parser; codex-event → `ProviderEvent` mapping; error/limit classifier;
  header builder.
- **Integration:** mock `fetch` returning recorded codex SSE → assert the
  `ProviderEvent` stream and a clean `finish`.
- **Live (flagged):** real round-trip against `backend-api/codex/responses` with
  a logged-in Max-plan token; assert text + tool-call + usage.

## 8  Phasing & sequencing

Protocol already validated by the spike (§6). Reasoning replay and the
WebSocket transport are both deferred — neither is needed for a correct,
resource-efficient v1.

> **Status: Phase 1 COMPLETE — reviewed & hardened.** Protocol core, auth (JWT,
> token store, PKCE + device OAuth, `OpenAICodexAuth` with silent refresh), the
> `CodexResponsesTransportProvider`, the `Provider.model`-optional change, and
> the CLI wiring (`--framework codex-native`, `login`/`logout --provider
> openai-codex` incl. `--device`, `doctor` codex-auth check) are all in and
> exercised by the built binary.
>
> A four-agent review (protocol, security, integration, tests) drove two fix
> passes: **Pass 1** — wiring blockers (`--device` plumbing, friendly error
> surfacing, effective-model id for budget/cost, framework-aware auth gate,
> context-sized compaction, synthesized `fc_*` id for multi-turn tool loops),
> plus loopback bound to localhost. **Pass 2** — provider robustness (multi-line/
> CRLF SSE, mid-stream + missing-terminal error handling, dropped-tool-call
> fallback), token-store concurrency/permission hardening, OAuth error-body
> redaction, and broad test coverage (multi-turn tool loop, abort, refresh
> failure, device flow, PKCE/CSRF, runtime branch). The build is fully clean
> (`minimem` installed). Live-proven end-to-end incl. a multi-turn tool loop.
>
> **Phase 2 COMPLETE.** #7 TLS preflight + #8 usage windows (both folded into
> `doctor`), #6.1 reasoning continuity (openclaw Option A — live-validated 2-turn
> replay), and #9 the WebSocket "cached" transport (`--codex-transport
> websocket|auto`, connection reuse + delta/`previous_response_id`, SSE
> auto-fallback) — **live-validated**: turn 2 continues on the same socket via a
> delta. The whole codex-native plan is now implemented.

**Phase 1** (working path): JWT/PKCE/device auth + token store →
request-builder/sse/events/errors/headers → provider → `Provider.model`
optional → `gpt-5.5` default + `400` pass-through → **pin `session_id`/
`prompt_cache_key` for caching (§6.2)** → CLI wiring → unit + mocked-SSE tests
(fixtures from §6.3) → live smoke. **No reasoning-replay work** (§6.1).

**Phase 2** (hardening): TLS preflight doctor; usage HUD; reasoning continuity
(openclaw Option A) for quality; WebSocket transport for latency on large
sessions (latency-only — caching already conserves tokens).

## 9  References

- `references/openclaw/src/llm/providers/openai-chatgpt-responses.ts` — provider,
  request builder, SSE, headers, error handling.
- `references/openclaw/extensions/openai/openai-chatgpt-auth-identity.ts` — JWT.
- `references/openclaw/extensions/openai/base-url.ts` — endpoint constants.
- `references/openclaw/src/plugins/provider-openai-chatgpt-oauth-tls.ts` — TLS preflight (Phase 2).
- `references/openclaw/src/infra/provider-usage.fetch.codex.ts` — usage windows (Phase 2).
- `references/opencode/packages/opencode/src/plugin/codex.ts` — compact PKCE + device-code OAuth reference.
- Existing: doc 24 (codex App Server subprocess path), doc 37/38 (HardenedNativeEngine).
