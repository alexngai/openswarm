# 46 — Sessionlog trajectory ingest (Layer 0) + MAP trajectory delivery

Status: **design / Layer 0 kickoff**
Related: `docs/45-adaptive-orchestration-design.md`, the memory system (`src/memory/*`)

## Goal

Make swarm-harness's **worker agent sessions** recordable as trajectories so the
swarmkit learning loop (cognitive-core → playbooks → skills) can distill them.
Today swarm-harness *consumes* skills/memory at every turn (done — `enrichTurnInputs`
at all four engine-run sites) but produces **no ingestable trajectory** of its own
agents' work. This closes the producer side.

## Why sessionlog

cognitive-core's `trajectory-sources/entire.ts` reads **sessionlog** checkpoints;
the reference integration (`GitHub/claude-code-swarm`) is sessionlog-centric end
to end. So the ecosystem-native trajectory format is sessionlog, and recording our
workers there feeds cognitive-core **directly, out-of-band** — no MAP required for
batch distillation. MAP trajectory delivery (below) is an additive live-push layer.

## The reference: claude-code-swarm

Two pieces, both directly mirrorable:

- **Emit** (`map-connection.mjs`, `sidecar-server.mjs`): connect with
  `capabilities: { trajectory: { canReport: true } }`, then
  `callExtension("trajectory/checkpoint", { checkpoint, resource_id? })`; cache the
  server's returned `resource_id`; **fall back to a broadcast `trajectory.checkpoint`
  message** if the extension is unsupported.
- **Content provider** (`content-provider.mjs`): `provideContent(checkpointId) →
  { metadata, transcript, prompts, context }`, served on demand from sessionlog
  (live `transcriptPath` JSONL + committed `createCheckpointStore().readSessionContent()`).

Crucially, claude-code-swarm only **reads** sessionlog state — sessionlog's own
**Claude Code hooks** do the recording. swarm-harness is its own runtime, so it must
drive sessionlog **programmatically**.

## sessionlog's integration contract

sessionlog is built around pluggable **agent adapters** + a hook-driven lifecycle:

- `Agent` (`src/agent/types.ts`): `{ name, type, description, isPreview,
  protectedDirs, detectPresence(cwd), …transcript parsing }`. Existing adapters:
  `claude-code` (~1084 LOC), `cursor`, `opencode`, `gemini-cli`.
- `LifecycleHandler.dispatch(agent: Agent, event: Event)` (`src/hooks/lifecycle.ts`):
  the programmatic seam. Handles `SessionStart`, `TurnStart`, `TurnEnd`
  (**→ creates a checkpoint/commit**), `SessionEnd`, `Compaction`, `Subagent*`,
  `Task*`, `PlanMode*`, `SkillUse`.
- `Event` (`src/types.ts`): `{ type: EventType, sessionID, sessionRef, prompt?,
  timestamp, toolUseID?, toolInput?, responseMessage?, metadata?, … }`.
- Checkpoints are git-native (`createCheckpointStore`, `commitTree`, a checkpoints
  branch).

## Design for swarm-harness

Two parts:

1. **A swarm-harness `Agent` adapter** — maps a worker's transcript to sessionlog's
   `Agent`/`SessionEntry` shape. swarm-harness already has the trajectory data in its
   lane-event spine (`src/swarm/events.ts` → `events.jsonl`); the adapter converts
   those lane events into sessionlog session entries (user prompt, tool_use,
   tool_result, assistant text).
2. **Lifecycle driving from the worker** (`src/cli/worker-entry.ts` /
   `src/swarm/worker-host.ts`): build `Event`s and call `dispatch(agent, event)`:
   - worker task start → `SessionStart` (`prompt` = task prompt)
   - per turn / tool batch → `TurnEnd` (**checkpoint** with `filesTouched`)
   - task complete → `SessionEnd`

That yields one sessionlog session per worker task, checkpointed, in the standard
store cognitive-core already reads.

### Transcript mapping

`events.jsonl` already records `text_delta`, `tool_use_start/input/end`,
`tool_result`, `message_stop` (wire-compatible with `NormalizedEvent`). The adapter
folds these into sessionlog `SessionEntry`s. No new capture is needed — only a
translation layer.

## The decision that gates implementation: adapter placement

| Option | Where the `Agent` adapter lives | Trade-off |
|---|---|---|
| **A. Upstream in sessionlog** *(recommended)* | `sessionlog/src/agent/agents/swarm-harness.ts`, registered alongside the other four | Ecosystem-correct (sessionlog is *designed* for this); `detectPresence`/registry "just work"; reusable by other swarmkit tools. Cost: a sessionlog change + release. |
| **B. Local in swarm-harness** | swarm-coder drives `createLifecycleHandler` + a locally-defined adapter object | No upstream change; faster to land. Cost: couples swarm-coder to sessionlog internals; duplicates adapter concerns; not reusable. |

Recommendation: **A** — it matches sessionlog's architecture and the four existing
adapters, and keeps swarm-coder's side thin (just lifecycle driving).

## Roadmap

- **Layer 0 (this doc)** — record worker sessions via sessionlog. Unblocks
  cognitive-core distillation out-of-band, *no MAP needed*.
- **Layer 1 — DONE.** A worker emits a `trajectory_checkpoint` lane event once
  its session is recorded (`worker-entry.ts`, carrying `sessionId` + `label` +
  `transcriptPath`); the host→MAP bridge (`map-bridge.ts`) maps it to the
  worker's MAP id and calls `sink.emitTrajectory`; the outbound sidecar
  (`map-sidecar.ts`) reports it via `callExtension("trajectory/checkpoint", …)`
  with `resource_id` caching and a broadcast-message fallback, advertising
  `trajectory: { canReport: true }`. Tests in `map-bridge.test.ts` +
  `map-sidecar.test.ts`. (Only the outbound/hosted-swarm path emits; standalone
  single runs have no sidecar.)
- **Layer 2 — DONE.** When the hub requests content for a checkpoint we
  reported, the sidecar serves it. `trajectory-content-provider.ts`
  resolves the worker session's `events.jsonl` (checkpointId = sessionId) into
  the inline content result `{ checkpointId, streaming: false, artifacts:
  { transcript, prompts, metadata, context } }`. `map-sidecar.ts` advertises
  `trajectory: { canServeContent: true }` and answers `trajectory/content.request`
  notifications with `sendNotification("trajectory/content.response", …)`.
  Tests: `trajectory-content-provider.test.ts` + `map-sidecar.test.ts`.
  (The hub-side forwarding/correlation follows MAP's content protocol; confirm
  the exact request/response shape against openhive when that consumer lands.)

**Trajectory ingest pipeline complete: record (0) → checkpoint (0b) → emit (1) →
serve content (2).** Remaining ecosystem work is on the consumer side
(openhive/cognitive-core requesting + distilling).

## Risks / open questions

- sessionlog assumes a **git repo** for the worker's cwd (checkpoints are commits) —
  confirm swarm workers run in a git worktree, or use sessionlog's separate
  session-repo mode.
- Granularity of `TurnEnd` → checkpoint for swarm workers (per turn vs per task).
- `worker-host.ts` / `team.ts` currently carry **unrelated uncommitted changes** —
  coordinate before editing the worker lifecycle.

## Progress

- **Part 1 (sessionlog adapter): DONE** — `sessionlog` branch
  `swarm-harness-agent-adapter` (`f5ed457`). Registered `swarm-harness` agent
  (`Agent` + `TranscriptAnalyzer`); 7-test suite.
- **Part 2a (transcript recording): DONE** — swarm-coder `2c59dfb`.
  `src/swarm/session-recorder.ts` writes the per-session `events.jsonl`
  (opt-in via `SWARM_HARNESS_SESSION_DIR` / `SWARM_HARNESS_RECORD_SESSIONS=1`),
  wired into `worker-entry.ts`. Verified end-to-end against the Part 1 adapter
  (prompt + modified files + summary extracted from the recorder's output).
- **Part 2b (checkpoint driving): DONE** — `src/swarm/session-checkpointer.ts`
  (programmatic, two-phase), driven from `SessionRecorder` (begin at record
  start, finish at close). `sessionlog` added as an optional dep + exported
  `resolveSessionRepoConfig` (sessionlog `b86f4e9`). Verified by
  `session-checkpointer.integration.test.ts`: the real recorder, in a
  sessionlog-enabled git repo, produces a `sessionlog/<hash>` checkpoint.

  Two corrections vs the naive recipe, found during implementation:
  1. **Pass the repo `cwd` to the stores** — the CLI passes `undefined` only
     because its own `process.cwd()` is the repo; an in-process caller is not in
     the repo, so `createSessionStore`/`createCheckpointStore` need it explicitly
     (otherwise the session state is written to the wrong place and no checkpoint
     forms).
  2. **Two-phase lifecycle** — `SessionStart`+`TurnStart` at record start (marks
     the turn offset *before* the work), then `TurnEnd`+`SessionEnd` at close
     after the transcript flushes. Dispatching all of it at close captures an
     empty turn window → no checkpoint.

  Note: `TurnEnd` creates a work-snapshot checkpoint (`sessionlog/<hash>`);
  promotion to a *committed* checkpoint (`checkpoints/v1`, what cognitive-core
  reads) happens via sessionlog's commit strategy when the worker actually
  commits code — out of scope here.

## Part 2b recipe (programmatic checkpoint driving)

Drive sessionlog **at session close** (transcript fully flushed → one checkpoint
per task; avoids per-turn flush ordering). Programmatic dispatch builds `Event`s
directly, so **no HookSupport** is needed on the adapter.

Prerequisites:
1. Add `sessionlog` as a swarm-coder dependency (+ symlink for dev, like
   skill-tree/minimem).
2. Export `resolveSessionRepoConfig` from sessionlog's `index.ts` (currently
   internal to `cli.ts`).

Checkpointer (`src/swarm/session-checkpointer.ts`, dynamic import + best-effort):
```ts
const sl = await import("sessionlog");          // best-effort; no-op if absent
if (!(await sl.isEnabled(cwd))) return;          // respect sessionlog config
const cfg = await sl.resolveSessionRepoConfig(); // { sessionRepoCwd, sessionsDir, checkpointsBranch }
const handler = sl.createLifecycleHandler({
  sessionStore: sl.createSessionStore(undefined, cfg.sessionsDir),
  checkpointStore: sl.createCheckpointStore(undefined, cfg.sessionRepoCwd, cfg.checkpointsBranch),
  cwd,
});
const agent = sl.getAgent("swarm-harness");
const base = { sessionID, sessionRef /* = events.jsonl path */, timestamp: new Date() };
await handler.dispatch(agent, { ...base, type: sl.EventType.SessionStart, prompt });
await handler.dispatch(agent, { ...base, type: sl.EventType.TurnEnd });   // -> checkpoint commit
await handler.dispatch(agent, { ...base, type: sl.EventType.SessionEnd });
```
Wire: `SessionRecorder.close()` flushes the stream, then calls the checkpointer.

Verification (needs a real environment): a temp **git repo** with sessionlog
**enabled**, run a worker with recording on, then assert a checkpoint commit
lands on `checkpointsBranch`. Requires `sessionlog` wired as a dep — hence
deferred to where that environment exists.
