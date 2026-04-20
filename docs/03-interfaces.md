# Key interfaces

Four abstraction seams must be correct from day one. Retrofitting them is expensive; other code can be rewritten freely. These contracts must stay stable across v0 → v1.

## 1. Provider

The conversation loop does not know *how* model calls happen — just that they do. `Provider` is a tagged union with two variants:

```ts
export type Provider = TransportProvider | FrameworkProvider;

export interface TransportProvider {
  readonly kind: "transport";
  readonly id: string;                  // "anthropic" | "openai" | "google" | …
  readonly model: LanguageModel;        // from `ai` (Vercel AI SDK)
  readonly capabilities: ProviderCapabilities;
}

export interface FrameworkProvider {
  readonly kind: "framework";
  readonly id: string;                  // "claude-agent-sdk" | "codex-chatgpt"
  readonly capabilities: ProviderCapabilities;

  run(request: AgentRunRequest): AsyncIterable<NormalizedEvent>;
}
```

### TransportProvider (default path — our loop)

Used by the Vercel AI SDK transport. Our `src/core/conversation.ts` owns the turn loop, calls `streamText({ model: provider.model, … })`, dispatches tool calls through our permission engine, persists via our `SessionStore`.

Providers: `anthropic`, `openai`, `google`, `xai`, `openai-compat` (Ollama / LM Studio / OpenRouter). Implementation is ~20 LOC per provider — mostly wrapping `createAnthropic` / `createOpenAI` / etc. with the right `AuthSource`.

### FrameworkProvider (opt-in path — their loop)

Used when the provider runs its own agent loop and we observe. Two concrete cases:

- **`claude-agent-sdk`** — for Claude Max subscription auth. Agent SDK owns loop, tools, permissions, sessions, compaction. We translate its events into our `NormalizedEvent` stream so session logs stay unified.
- **`codex-chatgpt`** — for ChatGPT Plus/Pro auth. Custom provider targeting `chatgpt.com/backend-api/codex/responses` with Codex App Server OAuth.

**Constraint:** In `FrameworkProvider` mode, `SwarmHost`-dependent tools (Tier 2 `send_message`, `check_inbox`, lane-event coordination) either degrade to no-ops or are removed from the tool surface. Documented tradeoff — users choose this path for subscription billing, not for full swarm features.

### Types

```ts
export interface ProviderCapabilities {
  streaming: boolean;
  promptCache: boolean;
  parallelToolUse: boolean;
  vision: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
  // Framework providers: true means the tool/permission/session layers are framework-owned
  ownsLoop: boolean;
}

export type NormalizedEvent =
  | { type: "text_delta";       text: string }
  | { type: "tool_use_start";   id: string; name: string }
  | { type: "tool_use_input";   id: string; jsonDelta: string }
  | { type: "tool_use_end";     id: string }
  | { type: "message_stop";     stopReason: StopReason; usage: Usage }
  | { type: "error";            error: ProviderError };
```

**Rule:** no Anthropic SDK, Vercel AI SDK, or Agent SDK types leak past `src/providers/`. The rest of the codebase imports only from `src/providers/index.ts`.

## 1b. AuthSource

Auth and provider are orthogonal. A `Provider` accepts an `AuthSource` at construction time; the same provider can be instantiated with different auth.

```ts
export interface AuthSource {
  readonly kind: "api-key" | "oauth-bearer" | "framework-managed";
  readonly providerId: string;     // "anthropic" | "openai" | …

  // Called by the provider before each request. Returns headers to merge.
  headers(): Promise<Record<string, string>>;

  // Optional: oauth-bearer implementations handle refresh.
  refresh?(): Promise<void>;
}
```

Concrete implementations:

| Auth impl | `kind` | Notes |
|---|---|---|
| `AnthropicApiKeyAuth` | `api-key` | `ANTHROPIC_API_KEY` → `x-api-key` header |
| `AnthropicOAuthAuth` | `framework-managed` | Delegated to Agent SDK; not used with `TransportProvider` |
| `OpenAIApiKeyAuth` | `api-key` | `OPENAI_API_KEY` → `Authorization: Bearer` |
| `OpenAIOAuthAuth` | `oauth-bearer` | Codex App Server OAuth → custom `codex-chatgpt` `FrameworkProvider` |
| `GoogleApiKeyAuth` | `api-key` | `GOOGLE_GENERATIVE_AI_API_KEY` |
| `XaiApiKeyAuth` | `api-key` | `XAI_API_KEY` |
| `OpenAICompatApiKeyAuth` | `api-key` | Works with Ollama / LM Studio / OpenRouter; `OPENAI_BASE_URL` override |

**Storage:** OAuth tokens live in `~/.swarm-coder/auth.json` (encrypted at rest where the platform supports it). Never in git, never in session logs.

## 2. PluginSource / SkillSource

Plugins and skills come from somewhere. v0 reads from Claude Code's layout; later sources may read from `.claw/`, custom registries, or remote marketplaces. The consumer never knows where a plugin came from.

```ts
export interface PluginSource {
  readonly id: string;                // "claude-code" | "claw" | …

  discover(): Promise<PluginManifest[]>;
  load(id: string): Promise<LoadedPlugin>;
}

export interface SkillSource {
  readonly id: string;

  discover(): Promise<SkillManifest[]>;
  load(id: string): Promise<LoadedSkill>;
}
```

Multiple sources can be registered and queried in order. First match wins for `load(id)`. Discovery is unioned across sources with source-id disambiguation on name collisions.

**v0 default registry:** `[claude-code-source]`. Add more sources later by appending to the registry.

## 3. SwarmHost

The bridge between an atomic agent and its parent orchestrator. Tier-2 tools (`send_message`, `check_inbox`, `agent`/spawn, `task_*`) dispatch through this interface, so the same tool code works whether the agent is standalone or a swarm worker.

```ts
export interface SwarmHost {
  readonly mode: "standalone" | "worker";
  readonly agentId: string;

  spawn(request: SpawnRequest): Promise<AgentHandle>;
  send(to: AgentId, message: Message): Promise<void>;
  inbox(): AsyncIterable<InboxEvent>;

  task: TaskAPI;   // create, get, list, update, stop, output
}
```

Two implementations:

- **`StandaloneHost`** — no parent. `spawn` still works (spawns a subprocess child). `send`/`inbox` operate on an in-process pub/sub so tools behave consistently.
- **`WorkerHost`** — talks to the orchestrator via JSONL over stdio. All `send`/`inbox`/`task_*` traffic is routed through the parent.

When `mode === "standalone"`, Tier-2 tools degrade gracefully but the **tool surface does not change** — the model sees the same tool list either way, so its behavior stays consistent.

## Interface stability policy

- Adding optional fields: allowed any time.
- Adding required fields: major-version bump of the interface.
- Renaming or removing: major-version bump.
- Semantic change to an existing method: major-version bump.

v0 through v0.x may break these interfaces freely. They become stable at v1.0.

## The four core interfaces (recap)

1. **`Provider`** (tagged union: `TransportProvider` | `FrameworkProvider`) — how model calls happen
2. **`AuthSource`** — how auth credentials are supplied (orthogonal to Provider)
3. **`PluginSource` / `SkillSource`** — where plugins and skills are loaded from
4. **`SwarmHost`** — the atomic agent ↔ orchestrator bridge

Everything else in the codebase is free to change.
