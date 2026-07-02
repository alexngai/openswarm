# ACP compatibility plan — expose openswarm as an Agent Client Protocol agent

Companion to [docs/02-architecture.md](../02-architecture.md) (the `AgentEngine` seam) and
[docs/03-interfaces.md §1](../03-interfaces.md). This doc is the design + execution plan for
making openswarm drivable from ACP clients (Zed, Neovim's CodeCompanion/avante, and any
future editor that speaks the protocol).

**Authoring date:** 2026-06-02.
**Status:** **realized.** The single-agent ACP parity this plan describes shipped (Stage A); the
teams×ACP design it defers was then built end to end ([docs/31](../31-teams-acp-design.md)–[36](../36-meta-swarm-convention.md)).
Retained as the originating compatibility analysis.
**Anchor:** [docs/00-vision.md](../00-vision.md) — "one agent is a tool, N coordinated agents is the product."
**Out of scope (its own docs, now written):** the deep teams×ACP design — exposing an
orchestrator/team as a single ACP session ([docs/31](../31-teams-acp-design.md)+). This plan ships **single-agent ACP parity** first;
§9 records the open question and why it's split out.

---

## TL;DR

ACP (Agent Client Protocol) is JSON-RPC 2.0 over newline-delimited JSON on stdio. An editor
("client") spawns the agent as a subprocess, calls `session/prompt`, and the agent streams
`session/update` notifications back while calling *client* methods (`session/request_permission`,
`fs/*`, `terminal/*`) mid-turn.

openswarm already has the two seams ACP needs:

- **`AgentEngine.run(config): AsyncIterable<NormalizedEvent>`** ([src/engine/index.ts:64](../../src/engine/index.ts)) —
  a streaming event channel. ACP `session/update` is *also* a streaming event channel. The ACP
  adapter is **a second consumer of the same stream `runHeadless` already drives**
  ([src/ui/headless.ts](../../src/ui/headless.ts)).
- **`PermissionGate = (toolName, input) => Promise<PermissionDecision>`** ([src/engine/index.ts:243](../../src/engine/index.ts)) —
  an async approval callback that maps **1:1** onto ACP `session/request_permission`.

So this is **not a port**. It's a new `run()` consumer (an event translator) plus a new
`PermissionGate` implementation (a `requestPermission` round-trip), wired behind a new
`openswarm acp` subcommand. Both reference adapters (`@agentclientprotocol/claude-agent-acp`,
`zed-industries/codex-acp`) follow the same pattern — **embed the engine, translate the events** —
and neither bakes ACP into the engine core. We do the same, as a subcommand rather than a
separate package, because our engine is already in-process.

**Scope:** stages A.1–A.7 below. **Estimate:** ~2–3d for single-agent parity. **Acceptance:** §7.

---

## 1. What ACP is (reference facts)

Primary sources:
- Spec: <https://agentclientprotocol.com>
- Schema (authoritative types, protocol version `1`):
  <https://github.com/zed-industries/agent-client-protocol> → `schema/schema.json`
- TS SDK: npm **`@agentclientprotocol/sdk`** (formerly `@zed-industries/agent-client-protocol`) —
  exposes `AgentSideConnection`, `ClientSideConnection`, `ndJsonStream`, and all `*Request/*Response` types.

### 1.1 Transport
- JSON-RPC 2.0, **one message per line** (ndjson) over the agent process's stdin/stdout.
- The **client spawns the agent**; there is no socket/HTTP transport in the base protocol.
- **stdout is reserved for protocol frames.** All logging goes to **stderr**. (The Claude adapter
  enforces this by reassigning `console.log/info/warn/debug = console.error` at startup.)
- Bidirectional: agent methods (`initialize`, `session/*`) come *from* the client; the agent calls
  *client* methods (`session/request_permission`, `fs/*`, `terminal/*`) during a turn.

### 1.2 Method surface (the subset we implement first in **bold**)

Agent methods (client → agent):
- **`initialize`** → `{ protocolVersion, agentCapabilities, agentInfo, authMethods }`
- `authenticate` / `logout` (cap-gated)
- **`session/new`** `{ cwd, mcpServers[], additionalDirectories? }` → `{ sessionId, modes?, configOptions? }`
- **`session/prompt`** `{ sessionId, prompt: ContentBlock[] }` → `{ stopReason }`
- `session/load` (cap-gated by `agentCapabilities.loadSession`)
- `session/set_mode`
- newer/optional: `session/resume|fork|list|close|delete|set_model|set_config_option`

Agent notifications (client → agent):
- **`session/cancel`** `{ sessionId }` (one-way; we finish the turn and return `stopReason: "cancelled"`).

Client methods (agent → client):
- **`session/request_permission`** `{ sessionId, toolCall, options: PermissionOption[] }` → `{ outcome }`
- `fs/read_text_file` / `fs/write_text_file` (cap-gated by `clientCapabilities.fs.*`)
- `terminal/create|output|wait_for_exit|kill|release` (cap-gated by `clientCapabilities.terminal`)

Client notifications (agent → client):
- **`session/update`** `{ sessionId, update: SessionUpdate }` — the streaming channel.

### 1.3 `SessionUpdate` variants (discriminated on `sessionUpdate`)
`user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
`tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`
(+ newer `usage_update`, `config_option_update`, `session_info_update`).

### 1.4 Permission round-trip
```
RequestPermissionRequest { sessionId, toolCall: ToolCallUpdate, options: PermissionOption[] }
PermissionOption { optionId, name, kind: "allow_once"|"allow_always"|"reject_once"|"reject_always" }
RequestPermissionResponse { outcome: { outcome: "selected", optionId } | { outcome: "cancelled" } }
```
`optionId` is agent-defined; `kind` is a UI hint only. If the turn is cancelled while a request is
outstanding, the client returns `cancelled`.

### 1.5 Capability negotiation (`initialize`)
- `clientCapabilities.fs.{readTextFile,writeTextFile}` (default false) — gates `fs/*`.
- `clientCapabilities.terminal` (default false) — gates all `terminal/*`.
- `agentCapabilities.{loadSession, promptCapabilities, mcpCapabilities, sessionCapabilities}`.
- Baseline (no negotiation): agent must accept `text` and `resource_link` content blocks in prompts.

### 1.6 How the reference adapters resolve the design choices

| Concern | `claude-agent-acp` (TS, Anthropic/Zed) | `codex-acp` (Rust, Zed) |
|---|---|---|
| Native ACP in engine? | No — adapter wraps Claude Agent SDK | No — adapter links `codex-core` crates |
| Pattern | embed engine, translate events | embed engine, translate events |
| Package / bin | `@agentclientprotocol/claude-agent-acp` / `claude-agent-acp` | `@zed-industries/codex-acp` / `codex-acp` |
| fs | **proxied** to client (`client.readTextFile/writeTextFile`) | local |
| terminal | runs **locally**; live output via custom `_meta` channel (not ACP `terminal/*`) | local; output streamed to client UI |
| permissions | SDK `canUseTool` → `session/request_permission` | codex approval events → `session/request_permission` |
| persistence/resume | SDK on-disk store; `session/load` replays `getSessionMessages` as chunks | codex `ThreadManager` resume |
| `AskUserQuestion` | **disallowed** (no clean ACP mapping) | n/a |

Takeaway both teams converge on: keep ACP out of the engine; write a thin translator.

---

## 2. Why openswarm fits this with minimal new surface

| ACP need | Existing openswarm seam | File |
|---|---|---|
| Stream agent output | `AgentEngine.run()` yields `AsyncIterable<NormalizedEvent>` | [src/engine/index.ts:64](../../src/engine/index.ts) |
| Approve a tool call | `PermissionGate(toolName, input) → PermissionDecision` | [src/engine/index.ts:243](../../src/engine/index.ts) |
| Cancel a turn | `RunConfig.abort?: AbortSignal` | [src/engine/index.ts:148](../../src/engine/index.ts) |
| New / resume a session | `SessionStore` + opaque `SessionSnapshot { engineId, data }` | [src/session/store.ts](../../src/session/store.ts), [src/engine/index.ts:267](../../src/engine/index.ts) |
| MCP servers from client | `RunConfig` + existing MCP bridge | `src/mcp/` |
| Subcommand entry | clean CLI subcommand registry | `src/cli/` |
| Headless stream consumer (the precedent) | `runHeadless(events)` writes JSONL to stdout | [src/ui/headless.ts](../../src/ui/headless.ts) |

The ACP adapter is conceptually `runHeadless` with: (a) ACP-shaped frames instead of raw
`NormalizedEvent` JSONL, and (b) a back-channel for permissions/fs/terminal.

---

## 3. Event mapping: `NormalizedEvent` → `SessionUpdate`

| `NormalizedEvent` ([src/core/types.ts:104](../../src/core/types.ts)) | ACP `SessionUpdate` | Notes |
|---|---|---|
| `text_delta {text}` | `agent_message_chunk` (text block) | direct |
| `tool_use_start {id,name}` | `tool_call` | map `name`→`ToolKind` (§4); set `status:"pending"` |
| `tool_use_input {id,jsonDelta}` | accumulate → `tool_call.rawInput` | buffer per `id`, parse when complete |
| `tool_use_end {id}` | `tool_call_update {status:"in_progress"}` | finalize `rawInput`; derive `locations` (§4) |
| `tool_result {toolUseId,content,isError}` | `tool_call_update {status: isError?"failed":"completed"}` | edits → `diff` content; else `content` block; set `rawOutput` |
| `message_stop {stopReason,usage}` | resolves `PromptResponse.stopReason` (+ emit `usage_update`) | map stop reasons (§5) |
| `error {error}` | `tool_call_update`/turn error | classify retryable vs fatal |
| `compaction`,`cache_hit`,`cache_miss`,`hook_event` | drop, or surface via `_meta` | cosmetic; not part of v1 acceptance |

---

## 4. Tool-name → `ToolKind` + locations + diffs

ACP `ToolKind ∈ read|edit|delete|move|search|execute|think|fetch|switch_mode|other`. Build a
static table from our Tier-0 tools:

| openswarm tool | `ToolKind` | `locations` source | diff? |
|---|---|---|---|
| `read_file` | `read` | `input.path` (+ `line` from offset) | — |
| `write_file` | `edit` | `input.path` | synth diff (oldText: prior file contents or `null`, newText: `input.content`) |
| `edit_file` | `edit` | `input.path` | **native** — tool already has old/new strings |
| `multi_edit` | `edit` | `input.path` | one `diff` block per edit, or aggregate |
| `glob` | `search` | — | — |
| `grep` | `search` | — | — |
| `bash` | `execute` | — | output as `content` (live streaming = §6 limitation) |
| `todo_write` | (→ `plan`, not a tool_call) | — | see §3.5 below |
| MCP tools (`mcp__<server>__<tool>`) | `other` (heuristic by verb) | best-effort | — |

`locations` (`{path, line?}`) drive Zed's "follow-along" cursor — populating them for read/edit
tools is the single highest-leverage detail for editor UX. Diffs render as inline review in Zed;
`edit_file`'s existing old/new payload maps straight to ACP `Diff {path, oldText, newText}`.

### 3.5 `todo_write` → ACP `plan`
openswarm ships a `todo_write` tool. Instead of surfacing it as a `tool_call`, intercept it
in the translator and emit a `plan` update (`entries: {content, priority, status}[]`). Zed renders
this as a live todo panel — high-value, low-cost. (This is the one place the translator is *not*
a pure 1:1 passthrough; it consumes the tool's input and re-shapes it.)

---

## 5. Stop-reason & cancellation mapping

| openswarm `StopReason` | ACP `StopReason` |
|---|---|
| `end_turn` | `end_turn` |
| `max_tokens` | `max_tokens` |
| `tool_use` | (internal; loop continues — not surfaced) |
| `stop_sequence` | `end_turn` |
| `error` | turn error / `refusal` per cause |
| (abort fired) | **`cancelled`** |

`session/cancel` → trip the `RunConfig.abort` `AbortSignal`, drain the stream, resolve any
in-flight `session/request_permission` as `cancelled`, return `PromptResponse {stopReason:"cancelled"}`.
**Correctness note (learned from claude-agent-acp #694):** emit `cancelled`, *not* `end_turn`, on
interrupt; and ensure the next `session/prompt` after a cancel/error still works (don't leave the
engine in a wedged state).

---

## 6. Known limitations we accept for v1

1. **No reasoning stream.** `NormalizedEvent` has no thinking/reasoning variant, so
   `agent_thought_chunk` stays empty until we add one (small engine-translator change; see §8 follow-up).
2. **Bash output is not streamed.** `tool_result` only fires at tool completion, so `bash` shows
   output in one shot, not live. Both reference adapters work around this with a custom `_meta`
   terminal channel; v1 ships one-shot output and notes it. (Follow-up: emit incremental
   `tool_call_update`s if/when the engine surfaces stdout deltas.)
3. **fs runs locally, not proxied.** We execute `read_file`/`write_file`/`edit_file` against disk
   ourselves (like codex-acp), so we will not honor the editor's *unsaved buffers*. Proxying via
   `fs/read_text_file`/`fs/write_text_file` (like claude-agent-acp) is a later capability-gated
   enhancement, not v1.
4. **`AskUserQuestion`-style tools** have no clean ACP mapping → disallow or degrade to text.
5. **Auth.** Per ToS we own zero auth code. `initialize.authMethods` is empty by default; an
   optional terminal-login method can shell `claude auth login` (mirrors claude-agent-acp's `--cli`
   passthrough). Out of v1 critical path — env/keychain auth already works.

---

## 7. Staged plan & acceptance

**Stage A — single-agent ACP parity.**

- **A.1 — Dependency + entry.** Add `@agentclientprotocol/sdk`. New `openswarm acp` subcommand
  ([src/cli/acp.ts]) that builds `ndJsonStream(stdout, stdin)` + `AgentSideConnection`, and
  **redirects all logging to stderr** (assert nothing writes to stdout outside the JSON-RPC stream).
- **A.2 — `initialize`.** Declare `agentInfo`, `agentCapabilities` (`loadSession: true`,
  `promptCapabilities.embeddedContext: true`), and `authMethods: []`. Echo negotiated `protocolVersion`.
- **A.3 — `session/new` + `session/cancel`.** Construct `AgentEngine` + `ToolDispatcher` +
  `SessionStore` per session; store by `sessionId`; wire an `AbortController` per session. Pass
  `mcpServers` from the request into the MCP bridge.
- **A.4 — `session/prompt` + the translator.** Implement `NormalizedEvent → SessionUpdate`
  (§3), the `ToolKind`/locations/diff table (§4), and `todo_write → plan` (§3.5). Resolve
  `PromptResponse.stopReason` (§5).
- **A.5 — Permission bridge.** Implement `PermissionGate` as a `client.requestPermission` round-trip:
  options `allow_once`/`allow_always`/`reject_once`; map `outcome` back to `PermissionDecision`;
  persist `allow_always` into the session's permission engine for the session lifetime.
- **A.6 — `session/load`.** Gated on `loadSession`. Replay history as `user_message_chunk` /
  `agent_message_chunk`. **Note the engine split:** SDK-engine history lives in the Claude Agent
  SDK's own JSONL store (read via its session helpers); NativeEngine writes its own JSONL log.
  The replay source therefore branches on `SessionSnapshot.engineId`.
- **A.7 — Docs + manual verification.** README "ACP" section; Zed `agent_servers` config snippet;
  a `scripts/smoke-acp.sh` that pipes a scripted client transcript and asserts the frame sequence.

**Acceptance (Stage A):**
- [ ] `tsc --noEmit` clean; unit tests for the translator (`NormalizedEvent → SessionUpdate`) and
      the permission mapper.
- [ ] A scripted ACP client (or Zed) can: `initialize` → `session/new` → `session/prompt "read
      src/cli/main.ts and summarize"` → receives `agent_message_chunk` + a `read`-kind `tool_call`
      with correct `locations` → `end_turn`.
- [ ] A prompt that triggers an `edit_file` produces a `tool_call` with a `diff` content block and
      a `session/request_permission` round-trip that the client can allow/deny.
- [ ] `session/cancel` mid-turn returns `stopReason: "cancelled"` and a subsequent `session/prompt`
      still works.
- [ ] Nothing but JSON-RPC frames ever reach stdout.
- [ ] Verified in real Zed via an `agent_servers` entry pointing at the local build.

**Stage B — teams×ACP (deferred to its own doc).** See §9.

---

## 8. Post-A follow-ups (tighten when touched)

- Add a `thinking_delta` / reasoning variant to `NormalizedEvent` + engine translators → wire
  `agent_thought_chunk`.
- `_meta` terminal channel for live `bash` output (match codex-acp's `terminal_*` meta shape).
- Capability-gated fs proxying (`fs/read_text_file`/`fs/write_text_file`) to honor unsaved buffers.
- `available_commands_update` from our slash-command registry (`src/cli/slash/commands/`).
- `session/set_mode` ↔ our `PermissionMode` (`read-only`/`workspace-write`/`danger-full-access`)
  and/or a plan mode.
- Terminal-login `authMethod` shelling `claude auth login`.

---

## 9. Open question — teams × ACP (to discuss next, separate doc)

ACP is **single-agent by design**: one session is one linear conversation with one assistant
voice. openswarm's headline is **N coordinated agents**. ACP has no native multi-agent concept,
so exposing a *team* over ACP requires a deliberate design decision. Two broad directions:

- **(A) Atomic-agent parity** — a session = one openswarm agent. Zed talks to it exactly as it
  talks to Claude/Codex. This is what Stage A ships: low-risk, reuses everything, no protocol
  invention.
- **(B) Orchestrator-as-session** — a session = the team lead; teammate activity is surfaced as
  `tool_call`s (e.g. an `agent`/spawn tool), nested `plan` entries per member, and/or `_meta`
  side-channels. No existing ACP agent does this, so it is unspecified territory — a potential
  differentiator, but it needs its own design pass (how do parallel members map onto one linear
  update stream? how do per-member permission prompts disambiguate? how does git-cascade worktree
  isolation present in an editor?).

This plan ships (A) first and defers (B). The teams×ACP analysis is intentionally **not** resolved
here — it's the subject of the follow-up discussion this doc is paired with.

---

## Key URLs
- <https://agentclientprotocol.com>
- <https://github.com/zed-industries/agent-client-protocol> (`schema/schema.json`, protocol v1)
- npm `@agentclientprotocol/sdk`
- <https://github.com/agentclientprotocol/claude-agent-acp> (npm `@agentclientprotocol/claude-agent-acp`)
- <https://github.com/zed-industries/codex-acp> (npm `@zed-industries/codex-acp`)
- <https://zed.dev/docs/ai/external-agents>
