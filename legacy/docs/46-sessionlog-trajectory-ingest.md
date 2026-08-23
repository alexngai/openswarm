# 46 — Sessionlog trajectory ingest (Layer 0) + MAP trajectory delivery

Status: **design / Layer 0 kickoff**
Related: `docs/45-adaptive-orchestration-design.md`, the memory system (`src/memory/*`)

## Goal

Make openswarm's **worker agent sessions** recordable as trajectories so the
swarmkit learning loop (cognitive-core → playbooks → skills) can distill them.
Today openswarm *consumes* skills/memory at every turn (done — `enrichTurnInputs`
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
**Claude Code hooks** do the recording. openswarm is its own runtime, so it must
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

## Design for openswarm

Two parts:

1. **A openswarm `Agent` adapter** — maps a worker's transcript to sessionlog's
   `Agent`/`SessionEntry` shape. openswarm already has the trajectory data in its
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
| **A. Upstream in sessionlog** *(recommended)* | `sessionlog/src/agent/agents/openswarm.ts`, registered alongside the other four | Ecosystem-correct (sessionlog is *designed* for this); `detectPresence`/registry "just work"; reusable by other swarmkit tools. Cost: a sessionlog change + release. |
| **B. Local in openswarm** | openswarm drives `createLifecycleHandler` + a locally-defined adapter object | No upstream change; faster to land. Cost: couples openswarm to sessionlog internals; duplicates adapter concerns; not reusable. |

Recommendation: **A** — it matches sessionlog's architecture and the four existing
adapters, and keeps openswarm's side thin (just lifecycle driving).

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

## Layer 0c — skill-exposure declaration (DONE)

cognitive-core's external-exposure contract (`learning/external-exposure.ts`,
consumed by `trajectory-sources/entire.ts`) expects serving layers to declare
which skills were surfaced into a session — sessionlog `skillsSurfaced` /
`skillsUsed` map to `surfacedPlaybookIds` / `appliedPlaybookIds`. Without the
declaration, skill-guided sessions are mislabeled "unguided" and contaminate
cognitive-core's lift baseline.

openswarm surfaces skills silently (prompt injection via the memory
providers), invisible to sessionlog's transcript-based skill detection, so we
declare explicitly:

- `MemoryFragment.skill` (`{ id, name, sourceType }`) — set by `SkillProvider`
  (`sourceType: "skill-tree"`) and `CogcorePlaybookProvider`
  (`sourceType: "cognitive-core"`).
- `enrichTurnInputs` returns `surfacedSkills` alongside the enriched prompts.
- `worker-entry.ts` passes them to `startSessionRecorder`, and
  `session-checkpointer.ts` dispatches a `SkillsSurfaced` event (sessionlog
  ≥ 0.0.9; skipped when the enum member is absent) between `TurnStart` and
  `TurnEnd`, with `upstreamSkillId` carrying the stable skill id. Best-effort:
  a failed dispatch never blocks checkpointing.

The *applied* leg (`skillsUsed` → `appliedPlaybookIds`) is declared too:
`SkillUseTracker` (`session-recorder.ts`) watches the lane-event stream for
explicit skill tool invocations — openswarm's tier-1 `skill` tool (input
`{id}`) or Claude Code's native `Skill` tool (input `{skill, args}`),
matched case-insensitively — reassembling streamed `tool_use_input` deltas
per tool-use id and discarding invocations whose `tool_result` was an error
(a failed load is not an application). At `close()` the recorder passes the
collected uses to `finish({ skillsUsed })`, which dispatches one sessionlog
`SkillUse` event per invocation (with `skillName`/`skillArgs`) just before
`TurnEnd`, so they land inside the turn window and reach the checkpoint
metadata. Surfaced-only = weak exposure evidence; explicitly invoked =
strong. Same guards as SkillsSurfaced: enum-presence check and best-effort
dispatch.

## Closing the local loop — CogcorePlaybookProvider (DONE)

Post-walkback, cognitive-core's canonical procedural memory is
filesystem-first: `<storage>/playbooks/<slug>/SKILL.md` (generic
name/description/tags frontmatter + a namespaced `ccore` block). cognitive-core
does **not** write the shared `~/.skill-tree` store the `SkillProvider` reads
(that bridge is openhive's), so the playbooks our own auto-consolidate kick
produces were never read back.

`src/memory/providers/cogcore-playbook-provider.ts` closes that loop: it reads
the canonical playbooks tree (resolution mirrors cogcore's `resolveStorageDir`:
`OPENSWARM_COGCORE_PLAYBOOKS_DIR` override → `COGNITIVE_CORE_HOME` →
`.openswarm/cognitive-core` → `.swarm/cognitive-core` → `.cognitive-core`),
parses procedural SKILL.md files, and surfaces the top matches per turn via
lightweight lexical scoring (name 3x, tags/description 2x, body 1x).
Read-only, best-effort, registered in `lifecycle.ts` alongside the other
providers; only activates when a store exists. The store is snapshotted at
provider initialization (once per process) — fine for short-lived workers.

## Namespace alignment (cognitive-core side, DONE)

cogcore's `resolveStorageDir` previously knew only `.swarm/cognitive-core` and
`.cognitive-core`; openswarm is mid-migration to the `.openswarm` namespace and
writes its auto-consolidate marker at
`.openswarm/cognitive-core/last-consolidate.json`. cognitive-core now checks
`.openswarm/cognitive-core` first (then `.swarm/cognitive-core`, then
`.cognitive-core`), so a migrated repo keeps cogcore storage and the marker
under one namespaced directory.

## Cross-repo without openhive — shared-bank mirroring (DONE)

Without openhive, nothing wrote the shared `~/.skill-tree` bank the
`SkillProvider` reads; learning stayed per-repo (the CogcorePlaybookProvider
loop above). cognitive-core now supports mirroring **graduated, extracted**
playbooks directly into a shared skill-tree filesystem bank:

- cognitive-core: `skillTree.sharedBank` config (`{ enabled, path }`, default
  off / `~/.skill-tree`), surfaced on the CLI as `cogcore run|dream
  --shared-bank [path]` or `COGCORE_SHARED_SKILL_BANK=1|<path>`. The
  `SkillPublisher` mirror is best-effort (never fails the primary SQLite
  publish), propagates deprecations, and only mirrors `origin: 'extracted'`
  playbooks — curated/imported ones would echo someone else's skills back
  into the shared bank.
- openswarm: `auto-consolidate.ts` (`resolveSharedBankArg`) appends
  `--shared-bank <dir>` to the spawned `cogcore run --once` when the
  SkillProvider's bank (`OPENSWARM_SKILLS_DIR` or `~/.skill-tree`) already
  exists. `OPENSWARM_SHARED_SKILL_BANK` overrides: falsy disables, a path
  forces that bank (created on first publish). We never create the
  machine-global bank unprompted.

Result: repo A's worker sessions → cogcore consolidation → shared bank →
repo B's SkillProvider surfaces the skill on its next turn. Skill-tree bank
writes (cc's skill-tree 0.2.1 `createSkillBank`) and reads (openswarm's 0.3.0
`FilesystemStorageAdapter`) were verified compatible end-to-end. openhive
remains the layer for *federation* (peer visibility, sync policy, multi-host);
this covers same-machine cross-repo sharing.

## Risks / open questions

- sessionlog assumes a **git repo** for the worker's cwd (checkpoints are commits) —
  confirm swarm workers run in a git worktree, or use sessionlog's separate
  session-repo mode.
- Granularity of `TurnEnd` → checkpoint for swarm workers (per turn vs per task).
- `worker-host.ts` / `team.ts` currently carry **unrelated uncommitted changes** —
  coordinate before editing the worker lifecycle.

## Progress

- **Part 1 (sessionlog adapter): DONE** — `sessionlog` branch
  `openswarm-agent-adapter` (`f5ed457`). Registered `openswarm` agent
  (`Agent` + `TranscriptAnalyzer`); 7-test suite.
- **Part 2a (transcript recording): DONE** — openswarm `2c59dfb`.
  `src/swarm/session-recorder.ts` writes the per-session `events.jsonl`
  (opt-in via `OPENSWARM_SESSION_DIR` / `OPENSWARM_RECORD_SESSIONS=1`),
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
1. Add `sessionlog` as a openswarm dependency (+ symlink for dev, like
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
const agent = sl.getAgent("openswarm");
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

## Live end-to-end validation (2026-07-02, DONE)

Ran the whole loop with real agents (`swarm run` + haiku via claude-agent-sdk)
in scratch git repos, plus real `cogcore run --once --shared-bank` ingests.
Verified working end to end, unattended:

1. Worker turn: SkillProvider surfaced the shared-bank skill, `[memory]
   injected …` includes `skill:<id>` and `cogcore-playbook:<id>` fragments.
2. `SkillsSurfaced` flowed into sessionlog session state
   (`.git/sessionlog-sessions/<id>.json` → `skillsSurfaced[]` with
   `upstreamSkillId`/`sourceType`) and into the committed checkpoint's
   `metadata.json` after condensation.
3. Auto-consolidate fired at session end with the right args:
   `cogcore run --once --repo <cwd> --shared-bank <bank>`.
4. A user `git commit` triggered sessionlog's hooks: trailer injected
   (`Sessionlog-Checkpoint: <id>`), session condensed onto
   `sessionlog/checkpoints/v1`.
5. `cogcore run --once` ingested the checkpoint; the stored experience's
   metadata carries `surfacedPlaybookIds: [<skill names + ids>]` — exposure
   attribution lands.
6. Shared-bank mirror: a graduated `origin: extracted` playbook published via
   the real `Atlas`/`refreshTiers` path appeared in the bank
   (`.skilltree/skills/<id>/SKILL.md`) and was surfaced by a *different*
   repo's SkillProvider on its next live worker run.

Two defects found live and fixed:

- **SkillProvider zero-hit on long prompts** — skill-tree's BM25
  (`textSearch`) requires *every* corpus-present query term to match one
  skill (AND semantics). Whole task prompts are long sentences, so once the
  bank held >1 skill, searches returned nothing. `enrichTurn` now falls back
  to a local field-weighted token-overlap ranking (`rankByTokenOverlap`,
  OR semantics) when BM25 yields zero results.
- **sessionlog absolute `filesTouched`** — the openswarm adapter extracts
  file paths from tool inputs, which are absolute; sessionlog's commit-hook
  overlap checks compare against repo-relative `git diff --name-only` output,
  so sessions never condensed. Fixed in sessionlog's `handleTurnEnd`
  (normalize to repo-relative with realpath, handles the macOS
  `/tmp` → `/private/tmp` symlink).

Follow-up hardening (same day):

- **SkillProvider bank guard** — the provider now activates only when
  `<basePath>/.skilltree` exists (a real skill-tree bank), not merely the
  basePath. Prevents `OPENSWARM_SKILLS_DIR` mispointed at a Claude-style
  skills dir (different layout) from reading zero skills while the adapter's
  `initialize()` mkdirs `.skilltree/` clutter into a user-managed directory.
  The auto-consolidate kick still keys on the basePath existing — that is the
  *write* opt-in (cogcore's mirror creates `.skilltree/` on first publish,
  after which the provider starts reading).
- **Skill frontmatter block scalars** — openswarm's registry skill parser
  (`src/skills/claude-code-source.ts`) now handles `key: |` / `key: >`
  (with chomping variants). skill-tree serializes mirrored SKILL.md
  descriptions as `description: |`, so bank skills copied/symlinked into
  `~/.claude/skills` and the like now parse with intact descriptions.

Operational prerequisites for the unattended loop (per repo):
`OPENSWARM_RECORD_SESSIONS=1` (or `OPENSWARM_SESSION_DIR`), sessionlog
enabled (`.sessionlog/settings.json` → `{"enabled": true}`), sessionlog git
hooks installed, and a current `sessionlog` CLI (≥ 0.1.0 with the
path-normalization fix) on PATH — the hooks shell out to `sessionlog`, and a
stale global install silently skips trailer injection/condensation.
