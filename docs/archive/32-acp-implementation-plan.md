# ACP implementation plan — build-ready task breakdown for Stage A

Execution companion to [docs/archive/30-acp-compatibility-plan.md](30-acp-compatibility-plan.md) (Stage A
design) and [docs/31-teams-acp-design.md](../31-teams-acp-design.md) (Stage B). Doc 30 says *what*
single-agent ACP parity ships; this doc says *how* — concrete files, signatures, the shared refactor,
test strategy, and a checkpointed build sequence grounded in the current `src/cli/main.ts` assembly.

**Authoring date:** 2026-06-02.
**Status:** **Stage A shipped** (the `acp --single` surface). This plan is retained as the build record.
**Scope:** Stage A (single-agent ACP). Stage B was subsequently built — see
[docs/archive/33](33-teams-acp-implementation-plan.md)–[36](../36-meta-swarm-convention.md).

---

## 1. The core finding — reuse, don't parallel-build

`runPrompt` ([src/cli/main.ts:169](../../src/cli/main.ts)) already assembles everything ACP needs, and
its two client-specific concerns are **already swappable**:

- **Permission driver.** The `canUseTool` closure ([main.ts:492](../../src/cli/main.ts)) runs the bash
  gate + `permEngine.check()`, then on mode-deny dispatches to **one of two drivers**:
  `readHeadlessApproval(pending)` (headless, [main.ts:539](../../src/cli/main.ts)) or
  `permissionBridge.request(pending)` (TTY, [main.ts:541](../../src/cli/main.ts)). **ACP is a third
  driver** — `client.requestPermission(...)` — selected the same way.
- **Event sink.** `engine.run(config)` yields `AsyncIterable<NormalizedEvent>`, consumed by
  `runHeadless(events)` (headless) or the TUI. **ACP is a third sink** — a translator that emits
  `session/update`.

Everything else — auth, hooks, `ToolDispatcher` + Tier0/plugin/skill/MCP registration, engine
selection, `SessionStore` — is identical. So Step 1 is a **refactor to share it**, then the ACP
subcommand supplies its own driver + sink.

---

## 2. Dependency + new module layout

**Add:** `@agentclientprotocol/sdk` (ACP TS SDK — exports `AgentSideConnection`, `ndJsonStream`,
`nodeToWebReadable/Writable`, and the `Agent` interface + `*Request/*Response` types). *Verify exact
export names at impl time against the installed version; the Claude adapter imports
`AgentSideConnection` + `ndJsonStream`.*

```
src/acp/                         ← new module
  agent.ts          AcpAgent implements the SDK `Agent` interface (session lifecycle)
  translator.ts     NormalizedEvent → SessionUpdate (+ tool-call accumulator, kind/diff tables)
  permission.ts     AcpPermissionDriver — PermissionGate dispatch via client.requestPermission
  capabilities.ts   initialize() response: agentInfo, agentCapabilities, authMethods
  tool-kind.ts      tool-name → ToolKind + locations + diff extraction
  session.ts        per-session state record (engine, dispatcher, abort, sessionId)
  index.ts          runAcp(opts) entry — builds the connection, owns stdout discipline
  *.test.ts         unit tests per module
src/cli/
  acp.ts            thin CLI shim → src/acp/index.ts (mirrors cli/swarm.ts shape)
scripts/
  smoke-acp.sh      scripted ACP-client transcript → asserts frame sequence
```

---

## 3. Step 0 — shared refactor (extract the runtime builder)

Extract `runPrompt` steps 1–7 (auth check, hooks, dispatcher+tools, permission engine, engine
selection, session resolve) into a reusable helper. **No behavior change** — `runPrompt` calls it and
keeps its driver/sink; `runAcp` calls it and supplies ACP's.

```typescript
// src/cli/runtime.ts (new)
export interface AgentRuntime {
  dispatcher: ToolDispatcher;
  tools: readonly ToolImpl[];          // filtered for framework
  permEngine: PermissionEngine;
  auth: AuthSource;
  makeEngine(sessionId: string): AgentEngine;   // defer engine ctor to per-session (ACP)
  hooksConfig: HooksConfigFile;
  mcpClients: McpStdioClient[];         // for clean shutdown
}
export async function buildAgentRuntime(opts: CommonOpts): Promise<AgentRuntime | { error: number }>;
```

Rationale for `makeEngine(sessionId)` rather than a prebuilt `engine`: ACP creates one engine **per
`session/new`**, and `NativeEngine`/prompt-cache key off `sessionId` ([main.ts:440](../../src/cli/main.ts)).
`runPrompt` calls `makeEngine(sessionId)` once; `AcpAgent` calls it per session.

**Acceptance:** existing `runPrompt` tests stay green; the refactor is pure extraction.

---

## 4. Step 1 — CLI wiring

- `src/cli/argv.ts`: add `"acp"` to `SUBCOMMANDS` (line 147); add `{ kind: "acp"; opts: CommonOpts }`
  to `ParsedArgs` (line 80); add a `case "acp"` returning it. The existing `CommonOpts` flags
  (`--model`, `--permission-mode`, `--no-mcp`, etc.) all apply unchanged.
- `src/cli/main.ts`: add `case "acp": return runAcp(parsed.opts);` to the `main()` switch
  ([main.ts:705](../../src/cli/main.ts)).
- `src/cli/acp.ts`: `export const runAcp = (opts) => import("../acp/index.js").then(m => m.runAcp(opts))`
  (lazy import keeps the ACP SDK out of the hot CLI path).

---

## 5. Step 2 — `runAcp` entry + stdout discipline

```typescript
// src/acp/index.ts
export async function runAcp(opts: CommonOpts): Promise<number> {
  redirectConsoleToStderr();                       // console.* → console.error (CRITICAL)
  const rt = await buildAgentRuntime({ ...opts, headless: true });
  if ("error" in rt) return rt.error;
  const stream = ndJsonStream(nodeToWebWritable(process.stdout), nodeToWebReadable(process.stdin));
  const conn = new AgentSideConnection((client) => new AcpAgent(client, rt, opts), stream);
  await conn.closed;                                // resolves on client disconnect
  await shutdown(rt);                               // close MCP clients, flush sessions
  return 0;
}
```

**stdout discipline (§ doc 30 A.1):** `redirectConsoleToStderr()` reassigns
`console.log/info/warn/debug = console.error`. Audit that no code on the ACP path writes to
`process.stdout` except the JSON-RPC stream — `runHeadless` and the stderr `[openswarm] …`
progress lines are fine (stderr), but `--dump-*` paths and any `process.stdout.write` must be guarded.
Add a test that captures stdout during a scripted session and asserts every line parses as JSON-RPC.

---

## 6. Step 3 — `AcpAgent` (session lifecycle)

```typescript
// src/acp/agent.ts — implements the SDK Agent interface
class AcpAgent {
  constructor(private client: AgentSideClient, private rt: AgentRuntime, private opts: CommonOpts) {}
  private sessions = new Map<string, AcpSession>();   // see session.ts

  async initialize(req): InitializeResponse            // → capabilities.ts (§7)
  async newSession(req): { sessionId }                 // make engine, dispatcher scope, AbortController
  async loadSession(req): { /* replay */ }             // A.6 — gated on loadSession cap
  async prompt(req): { stopReason }                    // run a turn (§ below)
  async cancel(req): void                              // trip session.abort
  async authenticate(req): {}                          // no-op / terminal-login (§7)
}
```

**`newSession`** ([doc 30 A.3]): `sessionId = req._meta?.resume ?? crypto.randomUUID()`;
`engine = rt.makeEngine(sessionId)`; store `{ engine, abort: new AbortController(), cwd: req.cwd }`.
Wire `req.mcpServers` into the dispatcher (extend buildAgentRuntime to accept extra MCP configs, or
note as a follow-up — v1 may use only ambient `.mcp.json`).

**`prompt`** — the heart. Per `session/prompt`:
```typescript
const session = this.sessions.get(req.sessionId)!;
const driver = new AcpPermissionDriver(this.client, req.sessionId, this.rt);   // §8
const config: RunConfig = {
  systemPrompt: "", prompt: contentBlocksToText(req.prompt),
  model: this.opts.model ?? DEFAULT_MODEL, auth: this.rt.auth,
  tools: this.rt.tools, canUseTool: driver.gate, permissionMode: this.opts.permissionMode,
  abort: session.abort.signal, hooks: this.rt.hooksConfig,
};
const translator = makeAcpTranslator(this.client, req.sessionId);             // §9
for await (const ev of session.engine.run(config)) {
  await translator.emit(ev);                  // NormalizedEvent → session/update notifications
}
return { stopReason: translator.stopReason() };   // mapped from message_stop / cancelled
```

`contentBlocksToText` flattens ACP `ContentBlock[]` (text + resource_link) into the engine's `prompt`
string; embedded `resource` blocks (if `promptCapabilities.embeddedContext`) inline as context.

---

## 7. Step 4 — capabilities + auth

```typescript
// src/acp/capabilities.ts
export function initializeResponse(req): InitializeResponse {
  return {
    protocolVersion: negotiate(req.protocolVersion),   // echo min(ours, theirs)
    agentInfo: { name: "openswarm", version: VERSION },
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { embeddedContext: true, image: false, audio: false },
    },
    authMethods: [],                                    // env/keychain auth already resolved
  };
}
```

Auth: `buildAgentRuntime` already runs `detectAuth()` and constructs `AnthropicEnvAuth` /
provider auth. So ACP `authMethods` is empty in v1 (the process inherits env/keychain per ToS). The
optional terminal-login method (`claude auth login` passthrough) is a §10 follow-up, not v1.

---

## 8. Step 5 — permission driver

```typescript
// src/acp/permission.ts
class AcpPermissionDriver {
  constructor(private client, private sessionId, private rt: AgentRuntime) {}
  gate: PermissionGate = async (toolName, input) => {
    const impl = this.rt.dispatcher.get(toolName);
    if (!impl) return { allow: false, reason: `unknown tool: ${toolName}` };
    // Reuse the SAME bash gate + mode check as main.ts:498-527 (extract to a shared
    // `evaluateToolPermission()` helper so all three drivers share it).
    const pre = await evaluateToolPermission({ toolName, impl, input, mode: this.rt.permEngine.mode });
    if (pre.decided) return pre.decision;               // bash-block / fast-allow
    const res = await this.client.requestPermission({
      sessionId: this.sessionId,
      toolCall: { toolCallId: makeId(), title: titleFor(impl, input), rawInput: input,
                  ...toolInfo(impl, input) },           // kind/locations from tool-kind.ts
      options: [
        { optionId: "allow_always", name: `Always allow ${impl.spec.name}`, kind: "allow_always" },
        { optionId: "allow",        name: "Allow",  kind: "allow_once" },
        { optionId: "reject",       name: "Reject", kind: "reject_once" },
      ],
    });
    if (res.outcome.outcome === "cancelled") return { allow: false, reason: "cancelled" };
    if (res.outcome.optionId === "reject")   return { allow: false, reason: "denied by user" };
    if (res.outcome.optionId === "allow_always") this.rt.permEngine.allowAlwaysForSession(impl.spec);
    return { allow: true };
  };
}
```

**Shared-helper refactor:** lift main.ts:498–544 (bash gate + mode check + the two-prompt-collapse
logic) into `evaluateToolPermission()` returning either a final decision or "needs prompt." All three
drivers (TTY, headless, ACP) call it, then each renders the prompt its own way. Keeps the gate logic
single-sourced.

---

## 9. Step 6 — the event translator

```typescript
// src/acp/translator.ts
function makeAcpTranslator(client, sessionId) {
  const open = new Map<string, { name: string; jsonParts: string[] }>();   // tool_use_start..end
  let stop: StopReason = "end_turn";
  return {
    async emit(ev: NormalizedEvent) {
      switch (ev.type) {
        case "text_delta":
          return notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: ev.text } });
        case "tool_use_start":
          open.set(ev.id, { name: ev.name, jsonParts: [] });
          if (ev.name === "todo_write") return;                 // handled at result → plan
          return notify({ sessionUpdate: "tool_call", toolCallId: ev.id, status: "pending",
                          ...toolInfoByName(ev.name) });
        case "tool_use_input":  open.get(ev.id)?.jsonParts.push(ev.jsonDelta); return;
        case "tool_use_end": {
          const t = open.get(ev.id); const input = parseJson(t?.jsonParts.join(""));
          if (t?.name === "todo_write") return emitPlan(input);  // → session/update {plan}
          return notify({ sessionUpdate: "tool_call_update", toolCallId: ev.id,
                          status: "in_progress", rawInput: input, locations: locationsFor(t!.name, input) });
        }
        case "tool_result": {
          const content = isEdit(ev) ? [diffBlock(ev)] : [{ type: "content", content: textBlock(ev.content) }];
          return notify({ sessionUpdate: "tool_call_update", toolCallId: ev.toolUseId,
                          status: ev.isError ? "failed" : "completed", content, rawOutput: ev.content });
        }
        case "message_stop": stop = mapStop(ev.stopReason); return;   // + emit usage_update
        case "error":        stop = "refusal"; /* surface as failed tool_call_update or turn note */ return;
        // compaction / cache_hit / cache_miss / hook_event → drop (or _meta in Stage B)
      }
    },
    stopReason: () => stop,
  };
  function notify(update) { return client.sessionUpdate({ sessionId, update }); }
}
```

`tool-kind.ts` owns: name→`ToolKind` (read/edit/search/execute/other per doc 31 §4), `locationsFor`
(path + line from input), and `diffBlock` (for `edit_file` the old/new strings are in the tool input;
for `write_file` synth `{oldText: null, newText: input.content}`). **Note:** the diff `oldText` for
`edit_file` is the matched old string; richer whole-file diffs are a Stage-A-follow-up.

---

## 10. Step 7 — `session/load` (A.6)

Replay prior history as `user_message_chunk` / `agent_message_chunk`. Branch on
`SessionSnapshot.engineId`: SDK-engine history comes from the Claude Agent SDK session store (via the
SDK's message helpers, as `SessionStore` already wraps); NativeEngine reads its own JSONL log. For
v1, replay text + tool-call boundaries in wall-clock order (matches doc 31 Q4's single-agent case —
team replay is Stage B).

---

## 11. Test strategy

| Layer | What | Where |
|---|---|---|
| Unit | translator: each `NormalizedEvent` → expected `session/update` (incl. todo→plan, edit→diff, tool accumulator) | `src/acp/translator.test.ts` |
| Unit | permission mapper: each `requestPermission` outcome → `PermissionDecision`; cancel → deny | `src/acp/permission.test.ts` |
| Unit | tool-kind table + locations + diff synthesis | `src/acp/tool-kind.test.ts` |
| Unit | capabilities/version negotiation | `src/acp/capabilities.test.ts` |
| Integration | `AcpAgent` methods driven directly against a scripted engine | `src/acp/agent.test.ts` |
| **E2E (in-process)** | the SDK's real **`ClientSideConnection`** linked to `AgentSideConnection(AcpAgent)` over a cross-wired `TransformStream` pair; drives initialize→new→prompt and a full `requestPermission` round-trip (allow + reject) | `src/acp/e2e.test.ts` |
| **E2E (subprocess)** | spawns the real `acp` **process**, drives it via `ClientSideConnection` over stdio + `ndJsonStream` (prompt turn; live variant gated by `OPENSWARM_ACP_LIVE`); the truest harness — exercises `runAcp`, stdout discipline, byte framing. Skipped if `bun` is absent | `src/acp/e2e.test.ts` |
| **E2E (live model)** | same harness, real runtime via `buildAgentRuntime`, a real Claude turn ("reply READY"); **gated by `OPENSWARM_ACP_LIVE=1`**, skipped in CI | `src/acp/e2e.test.ts` |
| Smoke | `scripts/smoke-acp.sh`: vitest `src/acp` + a wire run of initialize+session/new asserting pure-JSON-RPC stdout | `scripts/smoke-acp.sh` |
| E2E (editor) | real Zed `agent_servers` entry → manual checklist (doc 30 §7 acceptance) | manual |

The integration test leans on the existing `ScriptedTestEngine` ([src/engine/test-engine.ts](../../src/engine/test-engine.ts))
+ `OPENSWARM_TEST_SCRIPT` so no live API is needed in CI.

---

## 12. Build sequence (checkpointed)

1. **Step 0 refactor** — `buildAgentRuntime` + `evaluateToolPermission` extracted; `runPrompt`
   unchanged behaviorally; all existing tests green. *Checkpoint: `npm test` + `tsc` clean.*
2. **Steps 1–2** — `acp` subcommand parses + dispatches; `runAcp` opens a connection, `initialize`
   round-trips, stdout-discipline test passes. *Checkpoint: scripted client gets an `InitializeResponse`.*
3. **Steps 3+6** — `session/new` + `prompt` + translator stream text & tool calls against
   `ScriptedTestEngine`. *Checkpoint: integration test sees `agent_message_chunk` + a `read`-kind
   `tool_call` + `end_turn`.*
4. **Steps 5** — permission driver: an `edit_file` prompt produces `request_permission` + a `diff`;
   allow/deny both exercised. *Checkpoint: permission integration test green.*
5. **`session/cancel`** — mid-turn cancel returns `cancelled`; next `prompt` works.
   *Checkpoint: cancel-correctness test green.*
6. **Step 7 `session/load`** + **Step 4 capabilities** finalize.
7. **Docs + smoke + real-Zed** — README "ACP" section, Zed config snippet, `scripts/smoke-acp.sh`,
   manual Zed run. *Checkpoint: doc 30 §7 acceptance boxes all checked.*

**Estimate:** Step 0 ≈ 0.5d; Steps 1–6 ≈ 1.5d; load+caps+docs+Zed ≈ 0.5–1d. **~2.5–3d** total,
matching doc 30's estimate.

---

## 13. Stage-B touchpoints (don't build, but don't wall off)

Keep these seams Stage-B-friendly so doc 31 lands without rework:
- **`notify()` is the single emission chokepoint** — Stage B attaches `_meta.swarm` here. Keep all
  `session/update` emission flowing through it (don't scatter `client.sessionUpdate` calls).
- **`makeAcpTranslator(client, sessionId, opts?)`** — leave room for an emission-mode arg
  (collapse/rich, doc 31 §3) and a per-event `member` tag.
- **`AcpPermissionDriver`** — the `title` already carries human-readable context; Stage B adds the
  member prefix + `_meta.swarm.member` (the §6 safety duplication).
- **`AcpAgent.prompt`** — Stage B swaps the single `engine.run` for an orchestrator run whose member
  events fan into the same translator; per-prompt quiescence (doc 31 Q1) decides when to resolve.

---

## Key references
- [docs/archive/30-acp-compatibility-plan.md](30-acp-compatibility-plan.md) (Stage A design + acceptance)
- [docs/31-teams-acp-design.md](../31-teams-acp-design.md) (Stage B; `_meta.swarm`, locked decisions)
- Run-assembly seam: [src/cli/main.ts:169](../../src/cli/main.ts) (`runPrompt`), `:492` (`canUseTool`),
  `:548` (`RunConfig`), `:702` (`main` dispatch)
- npm `@agentclientprotocol/sdk`; reference adapter `@agentclientprotocol/claude-agent-acp`
