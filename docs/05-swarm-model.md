# Swarm model

## Atomic agent contract

An atomic agent:

- Takes one task: a text prompt, plus optional file context and an optional task id
- Runs a conversation loop with access to Tier 0 tools at minimum
- Emits a final result: text, structured output, or a task-completion signal
- Persists a session so it can resume or be inspected
- In worker mode: emits JSONL events on stdout during the run

The atomic agent is the product. It must stand alone — runnable from a terminal with no orchestrator required.

## Orchestrator contract

An orchestrator:

- Accepts a swarm request: task list, optional topology, shared config
- Spawns N atomic agents, each bound to a task (or a team role)
- Routes messages between agents via `SwarmHost`
- Collects results and returns aggregate output
- Handles failure policy (retry, reassign, abort)

The orchestrator is **not** the product. It is a consumer of the product. Anyone can write their own.

## v0 swarm minimum

Simplest useful orchestrator: a task-fanout runner.

```
orchestrator
  ├─ input:  tasks.jsonl   (one task per line)
  ├─ for each task: spawn subprocess `swarm-coder --headless --task-file=<tmp>`
  ├─ tail each subprocess's JSONL events, forward to console
  └─ output: results.jsonl (one result per task)
```

No team roles, no inter-agent messaging, no retry policy. Just parallel execution. Enough to prove the atomic-unit contract holds under spawn pressure.

## Communication

Parent ↔ worker uses JSONL over stdio by default. Every event carries:

```ts
{
  ts: number;           // epoch ms
  agentId: string;
  type: string;         // see event catalog below
  payload: unknown;
  fingerprint?: string; // for dedup (ported from claw's lane_events.rs)
  provenance?: string;  // which component emitted this
}
```

Future transports (unix socket, shared message bus, NATS) slot in behind the `SwarmHost` interface without changing tool code. That is the whole point of the interface.

### Lane event catalog

Ported near-verbatim from claw's `rust/crates/runtime/src/lane_events.rs` (research/05-swarm.md §5). Names and failure taxonomy stay the same; we gain interop with claw-ecosystem observers.

Event types (non-exhaustive — full list ported to `src/core/events.ts`):

- **Lifecycle:** `worker_spawned`, `worker_ready`, `worker_exited`, `worker_crashed`
- **Turn:** `turn_start`, `turn_end`, `message_stop`
- **Text / tool:** `text_delta`, `tool_use_start`, `tool_use_input`, `tool_use_end`, `tool_result`
- **Task:** `task_created`, `task_updated`, `task_completed`, `task_failed`, `task_stopped`
- **Permission:** `permission_prompt`, `permission_granted`, `permission_denied`
- **Coordination:** `branch_locked`, `branch_unlocked`, `stale_base_detected`, `message_sent`, `message_received`
- **User loop:** `question_asked`, `answer_received`
- **Error:** `error` with structured failure class (`transport`, `provider`, `permission`, `tool`, `timeout`, `panic`)

### TaskPacket shape

Structured task format (research/05-swarm.md §2). Claw ships `branch_policy` / `commit_policy` / `escalation_policy` as free-form strings that are just hints to the model. **Ours are discriminated-union records enforced at runtime (M3a Phase 2):**

```ts
type BranchPolicy =
  | { kind: "none" }
  | { kind: "reuse"; branch: string }
  | { kind: "create"; from: string; name?: string };

type CommitPolicy =
  | { kind: "none" }
  | { kind: "auto"; message?: string }
  | { kind: "atomic" };

type EscalationPolicy =
  | { kind: "none" }
  | { kind: "retry"; max: number; backoff: "fixed" | "exponential" }
  | { kind: "handoff"; targetRole: string };

interface TaskPacket {
  id: string;
  prompt: string;
  branchPolicy: BranchPolicy;
  commitPolicy: CommitPolicy;
  escalationPolicy: EscalationPolicy;
  budget?: { maxTurns?: number; maxTokens?: number; maxWallClockMs?: number; maxWallClockMsPerAttempt?: number };
  context?: { files?: string[]; parentTaskId?: string };
  role?: string;  // optional role name — applied by orchestrator at dispatch time (M3a Phase 6)
}
```

The Zod schemas live in `src/swarm/policies.ts`. Legacy flat strings (`"main"`, `"worktree"`, `"never"`, `"abort-on-error"`, etc.) are rejected at CLI parse time with a migration hint. See `docs/11-m3a-plan.md §Policy migration` for the before/after table.

### Worker state file

Each worker writes an atomic state file at `.swarm-coder/workers/<agentId>.json` (pattern borrowed from claw's `.claw/worker-state.json`). Orchestrator reads this for crash recovery — if a worker dies without emitting a final event, the state file is the last known good record.

## Failure model

- A worker crash does not take down the orchestrator — subprocess isolation is the default specifically for this.
- Worker timeout is enforced by the orchestrator, not the worker itself.
- A worker that violates its permission mode aborts and emits a final `error` event.
- Partial results are preserved — the session log is the source of truth. Orchestrator can resume a failed worker via `--resume <session-id>`.

## Identity

Every atomic agent has an `agentId` assigned at spawn time. It is:

- Stable for the agent's lifetime
- Used as the inbox address for `send_message`
- Logged on every event
- Passed via env `SWARM_CODER_AGENT_ID` to subprocess workers
- Propagated through to the session log header

## Team roles (deferred to M3)

At M3, orchestrators may assign roles: `architect`, `executor`, `reviewer`, `critic`. A role is a name + system-prompt overlay + tool allowlist. Roles do not change the atomic-agent binary — they are parameters passed at spawn time.

**Why not copy claw's `TeamRegistry`:** it stores only `{name, [task_id]}` with no roles, no allowlists, no system-prompt overlays (research/05-swarm.md §3). We ship teams with real semantics or not at all.

## Git-based coordination (M3)

Multi-agent swarms writing to the same git working tree need coordination to avoid stepping on each other. Claw has three small, pure, well-tested modules (research/05-swarm.md §6) we port near-verbatim:

- **`branch_lock`** — advisory lock on a branch; prevents two workers from concurrently committing to the same branch. Uses a lock file under `.swarm-coder/locks/<branch>.lock` with atomic-create semantics and stale-lock eviction.
- **`stale_base`** — detects when a worker's base commit has diverged from the current branch tip. Orchestrator decides: rebase, abort, or escalate.
- **`stale_branch`** — detects when a workspace test was run against a branch that has since moved. Blocks bash preflight on stale state.

These are the only parts of claw's coordination layer we import directly.

## Anti-patterns we reject

From claw-code research (05-swarm.md §3, §9; see `07-implementation-plan.md` for the full list):

- **Thread-based sub-agents** — claw's `Agent` tool spawns `std::thread`. We use subprocess.
- **Global `OnceLock` registries** — fine for one process, hostile to subprocess workers. Our registries are per-runtime with explicit IPC.
- **`CronRegistry` with no scheduler** — we don't ship cron until a real scheduler exists.
- **`TeamRegistry` with no roles** — we don't ship teams without system-prompt overlays and tool allowlists.
- **`SendUserMessage` that echoes** — no delivery mechanism in claw. We deliver or we skip.
- **`AskUserQuestion` that blocks stdin** — unusable from threads or headless. Ours routes via SwarmHost lane events.

## Resource accounting

Each worker's usage (input tokens, output tokens, cache hits, wall-clock) is reported on `message_stop` and aggregated by the orchestrator. The orchestrator is responsible for budget enforcement; the atomic agent is not.
