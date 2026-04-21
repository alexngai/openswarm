# M3a Coordination Primitives — Implementation Plan

**Status:** draft (rev 2)
**Owner:** alex
**Created:** 2026-04-20
**Prereq:** M2 complete (588 tests passing at `3b17fbd` on branch `mvp`)
**Refines:** the four highest-leverage items from §"Milestone M3 — orchestration depth + Claude Max subscription" in `docs/07-implementation-plan.md`

## Scope

M1 shipped the swarm (one-shot fan-out; `agent` + `task_create/update/get/list`). M2 made the atomic agent feel like a real CLI (REPL, slash commands, Tier 1, plugins, skills, MCP, hooks). M3a picks the four highest-leverage coordination primitives from M3 — inter-agent messaging, runtime-enforced policy enums, orchestrator retry + dead-letter, and team roles — and defers the rest of M3 (git coordination, prompt caching, parallel tool execution, `notebook_edit`, SwarmHost-routed `ask_user_question`, server-side preflight) to M3b.

**In scope:**

- Tier 2 messaging tools: `send_message`, `check_inbox`, `task_stop`, `task_output`
- Orchestrator-routed message delivery (worker → orchestrator → target worker) with in-flight inbox persistence
- Broadcast addressing: `*` (all peers) and `role:<name>` (all agents holding a role)
- Permission model for `task_stop`: orchestrator stops any task; peers stop only descendants they spawned
- TaskPacket policy upgrade from flat string enums to discriminated-union records — `BranchPolicy`, `CommitPolicy`, `EscalationPolicy` — validated at dispatch time (not just prompt hints)
- Orchestrator retry policies: fixed count, exponential backoff (both driven by `TaskPacket.escalationPolicy`)
- Dead-letter queue: tasks that exhaust retries go to `dead-letter.jsonl` alongside `results.jsonl`
- Team roles (`src/swarm/roles.ts`): `Role = { name, systemPromptSuffix, allowedTools }`; built-ins `architect`, `executor`, `reviewer`; user-defined via `.swarm-coder/roles.json`
- Per-worker role wiring: env var `SWARM_CODER_ROLE` → `RunConfig.systemPrompt` overlay + `RunConfig.allowedTools` filter
- CLI: `--role <name>` on `swarm run` (default role for all tasks) + per-task `TaskPacket.role` override
- `scripts/smoke-swarm-m3a.sh` live + offline (mirrors `smoke-swarm.sh`)

**Out of scope (explicit — M3b and beyond):**

- Git coordination (`branch_lock`, `stale_base`, `stale_branch`) — M3b
- Prompt caching — M3b
- Parallel tool execution — M3b
- `notebook_edit` tool — M3b
- `ask_user_question` routed via SwarmHost — M3b
- Server-side token preflight (`count_tokens`) — M3b
- Per-worker git worktree isolation — M3b (bundled with git coord)
- Signed role manifests / role trust model — M5+
- Remote cron / remote triggers — M5+
- Per-role resource budgets (separate token/wall-clock ceilings) — M3b

## Decision context

Four scope/mechanism choices need locking before implementation starts. Default picks below; each has a one-line rationale.

1. **Message delivery path: orchestrator-routed (B), not shared registry (A).**
   Rationale: the orchestrator already owns the authoritative agent map, depth tree, and transport graph (per M1 §0.4 and `standalone-host.ts`). Adding a second SoT (shared registry with O(1) lookup) duplicates state, invites drift, and complicates crash recovery. Orchestrator-routed is slightly more latency per hop but reuses the proven IPC path and makes permission checks centralized. Option A remains a M4 optimization if profiling shows inbox routing is hot.

2. **Inbox persistence window: in-memory per live agent; drained on worker exit; not re-delivered on respawn.**
   Rationale: M1 has no file-backed task registry, so an inbox that survives worker death would require persistence we don't yet have. Queue lives in the orchestrator's `AgentInbox` map keyed by `agentId`; `check_inbox` drains up to N messages; if target is mid-turn, messages queue; when target emits `worker_exited`, inbox is flushed to a lane event (`inbox_drained_on_exit`) and discarded. File-backed inbox is M3b together with task persistence.

   Overflow semantics: FIFO ordering is strict. Overflow evicts the **oldest** message (not newest) — keep the most recent messages. The sender receives `SendResult` with `{ ok: true, delivered: N, dropped: M, partial: true }` when any drops occurred due to overflow. An `inbox_overflow` lane event is emitted per drop with `{ agentId, droppedCount }`. `inbox_overflow` and `inbox_drained_on_exit` are added to the lane event catalog in Phase 0.3.
   - AC: broadcast to 5 recipients where 1 recipient is at capacity returns `{ ok: true, delivered: 5, dropped: 1, partial: true }` (the over-cap agent drops its oldest message to make room, so delivery count reflects the enqueue attempt succeeding after eviction).

3. **`task_stop` permission model: orchestrator can stop any task; peer workers can stop only tasks they (transitively) spawned.**
   Rationale: matches the authoritative depth map — the orchestrator already tracks `parentAgentId` for every spawn, so "is X a descendant of Y" is a cheap lookup. Prevents a peer from killing an unrelated task while preserving the natural "parent cancels child" flow. Explicit override via `SWARM_CODER_ALLOW_PEER_TASK_STOP=1` env flag for experimentation, off by default.

4. **Retry wall-clock accounting: separate per-attempt ceiling vs. absolute total ceiling.**
   `TaskBudget` gains a new field `maxWallClockMsPerAttempt?: number`. Default when not specified: `maxWallClockMs / 3` (matching the previous "3x cap" intuition without silent multiplication). `maxWallClockMs` remains the absolute ceiling across all attempts combined. This avoids the silent 3–5x multiplier of the old "per-attempt reset" design: M1/M2 `TaskBudget` users are unchanged (no retries, so the new field is irrelevant). Migration note: the old decision context's "3x hard cap" is now expressed explicitly via the default `maxWallClockMsPerAttempt = maxWallClockMs / 3`.

5. **Nested-spawn message topology: depth-1 only (Option A).**
   Decision context #1 claims orchestrator-routed delivery, but depth-2 workers have no direct transport to root — they only have `ParentTransport` to their immediate parent. M3a resolves this by scoping messaging to depth-1 only:
   - Two workers spawned by the root orchestrator CAN exchange messages (depth 1 peers).
   - Workers spawned by other workers (depth ≥ 2) cannot receive cross-subtree messages. Attempting `send_message` to a depth ≥ 2 worker returns `{ ok: false, reason: "depth>1 messaging unsupported" }`.
   - This is **Option A** (simpler). **Option B** (intermediate workers forward `message.send`/`message.recv` frames upward through `ParentTransport` to root as the authoritative inbox, requiring `forward_message_send`/`forward_message_recv` IPC notification methods and WorkerHost proxy logic) is the upgrade path — deferred to M3a.1 or M3b.
   - AC: depth-1 messaging scope is enforced at orchestrator dispatch; the error response is tested.

The plan below assumes all five default picks; flip any before implementation starts if needed.

## Acceptance criteria

Each is executable with a one-line test harness or manual smoke step.

1. `send_message` tool: worker A calls `send_message({ to: "<agentId>", content: "hello" })`; worker B's next `check_inbox()` call returns exactly one message with `from=A`, `content="hello"`, and a monotonic `timestamp`.
2. Inbox queueing across busy window: worker B is mid-turn when 3 messages arrive for it; B's next `check_inbox({ max: 10 })` returns all 3 in send-order.
3. `check_inbox` drains up to N: with 5 messages queued and `max=2`, the first call returns 2 (oldest), the second returns 2, the third returns 1, the fourth returns `[]`.
4. Broadcast `*`: `send_message({ to: "*", content: "go" })` from A reaches every other live worker's inbox exactly once; A does NOT receive its own broadcast.
5. Role broadcast: `send_message({ to: "role:executor", content: "go" })` reaches every worker currently holding `role=executor` and no others.
6. `task_stop` permission: worker A (depth 1) spawns worker B (depth 2); A calls `task_stop({ taskId: B.taskId })` → succeeds; worker C (sibling of A, depth 1) calls `task_stop({ taskId: B.taskId })` → returns `{ status: "error", message: "permission denied: caller is not an ancestor of target task" }`. Orchestrator can stop any task unconditionally.
7. `task_stop` signaling: stopping a running task emits `task_stopped` lane event, the worker's `handle.kill()` is invoked, `results.jsonl` records the task with `status: "cancelled"` and a `stoppedBy` field.
8. `task_output`: for a running task, `task_output({ taskId })` returns `{ status: "running", partialOutput: "..." }`. After completion, it returns `{ status: <terminal>, output, usage, wallClockMs }`. Unknown taskId returns `{ status: "error", message: "unknown taskId" }`.
9. TaskPacket policies are discriminated unions: `{ kind: "none" }`, `{ kind: "reuse", branch }`, `{ kind: "create", from, name? }` for `BranchPolicy` (and analogous for commit/escalation). Zod schema rejects legacy flat strings (`"main"`, `"worktree"`, etc.) at CLI parse time with a clear migration hint.
10. Runtime enforcement (BranchPolicy): `branchPolicy: { kind: "reuse", branch: "feature/x" }` causes the orchestrator to pre-flight `git rev-parse --verify feature/x`; failure → task fails before worker spawn with `escalationPolicy` path driving retry.
11. Runtime enforcement (EscalationPolicy): `escalationPolicy: { kind: "retry", max: 3, backoff: "exponential" }` on a worker that fails → orchestrator retries up to 3 times with `250ms * 2^attempt` backoff; fourth failure writes to `dead-letter.jsonl`.
12. Retry budget: each retry is bounded by `TaskBudget.maxWallClockMsPerAttempt` (default: `maxWallClockMs / 3`); the sum across all attempts is hard-capped by `TaskBudget.maxWallClockMs`; exceeding the absolute ceiling transitions to dead-letter regardless of remaining retries. M1/M2 callers that set only `maxWallClockMs` are unaffected.
13. Dead-letter file: `dead-letter.jsonl` contains one line per permanently-failed task with `{ id, lastError, attempts, totalWallClockMs, firstAttemptAt, lastAttemptAt }`; path overridable via `--dead-letter <path>`; orchestrator exits non-zero if dead-letter is non-empty unless `--allow-dead-letter` is passed.
14. Role registry: built-ins `architect`, `executor`, `reviewer` are registered at startup with distinct `systemPromptSuffix` bodies and `allowedTools` allowlists that strictly subset the full tool surface (architect has no `write_file`; executor has full Tier 0; reviewer has read-only Tier 0 + `structured_output`).
14a. Token budget is cumulative across retries: each retry attempt consumes from the same `TaskBudget.maxTokens` pool (not reset per-attempt). If cumulative usage across all attempts exceeds `maxTokens`, the task goes to dead-letter immediately with no further retries regardless of `EscalationPolicy.max`.
15. Custom roles: `.swarm-coder/roles.json` declaring a `{ name: "docs", systemPromptSuffix: "...", allowedTools: [...] }` is loaded at startup; registry-lookup returns it; unknown role name in `TaskPacket.role` → task fails at dispatch with `"unknown role: <name>"`.
16. CLI role default: `swarm run tasks.jsonl --role executor --concurrency 2` applies `executor` to every task that doesn't override via `TaskPacket.role`; override per-task honored.
17. Per-worker role wiring: a worker spawned with `role=reviewer` sees `process.env.SWARM_CODER_ROLE === "reviewer"`; its `RunConfig.systemPrompt` contains the reviewer suffix; its `RunConfig.allowedTools` is exactly the reviewer allowlist; attempting `write_file` returns `permission: denied` (verified via hook fixture that logs `permission_denied` events).
18. `npx tsc --noEmit` passes strict mode.
19. `npm test` baseline 588 → target 620–648 (delta +32 to +60); all passing.
20. `scripts/smoke-swarm-m3a.sh --offline` covers: send_message round-trip, broadcast, check_inbox drain, task_stop parent-kills-child, task_output partial + final, retry + dead-letter, role allowlist enforcement.
21. `scripts/smoke-swarm-m3a.sh` (live) covers: 2-worker send_message + check_inbox against real API; architect-role worker refuses `write_file`; retry policy surfaces on a forced-fail prompt.
22. Policy validation unit tests reject malformed discriminated unions at Zod-parse time with ≥ 10 cases (missing `kind`, wrong `kind` value, missing required sibling field per `kind`). Matches Phase 2.5 target.

## Implementation phases

### Phase 0 — Interface refinements (~0.5 day)

0.0. `src/swarm/host.ts` — widen `SwarmHost.send` from its current `send(to: AgentId, message: AgentMessage): Promise<void>` signature to support broadcast and role addressing:
```ts
send(
  to: AgentId | "*" | `role:${string}`,
  message: AgentMessage,
): Promise<SendResult>;

interface SendResult {
  readonly ok: boolean;
  readonly delivered: number;       // how many inboxes actually received
  readonly dropped?: number;        // over-cap drops
  readonly partial?: boolean;       // broadcast with some drops
}
```
Pair with Zod validation in the `send_message` tool (Phase 3.6).

0.1. `src/swarm/host.ts` — replace the flat-string `BranchPolicy` / `CommitPolicy` / `EscalationPolicy` type aliases with discriminated unions. Shape:
```ts
export type BranchPolicy =
  | { readonly kind: "none" }
  | { readonly kind: "reuse"; readonly branch: string }
  | { readonly kind: "create"; readonly from: string; readonly name?: string };

export type CommitPolicy =
  | { readonly kind: "none" }
  | { readonly kind: "auto"; readonly message?: string }
  | { readonly kind: "atomic" };

export type EscalationPolicy =
  | { readonly kind: "none" }
  | { readonly kind: "retry"; readonly max: number; readonly backoff: "fixed" | "exponential" }
  | { readonly kind: "handoff"; readonly targetRole: string };
```

0.2. `src/swarm/host.ts` — wire the EXISTING `SpawnRequest.role` and `SpawnRequest.allowedTools` fields end-to-end. These fields were pre-provisioned during M1 (`host.ts:86-89` already declares them); M3a makes them load-bearing:
- Orchestrator dispatch (Phase 6.4) populates `role` and `allowedTools` from the resolved `Role` object.
- Subprocess spawner (Phase 6.5) propagates them via `SWARM_CODER_ROLE` env var and an `allowedTools` env serialization.
- Worker entry (Phase 6.6) consumes both to overlay `RunConfig.systemPrompt` and filter `RunConfig.allowedTools`.

Also extend `SwarmHost` with the widen `send` signature (see M1 fix in Phase 0 preamble) and confirm task methods:
```ts
// new methods on TaskAPI (already declared stubs — wire real impl in Phase 4)
stop(id: string): Promise<void>;
output(id: string): AsyncIterable<string>;
```
Do NOT re-add `role` or `allowedTools` to `SpawnRequest` — they already exist.

0.3. `src/swarm/events.ts` — add lane event types: `message_sent` (already present), `message_received`, `inbox_drained_on_exit`, `task_stop_requested`, `retry_scheduled`, `retry_exhausted`, `dead_letter_written`, `role_registered`, `role_applied`. Confirm `message_sent` and `message_received` exist (they do). Add the rest.

0.4. `src/swarm/ipc/protocol.ts` — add IPC methods:
- Request: `"message.send"`, `"message.recv"`, `"task.stop"`, `"task.output"`
- Notification: repurpose the existing `sub_agent_event` stub (currently `protocol.ts:70-71`, "M1 future; stub only") for inbox delivery — this stub is now load-bearing. Update `IpcNotificationMethod` union to document that `sub_agent_event` params carry `AgentMessage` when `eventKind === "inbox_delivery"`. Also add `"task_stop_signal"` (orchestrator → worker; params: `{ taskId, reason }`). Do NOT add a separate `"inbox_delivery"` method — repurposing `sub_agent_event` is cleaner and avoids a new method.

0.5. `src/engine/index.ts` — confirm `RunConfig.systemPrompt` (exists) and `RunConfig.allowedTools` / equivalent. Add `readonly allowedTools?: readonly string[]` to `RunConfig` — this is the field role-driven tool filtering writes to. Commit this addition explicitly as "add `RunConfig.allowedTools?: readonly string[]` for role filtering" (do not leave as grep-later). If already present under a different name, thread that field instead and document the mapping here during implementation.

0.6. `src/tools/tier2/` (no code yet) — stub files placeholder: `send_message.ts`, `check_inbox.ts`, `task_stop.ts`, `task_output.ts`. Each exports a placeholder ToolImpl with a TODO body. Lets `buildTier2Tools()` grow in one edit later.

### Phase 1 — Dependencies (~0.1 day)

1.1. No new runtime deps. Node stdlib (`crypto`, `child_process`, `events`, `stream`) covers everything. Zod already pinned.

1.2. No new dev deps.

### Phase 2 — Policy enums (discriminated unions) (~1 day)

2.1. `src/swarm/policies.ts` (new) — three Zod schemas, one per policy union, plus runtime validators:
```ts
export const BranchPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("reuse"), branch: z.string().min(1) }),
  z.object({ kind: z.literal("create"), from: z.string().min(1), name: z.string().optional() }),
]);
export const CommitPolicySchema = /* … */;
export const EscalationPolicySchema = /* … */;

export const TaskPacketSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  branchPolicy: BranchPolicySchema,
  commitPolicy: CommitPolicySchema,
  escalationPolicy: EscalationPolicySchema,
  budget: z.object({ maxTurns: z.number().optional(), maxTokens: z.number().optional(), maxWallClockMs: z.number().optional() }).optional(),
  context: z.object({ files: z.array(z.string()).optional(), parentTaskId: z.string().optional() }).optional(),
  role: z.string().optional(),
});
```

2.2. `src/cli/swarm.ts` — replace the existing flat-string Zod schema with `TaskPacketSchema`. On parse failure, emit a migration hint to stderr: `"[swarm-coder] TaskPacket policies are now discriminated unions — see docs/11-m3a-plan.md §Policy migration"`.

2.3. `docs/11-m3a-plan.md` — add a "Policy migration" appendix with before/after examples. Users of existing `tasks.jsonl` files migrate:
- `"branchPolicy": "main"` → `"branchPolicy": { "kind": "none" }` (or `{ kind: "reuse", branch: "main" }` if intent was "operate on main")
- `"commitPolicy": "never"` → `"commitPolicy": { "kind": "none" }`
- `"escalationPolicy": "abort-on-error"` → `"escalationPolicy": { "kind": "none" }`
- `"escalationPolicy": "retry-with-backoff"` → `"escalationPolicy": { "kind": "retry", "max": 3, "backoff": "exponential" }`
- Update `scripts/smoke-swarm.sh` fixtures in lockstep so M1 smoke keeps passing.

2.4. `src/swarm/orchestrator.ts` — pre-flight validators per policy kind. At dispatch time (before `host.spawn`):
- `BranchPolicy.reuse`: shell out to `git rev-parse --verify <branch>`; failure → treat as task failure with `escalationPolicy` path.
- `BranchPolicy.create`: verify `from` branch exists; generate `name` if absent (`task-<id>-<shorthash>`); actual git operations deferred to M3b git coord (for M3a, log intent as `branch_policy_noop` lane event).
- `CommitPolicy`: purely advisory in M3a (git commits land in M3b); orchestrator logs `commit_policy_noop` lane event with the kind.
- `EscalationPolicy`: drives Phase 5 retry logic directly.

2.5. Tests (`src/swarm/policies.test.ts`): ≥ 10 cases covering each kind's accept/reject paths + legacy-flat-string rejection with migration hint.

### Phase 3 — Inter-agent messaging (send_message + check_inbox) (~1.5 days)

3.1. `src/swarm/inbox.ts` (new) — `AgentInbox`: per-agent FIFO queue, lives in the orchestrator.
```ts
export class AgentInbox {
  private queues = new Map<AgentId, AgentMessage[]>();
  enqueue(to: AgentId, msg: AgentMessage): void;
  drain(agent: AgentId, max: number): AgentMessage[];
  size(agent: AgentId): number;
  discardAgent(agent: AgentId): AgentMessage[]; // returns discarded for `inbox_drained_on_exit`
}
```
Synchronous API — Node single-threaded, no locks. Keyed by `agentId`. Bounded per-agent (default 1000; overflow evicts oldest and emits `inbox_overflow` lane event).

3.2. `src/swarm/role-index.ts` (new) — tracks `agentId → role` for role-based broadcast routing. Small, 1-line lookups. Populated by `StandaloneHost.spawn` when `request.role` is set. Entry is evicted on `worker_exited` lane event so stale agents are not targeted by role broadcasts.

3.3. `src/swarm/standalone-host.ts` — implement `send(to, message)`:
- Resolve addressing:
  - `to === "*"` → fan out to every agent in `depths` map except `message.from`
  - `to.startsWith("role:")` → consult `role-index.ts`
  - otherwise → direct address
- For each resolved recipient: enqueue into `AgentInbox`, emit `message_sent` lane event, attempt immediate delivery via `WorkerTransport.notify("inbox_delivery", msg)` if the target is live.
- Unknown direct recipient → reject with `{ code: "unknown_recipient" }`.

3.4. `src/swarm/worker-host.ts` — implement `send` (proxy via `"message.send"` request to parent) and `inbox()` async iterator (pulls `"inbox_delivery"` notifications the ParentTransport emits).

3.5. `src/swarm/ipc/worker-transport.ts` — add handler for inbound `"message.send"` requests; route to orchestrator's `host.send`.

3.6. `src/tools/tier2/send_message.ts` — Tier 2 ToolImpl. Zod:
```ts
z.object({
  to: z.string().min(1),  // agentId | "*" | "role:<name>"
  content: z.string(),
  correlationId: z.string().optional(),
})
```
Execute: `host.send(to, { from: host.agentId, to, content, timestamp: Date.now(), correlationId })`. Required permission: `"exec"` (messaging is a side-effect).

3.7. `src/tools/tier2/check_inbox.ts` — Tier 2 ToolImpl. Zod:
```ts
z.object({ max: z.number().int().positive().optional().default(10) })
```
Execute: synchronously drain up to `max` messages from the agent's inbox. No timeout, no blocking — return whatever is already queued at call time as a JSON array. If the queue is empty, return `[]` immediately. Required permission: `"read"` (no side-effects; inbox drain is a local state change). Drain semantics: "give me whatever's already here, don't block."

3.8. `src/tools/tier2/index.ts` — add `sendMessageTool`, `checkInboxTool` to `buildTier2Tools()`.

3.9. Tests:
- `src/swarm/inbox.test.ts` (≥ 6): FIFO order, max-bound overflow, discardAgent flushes.
- `src/tools/tier2/send_message.test.ts` + `check_inbox.test.ts` (≥ 8 combined): direct, broadcast, role-broadcast, unknown recipient, empty drain, partial drain, sender excluded from broadcast, across-busy-window delivery (target mid-turn).
- Real-subprocess integration test in `test/integration/swarm.test.ts`: worker A and B both live; A sends, B receives; B replies; A receives reply.

### Phase 4 — task_stop and task_output (~1.25 days)

4.1. `src/swarm/standalone-host.ts` — extend `TaskAPI.stop` and `.output` from M1 stubs:
- `stop(id)`: look up the `AgentHandle` for the task (track `taskId → handle` at `spawn()` time). Emit `task_stop_requested`. Invoke `handle.kill()`. TaskRegistry transitions to `stopped`.
- `output(id)`: async-generator that yields the partial `TaskRecord.output` buffer. Updated by the engine's `text_delta` → TaskRegistry append (see Phase 4.1a). Generator completes when task reaches terminal status.

4.1a. `src/swarm/task-registry.ts` (or wherever `TaskRegistry` lives) — extend with `appendOutput(id: string, chunk: string): void` method (distinct from `update(id, patch)`). Wire the orchestrator's lane_event listener so every `text_delta` event with a matching `taskId` calls `appendOutput(id, chunk)`. `task_output` reads the `output` field as accumulated-so-far during run and as finalized value after completion. Budget: +0.25d on Phase 4.

4.2. Ancestor-check helper: `src/swarm/ancestry.ts` — `isAncestorOf(caller, target, depths, spawnParents): boolean`. Uses the orchestrator's `depths` map + new `spawnParents: Map<AgentId, AgentId>`. StandaloneHost maintains the parent map (see Phase 4.2a).

4.2a. `src/swarm/standalone-host.ts` — extend to maintain `spawnParents: Map<AgentId, AgentId>` alongside the existing `depths: Map<AgentId, number>`. Populate `spawnParents.set(childId, parentId)` at the same call site where `depths.set(childId, depth)` is called. Evict on `worker_exited` lane event — note: `depths` is currently never evicted (pre-existing bug); M3a does NOT fix depths eviction. Both `depths` and `spawnParents` have the same non-eviction behavior in M3a; eviction on `worker_exited` is documented as a TODO but not implemented here. Budget: +0.25d.
- AC: `isAncestorOf` returns correct results for a 3-deep spawn chain.
- AC (deferred): eviction of `spawnParents` and `depths` on `worker_exited` is documented as TODO, not implemented in M3a.

4.3. `src/tools/tier2/task_stop.ts` — Tier 2 ToolImpl. Zod `{ taskId: z.string() }`. Execute:
- `const host = requireHost(ctx, "task_stop")`.
- If orchestrator-mode (standalone root) → unconditional stop.
- If worker-mode → check `ancestry.isAncestorOf(host.agentId, taskOwnerAgentId)`; reject with error if not ancestor (unless `SWARM_CODER_ALLOW_PEER_TASK_STOP=1`).
- Call `host.task.stop(taskId)`.

4.4. `src/tools/tier2/task_output.ts` — Tier 2 ToolImpl. Zod `{ taskId: z.string() }`. Execute: look up task record; if terminal → return full output + status + usage; if running → return `{ status: "running", partialOutput, sizeBytes }`. Does NOT stream (callers poll). Streaming variant (via `host.task.output()`) arrives in M3b.

4.5. `src/swarm/worker-host.ts` — implement `task.stop` / `task.output` as IPC proxies to `"task.stop"` / `"task.output"` methods.

4.6. `src/swarm/ipc/worker-transport.ts` — dispatch `"task.stop"` and `"task.output"` requests to orchestrator's `host.task`.

4.7. `src/swarm/orchestrator.ts` — extend `ResultLine` with optional `stoppedBy?: string` field (the `agentId` of the caller, or `"orchestrator"` when stopped by root). Populated when `task_stop` transitions a task to `cancelled`. Note this field in the file layout (orchestrator.ts MODIFIED).

4.8. Tests (≥ 7):
- Ancestor stop succeeds; sibling stop rejected; orchestrator stop unconditional.
- `task_output` on running task returns partial; on completed returns final; on unknown returns error.
- `task_stop` flips task status to `stopped` in registry.
- Result-line written to `results.jsonl` with `status: "cancelled"` and `stoppedBy` field.
- Depth-1 messaging works; depth-2 send returns `{ ok: false, reason: "depth>1 messaging unsupported" }` (C2 AC).

### Phase 5 — Retry + dead-letter (~1 day)

5.1. `src/swarm/retry-policy.ts` (new) — `planRetry(policy: EscalationPolicy, attempt: number): { shouldRetry: boolean, delayMs: number }`.
- `kind: "none"` → never retry.
- `kind: "retry"` → retry if `attempt < max`; `attempt` is **0-indexed** (first retry at `attempt=0`); `delayMs = backoff === "fixed" ? 250 : 250 * 2^attempt` (first retry delay = 250ms; cap 30_000).
- `kind: "handoff"` → returns `{ shouldRetry: false }`; caller dispatches a follow-up task to `targetRole`'s inbox. (Actual handoff dispatch lives in 5.4.)

5.2. `src/swarm/orchestrator.ts` — wrap each task's run loop with retry:
- Track `attempts: Map<taskId, number>` and `firstAttemptAt`.
- On task failure, consult `planRetry(task.escalationPolicy, attempts.get(id) ?? 0)`.
- If `shouldRetry`: sleep `delayMs`, re-spawn, increment counter, emit `retry_scheduled` lane event with `attempt`, `delayMs`, `policyKind`.
- If `!shouldRetry` AND policy kind `!== "none"` (i.e., exhausted): emit `retry_exhausted`, write to dead-letter.
- Hard-cap total wall-clock: `sum(per-attempt wallClock) > budget.maxWallClockMs` → stop retrying regardless of `max`. Per-attempt ceiling is `budget.maxWallClockMsPerAttempt ?? budget.maxWallClockMs / 3`.
- Token budget is cumulative: all retry attempts draw from the same `TaskBudget.maxTokens` pool. Track `cumulativeTokens: Map<taskId, number>`; if cumulative usage exceeds `maxTokens`, transition to dead-letter immediately without further retries.

5.3. `src/swarm/dead-letter.ts` (new) — `DeadLetterWriter` class mirroring the `results.jsonl` single-writer discipline. Opens `dead-letter.jsonl` via `fs.createWriteStream(path, { flags: "a" })` (append mode, matching `results.jsonl` behavior) at orchestrator start (or whatever `--dead-letter` points to). Write errors surface as `dead_letter_write_failure` lane event and non-zero exit.

`--allow-dead-letter` exit check: compare the file size before the orchestrator run begins to the file size after. A non-zero **delta** (new bytes appended this run) triggers non-zero exit; pre-existing lines from prior runs do NOT trigger the check.
- AC: running the orchestrator twice on a failing task produces two append-sections in `dead-letter.jsonl`; only the second run's delta is evaluated for the `--allow-dead-letter` gate; pre-existing lines from the first run do not cause the second run to fail if `--allow-dead-letter` is set.

5.4. Handoff (minimal): on `EscalationPolicy.handoff`, the orchestrator dispatches a new task with the same prompt + `role: targetRole` to the internal task queue. If no agent of `targetRole` exists, treat as dead-letter. Full handoff tracking (which task handed off to which) is M3b.

5.5. CLI flags — `src/cli/argv.ts` wiring + tests. Budget: +0.15d.
- `--dead-letter <path>` (default: `./dead-letter.jsonl`) — wire in `argv.ts`; thread to `DeadLetterWriter` via orchestrator options.
- `--allow-dead-letter` — wire in `argv.ts`; orchestrator exits 0 even if dead-letter delta is non-empty this run.
- Add ≥ 3 test cases in `src/cli/argv.test.ts`: (1) `--dead-letter /tmp/dl.jsonl` parsed and propagated; (2) `--allow-dead-letter` flag sets boolean; (3) both flags together parse without error and propagate correctly.
- AC: `swarm run t.jsonl --dead-letter /tmp/dl.jsonl --allow-dead-letter` parses with no error; both values propagate to `Orchestrator` constructor options.

5.6. Tests (≥ 6):
- `retry-policy.test.ts`: fixed vs exponential delays, max-exceeded returns `shouldRetry: false`, kind handoff returns `shouldRetry: false`, cap at 30s for exponential.
- Integration: scripted-test-engine task fails 2x then succeeds → `retry_scheduled` emitted twice, final result `succeeded`.
- Integration: task fails 4 times with `max: 3` → dead-letter has one line; orchestrator exits non-zero; `--allow-dead-letter` → exits 0.

### Phase 6 — Team roles (~1 day)

6.1. `src/swarm/roles.ts` (new):
```ts
export interface Role {
  readonly name: string;
  readonly systemPromptSuffix: string;
  readonly allowedTools: readonly string[];
}

export class RoleRegistry {
  private roles = new Map<string, Role>();
  register(role: Role): void;
  get(name: string): Role | undefined;
  list(): readonly Role[];
}

export const BUILTIN_ROLES: readonly Role[];
```

Built-ins:
- **architect**: systemPromptSuffix = "You are the architect. Propose designs, write specs, leave implementation to the executor. Do not write code files." allowedTools = Tier 0 read-side (read_file, glob, grep) + `todo_write` + Tier 1 web/structured + Tier 2 (agent, task_*). Excludes: bash, write_file, edit_file, multi_edit.
- **executor**: systemPromptSuffix = "You are the executor. Implement the task. Make minimal, focused changes." allowedTools = full Tier 0 + full Tier 1 + Tier 2 messaging/task read. Excludes: `agent` spawn (executors don't recursively spawn).
- **reviewer**: systemPromptSuffix = "You are the reviewer. Assess the change; point out risks and fixes. Do not modify files." allowedTools = Tier 0 read-side + `todo_write` + Tier 1 read-side + `structured_output` + Tier 2 task read/message. Excludes: bash, write_file, edit_file, multi_edit, agent.

6.2. `src/swarm/roles.ts` — custom role loader:
```ts
export async function loadCustomRoles(configPath: string): Promise<readonly Role[]>;
```
Reads `.swarm-coder/roles.json` (Claude Code–style tiered discovery from M2 config-resolved). Validates via Zod schema mirroring `Role`. Unknown roles ignored with `degraded_role` lane event.

6.3. `src/cli/main.ts` (orchestrator entry) — at startup:
- Instantiate `RoleRegistry`; register built-ins; load custom roles.
- Pass registry to `Orchestrator` constructor.

6.4. `src/swarm/orchestrator.ts` — when dispatching a task:
- Determine role: `task.role ?? cliDefaultRole ?? null`.
- If role is non-null and unknown: task fails at dispatch (pre-spawn) with `"unknown role: <name>"`.
- Otherwise pass role into `SpawnRequest.role` and `SpawnRequest.allowedTools = role.allowedTools`.

6.5. `src/swarm/subprocess-spawner.ts` — include `SWARM_CODER_ROLE` env var in child spawn when set.

6.6. `src/cli/worker-entry.ts` — at startup:
- Read `process.env.SWARM_CODER_ROLE`.
- If set: look up role in registry (registry is re-instantiated per worker; built-ins are static, custom loaded fresh). Append `systemPromptSuffix` to `RunConfig.systemPrompt` (prepend the parent's base prompt; role suffix wins on conflicts). Set `RunConfig.allowedTools` to the role's allowlist.
- If `RunConfig.allowedTools` is set, the tool dispatcher filters tool surface before passing to the engine.

6.6a. `src/tools/dispatcher.ts` (or wherever `ToolDispatcher` lives) — tool filtering happens at **dispatcher registration**, not per-call. `ToolDispatcher` accepts `allowedTools: readonly string[] | undefined` as a constructor option. When set, any tool not in the list is filtered out of the registered tools list BEFORE the engine sees them (the model never sees filtered tools in the tool list).

This is ORTHOGONAL to `canUseTool` (per-call permission gate) and `clampPermissionMode` (permission mode ceiling). Composition: role allowlist restricts VISIBLE tools; permission-mode clamp applies to the REMAINING visible tools' write privileges. Both can be active simultaneously.
- AC: when role is `reviewer` with `allowedTools: ['read_file', 'grep']`, the model cannot even see `bash` in its tool list regardless of permission mode.
- AC: filtering at registration is verified by inspecting the tool list passed to the engine in a scripted fixture (not just observing runtime rejections).

6.7. `src/cli/argv.ts` — add `--role <name>` to `swarm run`. Pass through to orchestrator. Budget: +0.1d. Add ≥ 2 test cases in `src/cli/argv.test.ts`: (1) `--role architect` parsed and value propagated; (2) `--role` without a value errors clearly. AC: `swarm run t.jsonl --role architect --dead-letter /tmp/dl.jsonl --allow-dead-letter` parses with no error; all three propagate to `Orchestrator` constructor options.

6.8. `src/cli/swarm.ts` — thread `--role` into the orchestrator options.

6.9. Tests (≥ 8):
- `roles.test.ts`: registry register/get, built-in shapes, unknown role lookup returns undefined, custom role load.
- Role-allowlist enforcement: spawn a worker with `role: reviewer`; scripted-test-engine tries `write_file` → dispatcher rejects; `permission_denied` lane event observed.
- SystemPrompt suffix applied: inspect `RunConfig.systemPrompt` during a scripted run; verify suffix appears.
- CLI integration: `--role executor` + no per-task role → all tasks run as executor; per-task `role: architect` override honored.

### Phase 7 — Tests, smoke, docs (~0.5 day)

7.1. `scripts/smoke-swarm-m3a.sh` — mirrors `smoke-swarm.sh` format (offline + live scenarios):
- **Offline** (ScriptedTestEngine):
  - [O1] `send_message` round-trip between 2 scripted workers
  - [O2] Broadcast `*` reaches 2 of 3 workers (not self)
  - [O3] Role broadcast `role:executor` reaches only executors
  - [O4] `task_stop` by ancestor succeeds; sibling denied
  - [O5] Retry policy: task fails 2x then succeeds → results.jsonl has one succeeded line, retry_scheduled in event log
  - [O6] Dead-letter: task fails beyond max → dead-letter.jsonl has one line; exit non-zero
  - [O7] Role allowlist: reviewer-role worker cannot call `write_file`
- **Live** (real API):
  - [L1] Two workers exchange a greeting via send_message (scripted with a short prompt)
  - [L2] Architect-role worker refuses to use `write_file` when prompted
  - [L3] Retry escalates on a forced tool_error fixture

7.2. Extend `scripts/smoke.sh --all` to invoke `smoke-swarm-m3a.sh` alongside existing smoke scripts.

7.3. `docs/05-swarm-model.md` — update TaskPacket section to show discriminated-union shapes; cross-reference this plan.

7.4. `docs/04-tool-tiers.md` (if exists) — mark `send_message`, `check_inbox`, `task_stop`, `task_output` as landed in M3a.

7.5. `docs/03-interfaces.md` — update SwarmHost section with the new Role parameter and policy unions (brief, 2-3 lines).

## File layout after M3a

```
src/
  swarm/
    host.ts                    # MODIFIED — policy unions, role field on SpawnRequest
    events.ts                  # MODIFIED — new lane event types
    policies.ts                # NEW — Zod schemas + validators for policy unions
    inbox.ts                   # NEW — AgentInbox FIFO per agent
    role-index.ts              # NEW — agentId → role map for broadcast
    roles.ts                   # NEW — Role type, RoleRegistry, built-ins, custom loader
    retry-policy.ts            # NEW — planRetry() pure function
    dead-letter.ts             # NEW — DeadLetterWriter
    ancestry.ts                # NEW — isAncestorOf() helper for task_stop
    standalone-host.ts         # MODIFIED — send/inbox impl; task.stop/task.output wired; role-index plumbing
    worker-host.ts             # MODIFIED — send/inbox + task.stop/task.output IPC proxies
    orchestrator.ts            # MODIFIED — policy pre-flight, retry loop, dead-letter, role dispatch
    subprocess-spawner.ts      # MODIFIED — SWARM_CODER_ROLE env var
    ipc/
      protocol.ts              # MODIFIED — message.send/recv, task.stop, task.output, inbox_delivery notification
      worker-transport.ts      # MODIFIED — new request handlers
      parent-transport.ts      # MODIFIED — inbox_delivery subscriber
    *.test.ts                  # NEW unit tests per new module
  tools/
    tier2/
      send_message.ts          # NEW
      check_inbox.ts           # NEW
      task_stop.ts             # NEW
      task_output.ts           # NEW
      index.ts                 # MODIFIED — export new tools
      *.test.ts                # NEW per tool
  cli/
    argv.ts                    # MODIFIED — --role, --dead-letter, --allow-dead-letter flags
    swarm.ts                   # MODIFIED — thread flags into orchestrator; TaskPacketSchema
    worker-entry.ts            # MODIFIED — read SWARM_CODER_ROLE → apply role to RunConfig
    main.ts                    # MODIFIED — instantiate RoleRegistry at startup
  engine/
    index.ts                   # MODIFIED (if needed) — RunConfig.allowedTools field
test/
  integration/
    swarm.test.ts              # MODIFIED — add messaging, task_stop, retry, role scenarios
  fixtures/
    worker-scripts/            # MODIFIED — add fixtures for send/recv, forced-fail-then-succeed, role allowlist
scripts/
  smoke-swarm-m3a.sh                 # NEW
  smoke.sh                     # MODIFIED — --all includes smoke-swarm-m3a.sh
docs/
  11-m3a-plan.md               # NEW (this file)
  05-swarm-model.md            # MODIFIED — policy unions, role section
  03-interfaces.md             # MODIFIED — brief role + policy mention
```

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Breaking change to `TaskPacket` breaks existing `tasks.jsonl` files in the wild | High | Medium | Migration appendix in plan; clear CLI error with migration hint; update `smoke-swarm.sh` fixtures in the same commit. Single-repo project; no external users at this stage, acceptable. |
| Orchestrator-routed messages add latency vs shared registry | Low | Low | Accept for M3a — simpler, one SoT. Profile post-M3a; if inbox delivery is hot, introduce direct worker-to-worker IPC in M4. |
| Inbox grows unbounded on zombied target | Medium | Medium | Per-agent cap (1000 messages); overflow evicts oldest and emits `inbox_overflow`. Heartbeat-driven `worker_stuck` already triggers SIGTERM in M3 (plumbed via M1). |
| Ancestor check is race-prone if worker exits during `task_stop` | Medium | Low | Orchestrator is single-threaded; ancestor map mutation and `task_stop` dispatch run on the same event loop tick. If target already exited, `task_stop` is a no-op with `{ status: "ok", note: "task already terminal" }`. |
| Retry cascades exhaust API quota | Medium | High | Exponential backoff caps at 30s; `TaskBudget.maxWallClockMs` hard-caps total attempt time at 3x the per-attempt ceiling; dead-letter file + non-zero exit forces operator attention. |
| Dead-letter silently lost if disk fills | Low | High | Single-writer discipline (same as results.jsonl); write errors emit `dead_letter_write_failure` lane event AND stderr log; orchestrator exits non-zero unless `--allow-dead-letter`. |
| Role allowlist bypass via engine's built-in tools (e.g., WebSearch enabled) | Medium | Medium | `RunConfig.allowedTools` filtering happens BOTH at tool dispatcher (our code) AND at `enabledBuiltinTools` assembly time. Reviewer role explicitly sets `enabledBuiltinTools: []`. Tested via scripted fixture. |
| System-prompt suffix ordering conflicts with base prompt | Low | Low | Role suffix appended AFTER base; last-writer-wins on model-perceived directives. Document this; test explicitly. |
| Broadcast to `role:*` sends to ex-role workers mid-role-change | Low | Low | Role is immutable for a worker's lifetime (set at spawn, not runtime-changed). Role-index entry removed on `worker_exited`. No mid-flight changes possible in M3a. |
| `check_inbox` busy-waits and wastes turns | Medium | Medium | 250ms timeout default; empty drain returns `[]` immediately. Model guidance in tool description: "call sparingly; inbox is push-delivered so you'll see tool_use_input interrupts for new messages." (Pure convention in M3a; push-interrupt is M4.) |
| Worker handoff to missing target role stalls | Medium | Medium | Handoff to non-existent role → immediate dead-letter with clear error. No indefinite wait for a role that isn't there. Tested. |
| `task_output` partial-stream mismatches engine chunking | Medium | Low | For M3a, `task_output` is snapshot-only (polling model). True streaming via `AsyncIterable` goes through `host.task.output()` in M3b, with explicit sync markers in the `text_delta` → registry pipeline. |
| Env var `SWARM_CODER_ROLE` collides with user env | Low | Low | Prefix `SWARM_CODER_` is already reserved by M1. No collision risk in practice. |
| Test count jumps too far (>60 delta breaks CI time) | Low | Low | Estimate range +32 to +60; mostly pure unit tests (<10ms each). Full suite already at ~15s; +60 tests at 50ms/test is +3s, still well under 30s CI target. |

## Verification steps

Run after each phase:

- **Phase 0:** `npx tsc --noEmit` clean.
- **Phase 1:** no-op.
- **Phase 2:** `npx vitest run src/swarm/policies.test.ts` green; existing `smoke-swarm.sh --offline` still green after fixture migration.
- **Phase 3:** `npx vitest run src/swarm/inbox.test.ts src/tools/tier2/send_message.test.ts src/tools/tier2/check_inbox.test.ts` green; integration test with 2 real subprocesses exchanging messages passes.
- **Phase 4:** `npx vitest run src/swarm/ancestry.test.ts src/tools/tier2/task_stop.test.ts src/tools/tier2/task_output.test.ts` green.
- **Phase 5:** `npx vitest run src/swarm/retry-policy.test.ts src/swarm/dead-letter.test.ts` green; integration test with forced-fail-then-succeed fixture passes.
- **Phase 6:** `npx vitest run src/swarm/roles.test.ts` green; full test suite 620+ green.
- **Phase 7:** `scripts/smoke-swarm-m3a.sh --offline` all pass; `scripts/smoke-swarm-m3a.sh` (live) all pass with valid auth; `scripts/smoke.sh --all` passes.

**End-of-M3a gate:** all 22 acceptance criteria verified, tagged `m3a-complete`.

## Estimated effort

| Phase | Effort | Delta vs rev 1 |
|---|---|---|
| 0 Interface refinements | 0.5 d | — |
| 1 Dependencies | 0.1 d | — |
| 2 Policy enums (discriminated unions + Zod) | 1 d | — |
| 3 Inter-agent messaging (send_message + check_inbox + inbox) | 1.5 d | — |
| 4 task_stop + task_output + ancestry | 1.5 d | +0.5 d (C3 spawnParents +0.25d; M8 appendOutput +0.25d) |
| 5 Retry + dead-letter | 1.15 d | +0.15 d (M7 CLI flags +0.15d) |
| 6 Team roles (registry + built-ins + wiring) | 1.1 d | +0.1 d (M7 --role flag +0.1d; M6 dispatcher allowlist is within existing scope) |
| 7 Smoke + docs + integration glue | 0.5 d | — |
| Buffer | 0.65 d | +0.25 d (grown to absorb rev 2 additions) |

**Total: ~7.0 engineer-days** (up from 5d). Additions: C3 spawnParents map (+0.25d), M8 appendOutput (+0.25d), M7 CLI flags (+0.25d total), buffer growth (+0.25d). Still within the 6-8 day extended target; if schedule pressure exists, drop order: handoff-kind EscalationPolicy (ship retry-only; handoff → M3b) → role broadcast (`role:<name>`, ship `*` and direct only) → custom-role loader (ship built-ins only).

## Open items to revisit during implementation

- **Streaming `task_output`.** M3a ships snapshot-only. M3b should decide whether to stream via AsyncIterable or a new lane-event fan-out. Open.
- **Role immutability.** M3a treats role as set-at-spawn, never-changed. If a use case for dynamic role switching surfaces (e.g., architect → executor mid-task), design a `swap_role` tool in M3b. Open.
- **Broadcast scoping.** `*` currently means "every live peer." Should we add `*:depth=<n>` or `*:descendants-of=<agentId>`? Not needed now. Revisit if broadcast gets abused.
- **Retry budget accounting precision.** Resolved in rev 2: `TaskBudget.maxWallClockMsPerAttempt` is now an explicit field (default `maxWallClockMs / 3`). Token budget is cumulative. No longer open.
- **Dead-letter replay.** M3a writes dead-letter.jsonl but has no replay command. `swarm-coder swarm replay dead-letter.jsonl` is a one-liner we might add if operators ask; otherwise leave for M4.
- **Role trust boundary.** `.swarm-coder/roles.json` is user-controlled — same trust boundary as M2 hooks. Signed role manifests are M5+. Document in the custom-role loader JSDoc.
- **IPC additions require version tag.** Every new request method breaks backward compat between orchestrator and worker at different versions. Add a `SWARM_CODER_IPC_VERSION` handshake? Not for M3a (single repo, single version shipped together); revisit at M4.
- **Handoff loop detection.** Role A handoffs to B; B handoffs to A. Currently no loop-detection. For M3a, lean on retry cap to stop the loop (each handoff counts as an attempt against the original task's EscalationPolicy). M3b: explicit handoff chain length cap.
- **Is `check_inbox` permission `"read"` right?** Resolved in rev 2: synchronous drain, no timeout. Sticking with `"read"` — inbox is agent-local state. Closed.
- **Depth ≥ 2 messaging.** Resolved in rev 2 as Option A (depth-1 only in M3a). Option B (forward via ParentTransport) deferred to M3a.1 or M3b. Closed for M3a.
- **`depths` and `spawnParents` map eviction.** Both maps are non-evicting in M3a (pre-existing behavior for `depths`; new `spawnParents` inherits same). Eviction on `worker_exited` is a documented TODO for M3b. Open.
- **`sub_agent_event` repurposing compatibility.** Now that `sub_agent_event` stub is load-bearing for inbox delivery, any future M3b use of that notification method must extend the `eventKind` discriminant rather than changing params shape. Document in protocol.ts JSDoc. Open.

## Cross-references

- Prereq scope: `docs/07-implementation-plan.md` §M3 (the four M3a items + explicit M3b out-of-scope list)
- Swarm model: `docs/05-swarm-model.md` (atomic agent + orchestrator contracts, lane events, TaskPacket)
- Interface contracts: `src/swarm/host.ts`, `src/swarm/events.ts`, `src/swarm/ipc/protocol.ts`
- Prior milestones: `docs/09-m1-plan.md` (swarm — landed), `docs/10-m2-plan.md` (UI depth — landed at `3b17fbd`)
- Research: `docs/research/05-swarm.md` §2 (task registry), §4 (subprocess env), §5 (lane events), §9 (ask_user_question anti-pattern — informs send_message real-delivery requirement)
- Anti-patterns refused: `docs/07-implementation-plan.md` §"What we explicitly refuse to copy from claw" items #6 (roleless TeamRegistry — M3a ships real roles) and #7 (echoing SendUserMessage — M3a delivers)

## Revision history

- **rev 1 (2026-04-20):** initial draft. Four scope/mechanism decisions locked: (1) orchestrator-routed message delivery over shared registry — simpler, single SoT, fits existing transport graph; (2) inbox in-memory-per-live-agent, flushed on exit, no respawn-redelivery — avoids persistence work that belongs with M3b file-backed registry; (3) `task_stop` permission model: orchestrator unconditional, peers only for descendants — cheap ancestor check against existing depth map; (4) retry wall-clock: per-attempt reset with 3x hard cap — prevents silent budget multiplication. Out-of-scope items explicitly enumerated: git coordination, prompt caching, parallel tool execution, notebook_edit, ask_user_question via SwarmHost, server-side preflight — all deferred to M3b. Total effort 5d, sits in 4-6d target.

- **rev 2 (2026-04-21):** applied critic findings (3 critical, 9 major, 7 minor). Key changes: **C1** — Phase 0.2 rewritten to wire EXISTING `SpawnRequest.role`/`allowedTools` fields (pre-provisioned in M1) end-to-end rather than treating them as new; **C2** — added Decision context #5 locking depth-1 messaging only (Option A); depth ≥ 2 returns explicit error, Option B (ParentTransport forwarding) deferred to M3a.1/M3b; **C3** — added Phase 4.2a to maintain `spawnParents: Map<AgentId, AgentId>` alongside `depths`, with eviction documented as TODO (not implemented in M3a, +0.25d); **M1** — added Phase 0.0 widening `SwarmHost.send` to `AgentId | "*" | \`role:${string}\`` with `SendResult`; **M2** — inbox overflow semantics specified: FIFO strict, evict oldest, sender receives `SendResult` with `partial: true`, `inbox_overflow` lane event per drop; **M3** — `sub_agent_event` stub repurposed for inbox delivery (cleaner, no new IPC method); **M4** — retry wall-clock resolved with explicit `TaskBudget.maxWallClockMsPerAttempt` field (default `maxWallClockMs / 3`), `maxWallClockMs` remains absolute ceiling; **M5** — token budget is cumulative across retries; exceeding `maxTokens` triggers immediate dead-letter; **M6** — added Phase 6.6a specifying tool filtering at dispatcher registration, orthogonal to `canUseTool`/`clampPermissionMode`; **M7** — Phase 5.5 and 6.7 expanded with `argv.ts` wiring details, test case counts, and AC; **M8** — added Phase 4.1a with `appendOutput()` method on TaskRegistry wired to `text_delta` events (+0.25d); **M9** — Phase 5.3 specifies append-mode (`flags: "a"`), `--allow-dead-letter` checks delta not total file size; minor fixes: N1 `RunConfig.allowedTools` commit explicit, N2 AC 22 unified to ≥ 10 cases, N3 `check_inbox` synchronous drain only (no timeout), N4 script renamed to `smoke-swarm-m3a.sh`, N5 role-index evicts on `worker_exited`, N6 `attempt` 0-indexed in backoff formula, N7 `ResultLine.stoppedBy` field noted. Total effort revised to ~7.0d (from 5d); buffer grown to 0.65d.
