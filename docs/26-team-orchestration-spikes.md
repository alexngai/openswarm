# Team-orchestration spikes — Track A & Track B

Empirical verification spikes that informed [docs/25-team-orchestration.md](25-team-orchestration.md) §8a (engine-mode parity for team peers).

**Authoring date:** 2026-05-02.
**Status:** complete. Both tracks GREEN.
**Anchor:** [docs/25-team-orchestration.md](25-team-orchestration.md).
**Detailed Track B protocol report:** [docs/26b-spike-track-b-codex-protocol.md](26b-spike-track-b-codex-protocol.md).

---

## TL;DR

Two spikes ran in parallel to determine whether `--framework claude-agent-sdk` and `--framework codex-chatgpt` agents can serve as **true peers in a team** (not just one-shot consultants). Both came back GREEN.

| Track | Question | Verdict | Cost to ship in v0.4 |
|---|---|---|---|
| A | Can `claude-agent-sdk` framework-mode workers use Tier 2 SwarmHost-routed tools (`send_message`, `check_inbox`, `task_stop`, `task_output`, `ask_user_question`) if we don't strip them? | **GREEN** — most work today; 3 pre-existing defects surfaced | ~1d (drop strip + verify) plus ~1.5d (defect fixes) |
| B | Can Codex App Server's `DynamicToolCall` mechanism register openswarm Tier 2 tools as host tools the agent will call? | **GREEN** — full round-trip captured live | ~4d (wire DynamicToolCall + 5 tools through the JSON-RPC pipe) |

**Net:** "true peer teams" are achievable in v0.4 across all three engine modes (transport / claude-agent-sdk / codex-chatgpt). The §8a "framework members can't be peers" constraint in the design draft was wrong; the rewrite reflects empirical reality.

---

## Track A — `claude-agent-sdk` framework-mode peer parity

**Goal:** determine which of the 5 Tier 2 SwarmHost-routed tools that `framework-filter.ts` strips would actually work under `--framework claude-agent-sdk` if we stopped stripping them.

**Method:** spike worktree at `.claude/worktrees/agent-a835be9d41a404060`. Added `SWARM_FRAMEWORK_FILTER_OFF=1` env toggle to `framework-filter.ts`. Built integration test `test/spike-track-a.test.ts` exercising each tool through `dispatcher.dispatch` with a real `WorkerHost` ↔ `StandaloneHost` IPC round-trip. 8 cases, all passing.

### Per-tool findings

| Tool | Status | Notes |
|---|---|---|
| `send_message` | **WORKS** | Drop strip. |
| `check_inbox` | **WORKS** | `WorkerHost.drainInbox` is fully local (line 190-194 of [worker-host.ts](../src/swarm/worker-host.ts)) — no IPC needed for the drain itself. |
| `task_stop` (peer) | **WORKS** with `SWARM_CODER_ALLOW_PEER_TASK_STOP=1` | Default ancestry-only policy needs to be revisited for flat peer teams. |
| `task_stop` (self) | **PARTIAL** — pre-existing transport race | Worker hangs when self-stopping because `kill()` closes transport before response flushes. Not strip-related. |
| `task_output` | **BROKEN** for sub-agent workers | Tool calls `host.task.get(...)` but `StandaloneHost.handleWorkerRequest` has no `task.get` IPC handler. Returns `UNKNOWN_METHOD`. Real defect surfaced by spike. |
| `ask_user_question` | **WORKS** | IPC round-trip plus lane-event observability are complementary. |

### Surprises

1. **The strip is largely vestigial.** The root orchestrator ([cli/main.ts:495](../src/cli/main.ts)) builds its tool list as `[Tier0, Tier1, plugin, MCP]` — Tier 2 tools never enter the list. `framework-filter` is filtering a list that already excludes its targets. The strip becomes load-bearing only when team orchestration mounts Tier 2 on the root (the design we're shipping).

2. **`worker-entry.ts` already runs Tier 2 tools through `ClaudeAgentSdkEngine` by default** for every sub-agent. Whatever happens in framework mode is the SAME code path that happens in `--framework auto`. Q16's "either degrade or don't function" hedging was forward-looking, not empirical.

3. **The dispatcher has no try/catch around `tool.execute()`** ([src/tools/dispatcher.ts:156](../src/tools/dispatcher.ts)). Tools that throw become unhandled rejections. Most Tier 2 tools wrap their I/O; `task_output` and `agent` don't or do incompletely.

### Defects surfaced (must fix before v0.4 ships)

These exist in v0.3; they become visible when teams start exercising Tier 2 tools heavily:

1. **`task_output` broken for sub-agent workers.** Add `task.get`/`task.list`/`task.create`/`task.update` IPC handlers in `StandaloneHost.handleWorkerRequest` for symmetry (closes a wider gap than fixing the tool alone).
2. **Dispatcher should wrap `tool.execute()` in try/catch** to convert thrown exceptions to `{status: "error", message}` results.
3. **`task_stop` self-stop transport race** ([worker-transport.ts:217](../src/swarm/ipc/worker-transport.ts)) — flush response before kill, OR defer kill until after respond returns.

### Recommendation

**Drop the strip; treat framework-mode peers as native team participants.** Default peer-stop policy needs a design decision (see open question below).

### Reproduction

In the spike worktree:

```bash
SWARM_FRAMEWORK_FILTER_OFF=1 bunx vitest run test/spike-track-a.test.ts
```

Expected: `Tests  8 passed (8)`.

### Open question for the design

**Default peer-stop policy.** Today's default is ancestry-only — workers can only stop their descendants. The `SWARM_CODER_ALLOW_PEER_TASK_STOP=1` env flag bypasses the check. For peer teams, peers stopping each other is reasonable (they're co-equal). Right answer is probably:

- Default: peer-stop allowed within the same team scope.
- Cross-scope stop: still ancestry-checked.

The check belongs in `task_stop.ts` or in `StandaloneHost.task.stop` and uses the same scope mechanism §6 introduces.

---

## Track B — Codex App Server `DynamicToolCall` viability

**Goal:** determine whether Codex App Server's experimental `DynamicToolCall` mechanism can be used to register openswarm Tier 2 tools as host tools that the Codex agent will plan against and invoke.

**Method:** captured a full live JSON-RPC round-trip at [test/fixtures/codex-app-server/dynamic-tool-call-spike.jsonl](../test/fixtures/codex-app-server/dynamic-tool-call-spike.jsonl) (129 frames, 41 KB). Single test tool `swarm_ping(content: string) → string` registered at thread start; agent prompted to call it.

### Protocol summary (extracted from captured trace)

**1. Initialize with the experimental capability** (frame 1):

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": {
    "clientInfo": {"name": "openswarm-track-b-spike", "version": "0.0.1"},
    "capabilities": {"experimentalApi": true}
  }
}
```

**2. Register tools at `thread/start`** via the `dynamicTools` array (frame 4):

```json
{
  "jsonrpc": "2.0", "id": 2, "method": "thread/start",
  "params": {
    "model": "gpt-5.4",
    "cwd": "...",
    "approvalPolicy": "never",
    "sandbox": "danger-full-access",
    "experimentalRawEvents": false,
    "dynamicTools": [{
      "name": "swarm_ping",
      "description": "...",
      "inputSchema": {
        "type": "object",
        "properties": {"content": {"type": "string"}},
        "required": ["content"],
        "additionalProperties": false
      }
    }]
  }
}
```

The `dynamicTools` shape matches [test/fixtures/codex-app-server/Tool.ts](../test/fixtures/codex-app-server/Tool.ts):

```ts
export type Tool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonValue;
  outputSchema?: JsonValue;
  annotations?: JsonValue;
  icons?: Array<JsonValue>;
  _meta?: JsonValue;
};
```

**3. When the agent calls a registered tool**, the server sends a JSON-RPC **request** (not a notification — has an `id`) named `item/tool/call` (frame 70):

```json
{
  "method": "item/tool/call", "id": 0,
  "params": {
    "threadId": "019deacd-1d99-...",
    "turnId": "0",
    "callId": "call_XAjMVufWEhTRqwy18YRqMcTb",
    "tool": "swarm_ping",
    "arguments": {"content": "hello"}
  }
}
```

There's also a v1 wrapper notification `codex/event/dynamic_tool_call_request` (frame 69) carrying the same payload — duplicate observable, can be ignored if subscribing to the v2 namespace.

**4. Host responds** (frame 71):

```json
{
  "jsonrpc": "2.0", "id": 0,
  "result": {
    "contentItems": [{"type": "inputText", "text": "pong:hello"}],
    "success": true
  }
}
```

Response shape matches [DynamicToolCallResponse.json](../test/fixtures/codex-app-server/DynamicToolCallResponse.json): `{contentItems: [{type, text|imageUrl}], success: bool}`. Content item types are `inputText` or `inputImage`. For Tier 2 tools that return string output, `inputText` suffices.

**5. Agent receives result and incorporates it** (frame 119): `"The tool returned exactly: \n\n```text\npong:hello\n```"`.

### Latency

Tool-call request sent at `1777760806175`; host response at `1777760806176`. **~1ms round-trip** — IPC overhead only. Total turn took ~3.7s, dominated by model thinking.

### Viability classification: **GREEN**

DynamicToolCall is the right primitive for hosting openswarm Tier 2 tools in codex-mode workers. The lifecycle is standard JSON-RPC request/response over the existing stdio pipe; no protocol invention needed. Response shape (`contentItems` with `inputText`) maps cleanly to openswarm's existing tool result format.

### Implementation cost estimate (v0.4)

| Item | Effort |
|---|---|
| Extend `CodexAppServerProvider` to take a `dynamicTools` argument at thread start | 0.5d |
| Register the 5 SwarmHost-routed Tier 2 tools (+ optionally `agent`/`task_create`/etc. for symmetry) into `dynamicTools` | 0.5d |
| Handler for incoming `item/tool/call` JSON-RPC requests — parse, route to `ToolDispatcher`, format response | 1d |
| Error path: when tool execution fails, return `success: false` with diagnostic in `contentItems` | 0.5d |
| Wire `experimentalApi: true` into the existing `initialize` capabilities | 0.25d |
| Tests: round-trip a registered tool, error path, multi-tool registration | 1d |
| Hook into `framework-filter.ts` so codex framework mode no longer fully strips openswarm tools — only the ones that don't make sense for codex | 0.25d |

**Total: ~4 days.** Risk: low. The protocol is captured; all moving parts are observable.

### Risk register

1. **`experimentalApi: true` may be unstable.** The capability flag name suggests pre-release. Verify against current Codex CLI release notes before ship; pin a tested CLI version.
2. **`gpt-5.4` model dependency persists** ([SPIKE-NOTES.md](../test/fixtures/codex-app-server/SPIKE-NOTES.md): codex-prefixed models are 400-rejected on subscription auth). Already a known constraint; not new.
3. **Codex's own tool surface remains active** — agents in codex framework mode see Codex's `exec`/`apply_patch`/etc. AND openswarm's Tier 2 tools. Verify the agent doesn't get confused; if it does, mitigation is to suppress Codex's surface via a thread/start parameter (need to check protocol for that).
4. **Schema differences between Codex's `Tool` and openswarm's `ToolSpec`.** Codex requires `inputSchema` as JSON Schema; openswarm Tier 2 tools have zod schemas. We already convert via `zod-to-json-schema` (used in [agent.ts:32](../src/tools/tier2/agent.ts)) — same conversion will work here.

### Recommendation

**GO for v0.4.** Wire DynamicToolCall as the standard mechanism for codex peer participation. Defer Codex's native `Collab*` events (still not bridged — they're a different mental model and we don't need them).

### Reproduction

The captured trace is at [test/fixtures/codex-app-server/dynamic-tool-call-spike.jsonl](../test/fixtures/codex-app-server/dynamic-tool-call-spike.jsonl). It's a complete record of the round-trip; future protocol-replay tests can use it as a golden fixture.

To reproduce against a live codex CLI:

```bash
codex --version    # confirm v0.98.0+
codex login        # if not authenticated
# Then implement the v0.4 wiring per the cost estimate above; verify against the captured trace.
```

---

## Decisions to lock in `docs/25-team-orchestration.md` based on these spikes

1. **§8a rewrite** — "framework-mode peers can't coordinate" is wrong. All three engine modes (transport / claude-agent-sdk / codex-chatgpt) can host team peers via three different mechanisms. Document each path with its empirical evidence reference.
2. **§13 phasing** — v0.4 grows from ~3 weeks to ~4 weeks. Add stages for the strip-drop verification (Track A close-out), DynamicToolCall wiring (Track B implementation), and the 3 Track-A defect fixes.
3. **§14.Q8 (Codex as team substrate)** — RESOLVED YES. Move to decision log.
4. **§14.Q9 (mixed-engine consultant)** — stays as a useful complementary feature. With Track B GREEN, the consultant pattern is no longer the *only* way to use codex from a team.
5. **§1 non-goals** — remove "framework-mode peers" from the non-goals list.
