# M1 Minimum Viable Swarm — Implementation Plan

**Status:** draft — revision 2 (post-critic review 2026-04-20)
**Owner:** alex
**Created:** 2026-04-20
**Prereq:** M0 complete (tag `m0-complete`)
**Refines:** §"Milestone M1 — minimum viable swarm" in `docs/07-implementation-plan.md`

## Scope

Turn M0's atomic agent into a coordinated swarm: one orchestrator process spawns N subprocess workers, each running a `ClaudeAgentSdkEngine`, fans out a task list, and collects results. Workers can also spawn nested sub-agents (full recursive swarm, subject to a depth limit).

**In scope:**
- `SwarmHost` interface with `StandaloneHost` + `WorkerHost` implementations
- Subprocess spawn machinery with env inheritance
- In-memory `TaskRegistry` owned by the orchestrator; accessed by workers via IPC
- Tier 2 tools: `agent`, `task_create`, `task_update`, `task_get`, `task_list`
- Lane event catalog port from `docs/research/05-swarm.md` §5 (names and failure taxonomy)
- `swarm-harness swarm run tasks.jsonl --concurrency N` CLI subcommand
- `results.jsonl` output stream (append-as-complete)
- Real-subprocess integration tests with mocked-SDK child process
- `scripts/smoke-swarm.sh` live-API gate (optional, like M0's `smoke.sh`)

**Out of scope (explicit):**
- `send_message`, `check_inbox`, `task_stop`, `task_output` (Tier 2 remainder → M3)
- Git coordination (`branch_lock`, `stale_base`, `stale_branch`) → M3
- Team roles, cron, retry policies → M3 / M5+
- Remote triggers
- Per-worker git worktree isolation (shared cwd for M1; worktree lands with M3 git coord)
- File-backed TaskRegistry (in-memory only; persistence arrives with retry in M3)
- **Worker-state file** at `.swarm-harness/workers/<agentId>.json` → M3 alongside file-backed TaskRegistry. `docs/05-swarm-model.md` §2.3 describes it, but it's not needed for M1's in-memory model.
- Plugins / skills / MCP-beyond-engine (M2)

## Decision context

Planning informed by M0 learnings + four locked decisions (see prompt interview):

1. **Shared cwd across workers.** All workers inherit the orchestrator's cwd. Write conflicts avoided via disjoint-target task design and Tier 0 tools' atomic-rename semantics.
2. **In-memory TaskRegistry.** Lost on orchestrator crash; user reruns the whole swarm. Recovery is M3.
3. **Full recursive swarm.** `agent`, `task_create`, `task_update`, `task_get`, `task_list` are available to both orchestrator and workers. Workers route spawn + task requests via `WorkerHost` IPC to the orchestrator, which owns the single source of truth.
4. **Real-subprocess + mocked-SDK tests.** Integration tests actually fork Node children that run a scripted test engine (no API calls), exercising the JSONL wire protocol end to end.

## Acceptance criteria

Each is executable with a one-line test harness.

1. `swarm-harness swarm run tasks.jsonl --concurrency 3` parses a JSONL task file, spawns workers, exits 0 when all complete.
2. With a 10-task file and `--concurrency 3`: at most 3 worker subprocesses alive at any instant. **Verification:** the orchestrator's internal `WorkerPool` instruments `activeCount`; test asserts `activeCount <= concurrency` at 10ms sampling intervals. `ps` sampling is a secondary sanity check, not the primary gate.
3. Each task reaches a terminal state (`succeeded` | `failed` | `timeout` | `cancelled`) — never orphaned `pending` / `running` on orchestrator exit. Every task in the input file gets a terminal state record in `results.jsonl`; internal registry state alone is insufficient.
4. `results.jsonl` has one line per input task with `{id, status, output?, error?, usage, wallClockMs, agentId, sessionId, completedAt}`. `completedAt` is epoch-ms at which the orchestrator received `task_result`. Consumers that require stable ordering sort by `completedAt` after read (the write order is a valid interleaving of completions, not a stable order on simultaneous finishes).
5. Orchestrator exit code 0 if every task `succeeded` AND `resultWriteFailures === 0`; non-zero otherwise.
6. `Ctrl-C` (SIGINT) on the orchestrator: broadcasts shutdown notification, 5s grace, SIGTERM, 5s grace, SIGKILL. Any remaining tasks in the queue are marked `cancelled`.
7. External `kill -9 <worker>` surfaces in the orchestrator event stream as `worker_crashed`; pending requests to that worker reject with `transport_closed`; task status transitions to `failed`. Orchestrator continues with remaining tasks.
8. `agent` tool from within a worker spawns a sub-agent via `WorkerHost.spawn`. Sub-agent's lane events relay back up through the parent worker's JSONL to the orchestrator; parent's `await agent.wait()` resolves with the sub-agent's `AgentResult`. All events carry `parentToolUseId` matching the `agent` tool-use id in the parent's transcript.
9. Recursion depth limit: fourth-level nested spawn rejects with `{ status: "error", message: "recursion depth limit reached (<MAX_DEPTH>)" }` — no fork bomb. **Authoritative:** orchestrator computes depth from its own agent map; a worker sending `SpawnRequest.depth: 0` cannot bypass the limit.
10. `task_create` / `task_update` / `task_get` / `task_list` from any agent (orchestrator or worker) hit the orchestrator's registry via IPC; semantics match the `SwarmHost.task` interface in `src/swarm/host.ts`.
11. **(11a)** Worker environment inheritance — unit-testable: `SWARM_HARNESS_AGENT_ID`, `SWARM_HARNESS_PARENT_PID`, `SWARM_HARNESS_ORCHESTRATOR_PID`, `SWARM_HARNESS_DEPTH`, and (when spawned from the `agent` tool) `SWARM_HARNESS_PARENT_TOOL_USE_ID` are set in the child process env. Verified by a test-mode worker that echoes its env back via IPC.
    **(11b)** Auth inheritance — live-smoke only, covered by AC #15: the SDK inside the child can reach a valid Anthropic credential (env `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` or keychain). Not unit-testable without API calls.
12. `npx tsc --noEmit` passes strict mode.
13. `npm test` runs ≥ 30 new M1 tests (in addition to M0's 218), all passing.
14. **≥ 5 real-subprocess integration tests** spawn an actual `node` child running `--worker` mode against a scripted test engine and assert the orchestrator's JSONL output. See Phase 7.3 for the scenario list.
15. `scripts/smoke-swarm.sh` (live API) fans out a 3-task script, all 3 complete, results.jsonl parses correctly.

## Implementation steps

### Phase 0 — Interface refinements (~0.5 day)

Edits surfaced by the nested-spawn decision + the critic revision.

0.1. `src/swarm/host.ts` — add `depth: number` and `parentAgentId?: AgentId` to `SpawnRequest`. Add `readonly depth: number` to `SwarmHost` itself. Default depth 0 for `StandaloneHost` and derived authoritatively (see 0.4), not from any field on an incoming request.

0.2. `src/swarm/host.ts` — `SpawnRequest.taskId?: string` so a spawn can reference an existing registered task (orchestrator registers the spawned sub-agent's work under an existing task id rather than always creating a fresh one).

0.3. `src/swarm/events.ts` — confirm the lane-event catalog covers everything we'll emit. Add if missing: `spawn_requested`, `spawn_completed`, `recursion_limit_hit`, `worker_stuck`, `worker_ready`, `heartbeat`.

0.4. **Authoritative depth enforcement.** `StandaloneHost` maintains `Map<AgentId, number>` tracking each live agent's depth. On `spawn()` — whether called locally or dispatched via IPC from a `WorkerHost` — the orchestrator **computes** `childDepth = parentDepth + 1` from its own records. The `depth` field on an incoming `SpawnRequest` is **ignored** (client-supplied values may be stale, lying, or hallucinated). `SpawnRequest.depth` becomes output-only — orchestrator sets it on the way to the child's env. This is defense-in-depth: no worker (even a malicious one) can bypass `MAX_DEPTH`.

0.5. **`parentToolUseId` propagation.** Add `SpawnRequest.parentToolUseId?: string`. The `agent` tool (Phase 6.1) captures the `toolUseId` from its own MCP handler invocation (exposed by the Agent SDK in the `extra` argument to the tool handler) and passes it as `parentToolUseId` on the spawn request. The orchestrator propagates to the child via env var `SWARM_HARNESS_PARENT_TOOL_USE_ID`. The child worker's event translator stamps this id on every emitted `NormalizedEvent` / lane event, so the orchestrator's merged stream can attribute sub-agent events to the invoking tool_use in the parent's transcript.

### Phase 1 — Dependencies (~0.1 day)

1.1. No new deps. Roll our own minimal internal `WorkerPool` class (~50–70 LOC with semaphore + promise queue + graceful drain). Keeps the dep count steady; easier to reason about than `p-limit`.

1.2. `node:child_process`, `node:readline`, `node:events`, `node:crypto` are stdlib.

### Phase 2 — TaskRegistry + task_* tools (~1.5 days)

2.1. `src/swarm/task-registry.ts` — `TaskRegistry` class. `Map<string, TaskRecord>` backed. Methods:
  - `create(packet: Omit<TaskPacket, "id">): TaskRecord` — auto-assign id
  - `get(id: string): TaskRecord | undefined`
  - `list(filter?: TaskFilter): readonly TaskRecord[]`
  - `update(id, patch): void`
  - `emit(event: LaneEvent): void` — for observers (orchestrator's results emitter)
  All methods are synchronous. Node is single-threaded; async boundaries exist only at IPC serialization. No locks required.

2.2. `src/tools/tier2/` — five tool files. Each uses Zod schema + the `SwarmHost.task` API at execution time. Tools do NOT talk to TaskRegistry directly — they dispatch via `ctx.host.task.*`.
  - `task_create.ts`, `task_update.ts`, `task_get.ts`, `task_list.ts`, `agent.ts`
  - `index.ts` factory: `buildTier2Tools(host: SwarmHost): ToolImpl[]`

2.3. Extend `ToolExecutionContext` (in `src/tools/types.ts`) with an optional `host?: SwarmHost`. Tier 2 tools require it non-null at execution time. Add a helper `src/tools/tier2/require-host.ts`:
```ts
export function requireHost(
  ctx: ToolExecutionContext,
  toolName: string,
): SwarmHost {
  if (!ctx.host) {
    throw new Error(
      `${toolName} requires SwarmHost; this binary was invoked without swarm support`,
    );
  }
  return ctx.host;
}
```
All Tier 2 tools use this helper at execute-entry. The CLI always constructs a `StandaloneHost` (even for single-agent `prompt` runs), so M1's CLI carries Tier 2 in both standalone and swarm modes — standalone users can use `agent` for local recursion too.

2.4. Unit tests per tool using a fake `SwarmHost` that records calls. Minimum 3 tests per tool; 15 tests total.

2.5. `TaskRegistry` unit tests: create returns unique ids, update merges patches, list filters correctly, get-unknown returns undefined. Minimum 6 tests.

### Phase 3 — IPC protocol + transports (~4 days)

The load-bearing phase. Revised from 2.5 days after the critic flagged hidden complexity in handshake, pending-request lifecycle, and backpressure.

3.1. `src/swarm/ipc/protocol.ts` — wire-format TypeScript types:

```ts
/** Every IPC frame is one line of JSON on stdio. */
export type IpcFrame = IpcRequest | IpcResponse | IpcNotification;

export interface IpcRequest {
  readonly kind: "request";
  readonly id: string;         // correlation id (crypto.randomUUID)
  readonly method: string;     // "run" | "spawn" | "task.create" | "task.update" | "task.get" | "task.list" | "shutdown"
  readonly params: unknown;
}

export type IpcResponse = IpcOk | IpcErr;
export interface IpcOk {
  readonly kind: "response";
  readonly id: string;
  readonly ok: true;
  readonly result: unknown;
}
export interface IpcErr {
  readonly kind: "response";
  readonly id: string;
  readonly ok: false;
  readonly error: { code: string; message: string };
}

export interface IpcNotification {
  readonly kind: "notification";
  readonly method: string;     // "worker_ready" | "lane_event" | "heartbeat" | "task_result" | "sub_agent_event" | "sub_agent_result"
  readonly params: unknown;
}
```
All request methods, their params types, and their result types centralized here. SDK types never leak across the wire.

3.2. `src/swarm/ipc/worker-transport.ts` — runs inside the **orchestrator**. Wraps one `child_process.ChildProcess`:
  - Reads stdout line-by-line (readline), parses IpcFrame, dispatches.
  - Pending-request map: `Map<string, { resolve, reject, timer }>`.
  - `send(method, params, { timeoutMs = 60_000 } = {}): Promise<result>` — sends request, awaits response. Per-request timer rejects with `{ code: "request_timeout", message: "request <method> timed out after <ms>ms" }`.
  - On `ChildProcess.close` event: iterate pending-request map, reject every entry with `{ code: "transport_closed", message: "worker exited before response" }`. No orphaned promises.
  - Emits events for notifications (`on("worker_ready", ...)`, `on("lane_event", ...)`, `on("heartbeat", ...)`, `on("task_result", ...)`).
  - `kill(signal)` and `waitForExit(): Promise<{code, signal}>`.

3.3. `src/swarm/ipc/parent-transport.ts` — runs inside the **worker**. Wraps `process.stdin` / `process.stdout`:
  - Reads parent's stdin for responses and shutdown notifications.
  - `send(method, params): Promise<result>` — sends request to parent, awaits response. Same per-request timeout + `transport_closed` cleanup rules as 3.2.
  - `notify(method, params)` — one-way emission.
  - **Backpressure + bounded outbound queue.** `send()` and `notify()` return `Promise<void>`; resolve only after `process.stdout.write()` returns `true` OR the `drain` event fires. Queue cap: 1 MiB. When full:
    - Low-priority notifications (`lane_event`, `heartbeat`) dropped with a stderr warning: `"[swarm-harness] worker outbound queue full; dropping <method>"`.
    - High-priority frames (`task_result`, `worker_ready`, request frames awaiting responses) block — never dropped.
  - **Heartbeat.** Every 30s the worker emits `{ kind: "notification", method: "heartbeat", params: { agentId, ts } }`. Orchestrator tracks `lastHeartbeatAt` per agent; missing 3 consecutive heartbeats (90s) → `worker_stuck` event logged and SIGTERM sent. Soft signal in M1; hard detection lands in M3.
  - Correlation-id matching for responses.

3.4. Shared: `src/swarm/ipc/correlation.ts` — id generation via `crypto.randomUUID()` (Node ≥ 18). 128-bit collision-free.

3.5. `src/swarm/ipc/framing.ts` — line-delimited JSON encode/decode with defensive handling:
  - Malformed lines → log to stderr, skip (don't crash the transport).
  - Partial lines at EOF → discard.
  - Max frame size cap (10 MiB) to prevent OOM on hostile input.

3.6. Unit tests for transport + framing: round-trip request/response, correlation matching, malformed line handling, per-request timeout, concurrent requests, **crash-mid-request rejects pending promise within 100ms**, **sustained high-rate emission with slow consumer does not exceed 1 MiB memory** (backpressure test).

3.7. **Worker lifecycle protocol.** The exact sequence a worker follows from spawn to exit:

1. Orchestrator `child_process.spawn` → child runs `node dist/cli.js --worker --agent-id=<id>`.
2. Child opens `ParentTransport` on stdin/stdout.
3. Child emits unsolicited `{ kind: "notification", method: "worker_ready", params: { agentId, depth, pid } }`.
4. Orchestrator's `WorkerTransport` awaits `worker_ready` (10s timeout; timeout → kill child + mark task `failed: "worker_ready_timeout"`) **before** issuing any request.
5. Orchestrator issues `{ kind: "request", method: "run", params: TaskPacket }`.
6. Worker responds immediately with `{ kind: "response", ok: true, result: { accepted: true } }` (before starting execution) so the orchestrator's `send()` promise resolves deterministically.
7. Worker begins the engine run. Emits `lane_event` notifications throughout (including `heartbeat` every 30s).
8. Worker emits final `{ kind: "notification", method: "task_result", params: AgentResult }` when done.
9. Worker exits 0 (success) or 1 (failure).

**Task packet delivery is IPC-only.** There is no `--task-file` or env-var delivery path for the task packet. The `--task-id` flag is used only for logging / diagnostics.

### Phase 4 — Subprocess spawner + WorkerHost + StandaloneHost (~2 days)

4.1. `src/swarm/subprocess-spawner.ts` — `spawnWorker(request: SpawnRequest): ChildProcess`:
  - Uses `child_process.spawn` with:
    - `process.execPath` (this node binary)
    - argv: `[dist/cli.js, --worker, --agent-id=<id>]`
    - `cwd`: `process.cwd()` (shared)
    - `stdio`: `["pipe", "pipe", "inherit"]` (stdout is JSONL, stderr passes through to console for debugging)
    - `env`: inherits `process.env` + overrides:
      - `SWARM_HARNESS_AGENT_ID` — `crypto.randomUUID()`; stable for worker's lifetime; never reused.
      - `SWARM_HARNESS_PARENT_PID`: `process.pid`
      - `SWARM_HARNESS_ORCHESTRATOR_PID`: top-level orchestrator pid
      - `SWARM_HARNESS_DEPTH`: authoritative child depth (computed by orchestrator per §0.4)
      - `SWARM_HARNESS_PARENT_TOOL_USE_ID`: optional; set only when spawned from the `agent` tool (per §0.5)
      - `SWARM_HARNESS_TEST_SCRIPT`: optional path for tests
      - *(note: `SWARM_HARNESS_SESSION_ID` is NOT set — resume is out of M1 scope; the SDK assigns a fresh session id per `query()` call)*
    - `detached: false` — on POSIX, parent death closes stdio and most child writes hit EPIPE. Combined with the orchestrator's exit-handler SIGKILL sweep (defined in Phase 5.1 + Risk table) this reliably reaps workers on crash. On Windows, only the SIGKILL sweep reaps; Windows support is best-effort for M1; document in README.

4.2. `src/swarm/standalone-host.ts` — `StandaloneHost implements SwarmHost`:
  - Used by the top-level CLI when there's no parent.
  - Maintains `Map<AgentId, number>` (authoritative depth map per §0.4).
  - `spawn()` subprocess-spawns via `subprocess-spawner.ts`; returns AgentHandle wrapping a `WorkerTransport`.
  - `task`: holds reference to the in-process TaskRegistry.
  - `emit(event)` → writes to TaskRegistry observer + forwards to `results.jsonl` emitter.
  - `inbox()` / `send()` → no-op in M1 (deferred to M3).
  - Handles incoming spawn requests from worker transports (nested spawn): looks up requesting agent's depth, computes child depth, rejects if at limit, otherwise spawns.

4.3. `src/swarm/worker-host.ts` — `WorkerHost implements SwarmHost`:
  - Used inside a worker subprocess.
  - `spawn()` → sends `{ kind: "request", method: "spawn", params: SpawnRequest }` to parent. Waits for response. Returns AgentHandle that proxies to parent for `wait`/`kill`/`events`.
  - `task.*` → proxies each call as a request to parent.
  - `emit(event)` → sends `{ kind: "notification", method: "lane_event", params: event }` to parent.
  - `inbox()` / `send()` → M3.

4.4. `src/cli/worker-entry.ts` — the `--worker` mode entrypoint:
  - Opens `ParentTransport` on stdin/stdout.
  - Emits `worker_ready` notification immediately.
  - Awaits `run` request from parent (delivers task packet via IPC per §3.7).
  - Instantiates `WorkerHost` wrapping the `ParentTransport`.
  - Builds Tier 0 + Tier 2 tools (Tier 2 tools use `ctx.host = workerHost`).
  - Runs `ClaudeAgentSdkEngine` (or `ScriptedTestEngine` if `SWARM_HARNESS_TEST_SCRIPT` is set).
  - Stamps every outbound event with `parentToolUseId` (if `SWARM_HARNESS_PARENT_TOOL_USE_ID` is set) per §0.5.
  - Emits lane events throughout; emits heartbeats every 30s.
  - On engine completion: sends `task_result` notification, closes transport, exits 0/1.

4.5. `src/cli/argv.ts` — add `--worker`, `--agent-id=<id>` flags (internal — not advertised in `--help`).

4.6. `src/cli/main.ts` — route `--worker` to `worker-entry`. Top-level `swarm` subcommand routes to the orchestrator (Phase 5). CLI `prompt` continues to work; now instantiates a `StandaloneHost` so Tier 2 tools are available (per §2.3).

### Phase 5 — Orchestrator + swarm CLI (~1.5 days)

5.1. `src/swarm/orchestrator.ts` — `Orchestrator` class:
  - Constructor takes `{ concurrency, permissionMode, resultsOut: WritableStream, eventsOut: WritableStream }`.
  - `run(tasks: TaskPacket[]): Promise<{succeeded, failed, timeout, cancelled}>` — the main fan-out.
  - Internal `WorkerPool` with `activeCount` instrumentation (for AC #2 testability).
  - For each task: queue → pool acquires a slot → spawn worker → wait for `worker_ready` → `transport.send("run", task)` → await `task_result` notification → release slot → append to `results.jsonl`.
  - Handles incoming spawn requests from workers (nested): spawns a sub-worker via the same machinery, relays events up, returns result.
  - **Results write-failure handling.** On `results.jsonl` write error callback: emit `error` lane event via `eventsOut`, log to stderr `"[swarm-harness] failed to persist result for task <id>: <err>"`, increment `resultWriteFailures`. On first write failure: stop accepting new results, drain remaining workers to completion, exit non-zero with summary `"N task results failed to persist"`.
  - **SIGTERM → SIGKILL escalation.** Unified policy for all shutdown paths (SIGINT, internal timeout, crash):
    1. Broadcast `shutdown` notification to all live workers.
    2. 5s grace.
    3. SIGTERM to survivors.
    4. 5s grace.
    5. SIGKILL the remainder.
    Remaining queued tasks marked `cancelled` in `results.jsonl`.
  - **Exit-handler SIGKILL sweep.** `process.on("exit")` handler iterates the pool's live children and `process.kill(pid, 'SIGKILL')` each one. Note: `exit` handlers are synchronous-only — can only issue signals, can't await. Graceful shutdown paths (SIGINT/SIGTERM) handle the full escalation before reaching `exit`.

5.2. `src/cli/swarm.ts` — `swarm run <tasks-file> [--concurrency N]` subcommand:
  - Parses tasks.jsonl (one TaskPacket per line, validated via Zod).
  - Creates Orchestrator with `results.jsonl` write stream at `./results.jsonl` (overridable via `--output <path>`).
  - Runs to completion; prints summary; exits 0/non-zero.

5.3. `src/cli/argv.ts` — add `swarm` subcommand + `run` sub-subcommand + flags (`--concurrency`, `--output`, `--permission-mode`).

5.4. `src/cli/main.ts` — route `swarm` subcommand.

5.5. Orchestrator unit tests: worker pool capping (`activeCount <= concurrency` asserted at 10ms sampling intervals), result streaming, SIGINT → SIGTERM → SIGKILL escalation, worker-crash recovery, **`results.jsonl` write failure surfaces as error event + non-zero exit** (simulated via an EBADF file descriptor). Minimum 6 tests.

### Phase 6 — Agent tool + nested spawn (~1.5 days)

Tie the pieces together.

6.1. `src/tools/tier2/agent.ts` — the `agent` tool implementation. Zod schema:
```ts
z.object({
  prompt: z.string(),
  model: z.string().optional(),
  permissionMode: z.enum(["read-only","workspace-write","danger-full-access"]).optional(),
  maxTurns: z.number().int().positive().optional(),
  wait: z.boolean().optional().default(true),
})
```
Behavior:
  - `const host = requireHost(ctx, "agent")`.
  - **Permission mode clamping.** If `input.permissionMode` is more permissive than the parent's mode, clamp to parent's: `read-only` ⊂ `workspace-write` ⊂ `danger-full-access`. Sub-agents cannot escalate.
  - Creates a task via `host.task.create(...)`.
  - Calls `host.spawn({ task, permissionMode: clamped, parentToolUseId: ctx.toolUseId, ... })`. `depth` is NOT passed by this tool — the orchestrator computes it authoritatively per §0.4.
  - Orchestrator's depth check: if `childDepth > MAX_DEPTH` (default 3, override via `SWARM_HARNESS_MAX_DEPTH`), rejects with `{ status: "error", message: "recursion depth limit reached (<MAX_DEPTH>)" }`. Error message interpolates the runtime limit so tests using override values don't flap.
  - If `wait === true`: awaits `handle.wait()`, returns the sub-agent's result as tool output.
  - If `wait === false`: returns the agent id + task id; caller polls via `task_get`.
  - Permission: `requiredPermission: "exec"` — this is a side-effect that creates subprocess work.
  - The SDK's tool handler `extra` argument exposes `toolUseID` (confirm by re-reading `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` before wiring); we capture it and pass as `parentToolUseId`.

6.2. `src/cli/main.ts` — when building the top-level runtime: instantiate `StandaloneHost`, register Tier 0 + Tier 2 tools. CLI `prompt` carries Tier 2 too — standalone runs can use `agent` for local recursion.

6.3. `src/swarm/depth-limit.ts` — `DEFAULT_MAX_DEPTH = 3` constant, override via `SWARM_HARNESS_MAX_DEPTH` env. The enforcement happens inside `SwarmHost.spawn()` impls (per §0.4) using the orchestrator's authoritative depth map — NOT inside the tool. The `agent` tool is advisory; the host is the gate.

6.4. Integration tests:
  - 3 levels of nesting succeed (depth 0 → 1 → 2 → 3).
  - 4th level rejected with the expected error shape.
  - **Adversarial test:** worker sends `SpawnRequest.depth: 0` from depth-2; orchestrator still rejects at level 4 because its map knows the worker is at depth 2.
  - **Permission clamping test:** worker at `read-only` tries to spawn with `danger-full-access`; sub-agent actually runs `read-only`.

### Phase 7 — Tests (~2 days)

7.1. `src/engine/test-engine.ts` — `ScriptedTestEngine implements AgentEngine`:
  - Loads a JSON file from `SWARM_HARNESS_TEST_SCRIPT`.
  - Each entry describes an event to emit (or a command like `spawn` / `task_create`).
  - Lets tests drive deterministic worker behavior without real API calls.
  - `capabilities` match `ClaudeAgentSdkEngine` (`streaming: true`, `mcp: true`, etc.) so tool wiring doesn't diverge between test and real paths.

7.2. Integration test harness: `test/integration/swarm.test.ts`:
  - Spawns `dist/cli.js --worker` as a real child process. The test runs `npm run build` in a setup step, OR runs against `src/**` via `tsx` if we add a dev runner — decide during implementation.
  - Sets `SWARM_HARNESS_TEST_SCRIPT` to a fixture file under `test/fixtures/worker-scripts/`.
  - Drives IPC via the real `WorkerTransport`; asserts orchestrator sees the right events and produces the right `results.jsonl`.

7.3. Concrete integration scenarios — **≥ 7**:
  - Single worker, text-only response → `results.jsonl` with `status: succeeded`.
  - Single worker, tool-use roundtrip (Tier 0 `read_file`) → task completes; tool events observed; events tagged with correct `parentToolUseId`.
  - Parallel fanout (3 tasks, concurrency=2) → `activeCount` never exceeds 2 (instrumented); all 3 complete.
  - Nested spawn (worker spawns sub-worker via `agent` tool) → sub-agent's events relay with `parentToolUseId`; depth tracked authoritatively.
  - Recursion-limit violation (adversarial worker sends `depth: 0` from level 2; tries to spawn level 4 via hallucinated count) → rejected; no subprocess spawned.
  - Permission-mode clamping (`read-only` parent tries to spawn `danger-full-access` child) → child runs at parent's mode.
  - SIGINT mid-run → 5s grace → SIGTERM → 5s → SIGKILL escalation; remaining queued tasks marked `cancelled` in `results.jsonl`.
  - Worker crash (fixture: child exits 1 mid-stream) → pending IPC requests reject; task marked `failed`; orchestrator continues.
  - `results.jsonl` write failure (simulated EBADF) → error event; non-zero exit.
  - `worker_ready` timeout (fixture: child sleeps forever) → 10s timeout; task marked `failed: "worker_ready_timeout"`.

7.4. Unit-test gaps: transport framing edge cases, malformed JSONL, correlation-id dedup, oversized frames rejected, heartbeat missed → `worker_stuck` event emitted.

Target: ≥ 30 new tests.

### Phase 8 — Live smoke + verification (~0.5 day)

8.1. `scripts/smoke-swarm.sh` — mirrors `scripts/smoke.sh` pattern. Writes a fixed 3-task JSONL, runs the swarm live, asserts `results.jsonl` has 3 lines all `succeeded`. Gated behind `--offline` to skip.

8.2. Extend existing `scripts/smoke.sh` with a `--swarm` flag that invokes smoke-swarm.sh, and a top-level `--all` that runs both.

8.3. End-to-end verification against Claude Max: 3 tasks fan out, all complete, results.jsonl parses. Validates IPC + subprocess + real API integration at the M1 gate. Also verifies AC #11b (auth inheritance: SDK inside the child successfully authenticates against the user's keychain).

## File layout after M1

```
src/
  swarm/
    host.ts                    # (exists) SwarmHost, AgentHandle, TaskAPI, LaneEvent types
    events.ts                  # (exists) lane-event catalog + ErrorPayload
    task-registry.ts           # NEW
    standalone-host.ts         # NEW
    worker-host.ts             # NEW
    orchestrator.ts            # NEW
    subprocess-spawner.ts      # NEW
    depth-limit.ts             # NEW
    ipc/
      protocol.ts              # NEW
      framing.ts               # NEW
      correlation.ts           # NEW
      worker-transport.ts      # NEW (orchestrator side)
      parent-transport.ts      # NEW (worker side)
    *.test.ts
  tools/
    tier2/
      agent.ts                 # NEW
      task_create.ts           # NEW
      task_update.ts           # NEW
      task_get.ts              # NEW
      task_list.ts             # NEW
      require-host.ts          # NEW — requireHost helper
      index.ts                 # NEW — buildTier2Tools(host)
      *.test.ts
  engine/
    test-engine.ts             # NEW — ScriptedTestEngine for integration tests
  cli/
    swarm.ts                   # NEW — swarm run subcommand
    worker-entry.ts            # NEW — --worker mode entry
    argv.ts                    # MODIFIED — add swarm subcommand + --worker flags
    main.ts                    # MODIFIED — route swarm / worker; always construct StandaloneHost
test/
  integration/
    swarm.test.ts              # NEW — real subprocess spawn tests
  fixtures/
    worker-scripts/            # NEW — ScriptedTestEngine JSON files
scripts/
  smoke-swarm.sh               # NEW — live-API swarm smoke test
```

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Pipe backpressure blocks worker writes or leaks memory | Medium | High | `parent-transport.ts` bounded outbound queue (1 MiB); low-priority events dropped with stderr warning; high-priority frames block. Backpressure test in Phase 3.6. |
| Orphaned workers after orchestrator crash | Medium | High | `detached: false`; parent's death closes child stdio; most child writes hit EPIPE and self-terminate. Orchestrator's `process.on("exit")` handler issues synchronous `SIGKILL` to the pool's live children. Windows = best-effort (SIGKILL sweep only). |
| Pending IPC requests leak on worker crash | Medium | High | Transport `close` handler iterates pending-request map, rejects with `transport_closed`. Per-request 60s timeout as secondary safety. Test in Phase 3.6. |
| Fork bomb via runaway nested spawn | Medium | High | Authoritative depth computed by the orchestrator from its own map (§0.4); `SpawnRequest.depth` is ignored inbound. Hard limit `MAX_DEPTH=3` (override via env). Adversarial test in Phase 6.4. |
| Worker bootstraps arrive out of order / task lost | Medium | High | Explicit worker lifecycle protocol (§3.7): worker emits `worker_ready` first; orchestrator waits before sending `run`; worker acks `run` before executing. 10s `worker_ready` timeout. |
| Correlation ID collisions | Low | Medium | `crypto.randomUUID()` (128-bit). Transport-side dedup check (reject duplicate request id as error). |
| Concurrent writes corrupt shared cwd files | Medium | Medium | Tier 0 `write_file` / `edit_file` / `multi_edit` use atomic rename (landed in M0). Conflicts on truly overlapping targets remain a task-design problem for M1; worktree isolation lands with M3 git coord. |
| IPC protocol drift between orchestrator and worker | Medium | High | Single `protocol.ts` module with all wire types. Any addition must be typed + backward-compat (optional new fields, never-remove-old). Test: orchestrator at version X must accept worker at version X's frames. |
| Zombie worker stalls the pool | Low | Medium | Heartbeat every 30s. Missing 3 consecutive → `worker_stuck` event + SIGTERM. Per-task wall-clock timeout (default 5 min, overridable per `TaskPacket.budget.maxWallClockMs`) enforces hard ceiling. |
| `results.jsonl` write failure silently loses data | Low | High | Write-error callback emits `error` lane event, logs stderr, increments `resultWriteFailures`. Orchestrator drains remaining workers then exits non-zero with summary. Integration test with EBADF. |
| Scripted test engine behaves differently from real engine | Medium | Medium | ScriptedTestEngine `capabilities` must match `ClaudeAgentSdkEngine`'s shape. `scripts/smoke-swarm.sh` exercises the real engine and catches drift. |
| `results.jsonl` corrupted by concurrent appends | Low | High | Single-writer discipline: only the orchestrator writes. Worker `task_result` notifications funnel to one `write()` call path. Node single-threaded ⇒ no interleaving. |
| Permission escalation via sub-agent | Low | High | `agent` tool clamps `permissionMode` to be at most as permissive as the parent's. Tested in Phase 6.4. |
| Windows subprocess differences | Medium | Low | M1 is POSIX-first; README documents Windows as best-effort. stdio and signal behaviors differ; formal Windows support deferred. |

## Verification steps

Run after each phase:

- **Phase 0:** `npx tsc --noEmit` clean.
- **Phase 1:** none (deps / utility step).
- **Phase 2:** `npx vitest run src/tools/tier2/ src/swarm/task-registry.test.ts` green.
- **Phase 3:** `npx vitest run src/swarm/ipc/` green; round-trip + backpressure + pending-request-cleanup tests pass.
- **Phase 4:** manual subprocess spawn: `SWARM_HARNESS_AGENT_ID=test-1 node dist/cli.js --worker --agent-id=test-1 </dev/null` emits `worker_ready` then exits after stdin close.
- **Phase 5:** manual `node dist/cli.js swarm run test/fixtures/simple-tasks.jsonl --concurrency 2` with ScriptedTestEngine.
- **Phase 6:** depth-limit, nested spawn, permission-clamping tests all pass.
- **Phase 7:** `npm test` shows ≥ 248 tests (218 from M0 + 30 new); all green; < 60s total.
- **Phase 8:** `scripts/smoke-swarm.sh` passes live.

**End-of-M1 gate:** all 15 acceptance criteria verified, tagged `m1-complete`.

## Estimated effort

| Phase | Effort |
|---|---|
| 0 Interface refinements (5 sub-items) | 0.5 d |
| 1 Dependencies / WorkerPool util | 0.1 d |
| 2 TaskRegistry + task_* tools | 1.5 d |
| 3 IPC protocol + transports + lifecycle protocol | **4 d** |
| 4 Spawner + hosts + worker-entry | 2 d |
| 5 Orchestrator + swarm CLI + shutdown escalation | 1.5 d |
| 6 Agent tool + nested spawn + clamping | 1.5 d |
| 7 Tests (ScriptedTestEngine + integration) | 2 d |
| 8 Smoke + verification | 0.5 d |
| Buffer | 0.5 d |

**Total: ~13.5 engineer-days.** Phase 3 bumped from 2.5 → 4 after the critic surfaced handshake / pending-request / backpressure complexity.

## Open items to revisit during implementation

Small decisions better made with code in hand:

- Whether to expose the sub-agent's full lane-event stream to the parent worker's `agent` tool caller via `handle.events()` (vs final-result-only). Start with final-result; add streaming in M3 if useful.
- Signal-handling edge cases on macOS vs Linux (SIGWINCH, SIGPIPE nuances with `detached: false`).
- `readline.createInterface` vs a hand-rolled splitter for framing (readline has CRLF quirks and allocates more).
- Test harness choice: build before integration tests, or run against src/** via `tsx`?
- Whether `SpawnRequest.taskId` is mutually exclusive with inline `task: TaskPacket` or both accepted (prefer exclusive — simplifies the orchestrator's create-vs-reuse branch).
- Whether `scripts/smoke-swarm.sh` inherits `--offline` semantics from `smoke.sh` or uses `--skip-smoke` — unify.
- Confirm via `sdk.d.ts`: does the SDK's tool handler `extra` expose `toolUseID` by that exact name? If not, adjust §0.5 field capture accordingly.

## Next milestone after M1

M2 (per `docs/07-implementation-plan.md`): ink UI depth + plugin/skill discovery + first-class MCP tool registration + mechanical compaction + hooks. Scope unchanged from doc 07.

## Cross-references

- Prereq scope: `docs/07-implementation-plan.md` §M1
- Swarm model: `docs/05-swarm-model.md` (atomic agent + orchestrator contracts, lane events, TaskPacket, anti-patterns)
- Interface contracts (already drafted): `src/swarm/host.ts`, `src/swarm/events.ts`
- Claw research informing this phase: `docs/research/05-swarm.md` (especially §5 "Lanes & events", §4 "Worker boot & subprocess protocol")
- Prior milestone: `docs/08-m0-plan.md` (atomic agent; M0 now complete)

## Revision history

- **rev 1 (2026-04-20):** initial draft
- **rev 2 (2026-04-20):** critic review returned REVISE with 5 critical + 7 major findings. Applied E1–E16:
  - Added Phase 3.7 worker lifecycle protocol (C1)
  - Specified pending-request cleanup on transport close (C2)
  - Added bounded outbound queue + backpressure policy (C3)
  - Specified `results.jsonl` write-failure handling (C4)
  - Added authoritative depth enforcement §0.4 (C5)
  - Split AC#11 into 11a (unit) + 11b (live) (C6)
  - Added `parentToolUseId` propagation §0.5 (M2 finding)
  - Phase 3 effort 2.5 → 4 d; total 12 → 13.5 d (M1 finding)
  - AC#2 verification via in-process counter instead of `ps` (M4)
  - Fixed `detached: false` claim + added exit-handler SIGKILL sweep (M3)
  - Added `requireHost` helper spec (M5)
  - AC#4 adds `completedAt` for consumer sort (M6)
  - Dropped `SWARM_HARNESS_SESSION_ID` from M1 env list (M7)
  - Heartbeat + unified SIGTERM→SIGKILL escalation + UUID agentId + permission clamping + worker-state-file deferred to M3 (missing pieces)
  - Cleaned up "Open items" — resolved items removed
