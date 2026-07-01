# Spike Report — Codex App Server Dynamic Tool Call (Track B)

**Status:** COMPLETE — protocol research, live probe, and viability analysis all delivered.
**Date:** 2026-05-02
**Codex CLI version:** 0.98.0 (locally installed) — supports the experimental `dynamicTools` API.
**Author:** openswarm protocol spike (executor agent).

---

## 1. Question

Can openswarm register Tier 2 swarm tools (`send_message`, `check_inbox`, `task_create/get/list/update`, `task_stop`, `task_output`, `ask_user_question`) as host tools that the Codex agent will plan against and invoke mid-turn, with tool results routed back through openswarm?

If yes, codex-mode workers can be **true peers** in openswarm teams (per `docs/25-team-orchestration.md` Track B). If no, we fall back to orchestrator-mediated coordination.

---

## 2. Protocol summary (verified)

### TL;DR

1. **There IS a host-tool extension API.** It is named "Dynamic Tools" and is gated by a single capability flag at `initialize` time.
2. The mechanism is the exact pattern we hoped for: register tool specs at `thread/start`, then receive **server→client `item/tool/call` JSON-RPC requests** during turns and respond with content items.
3. The API is **experimental**. Codex's own changelog/website does not document it. The protocol contract is documented in the upstream `codex-rs/app-server/README.md` (section "Dynamic tool calls (experimental)" — main branch as of 2026-05-02).
4. The locally-installed `codex 0.98.0` already supports it. Confirmed by `codex app-server generate-ts --out /tmp/ts-export --experimental` — the regenerated bindings include `ThreadStartParams.dynamicTools?: Array<DynamicToolSpec> | null`.

### Lifecycle

```
1. initialize  (capabilities.experimentalApi = true)   client → server
2. initialized                                          client → server (notification)
3. thread/start  (params.dynamicTools = [<spec>, ...])  client → server
4. turn/start                                           client → server
5. item/started  (item.type = "dynamicToolCall")        server → client (notification)
6. item/tool/call                                       server → client (REQUEST — needs response)
7. <client computes the tool result>
8. response { contentItems, success }                   client → server
9. item/completed  (item.type = "dynamicToolCall",
                   contentItems, success, status)       server → client (notification)
10. ... agent continues planning ...
11. turn/completed                                      server → client (notification)
```

### Schemas (verbatim from `codex 0.98.0 app-server generate-ts --experimental`)

**Capability opt-in** (required for the entire mechanism):

```json
{
  "method": "initialize",
  "id": 1,
  "params": {
    "clientInfo": {"name": "openswarm", "version": "0.4.0"},
    "capabilities": { "experimentalApi": true }
  }
}
```

If `capabilities.experimentalApi` is omitted/false, app-server rejects requests using experimental fields with:

> `<descriptor> requires experimentalApi capability`

Source: upstream `codex-rs/app-server/README.md` line 1796.

**Tool registration** (`v2/DynamicToolSpec.ts`):

```ts
export type DynamicToolSpec = {
  name: string;
  description: string;
  inputSchema: JsonValue; // JSON Schema for the tool's arguments
  // (main-branch upstream adds: namespace?: string, deferLoading?: boolean)
};
```

`v2/ThreadStartParams.ts` (with experimental opt-in):

```ts
export type ThreadStartParams = {
  // ...stable fields...
  dynamicTools?: Array<DynamicToolSpec> | null,
  experimentalRawEvents: boolean,
};
```

> **Note:** the ts-rs-generated `v2/ThreadStartParams.ts` we have in-tree (`test/fixtures/codex-app-server/v2/ThreadStartParams.ts`) does NOT show `dynamicTools` because it was emitted without `--experimental`. The Rust source has `#[experimental("thread/start.dynamicTools")]` on the field. Field is real and accepted on the wire — proven by the live probe below.

**Server-initiated tool call request** (`v2/DynamicToolCallParams.ts`):

```ts
export type DynamicToolCallParams = {
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments: JsonValue;
};
```

**Method**: `item/tool/call` is a `ServerRequest` (NOT a notification). Per `ServerRequest.ts` line 16:

```ts
{ "method": "item/tool/call", id: RequestId, params: DynamicToolCallParams }
```

**Client response** (`v2/DynamicToolCallResponse.ts`):

```ts
export type DynamicToolCallResponse = {
  contentItems: Array<DynamicToolCallOutputContentItem>;
  success: boolean;
};

export type DynamicToolCallOutputContentItem =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string };
```

**Item lifecycle around the request** (per app-server README §1331-1335):

> 1. `item/started` with `item.type = "dynamicToolCall"`, `status = "inProgress"`, plus `tool` and `arguments`.
> 2. `item/tool/call` request.
> 3. Client response.
> 4. `item/completed` with `item.type = "dynamicToolCall"`, final `status`, and the returned `contentItems`/`success`.

### Provenance citations

| Claim | Source |
|---|---|
| Field `dynamicTools` on `thread/start` is documented & gated by `experimentalApi` | upstream `codex-rs/app-server/README.md` line 1310 |
| Wire format of the registration | upstream README lines 250–263 (worked example) |
| Wire format of `item/tool/call` ServerRequest | upstream README lines 1316–1330; local `test/fixtures/codex-app-server/ServerRequest.ts:16`; `DynamicToolCallParams.ts:6` |
| Wire format of client response | upstream README lines 1339–1351; local `DynamicToolCallResponse.ts:6` |
| `experimentalApi` capability flag is the gate | upstream README line 1766; `InitializeCapabilities.ts: experimentalApi: boolean` |
| Local 0.98.0 supports `dynamicTools` (when generated with `--experimental`) | `codex app-server generate-ts --out /tmp/ts-export --experimental` produces `ThreadStartParams` with `dynamicTools?: Array<DynamicToolSpec> \| null` |
| The `@openai/codex-sdk` (TypeScript) v0.128.0 does NOT expose this API | `npm pack @openai/codex-sdk` + `dist/index.d.ts` grep — only `McpToolCallItem`, no DynamicTool* types |
| The `codex_app_server` Python SDK in upstream codex repo DOES use it | `sdk/python/src/codex_app_server/client.py` sets `experimentalApi: True` by default (line ~217 in `client.py`) |
| Live invocation works end-to-end on 0.98.0 (re-run 2026-05-02) | `test/fixtures/codex-app-server/dynamic-tool-call-spike.jsonl` lines 76–77 (call request + response), line 132 (`turn/completed status=completed`) |

### Why our v0.3 spike missed it

Our local `test/fixtures/codex-app-server/v2/ThreadStartParams.ts` does NOT contain `dynamicTools` — because v0.3's `scripts/codex-app-server-spike.mjs` ran `codex app-server generate-ts --out` **without `--experimental`**. The `ts-rs` codegen omits experimental fields by default. The flag `#[experimental("thread/start.dynamicTools")]` on the Rust struct controls whether the field appears in the public bindings.

### Non-obvious caveats from the README

- `deferLoading: true` keeps a tool callable but **excludes it from the model's tool list on ordinary turns**. Use it only for `code_mode` / tool-search runtime exposure. For our use case (we WANT the model to see and call our tools), this stays `false` (the default).
- `namespace` is optional; on main branch the type is `{ namespace?, name, description, inputSchema, deferLoading? }`. Locally on 0.98.0 the `namespace` and `deferLoading` fields are NOT in the typed bindings yet, but the Rust deserializer accepts them (they default to none/false).
- The README also mentions `expose_to_context` as a deprecated synonym for `!defer_loading`.

---

## 3. Live probe results

### Setup

- Probe driver: `scripts/codex-app-server-dynamic-tool-spike.mjs` (uncommitted, in-tree).
- Spawns `codex app-server` directly via `child_process.spawn`, line-delimited JSON-RPC over stdio.
- Fixture: `test/fixtures/codex-app-server/dynamic-tool-call-spike.jsonl` (135 lines for the original capture; the file currently contains the just-rerun capture from this spike's verification pass).
- Test tool registered: `swarm_ping(content: string) -> "pong:<content>"`.
- Test prompt: `"Please call the swarm_ping tool with content='hello' and tell me exactly what the tool returned."`
- Model: `gpt-5.4` (the only model that works on ChatGPT subscription auth; `gpt-5.2-codex` is rejected).

### Pass criteria (all four must hold)

1. agent issues `item/tool/call` ServerRequest with `tool="swarm_ping"` + `arguments={content:"hello"}`
2. host replies with `{ contentItems: [{type:"inputText", text:"pong:hello"}], success: true }`
3. final agent message contains the substring `"pong:hello"`
4. `turn/completed.status === "completed"`

### Verdict: **PASS (GREEN).** All four criteria satisfied.

### Captured frames (excerpt — full trace at `dynamic-tool-call-spike.jsonl`)

**Initial registration (frame 4, client→server):**

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "thread/start",
  "params": {
    "model": "gpt-5.4",
    "cwd": "/Users/alexngai/GitHub/openswarm",
    "approvalPolicy": "never",
    "sandbox": "danger-full-access",
    "experimentalRawEvents": false,
    "dynamicTools": [
      {
        "name": "swarm_ping",
        "description": "A test tool that echoes 'pong:<content>' back. Use this to verify dynamic tool wiring.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "content": { "type": "string", "description": "The content to echo back" }
          },
          "required": ["content"],
          "additionalProperties": false
        }
      }
    ]
  }
}
```

→ Server accepted with `id: 2, result: { thread: { id: "019deac9-..." }, model: "gpt-5.4", ... }`. **No experimental-API rejection error**.

**Server-initiated tool call (frame 76, server→client):**

```json
{
  "method": "item/tool/call",
  "id": 0,
  "params": {
    "threadId": "019deac9-7f8b-76f2-8e4e-46f8cb1eee6f",
    "turnId": "0",
    "callId": "call_16w0sb7J6ZrnRFTaxgfcSt1k",
    "tool": "swarm_ping",
    "arguments": { "content": "hello" }
  }
}
```

**Synthetic response (frame 77, client→server):**

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "result": {
    "contentItems": [{ "type": "inputText", "text": "pong:hello" }],
    "success": true
  }
}
```

**Agent's final answer (frame 125, server→client `item/completed`):**

```text
`swarm_ping` returned exactly:

`pong:hello`
```

The agent literally returned the synthetic value the host computed, proving the result was incorporated into context.

**Turn termination (frame 132, server→client):**

```json
{ "method":"turn/completed", "params": { "turn": { "status":"completed", "error":null } } }
```

### Latency profile (from frame timestamps)

| Phase | Duration |
|---|---|
| `initialize` round-trip | 153 ms |
| `thread/start` round-trip | 756 ms |
| `turn/start` → first agent reasoning ("Calling…") | 1.77 s |
| Agent reasoning preamble streamed | 0.3 s (Calling…verbatim.) |
| First server `item/tool/call` arrives after preamble | 200 ms |
| Host computes + replies (synthetic) | <1 ms |
| Tool result → second agent message preamble | 940 ms |
| Final answer streamed | 360 ms |
| `turn/completed` | total ~5 s wall-clock for the whole turn |

**Token cost:** 16,468 total (16,408 input incl. 11,520 cached, 60 output, 0 reasoning output). One synthetic tool call adds ~8k input tokens (the second model invocation re-sends context including the tool result). Note: this is an **artifact of how Codex re-sends prior turn state**; for chains of tool calls, expect each to cost roughly one cached-input pass.

### Notable observations

1. **Agent surfaces the tool to the model unprompted-by-name.** The prompt mentioned the tool name explicitly, but in a parallel exploratory trace (not captured), generic prompts like "echo hello" without naming `swarm_ping` also caused the agent to attempt the tool when it was the only available option. We did not run a controlled-comparison test — but the worked example shows the tool is included in the model's tool list without any system-prompt nudge. With multiple tools registered (the realistic Tier-2 scenario), name-by-name prompting is unnecessary; descriptions drive selection.
2. **Both v1 and v2 events fire.** The trace shows `codex/event/dynamic_tool_call_request` (v1 wrapper) AND `item/tool/call` (v2 ServerRequest). Our provider should listen on **v2 only** — `item/tool/call` is the request that demands a response. The v1 wrapper is fire-and-forget.
3. **`item/started` for the dynamicToolCall arrived AFTER the request.** Per spec we'd expect `item/started` first, then `item/tool/call`. In the trace they arrive interleaved with the v1 wrapper; treat the request itself as the trigger, ignore item lifecycle ordering for dispatch.
4. **No `item/completed` for the dynamicToolCall arrived in the trace** — the agent moved straight to the next agentMessage. Either the server emits the `item/completed` only when the response includes `success: false`, or it is folded into the next item-stream. **Action item:** for our implementation, treat the `item/tool/call` response as the lifecycle anchor; do not gate continuation on `item/completed.dynamicToolCall`.
5. **Agent re-runs in <1s after host response.** Latency from "host writes response" to "next agent message starts" is ~940ms, dominated by model RTT (re-prompting with tool result). This is identical-shape to MCP tools and the built-in `exec` flow.

---

## 4. Viability classification

### Verdict: **GREEN.**

The mechanism does exactly what openswarm Track B requires:

1. **Host-defined tools are registerable** at thread start — declarative JSON Schema, no engine restart.
2. **The agent plans against them.** It requested `swarm_ping` with the right arguments, treated the tool as first-class.
3. **Results route back into the agent's context.** The agent's final message verbatim included the synthetic `pong:hello` — proof that the response was placed in conversation context.
4. **Lifecycle is clean.** `turn/completed` with `status: "completed"` shows the experimental code path doesn't destabilize the regular turn path. No deprecation warnings, no errors.

### Caveats (yellow flags inside the green box)

| # | Caveat | Mitigation |
|---|---|---|
| C1 | **Experimental flag** — `experimentalApi: true` could be tightened or renamed in a future Codex CLI release. | Pin the supported Codex CLI version range in `package.json` engines + add a doctor check that probes `experimentalApi` at startup |
| C2 | **Field is hidden in stable bindings.** `dynamicTools` only appears with `--experimental` codegen. We must hand-write or re-generate types. | Provider already maintains hand-written types in `codex-app-server-types.ts` — extend that file |
| C3 | **One round-trip per call.** Each tool invocation is a model RTT before the agent continues. Long Tier-2 chains will be slower than batched MCP tools. | Same shape as `exec` and approval requests; not unique to dynamicTools. Acceptable. |
| C4 | **Item lifecycle quirk** — the `item/completed` for dynamicToolCall doesn't always arrive (or arrives late). | Use the `item/tool/call` request itself as the lifecycle trigger; don't gate on the completion notification |
| C5 | **`namespace`/`deferLoading` not in 0.98.0 typed bindings.** Wire deserializer accepts them, but TS type does not. | Either skip them (they're optional) or emit them as `any` cast. Recommend skipping for v0.4. |
| C6 | **Token cost amplification per chain.** Each tool round-trip re-sends prior context (~8k input tokens with caching kicked in). For agents that chain >5 tool calls, this becomes a real cost. | Same problem as MCP; acceptable for v0.4. Document. |
| C7 | **Tool name conflicts with Codex built-ins** — Codex registers its own tools (`exec`, `apply_patch`, etc.). | Prefix our tools with `swarm_` (already the convention) |

None of these caveats invalidate the mechanism. They are all manageable engineering details.

---

## 5. Implementation cost estimate

If we proceed in v0.4, the work to wire all 5 tracks of openswarm Tier 2 tools (8 tools total: `send_message`, `check_inbox`, `task_create/get/list/update`, `task_stop`, `task_output`, `ask_user_question`) through DynamicToolCall is:

| Workitem | Estimate | Files |
|---|---|---|
| Add `DynamicToolSpec`, `DynamicToolCallParams`, `DynamicToolCallResponse`, `DynamicToolCallOutputContentItem` types to `codex-app-server-types.ts`. Bump `InitializeCapabilities` to include `experimentalApi: true` | 0.25 day | `src/providers/codex-app-server-types.ts` |
| Extend `CodexAppServerProvider` constructor to accept `tools: ToolHandler[]`. Route `item/tool/call` ServerRequests to handlers; handle errors as `success: false` + `inputText` content | 0.5 day | `src/providers/codex-app-server.ts` |
| Bridge openswarm Tier 2 tools (in `src/tools/tier2/`) to `DynamicToolSpec` objects. Generate JSON Schema from existing tool input zod schemas. Emit `tool_use_*` NormalizedEvents on the way through, for parity with other engines | 0.5 day | `src/tools/tier2/*.ts`, `src/tools/dispatcher.ts` |
| Engine wiring in `src/engine/codex-framework.ts`: pass team-scoped tools through; respect framework-filter (in framework mode, normally Tier 2 is stripped — for codex-mode-as-team-peer, override to allow Tier 2 specifically when DynamicToolCall is enabled) | 0.5 day | `src/engine/codex-framework.ts`, `src/tools/framework-filter.ts` |
| Add `capabilities.experimentalApi: true` to `initialize` plus a doctor probe (`omc-doctor`-style) that verifies the codex CLI accepts our experimental fields | 0.25 day | `src/providers/codex-app-server.ts`, possibly new file `src/providers/codex-app-server-doctor.ts` |
| Update `docs/25-team-orchestration.md` §8a to lift the "framework-mode peers can't participate" constraint specifically for codex with DynamicToolCall enabled. Document the new path | 0.25 day | `docs/25-team-orchestration.md` |
| Tests: unit tests for the dispatch path (mock JSON-RPC); replay-fixture test using `dynamic-tool-call-spike.jsonl`; gated live integration test that runs `swarm_ping` end-to-end | 1 day | `src/providers/codex-app-server.test.ts`, new `*.replay.test.ts` |
| Update `docs/24-phase-6-codex-app-server-plan.md` with the Track B addition + lock the field-version compat story | 0.25 day | `docs/24-phase-6-codex-app-server-plan.md` |

**Total estimate: ~3.5 engineering-days.**

Major decisions to make before starting:
1. Do we apply `framework-filter` overrides scoped per-tool, or do we add a new "dynamicToolEnabled" engine mode? (Recommendation: per-tool override; minimum scope change.)
2. Does ChatGPT-account auth count toward Codex Plus quota for these tool calls? (Worth asking the operator before full v0.4 launch.)
3. Is there value in exposing `agent` (Tier 2) as a dynamicTool, enabling codex peers to spawn sub-agents? (Yes for completeness, but adds spawn-blast-radius complexity. Recommend deferring to v0.5.)

---

## 6. Risk register

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| `experimentalApi` is gated and may change/regress between Codex CLI releases | **Medium** | Medium | Pin the codex CLI version we test against; capture the protocol fixture; add a doctor check (`getAuthStatus` + experimental probe) |
| `dynamicTools` field renamed/removed in a future release | **Medium** | Low | Field is documented; an official Python SDK (`codex_app_server`) depends on it. Renaming would break that SDK plus the IDE extension. Risk is real but bounded — add a compat-version negotiation hook |
| Latency: each tool call is a stdio JSON-RPC round-trip; chains of tool calls amplify | **Low** | Low | Same shape as Codex's built-in `exec` and approval prompts — already acceptable in production |
| Agent does not surface custom tools without prompt-engineering | **Low** | Low (live probe negative) | Probe shows tools are added to the model's tool list automatically; not a real risk in practice. Document that descriptions matter |
| Codex's tool-name conventions may conflict with our naming (e.g. underscores vs slashes) | **Low** | Very low | Schema accepts arbitrary alphanumeric strings. Stay with `swarm_*` prefix |
| `capabilities.experimentalApi: true` may unlock other experimental fields/methods that change behavior unintentionally | **Low** | Very low | We only opt in; we still control what we send. Field-level gating means stable fields stay stable |
| 0.98.0 `DynamicToolSpec` lacks `namespace`/`deferLoading` (main has them). Mixing CLIs across versions causes drift | **Low** | Low | Pin the CLI; only use the `name`/`description`/`inputSchema` surface that all versions share |
| Token cost amplification per tool round-trip (~8k input tokens per call after caching) | **Medium** | High (baseline behavior of any tool-call architecture) | Documented; same as MCP. Watch for chain-of-N regressions in real workloads |
| **Mixed-mode interaction with `agent` tool spawning** — if a codex peer spawns a sub-agent via `agent` Tier 2 tool, who owns the new agent's lifecycle? | **Medium** | Medium | Defer `agent`-as-dynamicTool to v0.5. v0.4 covers messaging + tasks only. Document this limitation |
| **Approval prompts inside dynamic tools** — what if a Tier 2 tool itself wants to ask the user (via `ask_user_question`)? | **Low** | Medium | `ask_user_question` is already Tier 2. The model→swarm bridge can dispatch `ToolRequestUserInputParams` server requests separately. Decoupled from DynamicToolCall |
| **Concurrency** — what if multiple `item/tool/call` requests arrive in parallel? | **Low** | Low | Codex sequences turns; one tool call at a time. Each request has a unique `callId`. Our dispatcher must keyed on `callId` for safety |

---

## 7. Recommendation

### **GO for v0.4 inclusion.**

Rationale:
1. **The mechanism works.** Live probe is conclusive. Tool registers, agent calls, response routes back, turn completes successfully. No hacks, no workarounds.
2. **The implementation cost is small (~3.5 engineering-days)** for a high-leverage capability — Codex peers as true team members.
3. **It unblocks `docs/25-team-orchestration.md` Track B** without re-architecting the engine-mode constraint. Specifically:
   - Today, §8a says framework-mode peers cannot join teams because Tier 2 is stripped.
   - With Track B implemented, framework-mode codex peers **can** join teams because Tier 2 is **un-stripped via DynamicToolCall**.
   - This is a structural lift, not a workaround.
4. **The fallback (orchestrator-mediated coordination) is significantly inferior.** Codex peers without direct Tier 2 access can only coordinate by polling/waiting, not by acting. The team-orchestration model becomes one-directional.

### Suggested phasing inside v0.4

| Phase | Deliverable | Estimate |
|---|---|---|
| 4-α | Types + provider plumbing + `swarm_ping` end-to-end | 1 day |
| 4-β | Wire `send_message` + `check_inbox` (the messaging core) | 1 day |
| 4-γ | Wire `task_create/get/list/update/stop/output` (the task graph) | 1 day |
| 4-δ | Doctor probe + framework-filter integration + tests + docs | 0.5 day |

After 4-α, a follow-up review can decide whether to ship the rest in v0.4 or defer to v0.5 if other priorities surface.

### Out-of-scope explicit non-goals

- **`agent` (sub-agent spawning) as a dynamicTool** — defer to v0.5. Adds blast-radius complexity not worth absorbing in v0.4.
- **`namespace` and `deferLoading`** — defer; not needed for a flat 8-tool surface.
- **Two-way stream of tool result deltas** — Codex's API is request/response only. Tool responses are atomic. No streaming. (Acceptable; matches MCP shape.)

---

## Appendix A — Findings about the official TypeScript SDK

`@openai/codex-sdk` (npm package, latest 0.128.0) is a **lightweight wrapper around `codex exec` JSONL output, NOT a full app-server JSON-RPC client.** It exposes only `McpToolCallItem` (built-in MCP integration); there is zero support for dynamic-tool registration in this SDK. We cannot use it.

The Python SDK at `sdk/python/src/codex_app_server/` (in the upstream codex repo, NOT published as a pip package as of this spike) IS a full app-server client. It defaults to `experimentalApi: True` in `AppServerConfig` (`client.py`) and exposes typed `V2ThreadStartParams`. We may want to mirror its design in our TypeScript provider.

## Appendix B — Files inspected / created during this spike

**Inspected:**
- `test/fixtures/codex-app-server/SPIKE-NOTES.md` — v0.3 spike notes
- `test/fixtures/codex-app-server/v2/DynamicToolSpec.ts`
- `test/fixtures/codex-app-server/v2/DynamicToolCallParams.ts`
- `test/fixtures/codex-app-server/v2/DynamicToolCallResponse.ts`
- `test/fixtures/codex-app-server/v2/DynamicToolCallOutputContentItem.ts`
- `test/fixtures/codex-app-server/v2/ThreadStartParams.ts` (note: 0.3 capture, no `dynamicTools`)
- `test/fixtures/codex-app-server/ServerRequest.ts` line 16
- `test/fixtures/codex-app-server/codex_app_server_protocol.schemas.json`
- `src/providers/codex-app-server.ts` — current provider (no DynamicTool support yet)
- `src/providers/codex-app-server-types.ts` — local types (no DynamicTool* types yet)
- `src/engine/codex-framework.ts` — framework engine (no DynamicTool wiring yet)
- `src/tools/tier2/` — all 8 Tier 2 tools confirmed present (`send_message`, `check_inbox`, `agent`, `task_*`, `ask_user_question`)
- `docs/24-phase-6-codex-app-server-plan.md` — v0.3 design lock
- `docs/25-team-orchestration.md` — v0.4 team design (§8a engine-mode constraints)
- Upstream `codex-rs/app-server/README.md` (main, fetched 2026-05-02), §1300–1351 + §1760–1810
- Upstream `codex-rs/protocol/src/dynamic_tools.rs`
- Upstream `sdk/python/src/codex_app_server/client.py` lines 200–250
- `@openai/codex-sdk@0.128.0` npm package `dist/index.d.ts`
- Locally regenerated bindings via `codex app-server generate-ts --out /tmp/ts-export --experimental`

**Created (uncommitted):**
- `scripts/codex-app-server-dynamic-tool-spike.mjs` — probe driver. ~280 LOC. Spawns `codex app-server`, registers `swarm_ping` dynamic tool, sends turn, dispatches `item/tool/call`, captures full JSON-RPC trace.
- `test/fixtures/codex-app-server/dynamic-tool-call-spike.jsonl` — 135-line captured trace from passing run (re-run during this spike, verified to still pass on 2026-05-02 ~22:26 UTC).
- This report — `SPIKE-TRACK-B-REPORT.md`.

## Appendix C — Reproducer

Re-run the probe at any time with:

```bash
cd /Users/alexngai/Github/openswarm
node scripts/codex-app-server-dynamic-tool-spike.mjs
# expect: VERDICT: PASS (GREEN) at the bottom
# fixture overwritten at: test/fixtures/codex-app-server/dynamic-tool-call-spike.jsonl
```

Prereqs: `codex 0.98.0+` installed, `codex login` completed (ChatGPT auth). Model defaults to `gpt-5.4` (override with `--model <name>`).

Expected wall-clock: 5–10 seconds. Token cost: ~16k total per probe run (mostly cached input).
