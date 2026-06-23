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
- **Layer 1** — sidecar emits `trajectory/checkpoint` per task (mirror
  `map-connection.mjs`), with broadcast fallback + `resource_id` caching.
- **Layer 2** — trajectory content provider over the sessionlog transcript (mirror
  `content-provider.mjs`).

## Risks / open questions

- sessionlog assumes a **git repo** for the worker's cwd (checkpoints are commits) —
  confirm swarm workers run in a git worktree, or use sessionlog's separate
  session-repo mode.
- Granularity of `TurnEnd` → checkpoint for swarm workers (per turn vs per task).
- `worker-host.ts` / `team.ts` currently carry **unrelated uncommitted changes** —
  coordinate before editing the worker lifecycle.
