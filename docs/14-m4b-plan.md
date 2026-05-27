# M4b Provider Breadth + Plugin Install Lifecycle + ChatGPT Subscription Auth — Implementation Plan

**Status:** draft (rev 2)
**Owner:** alex
**Created:** 2026-04-20
**Prereq:** M4a complete (NativeEngine foundation, formalized Provider interface at `src/providers/index.ts`, `OpenAITransportProvider` via `@ai-sdk/openai`, model-prefix routing at `src/providers/routing.ts`, model alias table).
**Refines:** the remaining items from §"Milestone M4 — provider breadth + ChatGPT subscription" in `docs/07-implementation-plan.md` that are not covered by M4a. Specifically: (a) xAI / Google / DashScope `TransportProvider`s, (b) plugin install / enable / disable / update / uninstall lifecycle, (c) ChatGPT Plus/Pro subscription auth via Codex App Server OAuth.

## Scope

M4a delivered the transport foundation (NativeEngine, Provider interface, OpenAITransportProvider, model-prefix routing, alias table). M4b builds directly on that foundation with:

1. **Provider breadth** — three additional `TransportProvider` implementations plug into M4a's `Provider` interface: xAI (`grok*`), Google (`gemini-*`), and DashScope (`qwen*` / `qwen/*` via OpenAI-compat shim). Model-prefix routing extends; model-family quirks apply at provider boundary.
2. **Plugin install lifecycle** — `install / enable / disable / update / uninstall` flows on top of M2's read-only `ClaudeCodeSource`. Local-path + git-url install sources; atomic state at `~/.claude/plugins/state.json`; `PluginRegistry` consults `enabled` set before registering tools.
3. **ChatGPT Plus/Pro subscription auth** — per Q17 resolution: custom Vercel AI SDK provider targeting `https://chatgpt.com/backend-api/codex/responses` (NOT `api.openai.com`). `OpenAIOAuthAuth` implements `InteractiveAuth` against `auth.openai.com/oauth/` with PKCE using the Codex App Server client id. CLI `--framework codex-chatgpt`; `swarm-harness login --provider codex-chatgpt`.

**Prerequisites:** Phase 5.0 Codex Endpoint Spike (operator handoff) must complete before Phase 5.1 implementation begins. See §Phase 5.0 below.

**In scope:**

- `src/providers/xai-transport.ts` — `@ai-sdk/xai` wrapper; maps `grok*` to `Provider`. Handles reasoning-model param stripping for `grok-3-mini`.
- `src/providers/google-transport.ts` — `@ai-sdk/google` wrapper; maps `gemini-*` to `Provider`. Handles Google's different stop-reason naming where needed (most normalized by AI SDK).
- `src/providers/dashscope-transport.ts` — OpenAI-compat via `@ai-sdk/openai` with `OPENAI_BASE_URL` override to `https://dashscope.aliyuncs.com/compatible-mode/v1`; maps `qwen*` / `qwen/*`. Enforces 6 MB request-body cap at preflight (research/01-api.md §8). Strips `is_error` on tool results for `kimi*` models if routed here.
- `src/providers/routing.ts` — extended with `grok*`, `gemini-*`, `qwen*` / `qwen/*` entries; model-family quirk dispatcher (GPT-5* `max_completion_tokens`, reasoning-model tuning-param strip, Kimi `is_error` strip).
- `src/providers/dashscope-preflight.ts` — 6 MB body-size preflight; returns `ApiError.RequestBodySizeExceeded` equivalent on overflow.
- `src/auth/xai-api-key.ts`, `src/auth/google-api-key.ts`, `src/auth/openai-compat-api-key.ts` — API-key AuthSource impls for the three new providers (last one reused for DashScope via the base-URL/auth-header shim).
- `src/auth/openai-oauth.ts` (new) — `OpenAIOAuthAuth implements InteractiveAuth`. PKCE S256 flow against `auth.openai.com/oauth/authorize` with the Codex App Server client id. `login()`, `logout()`, `headers()` returning `Authorization: Bearer <access_token>`, `refresh()` against `/oauth/token`. Token persistence at `~/.swarm-harness/auth.json` under `openai-oauth` key, atomic temp-file + rename.
- `src/providers/codex-chatgpt.ts` (new) — custom Vercel AI SDK `LanguageModel` factory. Target base URL `https://chatgpt.com/backend-api/codex/responses`. Uses `OpenAIOAuthAuth.headers()` for bearer. Translates ChatGPT's streaming response shape (SSE, Codex-internal event vocabulary) to the AI SDK's normalized `StreamPart` event stream so NativeEngine consumes it via the standard `Provider` path.
- `src/plugins/install.ts` (new) — `installPlugin(id, source)` with `PluginInstallSource` discriminated union (`LocalPath { path }` | `GitUrl { url, ref? }`). Validates manifest on install (PluginJsonSchema from M2). Writes to `~/.claude/plugins/<sanitized-id>/`. Records `version`, `installedAt` in state.
- `src/plugins/enable.ts` / `src/plugins/disable.ts` — toggle `enabled` set in `~/.claude/plugins/state.json` without removing files.
- `src/plugins/uninstall.ts` — `rm -r` plugin dir + remove state entry. Refuse for bundled plugins (if/when we ship them; out-of-scope for M4b but reserve the guard).
- `src/plugins/update.ts` — `updatePlugin(id)`. Re-materialize from recorded `install_source`, validate manifest, atomic swap (copy to `<id>.new/`, rename `<id>` → `<id>.old`, rename `<id>.new` → `<id>`, `rm -r <id>.old`). Bumps `versions[id]` in state.
- `src/plugins/state.ts` (new) — `PluginStateStore` with atomic read/write. Shape `{ enabled: string[]; versions: Record<string, string>; installSources: Record<string, PluginInstallSource> }`. Located at `~/.claude/plugins/state.json`. Atomic write via `fs.writeFile(tmp)` + `fs.rename(tmp, final)`.
- `src/plugins/registry.ts` — MODIFIED — `buildPluginTools` consults `PluginStateStore.isEnabled(id)` before registering a plugin's tools. Disabled plugins: skip registration (no tool surface, no lifecycle hooks run).
- `src/cli/plugin.ts` (new) — subcommands `swarm-harness plugin install <source>`, `plugin list`, `plugin enable <id>`, `plugin disable <id>`, `plugin update <id>`, `plugin uninstall <id>`.
- `src/cli/main.ts` — MODIFIED — route `plugin` subcommand to `plugin.ts`; route `login --provider codex-chatgpt` to `OpenAIOAuthAuth.login()`; recognize `--framework codex-chatgpt` flag.
- `src/cli/login.ts` — MODIFIED — accept `--provider codex-chatgpt`; dispatch to `OpenAIOAuthAuth.login()` or the existing Anthropic path.
- `scripts/smoke-m4b.sh` offline + live (≥3 offline + ≥2 live scenarios).

**Framework mode (codex-chatgpt / claude-agent-sdk):** SwarmHost-routed tools (send_message, check_inbox, task_stop, task_output, ask_user_question) are REMOVED FROM THE TOOL SURFACE — the model doesn't see them. Not degraded to no-op.

**Out of scope (explicit):**

- M4a items: NativeEngine, `Provider` interface, OpenAITransportProvider, model-prefix routing skeleton. M4b extends these; it does not build them.
- GitHub Copilot subscription — permanently out per Q18. No exception in M4b.
- Direct OAuth to Anthropic Messages API bypassing Agent SDK — rejected per Q16. Claude Max continues to route through the existing `ClaudeAgentSdkEngine` FrameworkProvider path.
- Plugin signing / trust model — M5+ per `docs/07-implementation-plan.md`. M4b installs any local path or git URL the user points at; the user accepts the trust burden.
- Plugin marketplace / remote registry — M5+.
- Bundled plugins auto-sync — M5+ (out of M4b even though `versions` state can record them for forward-compat).
- Per-provider prompt caching beyond Anthropic — Anthropic-only from M3b; xAI / Google / DashScope caching is a no-op in M4b (usage struct reports 0 for cache fields, consistent with M2's OpenAI wiring).
- Auto-rotating ChatGPT Codex client id or fallback — if OpenAI revokes the client id, the feature becomes unavailable; graceful-degradation error message only.
- Codex response-shape compatibility guard — we normalize what's observed at implementation time. Long-term stability is risked (documented); no automated drift detection in M4b.
- Plugin dependency graph (plugin A requires plugin B) — out of scope; each plugin stands alone.

## Decision context

Seven scope/mechanism choices need locking before implementation starts. Default picks below; each has a one-line rationale.

1. **Codex App Server OAuth client id source: reverse-engineered, hard-coded, documented as risk.**
   Rationale: per Q17, there is no formal third-party program. The client id `app_EMoamEEZ73f0CkXaXp7hrann` is in production use by Cline / OpenClaw / opencode; swarm-harness uses the same value. Documented in `src/auth/openai-oauth.ts` as a top-of-file comment with "policy-tolerated, not contracted" risk note + "OpenAI can revoke this at any time; if login flow starts returning 4xx, the feature is dead pending user action." Alternative "ask each user to register their own app" rejected: OpenAI does not publish a self-serve registration path for this grant type; users can't actually do it.

2. **Plugin state file location: `~/.claude/plugins/state.json` (NOT `~/.swarm-harness/...`).**
   Rationale: we discover plugins from `~/.claude/plugins/` already (M2's `ClaudeCodeSource` default). Enable/disable state living alongside keeps the plugin install tree self-contained and interoperable-adjacent with Claude Code's own tooling (users can `rm -r ~/.claude/plugins/<id>` and our state cleans up on next `list`). Alternative "write to `~/.swarm-harness/plugins-state.json`" rejected: would split the source-of-truth across two roots; users deleting a plugin directory manually would leave a stale `enabled` entry that must be detected and reconciled. The chosen location makes `state.json` co-located with the plugins it describes. Note: the file is NOT a Claude Code contract — it's ours. We document its schema and never read anything we didn't write.

3. **Plugin state shape: flat `{ enabled[], versions{}, installSources{} }` — NOT per-plugin nested objects.**
   Rationale: flat keys simplify atomic writes (single JSON file, whole-file rewrite) and make `list` cheap (one parse, three lookups). Per-plugin nested objects would let each plugin carry its own metadata sidecar but complicate the atomic contract and invite partial-write bugs. Claw's `installed.json` uses a map `{ "<id>": { ... } }` — we diverge here because flat lets us keep `enabled` as a `string[]` (cheapest representation of "set of ids enabled") and versions/installSources as plain maps that never get merged partially. Trade-off: schema evolution is more disruptive (need a `version: 1` field and a migrator). Accepted; we add `schemaVersion: 1` to the file now to enable future migrations.

4. **Install materialization: temp-dir + rename (atomic swap), NOT direct copy into the install path.**
   Rationale: a plugin install that aborts halfway (network error mid-clone, user Ctrl-C) must not leave a partial directory in `~/.claude/plugins/<id>/` that `discover()` then sees as valid. Materialize into `~/.claude/plugins/.staging/<id>-<nonce>/`, run manifest validation there, then `fs.rename` to the final path. On any error, `rm -r .staging/<id>-<nonce>` and fail with a clear message. This is the standard safe-install pattern; cost is one extra directory hop.

5. **DashScope 6 MB cap: preflight at `dashscope-transport.ts`, rejected as non-retryable error.**
   Rationale: per research/01-api.md §8, DashScope observed limit is 6 MB. We serialize the wire-format payload, compare against 6 × 1024 × 1024 bytes, and fail before the network call with `RequestBodySizeExceeded`. Non-retryable: the model or caller must shrink the input. Alternative "trust the server to reject and surface the 413" rejected: DashScope's 413 comes back with a generic message, and round-tripping a megabyte payload just to learn it was too big wastes time. Fail early.

6. **Codex response-shape translator: stream-state in-provider, not a shared normalizer.**
   Rationale: the Codex endpoint returns OpenAI's Responses-API-style SSE events, NOT Messages-API chunks. The vocabulary is Codex-specific: `response.created`, `response.output_item.added`, `response.output_text.delta`, etc. We maintain a `CodexStreamState` inside `codex-chatgpt.ts` that accumulates partials and emits the AI SDK's normalized `StreamPart` events (`text-delta`, `tool-call-delta`, `finish`). Each emitted part is what NativeEngine expects (M4a owns that contract). Alternative "bolt onto `@ai-sdk/openai`'s internal stream translator" rejected: that translator assumes Chat Completions SSE and the Responses endpoint is shaped differently enough to make inheritance more fragile than a dedicated state machine.

7. **Plugin update: re-materialize from recorded install source, NOT "pull latest ref".**
   Rationale: for git-url installs, the recorded `installSource.ref` (if specified) is what defined the installed version. `updatePlugin(id)` re-runs the install against `installSource` — if `ref` is `"main"`, it pulls main; if `ref` is a commit hash, it's a no-op. For local-path installs, re-materialization is just a re-copy (picks up any edits the user made in the source path). This matches user expectations: "update" means "re-run install from what you recorded"; "upgrade to a different version" is `uninstall` + `install` with a new `source`. Alternative "always pull HEAD of the remote" rejected: surprising behavior for commit-pinned installs.

**Policy shape assumed throughout M4b:** M3a's discriminated-union `BranchPolicy` / `CommitPolicy` / `EscalationPolicy` are untouched; M4a's `Provider` tagged union is the foundation; M4b adds concrete `TransportProvider` impls and a new `FrameworkProvider` case for `codex-chatgpt`.

The plan below assumes all seven default picks; flip any before implementation starts if needed.

## Relationship to M4a

M4a is the hard prerequisite (not yet shipped; M4b cannot start without it). M4a delivers:

- **NativeEngine foundation** — our own turn loop with `executeTool` + `canUseTool` binding, streaming event translation, compaction glue (port of M2's observer). NativeEngine is the consumer of `Provider`.
- **`Provider` interface formalized** at `src/providers/index.ts` — tagged union of `TransportProvider` (Vercel AI SDK, our loop via NativeEngine) and `FrameworkProvider` (Agent SDK, its loop — M3 `ClaudeAgentSdkEngine` is an instance).
- **`OpenAITransportProvider`** via `@ai-sdk/openai` — the canonical `TransportProvider` example. M4b xAI / Google / DashScope providers follow its structural pattern.
- **Model-prefix routing** at `src/providers/routing.ts` — resolves alias → provider-id + canonical model; model-family quirks hook in here. M4b extends the alias table and routing entries.
- **Model alias table** — at least `opus`, `sonnet`, `haiku`, `gpt-4o`, `gpt-4o-mini` (M4a baseline).

Concrete integration points M4b depends on:

- **Phase 2 (xAI / Google / DashScope providers)** slot into M4a's `Provider` interface verbatim. No NativeEngine changes; only new `Provider` impls and routing-table entries.
- **Phase 4 (Codex ChatGPT FrameworkProvider)** registers as a new `Provider` case. Because NativeEngine owns the turn loop for `TransportProvider`s, and Codex-ChatGPT is technically a custom Vercel AI SDK provider (not Agent SDK), it's a `TransportProvider` — NativeEngine runs the loop, Codex-specific streaming is internal to the provider. The `--framework codex-chatgpt` flag is preserved for user-facing clarity (matches the Claude-Max `--framework claude-agent-sdk` pattern) even though internally it's not a FrameworkProvider in the tagged-union sense.
  - **Subtle point**: `FrameworkProvider` means "this provider owns the agent loop" (e.g. Agent SDK). Codex-ChatGPT OWNS its streaming wire format, NOT the agent loop — NativeEngine still runs the loop against it. So at the type level, `CodexChatGPTProvider` extends `TransportProvider`. The CLI flag is a UX affordance, not a type discriminator. Documented.
- **Phase 3 (plugin install lifecycle)** depends on M2's `ClaudeCodeSource.discover()` and `PluginRegistry.buildPluginTools()` — M4b injects `PluginStateStore.isEnabled()` checks into the latter. No breakage to M2's read-only path.
- **Test baseline**: M4a completing adds an estimated 60-100 tests (NativeEngine + Provider interface + OpenAI provider + routing). Baseline at M4b start ≈ 900-950 (M3b shipped 841 tests; M4a estimated +60-100).

M4b does NOT touch: NativeEngine's turn loop internals, compaction logic, `executeTool` dispatcher, permission engine, SwarmHost contract, M3b git-coordination. Those are stable contracts at M4a complete.

## Acceptance criteria

Each is executable with a one-line test harness or manual smoke step.

1. `swarm-harness --model grok-3 prompt "hi"` with `XAI_API_KEY` set routes to `XaiTransportProvider`, runs one turn end-to-end, writes a session log. Verified: the turn's lane-event stream includes a `provider_selected` event with `{ providerId: "xai", model: "grok-3" }`.
2. `swarm-harness --model gemini-2.0-flash prompt "hi"` with `GOOGLE_GENERATIVE_AI_API_KEY` set routes to `GoogleTransportProvider` likewise. `provider_selected` carries `{ providerId: "google", model: "gemini-2.0-flash" }`.
3. `swarm-harness --model qwen-plus prompt "hi"` with `DASHSCOPE_API_KEY` set routes to `DashScopeTransportProvider`. `provider_selected` carries `{ providerId: "dashscope", model: "qwen-plus" }`.
4. `swarm-harness --model qwen/qwen-max prompt "hi"` (slash-prefix form) routes to DashScope. Prefix-strip happens inside the provider; on-wire `model` is `qwen-max`.
5. Model-prefix routing precedence: with BOTH `ANTHROPIC_API_KEY` and `XAI_API_KEY` set, `--model grok-3` still routes to xAI (explicit prefix beats sniffer). Verified via unit test on `resolveProvider(modelName, env)`.
6. DashScope body-size preflight: a synthesized payload of 7 MB serialized size returns `{ status: "error", code: "request_body_exceeded", limitBytes: 6291456 }` before any network call. Verified via unit test with a mock HTTP layer that asserts zero requests issued.
7. Reasoning-model param strip: `--model o3-mini` (routed through OpenAI provider in M4a, with M4b quirks extension) serializes the request with `temperature` / `top_p` / `presence_penalty` / `frequency_penalty` fields ABSENT even if the user passed them. Verified via unit test inspecting the request body sent to `@ai-sdk/openai`.
8. Reasoning-model param strip extends to xAI: `--model grok-3-mini` same behavior. `*-thinking` models and `qwq*` models same behavior routed through DashScope. Each covered by a unit test in `routing.test.ts`.
9. GPT-5* max-tokens rename: `--model gpt-5` (whenever it lands) serializes with `max_completion_tokens` instead of `max_tokens`. Unit test on the provider request builder.
10. Kimi `is_error` strip: tool-result message with `{ is_error: true }` sent via DashScope to a `kimi*` model has `is_error` removed from the on-wire payload. Unit test.
11. Plugin install from local path: `swarm-harness plugin install test/fixtures/plugins/hello-plugin` (an existing fixture directory at test time) copies the directory to `~/.claude/plugins/hello-plugin/`, validates `plugin.json`, writes `~/.claude/plugins/state.json` with `{ enabled: ["hello-plugin"], versions: { "hello-plugin": "0.1.0" }, installSources: { "hello-plugin": { kind: "LocalPath", path: "<resolved-absolute-path>" } } }`. The source detector resolves the path via `path.resolve()` and confirms it exists on disk before classifying as `LocalPath`.
12. Plugin install atomicity: simulate a mid-install failure (mock `fs.rename` to throw on the final swap); assert `~/.claude/plugins/hello-plugin/` does NOT exist after the failed install, and `state.json` is unchanged.
13. Plugin list: `swarm-harness plugin list` prints a table with columns `id`, `version`, `enabled`, `source` for every plugin in `state.json`. Disabled plugins show `enabled=false`.
14. Plugin enable/disable: `swarm-harness plugin disable hello-plugin` flips the state; subsequent `swarm-harness prompt "..."` runs do NOT register hello-plugin's tools (assert via inspecting the tool list emitted on session start). `plugin enable` reverses it. Verified via integration test.
15. Plugin update: given an installed plugin at version 0.1.0 and its source path now contains a 0.2.0 manifest, `swarm-harness plugin update hello-plugin` atomically swaps, `state.versions["hello-plugin"] === "0.2.0"`. Verified: during the swap, a concurrent `discover()` call either sees 0.1.0 or 0.2.0 — NEVER a partial directory. Concurrent state writes: Two concurrent `plugin enable` invocations (spawned via `Promise.all` from a test harness) produce a final `state.json` containing BOTH enables. Neither is lost (serialized via `proper-lockfile`).
16. Plugin uninstall: `swarm-harness plugin uninstall hello-plugin` removes `~/.claude/plugins/hello-plugin/` and drops the id from `state.enabled` / `state.versions` / `state.installSources`. Idempotent: re-running exits 0 with "not installed" message.
17. PluginRegistry integration: `buildPluginTools()` called when `hello-plugin` is disabled returns a tool list that does NOT include any `plugin__hello-plugin__*` entries. When enabled, it includes them. Verified via unit test with a mock `PluginStateStore`.
18. ChatGPT login: `swarm-harness login --provider codex-chatgpt` opens a browser URL at `auth.openai.com/oauth/authorize?client_id=app_EMoamEEZ73f0CkXaXp7hrann&code_challenge=...&code_challenge_method=S256&...`, starts a loopback listener on an ephemeral port, waits for the callback, exchanges the code at `/oauth/token`, writes `~/.swarm-harness/auth.json` with `{ "openai-oauth": { access_token, refresh_token, expires_at, scopes } }`. Verified via a mock flow (browser launch mocked, callback URL synthesized, token endpoint mocked).
19. ChatGPT token refresh: when `access_token` is expired (past `expires_at`), `OpenAIOAuthAuth.headers()` transparently refreshes via `POST /oauth/token` with `grant_type=refresh_token`, persists the new token, returns fresh `Authorization` header. Verified via a unit test with a mocked fetch.
20. ChatGPT refresh-failure graceful degradation: when refresh returns 4xx (e.g. client id revoked or refresh token invalid), the error surfaces as `{ code: "oauth_refresh_failed", message: "Re-authenticate via `swarm-harness login --provider codex-chatgpt`." }`. The CLI process exits with non-zero; no infinite retry loop. Verified via unit test.
21. Codex ChatGPT end-to-end: `swarm-harness --framework codex-chatgpt prompt "hi"` with a valid `~/.swarm-harness/auth.json` routes through the `CodexChatGPTProvider`, which targets `https://chatgpt.com/backend-api/codex/responses`, streams the response, emits normalized `StreamPart` events to NativeEngine. Verified via smoke test (mocked endpoint using `test/fixtures/codex/responses-sse.txt`) and live smoke (**operator-only**; skip in CI).
22. Codex ChatGPT constrained swarm features: in `codex-chatgpt` mode, `send_message`, `check_inbox`, `task_stop`, `task_output`, `ask_user_question` are **removed from the tool surface** — the model does not see them. Not degraded to no-op; absent entirely. Verified via integration test: assert none of these tool names appear in the tool list passed to the model. Documented in CLI `--help` and at session-start lane event `framework_mode_active`.
23. **[operator-only; skip in CI]** Live smoke: `swarm-harness login --provider codex-chatgpt` completes OAuth in a real browser against `auth.openai.com`; a follow-up `--framework codex-chatgpt prompt "reply with one word"` returns a real response. Evidence: HTTP trace log shows request to `chatgpt.com/backend-api/codex/responses` with `Authorization: Bearer <redacted>`, response is a valid SSE stream matching the event vocabulary captured in `test/fixtures/codex/responses-sse.txt`.
24. `npx tsc --noEmit` passes strict mode.
25. `npm test` baseline ~900-950 (841 from m3b-complete + M4a estimated 60-100) → target `baseline + 60..90` for M4b; all passing.
26. `scripts/smoke-m4b.sh --offline` covers: (O1) xAI routing + one-turn mock, (O2) Google routing + one-turn mock, (O3) DashScope routing + one-turn mock with 5 MB payload (under cap; should succeed), (O4) DashScope 7 MB payload (over cap; should reject with `request_body_exceeded`), (O5) plugin install → list → disable → uninstall lifecycle on a fixture plugin, (O6) Codex OAuth mock flow (browser launch stubbed; callback synthesized; token exchange mocked).
27. `scripts/smoke-m4b.sh` (live, operator-driven, skip in CI): (L1) real xAI turn with `XAI_API_KEY`, (L2) real Google turn with `GOOGLE_GENERATIVE_AI_API_KEY`, (L3) real ChatGPT Plus/Pro OAuth + one turn. Requires `--live` flag and at least one of the credentials; partial-skip supported.
28. `scripts/smoke.sh --all` invokes `smoke-m4b.sh` alongside existing scripts.

## Implementation phases

### Phase 0 — Interface refinements (~0.3 day)

0.1. `src/providers/index.ts` — extend the `Provider` interface (or its M4a-shipped discriminated union) with per-provider preflight hook:
```ts
export interface Provider {
  // ... existing (M4a) ...
  /** Optional preflight — return null if OK; ProviderError if request should not be sent. */
  preflight?(request: ProviderRequest): ProviderError | null;
}
```
- DashScope implements this for the 6 MB body-size cap.
- Other providers leave it unset (null-safe default: "always OK").
- NativeEngine calls `preflight?.` before dispatch; short-circuits on error.

0.2. `src/plugins/index.ts` — add install-source discriminated union:
```ts
export type PluginInstallSource =
  | { readonly kind: "LocalPath"; readonly path: string }
  | { readonly kind: "GitUrl"; readonly url: string; readonly ref?: string };
```

0.3. `src/plugins/state.ts` (new interface module) — export `PluginStateStore`:
```ts
export interface PluginStateFile {
  readonly schemaVersion: 1;
  readonly enabled: readonly string[];
  readonly versions: Readonly<Record<string, string>>;
  readonly installSources: Readonly<Record<string, PluginInstallSource>>;
}
export interface PluginStateStore {
  read(): Promise<PluginStateFile>;
  write(state: PluginStateFile): Promise<void>;
  isEnabled(id: string): Promise<boolean>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  record(id: string, version: string, source: PluginInstallSource): Promise<void>;
  remove(id: string): Promise<void>;
}
```

0.4. `src/auth/index.ts` — no shape change needed; `OpenAIOAuthAuth` implements the existing `InteractiveAuth` contract (from M0's auth/index.ts stubs).

0.5. `src/providers/routing.ts` (extend M4a's skeleton) — add entries:
```ts
{ prefix: "grok", providerId: "xai", env: "XAI_API_KEY" }
{ prefix: "gemini-", providerId: "google", env: "GOOGLE_GENERATIVE_AI_API_KEY" }
{ prefix: "qwen-", providerId: "dashscope", env: "DASHSCOPE_API_KEY" }
{ prefix: "qwen/", providerId: "dashscope", env: "DASHSCOPE_API_KEY", stripPrefix: true }
{ prefix: "kimi-", providerId: "dashscope", env: "DASHSCOPE_API_KEY" }
{ prefix: "kimi/", providerId: "dashscope", env: "DASHSCOPE_API_KEY", stripPrefix: true }
```
- `stripPrefix` means strip `qwen/` / `kimi/` before sending to the wire.
- Also register model-family quirks: `o1*`/`o3*`/`o4*` + `grok-3-mini` + `*-thinking` + `qwq*` → "reasoning" (strip tuning params). `gpt-5*` → `max_completion_tokens` rename. `kimi*` → `is_error` strip.

0.6. `src/cli/argv.ts` — add flags:
- `--framework codex-chatgpt` (already groundwork from M3 for `claude-agent-sdk`; extend the enum).
- `--provider` param to `login` subcommand; accept `claude-agent-sdk` | `codex-chatgpt`.
- Top-level `plugin` subcommand with leaf args (`install <source>`, `list`, `enable <id>`, `disable <id>`, `update <id>`, `uninstall <id>`).

### Phase 1 — Dependencies (~0.1 day)

1.1. Runtime deps:
- `@ai-sdk/xai` (xAI provider — pins to the current `ai` major as M4a does).
- `@ai-sdk/google` (Google provider).
- Already present: `@ai-sdk/openai` (M4a) — reused for DashScope via base-URL override, NOT a new package.
- `proper-lockfile` — file locking for `PluginStateStore` concurrent writes (small, well-maintained). Budget +0.15d for lock integration.
- `undici` or rely on global `fetch` — for Codex OAuth HTTP calls. Default: global `fetch` (Node 18+); no new dep unless a deficiency surfaces.

1.2. Dev deps: none new.

### Phase 2 — xAI / Google / DashScope TransportProviders (~1.5 days)

2.1. `src/providers/xai-transport.ts` (new):
```ts
import { createXai } from "@ai-sdk/xai";
export function makeXaiProvider(opts: { apiKey: string; model: string }): Provider { ... }
```
- Construction reads `XAI_API_KEY` via M4b's `XaiApiKeyAuth`.
- Per-model capabilities: `parallelToolUse: false` for `grok-3-mini` (reasoning); `true` for `grok-3`. Context-window 131_072, max-output 64k (from `docs/research/01-api.md` §8).
- Model-family quirk hook: if model is `grok-3-mini`, strip `temperature` / `top_p` / `presence_penalty` / `frequency_penalty` on the request before dispatch (routing.ts owns the enum, provider honors it).

2.2. `src/providers/google-transport.ts` (new):
```ts
import { createGoogleGenerativeAI } from "@ai-sdk/google";
export function makeGoogleProvider(opts: { apiKey: string; model: string }): Provider { ... }
```
- Reads `GOOGLE_GENERATIVE_AI_API_KEY` via `GoogleApiKeyAuth`.
- Model capabilities: `gemini-2.0-flash` vision-capable; `gemini-2.0-pro` similar. AI SDK handles stop-reason normalization for us.
- Google-specific quirk: the AI SDK maps most naming for us. The one place we diverge: Google's `max_output_tokens` is always lowercase-underscored; AI SDK shim handles it. Nothing for M4b to special-case unless a live smoke surfaces drift.

**2.2a. Codex endpoint auth**

Required HTTP headers are captured by the Phase 5.0 spike and locked in `test/fixtures/codex/required-headers.json`. Provider implementation reads this file at construction time (or embeds the values as constants sourced from the captured fixture).

**2.2b. Google safety-settings verification (+0.25d reserve)**

If AC 23 live smoke with Gemini fails on safety filters:
- Thread `safetySettings: [{ category: 'HARM_CATEGORY_*', threshold: 'BLOCK_NONE' }]` through `makeGoogleProvider` config.
- Surface as a constructor option for operator override.
- Add live smoke scenario with a benign code prompt that exercises the pass-through.

If safety defaults work out of the box, this is a no-op and buffer absorbs. Budget explicitly reserved.

2.3. `src/providers/dashscope-transport.ts` (new):
```ts
import { createOpenAI } from "@ai-sdk/openai"; // reused — NOT @ai-sdk/xai or a new pkg
// Note: verify @ai-sdk/openai v5 signature at implementation time; may be
// `createOpenAICompatible` for non-OpenAI endpoints (flag as verify-at-implementation).
export function makeDashScopeProvider(opts: { apiKey: string; model: string }): Provider {
  const shim = createOpenAI({
    apiKey: opts.apiKey,
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  });
  const model = shim(opts.model); // strip qwen/ or kimi/ prefix beforehand via routing.ts
  return {
    id: "dashscope",
    model,
    capabilities: { streaming: true, promptCache: false, parallelToolUse: true, ... },
    preflight: (req) => dashscopePreflight(req),
  };
}
```
- `src/providers/dashscope-preflight.ts`:
  ```ts
  const LIMIT = 6 * 1024 * 1024;
  export function dashscopePreflight(req: ProviderRequest): ProviderError | null {
    const bytes = Buffer.byteLength(JSON.stringify(req.body), "utf8");
    if (bytes > LIMIT) return { code: "request_body_exceeded", limitBytes: LIMIT, estimatedBytes: bytes, provider: "dashscope" };
    return null;
  }
  ```
- Kimi `is_error` strip: if the model name matches `kimi*`, iterate `req.messages`, for any tool-result content block drop the `is_error` key before serializing. Implemented in a shared helper `src/providers/quirks.ts` so xAI and Google can call it too if future provider needs it.

2.4. `src/providers/routing.ts` (extend M4a) — fill in the entries from Phase 0.5; expose `resolveProvider(model, env) → { providerId, canonicalModel, quirks[] }`. `quirks` includes `"strip-reasoning-params"`, `"max-completion-tokens"`, `"strip-is-error"` as applicable. The provider (xAI / Google / DashScope / OpenAI) honors them before dispatch.

2.5. `src/auth/xai-api-key.ts`, `src/auth/google-api-key.ts`, `src/auth/openai-compat-api-key.ts` — minimal API-key `AuthSource` impls. Each reads its env var, returns the right `headers()` (xAI + Google use `Authorization: Bearer`; DashScope uses same since it's OpenAI-compat).

2.6. Tests:
- `xai-transport.test.ts` (≥ 4): basic send, reasoning-model param strip (grok-3-mini), missing-XAI_API_KEY error, capabilities shape.
- `google-transport.test.ts` (≥ 3): basic send, gemini-2.0-flash routing, capabilities shape.
- `dashscope-transport.test.ts` (≥ 5): basic qwen send, qwen/ prefix strip on-wire, 6 MB preflight fail, 5 MB preflight pass, kimi `is_error` strip.
- `routing.test.ts` extension (≥ 6): grok / gemini / qwen- / qwen/ / kimi- routing; explicit-prefix beats env-sniffer; quirk resolution for each model family.

### Phase 3 — Plugin install lifecycle (~1.5 days)

3.1. `src/plugins/state.ts` (new) — implement `PluginStateStore`:

State file at `~/.claude/plugins/state.json` (or `~/.swarm-harness/plugins/state.json` if the `~/.claude` collision-risk is taken seriously per M5). Shape: `{ schemaVersion: 1, enabled: string[], versions: Record<string, string>, installSources: Record<string, PluginInstallSource> }`.

- File path: `path.join(os.homedir(), ".claude/plugins/state.json")`.
- `read()`: `fs.readFile` → `JSON.parse` → validate `schemaVersion === 1` (throw if not); on ENOENT return default empty state `{ schemaVersion: 1, enabled: [], versions: {}, installSources: {} }`.
- `write(state)`: Writes are wrapped in a lockfile acquire/release cycle using the `proper-lockfile` npm package. Sequence:
  1. Acquire `<state.json>.lock` (5s timeout; stale reclaim after 30s).
  2. Read `state.json`.
  3. Mutate in memory.
  4. Write temp file `<state.json>.tmp.<pid>` (`O_CREAT | O_EXCL` for NFS-safety; NFS-safe IFF temp file is created with these flags; users on non-NFS systems are unaffected — document but don't require NFS in CI).
  5. Rename temp → `state.json`.
  6. Release lock.
- Mutations: `setEnabled` / `record` / `remove` go through the lock cycle. Concurrent `plugin enable A` + `plugin enable B` serialize on the lock; both mutations land.
- AC 15 revised: "Two concurrent `plugin enable` invocations (spawned via `Promise.all` from a test harness) produce a final `state.json` containing BOTH enables. Neither is lost."
- Tests (≥ 6): empty-state on ENOENT, round-trip read/write, `setEnabled` idempotent, `record` overwrites version for same id, `remove` deletes from all three maps, concurrent enable (Promise.all) produces both enables in final state.

3.2. `src/plugins/install.ts` (new):
```ts
export async function installPlugin(source: PluginInstallSource): Promise<InstallResult> {
  // 1. Materialize source → temp dir `~/.claude/plugins/.staging/<nonce>/`.
  //    LocalPath → fs.cp recursive.
  //    GitUrl → child_process git clone --depth 1 --branch <ref?>.
  // 2. Locate + validate plugin.json via PluginJsonSchema (M2 schema).
  // 3. Extract `id` from manifest.
  // 4. Reject if PluginStateStore.versions[id] is already set (no overwrite without explicit update).
  // 5. Atomic swap: fs.rename(staging, `~/.claude/plugins/<sanitized-id>`).
  // 6. PluginStateStore.record(id, version, source); also enable by default.
  // 7. On any error in 1-5: rm -r staging; throw.
}
```
- `sanitizeId(id)`: replace `/` with `--` or reject if the id contains characters that would escape the path boundary; lock down with a regex like `/^[a-zA-Z0-9._/-]+$/`; after charset check, `if (id.includes('..')) throw new RangeError('Plugin id must not contain path traversal sequences: ' + id)`.
- Tests (≥ 6): local-path install happy path, git-url install mocked, manifest-validation failure rejects, duplicate-install rejects, rename-failure leaves no partial state, state-file updated with version + source.

3.3. `src/plugins/enable.ts` / `src/plugins/disable.ts` (new, small):
```ts
export async function enablePlugin(id: string): Promise<void> { await state.setEnabled(id, true); }
export async function disablePlugin(id: string): Promise<void> { await state.setEnabled(id, false); }
```
- `setEnabled` throws if the id is not present in `versions` (can't enable what isn't installed). Tests (≥ 3 total): enable-when-installed, disable-when-enabled, enable-when-not-installed-rejects.

3.4. `src/plugins/update.ts` (new):
```ts
export async function updatePlugin(id: string): Promise<UpdateResult> {
  // 1. Read state; fetch installSources[id] (throw if not present).
  // 2. Re-materialize into staging as `<id>.new-<nonce>`.
  // 3. Validate manifest.
  // 4. Rename `<id>` → `<id>.old`, rename staging → `<id>`, rm -r `<id>.old`.
  //    If any fail mid-swap, attempt reverse (restore `<id>.old` → `<id>`) + rm staging.
  // 5. state.record(id, newVersion, installSources[id]).
}
```
- Tests (≥ 5): local-path update happy path, version bumped in state, failed-manifest-validation rolls back, rename-failure rolls back, concurrent discover() during update sees either old or new (never partial).

3.5. `src/plugins/uninstall.ts` (new):
```ts
export async function uninstallPlugin(id: string): Promise<void> {
  // 1. rm -r `~/.claude/plugins/<id>`.
  // 2. state.remove(id).
  // 3. Idempotent: ENOENT on step 1 is OK; log "not installed".
}
```
- Tests (≥ 3): uninstall happy path, idempotent re-uninstall, state entries removed.

3.6. `src/plugins/registry.ts` (modify):
- `buildPluginTools()` reads `PluginStateStore.enabled` once at the start; skips any manifest whose `id` is NOT in that set.
- Emits a `plugin_disabled` diagnostic lane event for each skipped plugin (informational only).
- Tests (≥ 2): registry with all enabled, registry with one disabled.

3.7. `src/cli/plugin.ts` (new) — dispatch subcommands:
- `install <source>` — source is resolved via the following unambiguous detector:
  ```ts
  function resolveInstallSource(raw: string): PluginInstallSource {
    if (raw.startsWith("git+") || raw.match(/\.git($|[#?])/) || raw.startsWith("git@")) {
      return { kind: "GitUrl", url: raw };
    }
    // Otherwise: require the path to exist on disk.
    const resolved = path.resolve(raw);
    if (!fs.existsSync(resolved)) {
      throw new Error(
        `plugin install source not recognized: "${raw}". ` +
        `Supply a path to an existing directory, or a git URL (ending in .git or starting with git+/git@).`
      );
    }
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error(`plugin install source must be a directory: ${raw}`);
    }
    return { kind: "LocalPath", path: resolved };
  }
  ```
  Note: `file:///abs/path` does NOT match git (no `.git` suffix, no `git+`/`git@` prefix) — it goes through the disk-existence check. `https://example.com/tarball` (no `.git`) likewise goes through disk-existence check and fails with a clear error. Non-existent paths fail with a clear message.
- `list` — print table; reads state + cross-references `ClaudeCodeSource.discover()` (warns on drift: in-state-but-missing-on-disk OR on-disk-but-missing-from-state).
- `enable <id>` / `disable <id>` / `update <id>` / `uninstall <id>` — thin wrappers.
- Exit codes: 0 on success, 1 on user error (unknown id, invalid source), 2 on infra error (filesystem, network).
- Tests (≥ 6): one per subcommand, plus list-with-drift. Additional unit tests for `resolveInstallSource` edge cases: `file:///x` (non-existent path → error), `https://example.com/tarball` (non-existent path → error), non-existent local path (→ error), path-not-directory (→ error), valid directory (→ LocalPath), git URL with `.git` suffix (→ GitUrl), `git+https://...` (→ GitUrl), `git@github.com:...` (→ GitUrl).

### Phase 4 — OpenAI OAuth for ChatGPT Plus/Pro (~1.5 days)

4.1. `src/auth/openai-oauth.ts` (new):
```ts
export class OpenAIOAuthAuth implements InteractiveAuth {
  readonly kind = "oauth-bearer";
  readonly providerId = "openai";

  // Reverse-engineered from Codex App Server. Policy-tolerated, not contracted.
  // If this stops working, see docs/06-open-questions.md Q17.
  private readonly CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
  private readonly AUTH_URL = "https://auth.openai.com/oauth/authorize";
  private readonly TOKEN_URL = "https://auth.openai.com/oauth/token";

  async login(opts?: { deviceCode?: boolean }): Promise<void> {
    // 1. Generate PKCE verifier + challenge (S256).
    // 2. Spawn local loopback server on ephemeral port.
    // 3. Open browser at AUTH_URL?client_id=...&redirect_uri=http://127.0.0.1:<port>/callback&response_type=code&code_challenge=...&code_challenge_method=S256&scope=...
    // 4. Wait for GET /callback?code=... (timeout 5min, configurable via SWARM_HARNESS_OAUTH_TIMEOUT_MS).
    // 5. POST TOKEN_URL with grant_type=authorization_code, code, code_verifier, client_id, redirect_uri.
    // 6. Persist { access_token, refresh_token, expires_at, scopes } to ~/.swarm-harness/auth.json under "openai-oauth".
    // 7. Close loopback server.
  }

  async logout(): Promise<void> { /* delete ~/.swarm-harness/auth.json "openai-oauth" key */ }

  async headers(): Promise<Record<string, string>> {
    const tokens = await this._readTokens();
    if (!tokens) throw new Error("not authenticated; run `swarm-harness login --provider codex-chatgpt`");
    if (tokens.expires_at <= Date.now() / 1000) await this.refresh();
    return { Authorization: `Bearer ${tokens.access_token}` };
  }

  async refresh(): Promise<void> {
    // POST TOKEN_URL grant_type=refresh_token, refresh_token, client_id.
    // Preserve old refresh_token if new response omits it (claw pattern).
    // On 4xx: throw OAuthRefreshFailedError (triggers AC 20).
  }

  async isAuthenticated(): Promise<boolean> { /* ... */ }
}
```
- PKCE: use `crypto.randomBytes(32).toString("base64url")` for verifier; `crypto.createHash("sha256").update(verifier).digest().toString("base64url")` for challenge. Cross-platform (not `/dev/urandom`).
- Loopback: `http.createServer` binding to `127.0.0.1:0`; read port from `server.address()`. Handle the `/callback` GET, respond with a "you can close this tab" HTML, shut down.
- Token file shape: `{ "openai-oauth": { access_token, refresh_token?, expires_at: number-unix-seconds, scopes: string[] } }`. Multi-provider safe (same file can hold `"anthropic-oauth"` key from M3's ClaudeAgentSdkEngine path if that ever migrates).

4.2. Tests (`src/auth/openai-oauth.test.ts`, ≥ 8):
- PKCE verifier/challenge correctness (SHA-256(verifier) = challenge; both base64url-encoded; length within RFC 7636 bounds).
- Mocked login flow: browser launch stubbed, callback simulated, token endpoint mocked → assert file written.
- Mocked refresh: expired token → refresh called → new token persisted → headers return fresh bearer.
- Refresh preserves old refresh_token when response omits it.
- Refresh 4xx → OAuthRefreshFailedError with AC 20 wording.
- logout deletes the key; subsequent headers() throws.
- isAuthenticated: true when token valid; false when absent; true when expired but refresh succeeds.
- Loopback server binds to ephemeral port (not a fixed port).

### Phase 5 — Codex ChatGPT custom TransportProvider (~1.25 days + 0.25d spike)

> **SUPERSEDED 2026-04-30 by [docs/24-phase-6-codex-app-server-plan.md](24-phase-6-codex-app-server-plan.md).** Web research found that OpenAI's official integration surface for third-party tools is the **Codex App Server (JSON-RPC over stdio)**, not the private browser-to-backend SSE channel this section targets. The pivot drops the SSE spike + custom Vercel AI SDK provider entirely and replaces them with a `FrameworkProvider` that delegates to the locally-installed `codex` binary. The categorization also changes (Codex hosts agent threads, so it's a `FrameworkProvider`, not a `TransportProvider`). The sections below remain for historical record; the implementation path is doc 24.

#### 5.0. Codex Endpoint Spike (0.25d) — BLOCKS Phase 5.1+

BEFORE any Phase 5 implementation work, an operator with ChatGPT Plus/Pro access runs one live Codex request and captures:
- Exact SSE event names (`response.output_text.delta`, etc.)
- Exact required HTTP headers (`OpenAI-Beta`, `User-Agent`, anything else)
- Response envelope shape for the final message

Deliverables from the spike:
- `test/fixtures/codex/responses-sse.txt` — raw captured SSE trace
- `test/fixtures/codex/required-headers.json` — header whitelist
- Inline update to this plan's Phase 5.2 + 5.3 locking the event-name vocabulary and header requirements to match reality.

Phase 5.1+ is BLOCKED on this spike completing. Implementation against speculation is explicitly forbidden.

AC 21 + AC 23 offline/live tests both reference this captured fixture.

5.1. `src/providers/codex-chatgpt.ts` (new):
```ts
export function makeCodexChatGPTProvider(opts: { auth: OpenAIOAuthAuth; model?: string }): Provider {
  const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
  // Uses the low-level Vercel AI SDK provider factory (customProvider or
  // @ai-sdk/provider's LanguageModelV1 directly). Builds a LanguageModel-shaped
  // object with doGenerate / doStream methods that target ENDPOINT.
  return {
    id: "codex-chatgpt",
    model: makeLanguageModel(...),
    capabilities: {
      streaming: true,
      promptCache: false,
      parallelToolUse: false, // not supported by Codex endpoint surface
      vision: false,
      maxContextTokens: 128_000, // conservative; Codex surface is capped
      maxOutputTokens: 16_384,
    },
  };
}
```
- `doStream`: POST `ENDPOINT` with `{ model, messages, tools, stream: true, ...codex-specific-fields }`; read SSE; feed to `CodexStreamState`.
- `CodexStreamState`: maintains partials for text, tool-call args, finish reason. Emits AI-SDK-normalized `StreamPart` events:
  - `response.output_text.delta` → `{ type: "text-delta", textDelta }`
  - `response.output_item.added` (tool call) → `{ type: "tool-call", ... }`
  - `response.output_item.done` with tool-call args → `{ type: "tool-call-delta", ... }` + final close
  - `response.completed` → `{ type: "finish", finishReason, usage }`
- Headers: `Authorization: Bearer <from auth.headers()>`, `Content-Type: application/json`, `Accept: text/event-stream`, plus all headers listed in `test/fixtures/codex/required-headers.json` (captured by Phase 5.0 spike; do not speculate).

5.2. `src/cli/main.ts` + `src/cli/login.ts` (modify):
- `--framework codex-chatgpt` invokes NativeEngine with `makeCodexChatGPTProvider({ auth: new OpenAIOAuthAuth() })`.
- `login --provider codex-chatgpt` dispatches to `OpenAIOAuthAuth.login()`.
- Tool-surface filtering: in codex-chatgpt mode, REMOVE `send_message`, `check_inbox`, `task_stop`, `task_output`, `ask_user_question` from the tool list AT session start — the model does not see them (not degraded to no-op; removed entirely). Uses `filterToolsForFramework` helper (§7.3). Emit `framework_mode_active` lane event with `{ mode: "codex-chatgpt", removedTools: [...] }`.

5.3. Tests (`src/providers/codex-chatgpt.test.ts`, ≥ 6):
- Mock ENDPOINT returns the canned SSE trace from `test/fixtures/codex/responses-sse.txt` (captured by Phase 5.0 spike); `CodexStreamState` emits expected `StreamPart` sequence.
- Tool call accumulation: partial-arg deltas concatenate into final tool-call; `tool-call` event fires only once.
- 401 from ENDPOINT → error surfaces via AuthSource headers reload (one retry at most).
- Capabilities object shape is stable.
- NativeEngine integration test: feed mock provider to a scripted turn; verify events flow end-to-end.
- Tool-surface filter: assert `send_message` NOT in tool list when `--framework codex-chatgpt`.

**5.4. DashScope preflight integration test**

`test/integration/dashscope-preflight.test.ts` (new):
- Construct `NativeEngine` with `DashScopeTransportProvider`.
- Submit a `RunConfig` with a messages array large enough to `JSON.stringify` to > 6 MB.
- Assert `NativeEngine`'s event stream emits an error `NormalizedEvent` with `code: "request_body_too_large"` BEFORE any network I/O fires (mock `fetch` to throw if called).
- Assert the error fires via the preflight hook, not after a failed fetch.

AC X: NativeEngine with DashScope provider rejects a > 6 MB payload at the preflight hook boundary before any network call; `fetch` is never invoked.

### Phase 6 — Model-family quirks centralization (~0.3 day)

6.1. `src/providers/quirks.ts` (new):
```ts
export type QuirkTag = "strip-reasoning-params" | "max-completion-tokens" | "strip-is-error";

export function resolveQuirks(canonicalModel: string): readonly QuirkTag[];

export function applyQuirks(body: ProviderRequestBody, tags: readonly QuirkTag[]): ProviderRequestBody;
```
- Pattern match inside `resolveQuirks`:
  - `/^o[134]($|-)/`, `/-thinking$/`, `/^qwq/`, `/^grok-3-mini$/` → `"strip-reasoning-params"`
  - `/^gpt-5/` → `"max-completion-tokens"`
  - `/^kimi/` → `"strip-is-error"`
- `applyQuirks` mutates a shallow copy of the body per tag.
- Each TransportProvider (openai, xai, google, dashscope, codex-chatgpt) calls `applyQuirks(body, resolveQuirks(model))` right before serialization.

6.2. Tests (`src/providers/quirks.test.ts`, ≥ 8): one test per model-family regex; verify `applyQuirks` idempotent; verify multiple quirks stack correctly (e.g. a hypothetical `kimi-thinking` would get both strips).

### Phase 7 — CLI plumbing + framework-mode tool filtering (~0.4 day)

7.1. `src/cli/main.ts` (modify):
- Route `plugin` subcommand to `src/cli/plugin.ts`.
- Route `login --provider codex-chatgpt` to `OpenAIOAuthAuth.login()`; preserve existing Anthropic path for `--provider claude-agent-sdk` (or absence).
- Accept `--framework codex-chatgpt`; construct NativeEngine with CodexChatGPTProvider.
- Accept `--model` with any of the new prefixes; routing handles dispatch.

7.2. `src/cli/argv.ts` — extend flag parser with `plugin <sub> [args]`, `login --provider <...>`, `--framework codex-chatgpt`.

**7.2a. CLI: logout subcommand**

```
swarm-harness logout --provider <codex-chatgpt|anthropic-oauth>
```
- Resolves the AuthSource for the provider.
- If it implements `InteractiveAuth.logout()`, invoke it.
- Prints `"logged out from <provider>. Credentials removed from ~/.swarm-harness/auth.json."`
- If the provider's credential key is absent, prints `"no credentials stored for <provider>"` and exits 0.

AC: `swarm-harness logout --provider codex-chatgpt` after login removes ONLY the `codex-chatgpt` key from `auth.json`; other provider keys remain.

7.3. Tool-surface filter (shared helper):
```ts
// src/tools/framework-filter.ts
export function filterToolsForFramework(
  tools: ToolImpl[],
  framework: "native" | "claude-agent-sdk" | "codex-chatgpt",
): ToolImpl[] {
  if (framework === "native") return tools;
  const REMOVE = new Set(["send_message", "check_inbox", "task_stop", "task_output", "ask_user_question"]);
  return tools.filter(t => !REMOVE.has(t.spec.name));
}
```
- New helper in `src/tools/framework-filter.ts`. Orthogonal to M3a's `ToolDispatcher.allowedTools` (which filters at registration based on role). This filter runs EARLIER — at `buildTier2Tools()`-style factory calls — to remove tools that don't make sense in a given framework mode:
  - `framework === "codex-chatgpt"`: remove `send_message`, `check_inbox`, `task_stop`, `task_output`, `ask_user_question` (no SwarmHost routing in framework mode).
  - `framework === "claude-agent-sdk"`: same removals (M3 shipped with the SDK owning a different path).
  - `framework === "native"` or `"auto"`: no removals.
- M4b NEVER touches M3a's `ToolDispatcher.allowedTools` field. Composition: framework-filter runs first → registers into dispatcher → dispatcher applies role-`allowedTools` per-call.
- NO changes to `src/tools/dispatcher.ts` beyond what M4a already touched.

7.4. Tests (`src/cli/argv.test.ts` extension, `src/cli/plugin.test.ts`, `src/tools/framework-filter.test.ts`, ≥ 10 total).

### Phase 8 — Tests + smoke + docs (~0.65 day)

8.1. `scripts/smoke-m4b.sh` — mirrors `smoke-m3b.sh` format:
- **Offline** (mocked endpoints + fixtures):
  - [O1] xAI routing: `--model grok-3 prompt "hi"` with a mocked xAI endpoint returning a canned stream.
  - [O2] Google routing: `--model gemini-2.0-flash prompt "hi"` mocked.
  - [O3] DashScope routing: `--model qwen-plus prompt "hi"` mocked; payload under 6 MB.
  - [O4] DashScope over-cap: synthesized 7 MB payload → `request_body_exceeded` before any HTTP call.
  - [O5] Plugin lifecycle: install → list → disable → enable → update → uninstall on `test/fixtures/plugins/hello-plugin`.
  - [O6] Codex OAuth mock flow: login with stubbed browser + synthesized callback + mocked token endpoint → `~/.swarm-harness/auth.json` written.
- **Live** (real API, `--live` flag, operator-driven, skip in CI):
  - [L1] Real xAI turn with `XAI_API_KEY`.
  - [L2] Real Google turn with `GOOGLE_GENERATIVE_AI_API_KEY`.
  - [L3] Real ChatGPT Plus/Pro OAuth + one turn (interactive; manual driver).

8.2. Extend `scripts/smoke.sh --all` to invoke `smoke-m4b.sh`.

8.3. Doc updates:
- `docs/03-interfaces.md` — add Codex-ChatGPT provider section under the Provider table.
- `docs/07-implementation-plan.md` — mark M4b items as shipped once complete.
- `docs/06-open-questions.md` — no changes; Q17/Q18 already resolved.
- `docs/04-tool-tiers.md` (if exists) — no changes; no new tools.

8.4. **Risk-note addition** in `docs/03-interfaces.md` at the end of the Codex section: "OpenAI can revoke the shared client id at any time. If the login flow starts returning 4xx, the feature is unavailable until OpenAI restores it or we find an alternative OAuth path. No auto-fallback."

## File layout after M4b

```
src/
  providers/
    index.ts                            # MODIFIED — optional preflight hook
    routing.ts                          # MODIFIED — xai / gemini / qwen / kimi entries; quirk dispatch
    xai-transport.ts                    # NEW
    xai-transport.test.ts
    google-transport.ts                 # NEW
    google-transport.test.ts
    dashscope-transport.ts              # NEW
    dashscope-transport.test.ts
    dashscope-preflight.ts              # NEW (6 MB cap helper)
    codex-chatgpt.ts                    # NEW (custom Vercel AI SDK provider)
    codex-chatgpt.test.ts
    quirks.ts                           # NEW (model-family quirks)
    quirks.test.ts
  auth/
    index.ts                            # unchanged (InteractiveAuth contract stable)
    xai-api-key.ts                      # NEW
    google-api-key.ts                   # NEW
    openai-compat-api-key.ts            # NEW (reused for DashScope)
    openai-oauth.ts                     # NEW (Codex App Server PKCE flow)
    openai-oauth.test.ts
  plugins/
    index.ts                            # MODIFIED — PluginInstallSource union
    state.ts                            # NEW (PluginStateStore)
    state.test.ts
    install.ts                          # NEW
    install.test.ts
    enable.ts                           # NEW
    disable.ts                          # NEW
    enable-disable.test.ts              # combined tests
    update.ts                           # NEW
    update.test.ts
    uninstall.ts                        # NEW
    uninstall.test.ts
    registry.ts                         # MODIFIED — consults PluginStateStore
    claude-code-source.ts               # unchanged from M2
  tools/
    framework-filter.ts                 # NEW (shared filter for framework modes)
    framework-filter.test.ts
  cli/
    main.ts                             # MODIFIED — plugin subcommand, framework routing, logout
    argv.ts                             # MODIFIED — plugin / login --provider / logout / --framework extensions
    plugin.ts                           # NEW
    plugin.test.ts
    login.ts                            # MODIFIED — --provider dispatch
    logout.ts                           # NEW — logout subcommand (§7.2a)
scripts/
  smoke-m4b.sh                          # NEW
  smoke.sh                              # MODIFIED — --all includes smoke-m4b.sh
test/
  fixtures/
    plugins/
      hello-plugin/                     # NEW (manifest + trivial tool)
      hello-plugin-v0.2/                # NEW (for update test)
    codex/
      responses-sse.txt                 # NEW (canned Codex SSE trace — captured by Phase 5.0 spike)
      required-headers.json             # NEW (header whitelist — captured by Phase 5.0 spike)
  integration/
    dashscope-preflight.test.ts         # NEW (§5.4 — NativeEngine + DashScope >6MB end-to-end)
docs/
  14-m4b-plan.md                        # NEW (this file)
  03-interfaces.md                      # MODIFIED — Codex provider section, Codex risk note
  07-implementation-plan.md             # MODIFIED — mark M4b items shipped
.omc/
  plans/
    m4b-provider-breadth-oauth.md       # NEW (mirror of this file)
```

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| OpenAI revokes Codex App Server OAuth client id | Medium | High | Document clearly at top of `openai-oauth.ts` as "policy-tolerated, not contracted." Graceful-degradation error message (AC 20) on 4xx. No auto-retry; user must pick a different provider. |
| Codex endpoint response format drifts | Medium | Medium | `CodexStreamState` is isolated — all drift is contained to one file. Unit tests use a canned SSE fixture; if the fixture stops matching live behavior, the tests fail loud. No silent breakage. |
| `@ai-sdk/xai` or `@ai-sdk/google` minor version introduces breaking change to `createXai`/`createGoogleGenerativeAI` | Medium | Low | Pin to `~x.y.z` (patch range only). Upgrade is an explicit PR with test re-run. |
| DashScope 6 MB cap changes (either direction) | Low | Low | Limit lives in one constant in `dashscope-preflight.ts`. Change is a one-line edit + test update. |
| Plugin state write race: two CLI processes call `plugin enable` simultaneously | Low | Medium | Mitigated via `proper-lockfile`; residual risk is a 5s timeout causing the second invocation to fail loudly with a clear error — documented as intended behavior. Plugin install from two processes simultaneously: cross-process install race still accepted (EEXIST on staging dir is clean rejection). |
| Plugin update leaves system with `<id>.old` dangling after partial failure | Low | Low | `update.ts` always attempts cleanup of `<id>.old` in a `finally`. If cleanup itself fails, `plugin list` detects the dangling dir on next run and prints a "drift" warning. |
| PKCE verifier leaks to logs | Low | Medium | Never log the raw verifier; only log `code_verifier.length` and `code_challenge.substring(0, 16) + "..."`. Covered by a code-review grep check (no `console.log.*verifier` in the source). |
| Codex ChatGPT turn-loop integration with NativeEngine not observed until M4a ships | High | Medium | M4b defers end-to-end integration tests behind a `describe.skipIf(!process.env.M4A_READY)` guard. Unit tests (CodexStreamState state machine) run unconditionally. Once M4a ships, the integration tests come live. |
| Parallel tool use claimed by `@ai-sdk/google` but doesn't work end-to-end | Medium | Low | Capability flag reads conservatively: `parallelToolUse: false` for Google until a live smoke confirms multi-tool turns work. Upgrade the flag in a follow-up; no behavioral regression. |
| Plugin `disable` called on a plugin mid-turn (plugin's tool was registered at session start, then disabled externally) | Low | Low | Tool registration is session-bounded (read once at start). `disable` takes effect on next session start. Document in CLI `--help`. |
| Plugin install from a malicious git URL runs arbitrary code on load | High | High | Documented risk: M4b has no plugin trust model (M5+). The user accepts the burden. CLI emits a "installing from untrusted source; this will run code from the manifest's `command` field" warning on `plugin install <git-url>` and requires `--yes-i-trust-this-source` for non-TTY use. |
| `state.json` schema changes break on upgrade | Medium | Medium | `schemaVersion: 1` is encoded now. If a future version bumps, `read()` migrates; refusing to parse a higher `schemaVersion` than we know is also OK (error with a clear upgrade message). |
| `~/.claude/plugins/state.json` collides with a future Claude Code state file of the same name | Low | Medium | The file is OUR contract, not Claude Code's. We document this in the file header comment (emitted on first write). If Claude Code ever adopts the same path, we rename to `~/.claude/plugins/.swarm-harness-state.json` as a one-release migration. |

## Verification steps

Run after each phase:

- **Phase 0:** `npx tsc --noEmit` clean.
- **Phase 1:** `npm ci` clean; no new lockfile conflicts.
- **Phase 2:** `npx vitest run src/providers/{xai,google,dashscope}-transport.test.ts src/providers/routing.test.ts` green; mocked one-turn scenarios for each provider pass.
- **Phase 3:** `npx vitest run src/plugins/` green; manual: `swarm-harness plugin install ./test/fixtures/plugins/hello-plugin` + `plugin list` round-trip.
- **Phase 4:** `npx vitest run src/auth/openai-oauth.test.ts` green; manual: `swarm-harness login --provider codex-chatgpt --help` shows expected usage; live login deferred to Phase 8 smoke (operator-driven).
- **Phase 5:** `npx vitest run src/providers/codex-chatgpt.test.ts` green; mocked end-to-end turn with NativeEngine (after M4a ships).
- **Phase 6:** `npx vitest run src/providers/quirks.test.ts` green.
- **Phase 7:** `npx vitest run src/cli/plugin.test.ts src/cli/argv.test.ts src/tools/framework-filter.test.ts` green.
- **Phase 8:** `scripts/smoke-m4b.sh --offline` all pass; `scripts/smoke-m4b.sh --live` operator-run with valid credentials (partial-skip supported); `scripts/smoke.sh --all` passes.

**End-of-M4b gate:** all 28 acceptance criteria verified (live criteria 23, 27 L1/L2/L3 operator-attested), tagged `m4b-complete`.

## Estimated effort

| Phase | Effort |
|---|---|
| 0 Interface refinements | 0.3 d |
| 1 Dependencies | 0.1 d |
| 2 xAI / Google / DashScope TransportProviders (+ auth + preflight) | 1.5 d |
| 3 Plugin install lifecycle (state, install, enable/disable, update, uninstall, CLI) | 1.65 d (+0.15d proper-lockfile) |
| 4 OpenAI OAuth for ChatGPT Plus/Pro (PKCE, loopback, persistence) | 1.5 d |
| 5.0 Codex Endpoint Spike (operator prerequisite) | 0.25 d |
| 5.1–5.4 Codex ChatGPT custom TransportProvider (stream state machine, NativeEngine wiring, DashScope integration test) | 1.25 d |
| 6 Model-family quirks centralization | 0.3 d |
| 7 CLI plumbing + framework-mode tool filter + logout subcommand | 0.4 d |
| 8 Smoke + docs + integration glue | 0.65 d |
| Buffer (shrunk by Google safety-settings reserve of 0.25d) | 0.25 d |

**Total: ~8.4 engineer-days** (up from 8.0d: +0.25d Phase 5.0 spike, +0.15d proper-lockfile; buffer reduced by 0.25d absorbed Google safety-settings reserve). Sits slightly above the 5-8 day target but all additions are forced by critic-identified correctness gaps. If schedule pressure hits, drop order: (a) `plugin update` atomic-swap sophistication (ship simpler "uninstall + reinstall" under the hood) → (b) Codex risk-note in docs → (c) model-family quirks centralization (leave inlined in each provider for v0, refactor later).

## Open items to revisit during implementation

- **Codex endpoint exact response shape.** Resolved by Phase 5.0 spike (operator prerequisite). SSE vocabulary locked in `test/fixtures/codex/responses-sse.txt` before Phase 5.1 begins. No speculation permitted.
- **Codex header requirements.** Resolved by Phase 5.0 spike. Required headers locked in `test/fixtures/codex/required-headers.json`. See §2.2a.
- **`@ai-sdk/google` parallel tool-use claim.** Capability flag reads conservative; upgrade after live validation.
- **Plugin `installedAt` / `updatedAt` timestamps.** Not in the state shape yet; add if `plugin list --verbose` demands it. Trivial extension.
- **Git clone depth / branch handling.** M4b uses `git clone --depth 1 --branch <ref?>`. If users have plugins on orphan refs or shallow-clone-incompatible repos, surface a clear error; full-history fallback deferred to M5.
- **Multi-auth-file co-existence.** `~/.swarm-harness/auth.json` will hold `openai-oauth` here and may hold `anthropic-oauth` or similar later. File locking on concurrent CLI invocations: atomic write-rename is sufficient for single-writer workflows; concurrent writes from two CLI processes could lose an update. Accept for M4b; revisit if users report.
- **Kimi model routing via DashScope vs. a separate Moonshot provider.** Currently routed through DashScope. If Moonshot ships a direct API endpoint with different semantics, split at that point.
- **Framework-mode tool filter helper location.** `src/tools/framework-filter.ts` is proposed. If M3 already centralized this for `--framework claude-agent-sdk`, merge with the existing location instead of creating a new one.

## Cross-references

- Prereq scope: `docs/07-implementation-plan.md` §M4 (all items not in M4a), `docs/06-open-questions.md` Q17 (Codex OAuth), Q18 (Copilot out).
- Prior milestones: `docs/10-m2-plan.md` (plugin read-only source; OpenAI TransportProvider surface; `AuthSource` variants), `docs/12-m3b-plan.md` (baseline we extend for prompt caching compatibility with non-Anthropic providers — no-op in M4b).
- Research: `docs/research/01-api.md` §6 (multi-provider routing), §7 (prompt caching — Anthropic-only), §8 (preflight + DashScope 6 MB cap); `docs/research/04-integrations.md` §2 (plugin lifecycle patterns from claw-code).
- Interface contracts: `src/providers/index.ts` (Provider interface + capabilities + optional preflight), `src/auth/index.ts` (InteractiveAuth for OAuth), `src/plugins/index.ts` (PluginSource + PluginInstallSource).
- Anti-patterns refused: GitHub Copilot (Q18); direct Anthropic OAuth bypassing Agent SDK (Q16).

## Revision history

- **rev 1 (2026-04-20):** initial draft. Seven scope/mechanism decisions locked: (1) Codex App Server OAuth client id hard-coded from Codex reverse-engineering, policy-tolerated with documented risk; (2) plugin state file at `~/.claude/plugins/state.json`, NOT `~/.swarm-harness/`; (3) flat state shape `{ schemaVersion, enabled[], versions{}, installSources{} }` with explicit schema version for forward migration; (4) install materialization via temp-dir + rename for atomic swap; (5) DashScope 6 MB cap enforced at provider preflight, non-retryable; (6) Codex response-shape translator lives inside `codex-chatgpt.ts` as `CodexStreamState`, NOT shared; (7) plugin update re-materializes from recorded install source, not "pull latest." M4b depends on M4a being complete; tests baseline ~900-950 assuming M4a adds 60-100 tests; target delta +60-90 for M4b. Biggest risk: Phase 5 Codex integration depends on a real-traffic response-shape capture not yet done — acceptance criterion 21 offline smoke uses a canned fixture; live AC 23 is operator-driven. Total effort ~8.0d, sits at top of 5-8 day target.
- **rev 3 (2026-04-22):** Phases 0/1/2/3/4/6/7/8 shipped in commits 23e2500, 37be22a, and Phase 8 scripts+docs. Phase 5 (Codex ChatGPT custom TransportProvider) deferred — blocked on operator SSE spike per §5.0. Login path via `swarm-harness login --provider codex-chatgpt` works end-to-end (OAuth PKCE flow shipped in Phase 4); end-to-end model turns require Phase 5 to land. See Q20 in `docs/06-open-questions.md` for resolution path.
- **rev 2 (2026-04-21):** applied critic REVISE feedback. 3 critical (C1 Phase 5.0 Codex spike gate blocks Phase 5.1+; C2 install-source detector replaced with unambiguous `resolveInstallSource` using disk-existence check; C3 `proper-lockfile` for concurrent state writes serializing cross-process `plugin enable`), 6 major (M1 logout CLI subcommand at §7.2a; M2 DashScope >6MB NativeEngine integration test at §5.4 with AC X; M3 framework-filter orthogonality clarified — orthogonal to M3a ToolDispatcher, runs earlier at factory call, no dispatcher.ts changes; M4 tool-surface removal unambiguous — REMOVED not no-op in Scope, AC 22, Phase 5.2; M5 Codex auth headers sourced from Phase 5.0 spike fixture at §2.2a; M6 Google safety-settings budget reserve at §2.2b). Minor fixes: `sanitizeId` explicit `..` rejection, `@ai-sdk/openai` v5 verify-at-implementation note, NFS-safety rewrite, AC 11 uses existing fixture path, AC 21/23 operator-only markers, Open items updated to remove resolved spike items. Total 8.0d → 8.4d. No new scope; fixes only.
