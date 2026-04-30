# 05 · Swarm primitives in claw-code (Rust)

Slice extracted for swarm-harness's orchestrator / `SwarmHost` design. Source: `references/claw-code/rust/crates/runtime/src/*` plus the Tier 2/3 tool sections of `crates/tools/src/lib.rs`.

## 1. Summary

claw-code ships a **per-process, in-memory** swarm substrate. Four `OnceLock`-backed singletons — `TaskRegistry`, `TeamRegistry`, `CronRegistry`, `WorkerRegistry` — hold lifecycle state; tools are thin JSON wrappers over those registries. The "swarm" lives entirely inside one `claw` process: there is no cross-process broker, no persistent store, no scheduler daemon. Sub-agents are spawned as **threads** that run a nested `ConversationRuntime`, not subprocesses. Workers (the only subprocess-aware abstraction) are driven by an *observe-terminal-text* state machine rather than a structured JSONL protocol — they are aimed at detecting another interactive coding CLI and recovering when a prompt is misdelivered, not at running headless JSONL workers.

The Git-coordination primitives (`branch_lock`, `stale_base`, `stale_branch`) are the most reusable layer: small, pure, testable. The `lane_events` catalog is a mature event vocabulary we can borrow nearly verbatim. Everything above the registry layer (cron, team, remote) is either a stub or a single-process shim.

Key implication for swarm-harness: keep claw-code's **data models** (TaskPacket, lane event names, Worker lifecycle states, BranchLock collision detection) but replace the **transport** (threads + in-memory registries + screen-scraping) with subprocess JSONL and a `SwarmHost` interface that allows future swap to a real bus.

## 2. Task model — registry, packet, lifecycle, dispatch

### 2.1 `Task` (runtime/src/task_registry.rs)

```rust
pub struct Task {
  task_id: String,          // "task_{ts_hex}_{counter}"
  prompt: String,
  description: Option<String>,
  task_packet: Option<TaskPacket>,     // optional structured form
  status: TaskStatus,       // Created | Running | Completed | Failed | Stopped
  created_at: u64, updated_at: u64,
  messages: Vec<TaskMessage>,          // user nudges appended via task_update
  output: String,           // append-only string buffer
  team_id: Option<String>,  // assigned by team_create
}
```

Lifecycle: **Created → Running → {Completed | Failed | Stopped}**. Terminal states reject further `stop()`. `set_status` is caller-controlled — the registry does not drive transitions itself (dispatch is the tool caller's job).

Output is a **single `String` buffer**, appended via `append_output`. There is no stream abstraction, no backpressure, no chunked frame. That is a deliberate simplification, but it means a "live tail" on another agent requires polling `TaskOutput`.

### 2.2 `TaskPacket` (runtime/src/task_packet.rs)

The richer wire form of a task:

```rust
struct TaskPacket {
  objective: String,
  scope: TaskScope,          // Workspace | Module | SingleFile | Custom
  scope_path: Option<String>,// required for non-Workspace
  repo: String,
  worktree: Option<String>,
  branch_policy: String,     // free-form string, e.g. "origin/main only"
  acceptance_tests: Vec<String>,       // shell commands
  commit_policy: String,
  reporting_contract: String,
  escalation_policy: String,
}
```

Validation: `validate_packet` enforces non-empty required fields and scope_path when scope is non-Workspace. Everything else is a free-form string — the contracts (branch_policy, commit_policy, escalation_policy) are **instructions to the agent**, not enforced by the runtime.

### 2.3 Dispatch

There is no dispatcher. `TaskCreate` only writes to the registry. No worker is spawned by `task_create` — the agent is expected to poll `TaskList`/`TaskGet`. The only path that actually *runs* a task is the `Agent` tool, which writes a separate store (§8). Task and Agent registries are not linked.

## 3. Team & cron model

### 3.1 `Team` (runtime/src/team_cron_registry.rs)

```rust
struct Team {
  team_id: String, name: String,
  task_ids: Vec<String>,               // references into TaskRegistry
  status: TeamStatus,                  // Created | Running | Completed | Deleted
  created_at, updated_at,
}
```

`TeamCreate` accepts a `name` and an array of **task objects** (not task IDs) but `run_team_create` only extracts `task_id` fields — so the tool as written requires you to have already called `TaskCreate`. No roles, no member-to-role mapping, no system-prompt overlays. This is a stub for swarm-harness's concept of "team roles."

Delete is a **soft delete** (sets status = Deleted) via `delete`; `remove` is the hard path. `TeamDelete` uses the soft path.

### 3.2 `CronEntry`

```rust
struct CronEntry {
  cron_id: String,
  schedule: String,           // free-form (not parsed)
  prompt: String, description: Option<String>,
  enabled: bool,
  created_at, updated_at,
  last_run_at: Option<u64>, run_count: u64,
}
```

**Cron is a registry, not a scheduler.** No process parses `schedule`, no background task evaluates it. The only runtime usage is `disable_matching_crons` in the agent finalizer: when a sub-agent completes referencing a ROADMAP item, any cron whose prompt/description mentions that item gets disabled (a clean-up hack). The schedule string is never interpreted.

## 4. Worker boot & subprocess protocol (worker_boot.rs)

Contrary to what its name suggests, `WorkerRegistry` does **not** spawn subprocesses. It tracks the state of an *external* interactive coding CLI (e.g. another `claw`/`opencode` process) that someone else spawned (typically via tmux/terminal). Worker lifecycle is driven by feeding observed **screen text** into `observe()`.

### 4.1 States
`Spawning → TrustRequired → ReadyForPrompt → Running → {Finished | Failed}`.

### 4.2 Detection
- **Trust prompt** regexes: "do you trust the files in this folder", "yes, proceed", etc. Auto-resolved if `cwd` matches `trusted_roots`, else requires `resolve_trust`.
- **Ready-for-prompt**: matches "ready for input", a final line equal to `>`, `›`, `❯`, or a boxed `│ >` prompt — and explicitly rejects plain shell prompts (`$`, `%`, `#`).
- **Prompt misdelivery**: compares expected prompt snippet against observed shell output. Three classes: `Shell` (landed in zsh/bash), `WrongTarget` (cwd mismatch), `WrongTask` (expected `WorkerTaskReceipt` tokens not visible on screen). If `auto_recover_prompt_misdelivery`, the worker state becomes `ReadyForPrompt` again with `replay_prompt` armed.
- **Startup no-evidence**: timeout path emits a `StartupEvidenceBundle` (transport/mcp health, last lifecycle state, prompt_sent_at, elapsed_seconds) and classifies into `TransportDead | TrustRequired | PromptAcceptanceTimeout | PromptMisdelivery | WorkerCrashed | Unknown`.
- **Completion**: `observe_completion(finish_reason, tokens_output)` — classifies `finish=unknown && tokens=0` as a provider-degraded failure.

### 4.3 Side-effect: state file

Every state transition writes `{cwd}/.claw/worker-state.json` atomically (tmp + rename) with `worker_id, status, is_ready, trust_gate_cleared, prompt_in_flight, last_event, seconds_since_update`. This is the **file-based observability surface** — external orchestrators poll this instead of hitting an HTTP endpoint.

### 4.4 `WorkerTaskReceipt`
```rust
struct WorkerTaskReceipt {
  repo, task_kind, source_surface, objective_preview: String,
  expected_artifacts: Vec<String>,
}
```
Expected on the worker's screen so `WrongTask` can be detected.

### 4.5 Relevance to swarm-harness

Almost none of this maps directly. swarm-harness's worker is a subprocess we own, talking JSONL over stdio — we do not need to parse terminal text. What *is* reusable:
- The **lifecycle state machine** (Spawning / Ready / Running / Finished / Failed).
- The **StartupEvidenceBundle** pattern — ship a structured cause object on timeout failure.
- The **atomic state-file pattern** (tmp + rename) for file-based observability.

## 5. Lanes & events (lane_events.rs)

This is the most mature file in the slice and the one I'd borrow most directly.

### 5.1 Event names (wire strings)
`lane.started | lane.ready | lane.prompt_misdelivery | lane.blocked | lane.red | lane.green | lane.commit.created | lane.pr.opened | lane.merge.ready | lane.finished | lane.failed | lane.reconciled | lane.merged | lane.superseded | lane.closed | branch.stale_against_main | branch.workspace_mismatch | ship.prepared | ship.commits_selected | ship.merged | ship.pushed_main`

### 5.2 Event envelope
```rust
struct LaneEvent {
  event: LaneEventName, status: LaneEventStatus,
  emitted_at: String,        // ISO 8601
  failure_class: Option<LaneFailureClass>,
  detail: Option<String>,
  data: Option<Value>,
  metadata: LaneEventMetadata,   // seq, provenance, session_identity, ownership, nudge_id, fingerprint, ts_ms
}
```

### 5.3 Failure taxonomy
`prompt_delivery | trust_gate | branch_divergence | compile | test | plugin_startup | mcp_startup | mcp_handshake | gateway_routing | tool_runtime | workspace_mismatch | infra`. This is a directly-borrowable vocabulary; swarm-harness should adopt it almost verbatim in our `events/lane.ts`.

### 5.4 Provenance
`live_lane | test | healthcheck | replay | transport` — important for deduping events that came from replay vs. real execution.

### 5.5 Dedup
- `dedupe_terminal_events`: hash-based fingerprint on (event, status, data) — keeps only first terminal event per fingerprint in a reconciliation window.
- `dedupe_superseded_commit_events`: collapses multiple `lane.commit.created` by `canonicalCommit` key and drops anything flagged `supersededBy`.

Neither dedup is invoked automatically — they are helpers the caller applies when reading history.

There is **no producer-consumer channel.** Events are constructed with `LaneEventBuilder` and stored on the `AgentOutput` manifest. No subscription API.

## 6. Git-based coordination

### 6.1 branch_lock.rs
Tiny pure module. `detect_branch_lock_collisions(&[BranchLockIntent])` returns collisions where two lanes want to work on the *same branch* and *overlapping modules*. Module overlap is prefix-based (`runtime` and `runtime/mcp` collide on `runtime`). Output is `{branch, module, lane_ids}` sorted and deduped. 100% data; no locking, no file I/O. **Directly portable.**

### 6.2 stale_base.rs
Compares current HEAD against an expected base commit. Expected base comes from either a `--base-commit` flag or a `.claw-base` file in cwd. Returns `Matches | Diverged{expected, actual} | NoExpectedBase | NotAGitRepo`. Shells out to `git rev-parse`. Also provides a human-readable warning formatter.

### 6.3 stale_branch.rs
Compares a branch against a main ref. Returns `Fresh | Stale{commits_behind, missing_fixes} | Diverged{ahead, behind, missing_fixes}` using `git rev-list --count A..B` and `git log --format=%s B..A`. Policy engine `apply_policy` maps freshness → `Noop | Warn | Block | Rebase | MergeForward`. Policies are one of `AutoRebase | AutoMergeForward | WarnOnly | Block`.

Note: `apply_policy` returns **intents** (`Rebase`, `MergeForward`); no code in the slice actually performs the rebase/merge. That's the caller's job.

These three files are small, pure (except for git shell-out), well-tested, and worth porting mostly verbatim to TypeScript.

## 7. Remote triggers

### 7.1 `RemoteTrigger` tool (tools/src/lib.rs §1128, §1746)
Nothing remote-agent-specific. It's an HTTP client: input is `{url, method, headers, body}` with a 30-second timeout using `reqwest`. Truncates body at 8192 bytes. Supports GET/POST/PUT/DELETE/PATCH/HEAD. **It's a webhook tool, not agent RPC.**

### 7.2 `remote.rs`
This file is about **upstream HTTPS proxy bootstrap for claw-code's own outbound traffic when running on ccr (Claude Code Remote)**, not about remote-agent invocation. It reads env vars (`CLAUDE_CODE_REMOTE`, `CLAUDE_CODE_REMOTE_SESSION_ID`, `CCR_SESSION_TOKEN_PATH`, `CCR_CA_BUNDLE_PATH`), builds a WebSocket proxy URL, and produces subprocess env (`HTTPS_PROXY`, `SSL_CERT_FILE`, `NO_PROXY`, etc.) for child processes. Scope: **out of scope for our SwarmHost.** Unrelated to orchestrator contract.

### 7.3 Python remote_runtime
`references/claw-code/src/remote_runtime.py` exists (confirmed) but is outside our Rust slice and outside the multi-agent product thesis. Skip.

**Bottom line on "remote":** claw-code has no real remote-agent transport. It has a webhook hammer and an ops-time HTTP proxy. swarm-harness's `remote_trigger` spec can be exactly this — a typed HTTP webhook. Real remote-agent invocation is a future design.

## 8. Sub-agent spawn (Agent tool, tools/src/lib.rs §572, §2113, §3477)

```rust
struct AgentInput {
  description: String,       // required
  prompt: String,            // required
  subagent_type: Option<String>, // "Explore" | "Plan" | "Verification" | "claw-guide" | "statusline-setup" | other → default
  name: Option<String>,
  model: Option<String>,     // default: DEFAULT_AGENT_MODEL = "claude-opus-4-6"
}
```

### 8.1 Flow
1. Generate `agent_id = "agent-{nanos}"`.
2. Create `.clawd-agents/` store (overridable by `CLAWD_AGENT_STORE` env). Write `.md` transcript + `.json` manifest.
3. Spawn a **std::thread** named `clawd-agent-{id}` (NOT a subprocess).
4. Thread builds its own `ConversationRuntime` with a `SubagentToolExecutor`, a filtered system prompt ("You are a background sub-agent of type `{X}`. Work only on the delegated task…"), and a per-type tool allowlist.
5. Thread calls `runtime.run_turn(prompt, None)` with `DEFAULT_AGENT_MAX_ITERATIONS = 32`.
6. On completion: `persist_agent_terminal_state` writes status + result + blocker classification + derived_state + ISO timestamp back to the manifest.
7. On panic: caught via `catch_unwind` and manifest is marked failed.

### 8.2 Returned immediately to caller (`AgentOutput`)
```rust
{
  agentId, name, description, subagentType, model,
  status: "running",
  outputFile: "…/agent-{id}.md",
  manifestFile: "…/agent-{id}.json",
  createdAt, startedAt, completedAt?,
  laneEvents: [lane.started],
  currentBlocker?, derivedState, error?
}
```

Parent observes progress by re-reading manifestFile. There is **no live streaming** from sub-agent back to parent.

### 8.3 Tool allowlists (per subagent_type)
- `Explore`: read-only research (read_file, glob, grep, WebFetch, WebSearch, ToolSearch, Skill, StructuredOutput)
- `Plan`: Explore + TodoWrite + SendUserMessage
- `Verification`: bash + reads + WebFetch/Search + TodoWrite + SendUserMessage + PowerShell
- `claw-guide`: Explore + SendUserMessage
- `statusline-setup`: bash + full file ops + glob/grep + ToolSearch
- default (general-purpose): bash + full file ops + web + TodoWrite + Skill + ToolSearch + NotebookEdit + Sleep + SendUserMessage + Config + StructuredOutput + REPL + PowerShell

### 8.4 `derive_agent_state`
Rule-based classifier that reads status/result/error and returns one of `working | finished_cleanable | finished_pending_report | blocked_background_job | blocked_merge_conflict | degraded_mcp | interrupted_transport | truly_idle`. This is a nice UX signal for an orchestrator's dashboard.

### 8.5 Critical caveat
The Agent tool runs sub-agents as **in-process threads sharing API client state**. This is wrong for swarm-harness's thesis ("one agent is a tool, N coordinated agents is the product"). swarm-harness must use real subprocesses for the isolation property — a worker crash must not take down the parent.

## 9. Messaging (SendMessage, AskUserQuestion)

### 9.1 `AskUserQuestion` (Tier 3)
```rust
{ question: String, options: Option<Vec<String>> }
```
Implementation (§1327): writes the question to stdout, reads a line from stdin, resolves numeric choice against options if provided. Blocks the current thread on stdin. Returns `{question, answer, status: "answered"}`.

This is **strictly single-process, single-user, single-thread**. It can't work from a sub-agent thread (competing for stdin), and it can't work under the `Agent` tool allowlist (it's not whitelisted for any subagent_type). For swarm-harness this is orchestrator-only — our `ask_user_question` must route back to the root TUI/CLI through `SwarmHost`.

### 9.2 `SendUserMessage` / `Brief`
```rust
{ message: String, attachments?: Vec<String>, status: "normal" | "proactive" }
```
Implementation (`execute_brief`, §5239): **just validates the input and echoes back `{message, attachments, sent_at}`**. No actual delivery mechanism. This is the claw-code way for a sub-agent to "tell the user something" — but the wire-up to actually display it lives in the CLI layer, not the tool layer.

### 9.3 Missing: agent-to-agent SendMessage
**There is no `SendMessage`/`send_message` tool in claw-code.** Agents cannot directly address each other. The only communication channels are:
1. Parent calls `TaskUpdate(task_id, message)` to append a user message to a task.
2. Agents read task messages via `TaskGet`.
3. Agents read peer outputs via `TaskOutput` (polling, not push).

This is the biggest gap vs. what the 04-tool-tiers.md doc describes (`send_message` + `check_inbox` by agentId). swarm-harness designs this fresh.

## 10. Requirements for swarm-harness

### v0
- [v0] **Port TaskPacket shape** (objective, scope, scope_path, repo, worktree, branch_policy, acceptance_tests, commit_policy, reporting_contract, escalation_policy) and validator. Treat the *_policy fields as strings surfaced into the agent's system prompt.
- [v0] **TaskRegistry lifecycle** (Created / Running / Completed / Failed / Stopped) — in-memory Map is fine for MVP. Terminal states reject further transitions.
- [v0] **agentId convention** stable for an agent's lifetime; passed via env (`SWARM_HARNESS_AGENT_ID` per 05-swarm-model.md) and present on every lane event. Ours, not claw-code's.
- [v0] **Atomic state file** at `{cwd}/.swarm-harness/worker-state.json` (tmp + rename) — this is claw-code's observability pattern and is cheap to adopt.
- [v0] **Lane event wire names** — borrow claw-code's catalog wholesale (§5.1): `lane.started`, `lane.ready`, `lane.finished`, `lane.failed`, `lane.blocked`, `lane.red`/`green`, `lane.commit.created`. Defer ship.* until we have a shipper.
- [v0] **LaneFailureClass** — adopt verbatim (§5.3), plus add `worker_crash` for subprocess isolation failures that have no claw-code analog.
- [v0] **branch_lock collision detection** — port `detect_branch_lock_collisions` as-is to TS. Pure, tested, small.
- [v0] **stale_base** — port including `.swarm-base` file pattern (rename from `.claw-base`).
- [v0] **stale_branch** — port check + policy split. Emit `Rebase` / `MergeForward` as intents; do **not** auto-execute.
- [v0] **Atomic agent contract** already defined in our 05-swarm-model.md is strictly better than claw-code's: claw-code spawns threads, we spawn subprocesses. Keep our direction.

### v1
- [v1] **WorkerRegistry state machine** but adapted: drop screen-text detection entirely; drive transitions from JSONL events on the worker's stdout. States: Spawning → Ready → Running → {Finished | Failed}. Skip TrustRequired (we control the worker binary).
- [v1] **StartupEvidenceBundle** pattern — when a worker fails to emit any JSONL within a timeout, the orchestrator surfaces a structured `startup_no_evidence` with (transport_healthy, last_event_seen_ms_ago, pid_alive, stderr_tail) and a classification.
- [v1] **TeamRegistry + role overlays** — but designed fresh. claw-code's Team is a stub; it does not carry roles, system-prompt overlays, or tool allowlists. Our v1 Team should carry `members: [{agentId, role, systemPromptOverlay, toolAllowlist}]`.
- [v1] **Per-subagent tool allowlists** — borrow the Explore/Plan/Verification archetype (§8.3) as a starting set of named roles.
- [v1] **ask_user_question via SwarmHost** — worker emits a structured question event; parent TUI prompts and replies via stdin to the worker. Do not port claw-code's blocking stdin impl.
- [v1] **send_message / check_inbox** — design fresh. claw-code has no agent-to-agent channel; 04-tool-tiers.md already lists both.
- [v1] **derive_agent_state** — adopt as a computed orchestrator-side signal: `working | finished_cleanable | finished_pending_report | blocked_merge_conflict | degraded_mcp | interrupted_transport | truly_idle`. It's rule-based and cheap.

### later
- [later] **Event dedup helpers** — port `dedupe_terminal_events` (fingerprint = hash of event+status+data) and `dedupe_superseded_commit_events`. Useful when consolidating logs, not critical for MVP.
- [later] **Event provenance tags** (`live_lane | test | healthcheck | replay | transport`) — helpful for test harnesses.
- [later] **`remote_trigger` as an HTTP webhook tool** — claw-code's design is sufficient (URL + method + headers + body + 30s timeout + 8KB truncation). Keep it as a Tier 3 network tool, not a remote-agent mechanism.

### skip
- [skip] **claw-code's `Agent` tool as thread spawn.** Architecturally wrong for us — we need subprocess isolation.
- [skip] **Worker screen-text detection.** Solves the wrong problem (controlling someone else's interactive CLI).
- [skip] **remote.rs upstream proxy bootstrap.** Deployment concern, not product.
- [skip] **CronRegistry as shipped** — it's a store with no scheduler. If we want cron, we design it (node-cron or a daemon), not port a stub.
- [skip] **`disable_matching_crons` roadmap-item heuristic.** It's a brittle string-match hack on cron prompts triggered by agent completion; does not generalize.
- [skip] **Soft-delete on teams.** Hard-delete is fine for our scope.
- [skip] **TaskRegistry.messages (user nudges via TaskUpdate).** Our inter-agent story is `send_message` directly addressed by agentId; piggybacking on task messages is a claw-code shortcut.

## 11. Open questions

1. **Is `SwarmHost` a single object per-process or per-agent?** The shape of TaskRegistry singleton suggests per-process would be simplest, but it fights subprocess isolation — two workers in different subprocesses need to share a task registry through some IPC. Decision affects whether `task_create` in a worker writes locally + ships an event, or RPCs to the parent.
2. **Where does the task registry live across processes?** Options: (a) parent-owned, workers RPC in via JSONL requests; (b) file-backed under `.swarm-harness/tasks/*.json`; (c) no cross-process task registry in v0 — only `agent_id` + lane events. claw-code punts (single-process only); we must decide.
3. **Do we carry `TaskPacket` at v0 or only `{prompt, description}`?** 04-tool-tiers.md v0 subset lists only `task_create/get/list/update`. Packet is richer but over-specified for a fanout MVP. Lean: v0 free-form, v1 packet.
4. **Lane event transport — stream vs. batch?** claw-code stores events on the agent manifest (batch + reread). We should stream via JSONL stdout in worker mode; orchestrator accumulates.
5. **Do we adopt `workflow_scope` from `LaneOwnership`?** claw-code uses strings like `claw-code-dogfood` to partition events for watchers. For multi-tenant swarm runs this is useful; for MVP likely overkill.
6. **Branch lock enforcement model.** `detect_branch_lock_collisions` is pure — who runs it, at spawn time or continuously? Spawn time gating is simpler; continuous check requires an orchestrator-side reconciliation loop.
7. **AskUserQuestion when no human is attached.** Headless orchestrator runs have no TUI to answer. Policy: reject-on-no-human, timeout-reject, or fallback answer? claw-code blocks forever on stdin.
8. **How do we handle sub-agent output streaming?** claw-code gives parents only manifest-polling. We committed to JSONL streaming in 05-swarm-model.md — what event shape do worker-spawned sub-agents emit back to their parent worker?

## 12. File references

Slice files (all absolute):

- /Users/alexngai/GitHub/swarm-harness/references/claw-code/rust/crates/runtime/src/task_registry.rs
- /Users/alexngai/GitHub/swarm-harness/references/claw-code/rust/crates/runtime/src/task_packet.rs
- /Users/alexngai/GitHub/swarm-harness/references/claw-code/rust/crates/runtime/src/team_cron_registry.rs
- /Users/alexngai/GitHub/swarm-harness/references/claw-code/rust/crates/runtime/src/worker_boot.rs
- /Users/alexngai/GitHub/swarm-harness/references/claw-code/rust/crates/runtime/src/lane_events.rs
- /Users/alexngai/GitHub/swarm-harness/references/claw-code/rust/crates/runtime/src/branch_lock.rs
- /Users/alexngai/GitHub/swarm-harness/references/claw-code/rust/crates/runtime/src/stale_base.rs
- /Users/alexngai/GitHub/swarm-harness/references/claw-code/rust/crates/runtime/src/stale_branch.rs
- /Users/alexngai/GitHub/swarm-harness/references/claw-code/rust/crates/runtime/src/remote.rs (upstream proxy bootstrap; not agent-RPC)

Tool sections in `/Users/alexngai/GitHub/swarm-harness/references/claw-code/rust/crates/tools/src/lib.rs`:

- Agent tool spec: L572–587; input struct L2305–2312; `execute_agent_with_spawn` L3481–3559; thread spawn L3561–3586; allowlists L3642–3721
- AskUserQuestion: spec L729–745; impl L1327–1375; input L2404–2409
- TaskCreate/Get/List/Stop/Update/Output: specs L747–854; impls L1378–1489
- RunTaskPacket: spec L760–791 (bonus — takes a full packet)
- Worker* (Create/Get/Observe/ResolveTrust/AwaitReady/SendPrompt/Restart/Terminate/ObserveCompletion): specs L856–995; impls L1492–1568
- TeamCreate/Delete: specs L997–1032; impls L1571–1603
- CronCreate/Delete/List: specs L1034–1070; impls L1606–1653
- RemoteTrigger: spec L1128–1142; impl L1746–1806
- SendUserMessage/Brief: spec L633–652; impl L5239–5264
- Global singletons: L47–69
- `disable_matching_crons`: L4306–4328
- `derive_agent_state`: L4346–4385
- `agent_store_dir` / `make_agent_id`: L4991–5008
- Dispatch table: L1230–1284

Out of slice but flagged:
- /Users/alexngai/GitHub/swarm-harness/references/claw-code/src/remote_runtime.py — Python, skipped
