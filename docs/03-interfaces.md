# Key interfaces

Abstractions live at two layers. The **outer layer** is what CLI, ink UI, SwarmHost wrapper, tools, and orchestrator consume — this is stable from day one. The **inner layer** is an implementation detail and becomes real only when we ship a second AgentEngine at M4.

```
outer (consumed by CLI / UI / SwarmHost / tools / orchestrator)
  ┌─ AgentEngine ──── run a conversation, stream events
  ├─ AuthSource  ──── credentials, orthogonal to engine
  ├─ SwarmHost   ──── atomic agent ↔ orchestrator bridge
  └─ PluginSource / SkillSource ── where plugins and skills come from

──────────────── stable boundary ────────────────

inner (only consumed by a native AgentEngine implementation — M4+)
  ┌─ Provider     ─── finer-grained LLM transport
  ├─ Compactor    ─── conversation compression strategy
  └─ MCP client   ─── our stdio MCP bridge
```

Inner-layer abstractions are used *inside* `NativeEngine` (M4). The M0 `ClaudeAgentSdkEngine` wraps Anthropic's Agent SDK, which owns loop / streaming / MCP / compaction / session / prompt cache internally — we don't touch the inner layer at all in M0.

The outer-layer contracts must stay stable across v0 → v1. Inner-layer may break freely until M4 ships.

## 1. AgentEngine

The primary abstraction: "run a conversation to completion, streaming events back."

```ts
export interface AgentEngine {
  readonly id: string;                          // "claude-agent-sdk" | "native"
  readonly capabilities: EngineCapabilities;

  run(config: RunConfig): AsyncIterable<NormalizedEvent>;
}
```

The engine drives the turn loop internally. It emits `NormalizedEvent`s (streaming text, tool-use blocks, stop reasons, errors) and calls back to outer code for two things only:

- **`canUseTool(name, input)`** — permission gate, answered by our `PermissionEngine`
- **`executeTool(name, input, ctx)`** — tool dispatch, handled by our tool dispatcher

Tool execution never happens inside the engine. This keeps side effects gated by our permission model, logged as lane events, and routed through SwarmHost regardless of which engine is driving.

### Two implementations planned

| Impl | Composition | When | Notes |
|---|---|---|---|
| `ClaudeAgentSdkEngine` | Thin wrapper over `@anthropic-ai/claude-agent-sdk` | M0 | Engine owns loop, streaming, MCP, compaction, session, cache. Ships OAuth for Claude Max. |
| `NativeEngine` | Composes `Provider` (Vercel AI SDK) + our Compactor + our MCP client + our turn loop | M4 | Multi-provider (OpenAI, Google, xAI, Ollama, ChatGPT Codex). |

Both implement the same `AgentEngine` surface. All outer code is engine-agnostic.

### Capabilities

`EngineCapabilities` advertises what an engine handles natively vs. what outer code must drive:

```ts
export interface EngineCapabilities {
  readonly streaming: boolean;
  readonly promptCache: boolean;
  readonly parallelToolUse: boolean;
  readonly mcp: boolean;          // engine runs MCP internally?
  readonly compaction: boolean;   // engine owns compaction?
  readonly resume: boolean;       // supports SessionSnapshot resume?
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
}
```

Outer code checks the capabilities to decide whether to run its own MCP client / compactor / cache layer alongside. In M0, `ClaudeAgentSdkEngine.capabilities` reports `{ mcp: true, compaction: true, promptCache: true, … }` so we don't double up.

### Session snapshots

```ts
export interface SessionSnapshot {
  readonly engineId: string;
  readonly data: unknown;
}
```

Opaque per-engine state, stored alongside our per-worktree JSONL log. `--resume` looks up the snapshot and passes it back via `RunConfig.resumeFrom`. Cross-engine resume is not supported in v0.

**Rule:** No Anthropic SDK, Vercel AI SDK, or Agent SDK types leak past `src/engine/*` and `src/providers/*`. Everything else imports only from `src/engine/index.ts`.

## 2. Provider (inner layer, M4a shipped)

Finer-grained LLM transport. Lives *inside* `NativeEngine`. Not consumed by outer code. Shipped in M4a — see `docs/13-m4a-plan.md` for implementation detail.

```ts
export interface Provider {
  readonly id: string;
  readonly model: LanguageModel;     // from `ai` (Vercel AI SDK)
  readonly capabilities: ProviderCapabilities;
}

/** Marker for providers that own the turn loop (Agent SDK, Codex App Server). */
export interface TransportProvider extends Provider {
  readonly _transport: true;
}

export interface ProviderCapabilities {
  readonly streaming: boolean;
  readonly parallelToolUse: boolean;
  readonly reasoning: boolean;        // true for o1/o3/o4/* and QwQ model families
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
}

export interface ProviderRequest {
  readonly model: string;
  readonly messages: CoreMessage[];
  readonly tools?: ToolDefinition[];
  readonly system?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; partial: string }
  | { type: "tool_use_end"; id: string }
  | { type: "message_stop"; stopReason: StopReason; usage: Usage };
```

Shipped in M4a: `openai` (`@ai-sdk/openai`). Planned M4b: `anthropic`, `google`, `xai`, `openai-compat`, `codex-chatgpt`.

Model-prefix routing (`claude*` / `grok*` / `openai/` / `gpt-` / `qwen*` / `gemini-*`) and alias resolution live in `src/providers/routing.ts` and `src/providers/aliases.ts`.

## 3. AuthSource

Auth and engine are orthogonal. The same engine can be instantiated with different auth; the same auth can back different engines.

```ts
export interface AuthSource {
  readonly kind: "api-key" | "oauth-bearer";
  readonly providerId: string;

  headers(): Promise<Record<string, string>>;
  refresh?(): Promise<void>;
  isAuthenticated(): Promise<boolean>;
}

export interface InteractiveAuth extends AuthSource {
  readonly kind: "oauth-bearer";
  login(options?: { readonly deviceCode?: boolean }): Promise<void>;
  logout(): Promise<void>;
}
```

### Concrete implementations

| Impl | Kind | Provider id | Ships in |
|---|---|---|---|
| `AnthropicApiKeyAuth` | api-key | anthropic | M0 |
| `AnthropicOAuthAuth` | oauth-bearer | anthropic | M0 |
| `OpenAIApiKeyAuth` | api-key | openai | M4 |
| `OpenAIOAuthAuth` (Codex App Server) | oauth-bearer | openai | M4 |
| `GoogleApiKeyAuth` | api-key | google | M4 |
| `XaiApiKeyAuth` | api-key | xai | M4 |
| `OpenAICompatApiKeyAuth` | api-key | openai-compat | M4 |

**Note on Claude Max OAuth:** `AnthropicOAuthAuth.login()` delegates to the Agent SDK (or reimplements the flow from claw-code's `oauth.rs`). Under `ClaudeAgentSdkEngine`, the engine reads its persisted credentials directly — `headers()` may return `{}`. Decision Q16 in `06-open-questions.md`.

**Storage:** tokens live in `~/.swarm-coder/auth.json`, encrypted at rest where the platform supports it. Never in git, never in session logs.

## 4. PluginSource / SkillSource

Where plugins and skills come from. Plugins are JSON-manifest subprocesses that bring tools/commands/hooks; skills are `SKILL.md` files whose body becomes a system-prompt fragment.

```ts
export interface PluginSource {
  readonly id: string;                    // "claude-code" | "claw" | …
  discover(): Promise<PluginManifest[]>;
  load(id: string): Promise<LoadedPlugin>;
}

export interface SkillSource {
  readonly id: string;
  discover(): Promise<SkillManifest[]>;
  load(id: string): Promise<LoadedSkill>;
}
```

Multiple sources can be registered and queried in order. First match wins for `load(id)`. Discovery unions across sources; the `sourceId` field disambiguates collisions.

**v0 default registry:** `[claude-code-source]`. Adds more sources later without breaking consumers.

## 5. SwarmHost

The bridge between an atomic agent and its parent orchestrator. Tier-2 tools (`send_message`, `check_inbox`, `agent`/spawn, `task_*`) dispatch through this interface — the same tool code works whether the agent is standalone or a subprocess worker.

```ts
export interface SwarmHost {
  readonly mode: "standalone" | "worker";
  readonly agentId: AgentId;

  emit(event: Omit<LaneEvent, "ts" | "agentId">): void;
  spawn(request: SpawnRequest): Promise<AgentHandle>;
  send(to: AgentId, message: AgentMessage): Promise<void>;
  inbox(): AsyncIterable<InboxEvent>;

  readonly task: TaskAPI;
}
```

**M3a additions (Phase 6):** `SpawnRequest.role` and `SpawnRequest.allowedTools` are now load-bearing — the orchestrator populates them from the resolved `Role` object, the subprocess spawner propagates `SWARM_CODER_ROLE` to the child, and the worker entry wires them into `RunConfig.systemPrompt` + `RunConfig.allowedTools`. The `BranchPolicy`, `CommitPolicy`, and `EscalationPolicy` fields on `TaskPacket` are discriminated-kind records (not flat strings); Zod schemas live in `src/swarm/policies.ts`. See `docs/11-m3a-plan.md` for the migration path from legacy flat strings.

**M3b additions:**
- `SwarmHost.askUser(question, options?): Promise<AskUserResponse>` (Phase 6) — routes through the host, so Tier 2 `ask_user_question` works identically in standalone (TTY readline fallback) and worker (IPC → orchestrator) modes. `AskUserResponse = { status: "answered"; answer } | { status: "cancelled" | "timed-out" } | { status: "error"; message }`.
- `RunConfig.systemPrompt` now accepts `string | readonly string[]` (Phase 3). When a string is supplied, `ClaudeAgentSdkEngine` wraps it with `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` from the SDK so the static prefix is eligible for prompt caching while per-run dynamic context stays uncached. If the marker export is missing at runtime (SDK version skew), the engine falls back to a plain string and emits `prompt_cache_unavailable`.
- `AgentEngine.countTokens?(input): Promise<CountTokensResult>` (Phase 7) — optional preflight. M3b ships a local-estimate-only implementation (`source: "local-estimate"`); the server path waits for an SDK-native count method since the REST endpoint needs API-key auth unavailable under Claude Max.

Two implementations:

- **`StandaloneHost`** — no parent. `spawn` subprocess-spawns a child. `send`/`inbox` operate on an in-process pub/sub so tool behavior stays consistent.
- **`WorkerHost`** — talks to orchestrator via JSONL over stdio. All `send` / `inbox` / `task_*` traffic routes through the parent.

When `mode === "standalone"`, Tier-2 tools degrade gracefully, but the **tool surface does not change** — the model sees the same list either way, so its behavior stays stable.

Each subprocess worker runs its own `AgentEngine` instance. SwarmHost sits one layer above the engine, so the choice of `ClaudeAgentSdkEngine` vs `NativeEngine` is transparent to coordination.

## Interface stability policy

- Adding optional fields: allowed any time.
- Adding required fields: major-version bump of the interface.
- Renaming or removing: major-version bump.
- Semantic change to an existing method: major-version bump.

v0 through v0.x may break outer-layer interfaces freely; they become stable at v1.0. Inner-layer (Provider, Compactor, MCP) may break freely until M4 ships.

## Recap

**Outer interfaces (consumed by everything):** `AgentEngine`, `AuthSource`, `PluginSource`, `SkillSource`, `SwarmHost`.

**Inner interface (used only inside a NativeEngine impl, M4+):** `Provider`.

Everything else in the codebase is free to change.
