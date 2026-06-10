# 44 — macro-agent Parity: Implementation Plan

Build plan for the pruned, decided scope in [`43-macro-agent-parity.md`](./43-macro-agent-parity.md).
Companion to that tracker: 43 says *what* and *why*; this doc says *how*, *in what
order*, and *done-when*.

**Decisions this plan executes** (from 43):
- **D1** — Hybrid landing model: build `LandingStrategy` + `ConflictRecoveryStrategy`
  registries once; trigger from the topology executor first (model A), add a
  per-agent `done()` trigger later for the merge queue (model B).
- **D2** — Scope = cover real workflows, minimal-viable. Cut: `auto-resolve`,
  `direct-push`/`optimistic-push`, declarative DSL, capability map,
  foreign-agent wrapping, REST/federation/control servers.
- **D3** — OpenHive hosting via **Path B** (direct-spawn, standalone, own ports)
  + adopt **`@multi-agent-protocol/sdk`** for the MAP layer.

## Two tracks, one convergence

```
TRACK A — git-workspace (§2)         TRACK B — OpenHive hosting (§1)
  P0 seam refactor                     P5 boot() host entry + bootstrap + health
  P1 conflict dispatch (sync)          P6 ACP-over-WebSocket (+ ACP-over-MAP)
  P2 spawn-resolver + resolve_conflict P7 MAP server + register + sidecar  ◀ dominant cost
  P3 cascade auto-rebase
  P4 merge queue + integrator
                       ╲                        ╱
                        ▼                       ▼
                   P8 — CONVERGENCE: cascade-action handlers
                   (merge/push/commit/abandon/resolve) + _macro/spawnAgent
                   wire OpenHive's hub buttons to Track A's primitives
```

**Sequencing rationale.** Track A primitives (P0–P4) are foundational *and*
independently valuable (autonomous teams work with no hub). Track B (P5–P7) is
largely independent and can run **in parallel** by a second contributor — it only
needs Track A at **P8**, where OpenHive's cascade actions bind to the
landing/recovery primitives. So: start P0–P1 (unblocks the most), let P5–P7 run
alongside, and land P8 once both `merge_to_parent`/recovery (P1) and the MAP
server (P7) exist.

**Effort legend:** `XS` <0.5d · `S` 0.5–1d · `M` 1–3d · `L` 3–7d · `XL` >1w.

---

## Track A — git-workspace

### P0 — Strategy-seam refactor _(S, no behavior change)_ — ✅ DONE (2026-06-09)

> **Landed.** New `src/swarm/landing/` (`types`, `merge-to-parent`, `registry`,
> `index`) + `src/swarm/recovery/` (`types`, `registry`, `index`); `peer-team.ts`
> `maybeMergeStreams` delegates per-agent merge to `MergeToParentStrategy` (same
> adapter calls, same null/conflict semantics); optional `landingRegistry`/
> `recoveryRegistry` on `TopologyContext`; optional `MemberSpec.onConflict` +
> `TeamCoordination.conflictRecovery` on `TeamSpec` (pulled forward so
> `RecoveryRegistry.select` is real). Recovery seam is **dormant** (no strategies
> registered, no dispatch wired — that's P1). Verify: full `src/swarm` suite
> **633 pass**, new suites **+96**, `tsc --noEmit` clean.


Create the two registries macro-agent has (`workspace/landing/`, `workspace/recovery/`)
and refactor the current inline merge into the first landing strategy. Pure
refactor — same observable behavior, full green suite.

**New files**
- `src/swarm/landing/types.ts` — port `LandingStrategy` / `LandingContext` from
  macro `workspace/types-v3.ts:122-152`, adapted to swarm shapes (`MergeStreamResult`).
- `src/swarm/landing/merge-to-parent.ts` — `MergeToParentStrategy`: lifts the
  body of `PeerTeamTopology.maybeMergeStreams()` (`peer-team.ts:428-489`)
  verbatim into `land(ctx)`.
- `src/swarm/landing/index.ts` — `registerBuiltinLandingStrategies()`.
- `src/swarm/recovery/types.ts` — `ConflictContext` / `ConflictResolution` /
  `ConflictRecoveryStrategy` (port `conflict-recovery.md` §3; swap macro's
  `streamId`-keying for swarm's `sourceAgentId` keying; **synthesize `conflictId`
  locally** — git-cascade only surfaces `conflicts: string[]`).
- `src/swarm/recovery/registry.ts` — register/select/recover; `select(role, spec)`
  resolves `member.onConflict ?? coordination.conflictRecovery.defaultStrategy ?? "defer"`.

**Modified**
- `src/swarm/topologies/peer-team.ts` — `maybeMergeStreams` calls
  `landingRegistry.land(...)` instead of inlining the merge.
- `src/swarm/host.ts` / `TopologyContext` — expose `landingRegistry` +
  `recoveryRegistry` handles.

**Acceptance:** existing topology/merge tests pass unchanged; new unit tests for
registry select/registration; `MergeToParentStrategy` exercised by the current
`peer-team` merge tests (re-pointed, not rewritten).

---

### P1 — Conflict-recovery dispatch, sync strategies _(M)_ — ✅ DONE (2026-06-09)

> **Landed.** Built-in strategies `src/swarm/recovery/{defer,abandon,escalate}.ts`
> (pure; `auto-resolve` intentionally absent per D2) + `createDefaultRecoveryRegistry`
> + `describeResolution`. `peer-team.ts maybeMergeStreams` now dispatches recovery
> at the conflict branch: original failure note preserved, then
> `recovery.select(role, spec).recover(...)` runs and emits a second note; throws
> only when `!resolved && failOnConflict`. **Default `defer` ⇒ identical behavior
> to P0** (existing conflict tests unchanged). Unknown strategy names (e.g.
> `spawn-resolver` pre-P2) degrade to deferred. `pipeline` doesn't land streams,
> so peer-team is the only wiring site. Verify: full `src/swarm` **643 pass**
> (+10), `tsc --noEmit` clean.

Stop swallowing conflicts. Dispatch a recovery strategy at the existing conflict
branch.

**Strategies** (`src/swarm/recovery/`): `defer.ts`, `abandon.ts`, `escalate.ts`.
- `defer` — no-op, returns `{kind:"deferred"}` (the safe default).
- `abandon` — leaves the stream; optional `git worktree remove`; `{kind:"abandoned"}`.
- `escalate` — emit a `team_note`/lane event + (if inbox enabled) an
  `agent-inbox` message to the lead; `{kind:"escalated"}`. **This is the hosted-team
  path** — surfaces as OpenHive's cascade `resolve` action (P8).
- **`auto-resolve` is NOT built** (D2 — harmful blind side-picking).

**Modified**
- `src/swarm/topologies/peer-team.ts:469` — replace the `if (!result.success)`
  `team_note`-and-give-up block with recovery dispatch:
  ```ts
  if (!result.success && result.errorType === "conflict") {
    const strat = recoveryRegistry.select(member.role, spec);
    const res = await recoveryRegistry.recover(strat, {
      sourceAgentId: handle.agentId, streamId, paths: result.conflicts ?? [],
      operation: "merge", targetBranch: cfg.targetBranch, recoveryDepth: 0, host, adapter,
    });
    if (res.kind !== "resolved" && cfg.failOnConflict) throw new Error(...);
  }
  ```
  Apply the same to `pipeline.ts` (and any topology that lands streams).
- `src/swarm/team-spec.ts` — add `MemberSpec.onConflict?: string` and
  `TeamCoordination.conflictRecovery?: { defaultStrategy?: string;
  defaultConfig?: Record<string,unknown>; maxRecoveryDepth?: number }` (+ zod).

**Acceptance:** a forced merge conflict (two members editing the same file →
`mergeStreams`) now produces a deterministic, observable resolution per role
config instead of a silent green run; `failOnConflict` still aborts; e2e covers
defer + escalate. (Mirror macro's `conflict-resolution-git.e2e.test.ts`.)

---

### P2 — `spawn-resolver` + `resolve_conflict` (W1b + W6) _(M–L)_

> **Split into P2a (done) + P2b (pending live-git work).** The merge conflict
> lives in a throwaway worktree, the resolver runs as a subprocess WorkerHost,
> and a real LLM resolver needs a live-agent test — so the self-contained,
> unit-testable core ships first; the live wiring + real-git worktree handling
> follows.
>
> **P2a — ✅ DONE (2026-06-09).** `resolver` built-in role (commit_changes +
> resolve_conflict); `resolve_conflict` tool (`src/tools/tier2/`) +
> `StandaloneHost.resolveConflict`/`waitForConflictResolution` coordination
> primitive (optional on `SwarmHost`); `spawn-resolver` strategy
> (`recovery/spawn-resolver.ts`) with an **injected** `ctx.spawnResolver`
> (bounded recursion, escalate-on-timeout/no-spawner), registered in the default
> registry (inert until a spawner is injected). Verify: `src/swarm` + `src/tools`
> **742 pass**, `tsc --noEmit` clean. **Deferred from P2a:** the `attach`
> BranchPolicy — it locks a git-worktree design (one-worktree-per-branch) better
> decided against real git in P2b.
>
> **P2b — PLANNED (see "P2b sub-plan" below).** Real `ResolverSpawner` +
> WorkerHost→orchestrator IPC + the conflicted-worktree mechanism + two test
> loops.

#### P2b sub-plan — live resolver wiring

**Test-loop model (verified in this environment).** Integration tests spawn real
`node dist/cli.js --worker` subprocesses but select a `ScriptedTestEngine` via
`SWARM_HARNESS_TEST_SCRIPT=<fixture.json>` (`worker-entry.ts:359`); a fixture is a
JSON event array that includes **real tool calls** (`tool_use_* → tool_result`,
e.g. `test/fixtures/worker-scripts/with-tool-call.json`). So two loops:

- **Loop 1 — deterministic mechanics (scripted engine, no LLM, CI-able).** The
  resolver is a *scripted* worker; everything else is real (git, worktrees,
  merge, conflict, IPC, retry). Covers ~90% of P2b correctness. Needs only
  `npm run build` (integration `global-setup.ts` does it). Readiness confirmed:
  `npm run test:integration` → 40 pass / 7 live-skipped, 33s.
- **Loop 2 — true live agent (real Claude, gated).** Swaps the scripted resolver
  for the real engine + the `resolver` role prompt; validates only that the LLM
  *resolves the conflict correctly*. Env present: `@anthropic-ai/claude-agent-sdk`
  + native binary + Claude Max auth. Gate behind a new flag; manual, costs tokens.

**D4 — Conflicted-worktree mechanism: retain-and-resolve-in-place** _(decided)_.
Today `mergeStreamToBranch` (adapter:511) merges `stream/<src>` into a detached
tmp worktree at the target and, on conflict, deletes it in `finally` — so the
markers vanish. P2b adds a **retain-on-conflict** mode: leave the conflicted tmp
worktree, return its path + the target's pre-merge sha. The resolver runs *in
that worktree* (the merge is mid-state), resolves markers, commits (completing
the merge), and calls `resolve_conflict`. The coordinator finalizes with the
existing CAS `git update-ref refs/heads/<target> <resolutionCommit> <oldSha>`
(adapter:561) and removes the worktree. Most faithful + reuses the finalize path;
rejected alternative: resolver re-merges in its own worktree (more moving parts,
two target worktrees).

**Steps:**

- **P2b.1 — `resolve_conflict` IPC proxy. ✅ DONE (2026-06-09).** `task.resolve_conflict`
  request method + `TaskResolveConflictParamsSchema` (`ipc/protocol.ts`);
  `WorkerHost.resolveConflict` awaits the orchestrator ack; `StandaloneHost`
  routes the frame → `resolveConflict` → acks; `SwarmHost.resolveConflict` widened
  to `void | Promise<void>` so the tool awaits delivery. Verify: swarm+tier2
  **746 pass**, `tsc` clean. _(original note:)_ Mirror `WorkerHost.commitChanges`
  (`worker-host.ts:292` → `transport.send("task.commit_changes", …)`): add
  `WorkerHost.resolveConflict` → `transport.send("task.resolve_conflict", …)`,
  add `task.resolve_conflict` to `IpcRequestMethod` + a params schema
  (`ipc/protocol.ts`), and an orchestrator handler routing to
  `StandaloneHost.resolveConflict`. Unit-test the worker proxy + orchestrator
  routing. _(S–M)_
- **P2b.2 — retain-on-conflict in the adapter. ✅ DONE (2026-06-09).**
  `mergeStreamToBranch({retainOnConflict})` now leaves the conflicted tmp
  worktree in place and returns `conflictWorktree` + `targetOldSha` + the
  unmerged `conflicts` paths; `finalizeConflictResolution({worktree,
  targetBranch, oldSha, resolutionCommit})` CAS-updates the ref (`stale` on
  mismatch) + removes the worktree. **Also fixed** conflict detection to be
  authoritative (unmerged-paths query) — git writes "CONFLICT" to stdout not
  err.message, so the prior string-match could mislabel real conflicts as
  `git_error` and bypass P1 recovery. Verify: real-git test (retain → resolve →
  finalize, no-retain cleanup, stale CAS) + full `src/swarm` **661 pass**, `tsc`
  clean. _(original note:)_ Add a `retainOnConflict` option
  to `mergeStreamToBranch`; on conflict, skip cleanup and return
  `{ ..., conflictWorktree, targetOldSha }`. Add `finalizeConflictResolution(
  { worktree, targetBranch, oldSha, resolutionCommit })` (update-ref + remove
  worktree). Unit-test against a real temp git repo (the `policies`/`standalone-
  host` tests already use real git). _(M)_
- **P2b.3 — real `ResolverSpawner` + coordinator in peer-team. ✅ DONE
  (2026-06-09).** `recovery/resolver-spawner.ts` `buildResolverSpawner(deps)`:
  re-merge with retain → spawn `resolver` on the conflict worktree → await
  `resolve_conflict` (or timeout→escalate) → finalize. Deps injected (unit-tested
  with fakes across all branches). `StandaloneHost` gained
  `mergeStreamToBranchForAgent({retainOnConflict})` + a `finalizeConflictResolution`
  wrapper; adapter `finalizeConflictResolution` auto-reads the worktree HEAD when
  no commit is reported (the scripted/real resolver can't echo a dynamic sha).
  `peer-team` builds the coordinator (only when landing-to-branch + the host
  implements the primitives) and injects `ctx.spawnResolver`. Verify: full
  `src/swarm` **669 pass**, `npm run build` clean. The live subprocess+git path
  is P2b.4. _(original note:)_ Build the
  closure injected as `ctx.spawnResolver`: spawn a `resolver` member with
  `cwd = conflictWorktree` + the `conflictId`/target threaded via task context;
  `await host.waitForConflictResolution(conflictId, timeoutMs)`; on resolve →
  `finalizeConflictResolution` → `{kind:"resolved"}`; on timeout →
  `{kind:"escalated"}` + worktree cleanup. Pass `recoveryDepth+1` for
  resolver-induced conflicts. _(M)_
- **D5 — ScriptedTestEngine does NOT execute tools** _(found 2026-06-09)_. It
  replays fixture events (`test-engine.ts:136` `yield event`); the `tool_result`
  in a fixture is baked-in, not produced by running the tool. So a *scripted*
  resolver subprocess cannot actually resolve a conflict or invoke
  `resolve_conflict`. Loop 1 therefore can't drive the real resolver subprocess
  deterministically — it splits into a direct integration test (P2b.4, real git +
  real coordination, simulated agent) and the live subprocess test (P2b.5). The
  subprocess `resolve_conflict` IPC itself is already unit-tested (P2b.1). _(A
  future option: extend ScriptedTestEngine with a real tool-exec directive to get
  a deterministic subprocess test — out of scope per D2.)_
- **P2b.4 — direct coordinator + real-git integration test. ✅ DONE
  (2026-06-09).** `recovery/resolver-spawner.integration.test.ts`: real temp git
  repo + real `GitCascadeBranchPolicyAdapter` + real `StandaloneHost`; drives
  `buildResolverSpawner` with REAL deps (host merge/finalize/wait) and a simulated
  resolver agent (writes the resolution in the worktree + `host.resolveConflict`).
  Asserts a real conflict resolves end-to-end (main advances to the resolution,
  resolved content present, worktree removed) and the timeout→escalate path
  leaves main untouched. (Test git is isolated from the host `~/.gitconfig` via
  `GIT_CONFIG_GLOBAL=/dev/null` + env identity — a host gpgsign/hook made the
  resolver's `git commit` block the event loop.) Verify: full `src/swarm`
  **671 pass**, `npm run build` clean. _(original note:)_ Real temp git repo,
  real `GitCascadeBranchPolicyAdapter` + real `StandaloneHost`; drive
  `buildResolverSpawner` with REAL deps (`mergeWithRetain`/`finalize` =
  adapter+git, `waitForResolution`/signal = host) and a simulated resolver agent
  (writes the resolution in the worktree + `host.resolveConflict`). Assert the
  conflict resolves end-to-end: target advances to the resolution, worktree
  removed, `{kind:"resolved"}`. Validates the git + coordination glue the unit
  mocks couldn't. _(M)_
- **P2b.5 — Loop 2 gated live test. ✅ DONE — PASSES live (2026-06-09).**
  `recovery/resolver-spawner.live.test.ts` — `describe.skipIf(!SWARM_HARNESS_LIVE_RESOLVER)`:
  real git conflict → real `TeamSession.spawnMember` resolver subprocess (live
  engine) → real `resolve_conflict` IPC → finalize. Skipped by default (suite
  green); run with `SWARM_HARNESS_LIVE_RESOLVER=1`. **Confirmed end-to-end with
  real Claude: the resolver resolves both sides, commits via bash, signals, the
  IPC wakes the coordinator, finalize advances `main` — ~14s.**

  **Root cause of the initial escalations (found via instrumentation):** the
  **orchestrator host's permission mode is the ceiling** for sub-agents
  (`host.ts`: "sub-agents cannot escalate beyond this"). The host was left at the
  default `workspace-write`, which clamped the resolver below `exec`, so its
  `git commit` (bash) **and** `resolve_conflict` (both require `exec`) were
  permission-denied — the agent resolved the markers in its worktree but couldn't
  commit or signal → escalate. Fix: construct the orchestrator `StandaloneHost`
  with `permissionMode: "danger-full-access"`. (The earlier ~17-min teardown was
  the *blocked* worker lingering — gone once it completes cleanly.)

  **Product implication (follow-up, not blocking):** in `peer-team`, the resolver
  inherits the team's permission mode. A team running below `exec` can't run a
  resolver — spawn-resolver then degrades to `escalate` (the safe fallback). If we
  want resolvers to work under restrictive teams, the spawn-resolver path needs to
  request elevated permission for the resolver (a security trade-off to decide
  before P4/production).

  _(original note:)_ Real subprocess resolver via Claude behind
  `SWARM_HARNESS_LIVE_RESOLVER=1`: real engine + `resolver` role prompt, longer
  timeout. The only path that exercises the real agent-driven resolution +
  resolve_conflict IPC end-to-end. Manual. _(S)_

**Acceptance:** Loop 1 green in CI (a real conflict is resolved end-to-end by a
scripted resolver subprocess through real git + IPC); Loop 2 green once locally
against real Claude.


The autonomous-team conflict path. Two new primitives.

**New primitive 1 — attach to the conflicted branch.** macro forks a *new* stream;
the resolver needs a worktree *on* `stream/<conflictedId>`.
- `src/swarm/host.ts` / `policies.ts` — add `BranchPolicy { kind: "attach"; branch: string }`.
- `src/swarm/adapters/git-cascade-branch-policy.ts` — handle `kind:"attach"` in
  `resolve()`: `createWorktree({ agentId, path, branch })` on the existing branch
  (no new stream). ~20 lines next to the `stream`/`fork` cases (adapter:345-395).

**New primitive 2 — recovery coordinator + tool.**
- `src/swarm/recovery/spawn-resolver.ts` — `createSpawnResolverStrategy({ host })`;
  `mode: "async"`. Spawns a `resolver`-role member (via `host`/orchestrator) on the
  attached branch, awaits a `conflict.resolved` signal or `timeout_ms` →
  `{kind:"escalated"}`. Bounded: `recoveryDepth` cap (default 3) → fall back to
  `escalate`. **No `max_concurrent` pools, no cross-team policy** (D2 — keep dumb).
- `src/tools/tier2/resolve_conflict.ts` — new tool next to `commit_changes.ts`;
  `{ conflictId }` → signals the coordinator (resolve + retry the merge once).
- `src/swarm/roles.ts` — add a built-in `RESOLVER` role with
  `allowedTools: [...read/edit/bash, "commit_changes", "resolve_conflict"]`.
  (Gating is just `allowedTools` — D2, no capability map.)

**Acceptance:** an autonomous team (no human) recovers a real conflict via the
resolver agent end-to-end; resolver timeout escalates cleanly; recursion cap
holds. Gate the live-agent test behind the usual flag.

---

### P3 — Cascade auto-rebase (W5) _(S–M)_ — ✅ DONE (2026-06-09)

> **Landed.** `src/swarm/cascade-scheduler.ts` — `CascadeScheduler`: coalesces
> `request(root)` per root and debounces (2s default); `flush()` drains
> immediately for the batch case; timer auto-fire for the trickle case; injected
> `run` callback (unit-tested without git). `StandaloneHost.cascadeRebase` wrapper
> delegates to the adapter (which already ships `cascadeRebase` with
> `defer_conflicts`). `MemberSpec.onParentAdvanced?: "sync"` (+ zod) opts in.
> `peer-team` builds the scheduler when a member opts in **and** the merge target
> is a STREAM (cascade roots are streams, not branches), `request()`s on each
> successful stream-merge, and `flush()`es after the loop — N merges into one
> target coalesce to **one** cascade; results surface as `team_note`s. Verify:
> full `src/swarm` **679 pass**, `npm run build` clean. _(Cascade-conflict →
> recovery routing left as a follow-up: the recovery dispatcher is merge-oriented;
> cascade `defer_conflicts` failures currently surface as notes.)_


Primitive already ships (`GitCascadeBranchPolicyAdapter.cascadeRebase()`,
adapter:421). Add the trigger.

**Modified**
- `src/swarm/team-spec.ts` — `MemberSpec.onParentAdvanced?: "sync"`.
- topology executor (`peer-team.ts` / `pipeline.ts`) — after a merge advances a
  parent stream, call `host.cascadeRebase({ rootStream, strategy: "defer_conflicts" })`,
  **2s-debounced** (coalesce bursts). Each `defer_conflicts` failure → feed the
  stream into the P1 recovery dispatcher (`conflict-recovery.md` E5).

**Acceptance:** a parent stream advancing triggers exactly one (debounced) rebase
of dependents; deferred conflicts route to recovery; no rebase storm under rapid
merges.

---

### P4 — Merge queue + integrator (W2) _(M)_ — ✅ CORE DONE (2026-06-09)

> **Landed (queue mechanics + landing + role).** Used git-cascade's queue for
> **ordering + persistence** but the actual merge runs through the adapter's
> proven `mergeStreamToBranch` machinery — because git-cascade's own
> `processMergeQueue` merges via `mergeStream(targetStream: branch)`, which has
> the very branch-vs-stream limitation `mergeStreamToBranch` was built around.
> - Adapter: refactored the merge into a streamId-keyed `mergeStreamIdIntoBranch`
>   (the enqueuing agent may be gone by drain time); `enqueueMerge` (addToQueue +
>   markReady) + `drainMergeQueue` (getNextToMerge → merge → remove/cancel,
>   ordered) → `MergeQueueDrainResult {merged[], failed[]}`. Queue methods added
>   **optional** on the tracker type so non-queue mocks don't break.
> - `StandaloneHost.enqueueMerge` / `drainMergeQueue` wrappers.
> - `queue-to-branch` LandingStrategy (enqueue; "success" = enqueued) registered.
> - `INTEGRATOR` built-in role.
> Verify: real-git test (enqueue 2 → ordered drain → both land; a conflicting
> stream → `failed[]` while the rest keep draining) + full `src/swarm` **687
> pass**, build clean. `mergeStreamToBranch` refactor guarded by the P2b.2 tests.
>
> **Deferred (the model-B agent wiring):** a long-lived `integrator` *agent*
> draining via a `drain_queue` tool + the per-agent `done()` landing trigger so
> workers pick `queue-to-branch`; topology opt-in (`mergeStreams.viaQueue`);
> routing drain `failed[]` into the P1 recovery dispatcher. The primitives above
> make these thin — they need a real many-writer-streaming consumer to land
> against (D2).


Needs model **B** (a long-lived integrator draining a queue). The queue itself
ships in `git-cascade@0.0.7` — **no dep bump** (verified: `tracker.d.ts:298-333`).

**Modified / new**
- `src/swarm/adapters/git-cascade-branch-policy.ts` — surface `addToMergeQueue`,
  `getNextToMerge`, `processMergeQueue`, `markMergeQueueReady`,
  `getMergeQueuePosition` on `BranchPolicyAdapter`.
- `src/swarm/landing/queue-to-branch.ts` — `land(ctx)` = `addToMergeQueue({ streamId,
  targetBranch, agentId })`.
- `src/swarm/roles.ts` — `INTEGRATOR` role; uses `MemberSpec.longLived: true`
  (`team-spec.ts:55`) to stay alive and drain via `processMergeQueue(...)`
  (`ProcessQueueOptions.strategy`: `merge-commit|squash|rebase`).
- model-B `done()` trigger: a minimal per-agent landing hook so a worker calling
  done invokes its role's `LandingStrategy` (queue-to-branch). Keep narrow — only
  what the integrator flow needs.
- `ProcessQueueResult.failed[]` → P1 recovery dispatcher.

**Acceptance:** N workers landing via `queue-to-branch` are drained in
priority/FIFO order by one integrator; conflicts in the drain route to recovery;
`x-cascade/queue.*` events observable.

---

## Track B — OpenHive hosting (Path B, can run parallel to Track A until P8)

### P5 — `boot()` host entry + bootstrap + health (H0/H4/H3) _(M)_ — ✅ DONE (2026-06-10)

swarm-harness's analog of macro's `bootV2` — binds its own ports, reads bootstrap.

> **P5 — ✅ DONE (2026-06-10).** `src/host/` landed: `bootSwarmHost()`
> (`boot.ts`) derives the OpenHive 3-port stride (base=ACP-WS, base+1=health,
> base+2=MAP) and returns a handle with `shutdown()`; `health.ts` serves
> `GET /health` (+ `/healthz`) → `200 {status:"ok", swarmId?, uptimeMs, ports}`
> on base+1 (NOT REST CRUD, per D2); `bootstrap.ts` parses the OpenHive contract
> (`OPENSWARM_BOOTSTRAP_TOKEN` base64-JSON, `OPENSWARM_DATA_DIR`,
> `MACRO_BOOTSTRAP_COORDINATOR|CWD|REHYDRATE`, plus `SWARM_HARNESS_*` aliases).
> CLI: `swarm-harness host --port N [--host H] [--adapter X]` (`cli/host.ts`,
> `argv.ts`, `main.ts`) stays alive until SIGTERM/SIGINT → graceful shutdown.
> Smoke-tested end-to-end: spawn → `/health` 200 → SIGTERM clean exit. The
> ACP-WS (base, P6) and MAP (base+2, P7) servers slot into the reserved ports
> next; the bootstrap-coordinator spawn + rehydrate-on-restart wire with ACP
> (the handle records the intent today). 100 new unit tests (health/bootstrap/
> boot/argv); full `src/swarm` gate green.

**New**
- `src/host/boot.ts` — `bootSwarmHost({ host, port, cwd, bootstrap })`: stands up
  the ACP-WS (P6), MAP (P7), and health servers; returns a handle with
  `shutdown()`. Binds `base` / `base+1` / `base+2`.
- `src/host/health.ts` — tiny HTTP `/health` (+ `/metrics`) on `base+1`
  (probed by OpenHive `deriveHealthUrls`). **Not** REST CRUD (D2).
- `src/cli/*` — `--port` / `--host` flags routed to `bootSwarmHost`.
- Bootstrap env: read `OPENSWARM_BOOTSTRAP_TOKEN`, `OPENSWARM_DATA_DIR`,
  `MACRO_BOOTSTRAP_COORDINATOR/CWD`, `MACRO_BOOTSTRAP_REHYDRATE` (swarm-harness-
  prefixed aliases acceptable). State dir keyed by `swarm_id`.
- **Rehydrate-on-restart**: on boot with `REHYDRATE=all`, restore the full agent
  tree from the session store (the one non-trivial bit — needs the daemon/session
  persistence to enumerate + respawn).

**Acceptance:** `swarm-harness host --port N` binds 3 ports, answers `/health`,
boots a coordinator when `BOOTSTRAP_COORDINATOR` is set, and OpenHive's
`spawn_command_override` path reaches a healthy swarm.

---

### P6 — ACP-over-WebSocket (+ ACP-over-MAP) (H1) _(M)_ — ✅ DONE (2026-06-10)

> **P6 — ✅ DONE (2026-06-10).** `src/host/acp-ws-server.ts`: `createAcpWsServer`
> accepts WebSocket connections on the base port at `/acp`, adapts each `ws`
> socket into the SDK's `Stream` (parsed `AnyMessage` duplex — no ndjson framing
> over WS), and hands it to an `AgentSideConnection`. Per-connection teardown via
> `AcpConnection.close()`; non-WS HTTP probes get 426. The per-connection
> coordinator-team wiring (router + runner + spine) was extracted into
> `src/acp/team-connection.ts` (`createTeamConnection`), now shared by the stdio
> path (`runAcpTeam`, refactored, regression-free) and the host. `boot.ts` binds
> the ACP-WS server when an `acpFactory` is supplied; `cli/host.ts` wires the
> team factory so each WS client gets its own coordinator team. Verified
> end-to-end: a WebSocket client `initialize` against the live `swarm-harness
> host` returns `{protocolVersion, agentInfo:swarm-harness, agentCapabilities:{
> loadSession:true, _meta.swarm}}` — resume-by-session rides on `loadSession`
> (AcpTeamAgent's session/load + spine replay). Concurrent connections get
> independent teams (single-active-client assumption; reconnect resumes via the
> persisted spine). Added `ws`/`@types/ws` deps. Transport + boot-wiring unit
> tests; full src/swarm + src/acp gates green (946 passed).

**New / modified**
- `src/acp/ws-transport.ts` — WebSocket transport in front of the existing
  `AcpAgent` (`src/acp/agent.ts`, `index.ts` is stdio today). Serve `/acp` on `base`.
- Reuse `loadSession`/`resumeFrom` (`agent.ts:85`) for OpenHive's resume-by-
  `provider_session_id` (`/sessions/{id}/resume`). Map `provider_session_id` ↔
  swarm session id.
- ACP-over-MAP (`createACPStream`) bridge for the hub/TUI path (depends on P7).

**Acceptance:** an ACP client connects over WS, runs a turn, disconnects,
reconnects, and resumes the session with transcript replay; `_meta.swarm`
enrichment rides through.

---

### P7 — MAP server + per-agent register + sidecar (H2) _(L — dominant cost)_ — ✅ DONE (2026-06-10)

> **P7 — ✅ DONE (2026-06-10).** Adopted `@multi-agent-protocol/sdk`'s
> `MAPServer`. `src/host/map-server.ts`: `createMapServer` binds an inbound WS
> server on `base+2` at `/map`, adapts each `ws` socket into the MAP `Stream`,
> and hands it to `MAPServer.accept(stream, {role:"client"})` — OpenHive's
> MAPClientManager connects here (Path B: swarm = server, hub = client).
> `src/host/map-bridge.ts`: `bridgeHostToMap` subscribes the StandaloneHost lane
> bus and registers agents via the SDK registry on `worker_spawned` (coordinators
> carry `capabilities:['acp']` + structured metadata so OpenHive resolves its ACP
> target; workers don't), unregisters on `worker_exited`, and forwards
> lifecycle/task/mail lane events onto the MAP event bus. `boot.ts` stands up the
> MAP server + bridge when `map:true`; `cli/host.ts` enables it. Verified
> end-to-end: a real MAP SDK `ClientConnection` over WS completed the `connect`
> handshake against the live `swarm-harness host` and called `listAgents()`.
> **SDK packaging fix:** the SDK's `/server` subpath shipped no `.d.ts`
> (rollup-dts hard-fails on pre-existing federation/auth strict errors); fixed in
> the `references/multi-agent-protocol` submodule by emitting the server
> declaration tree with `tsc` (best-effort) and repointing the `./server` export
> — symlinked into swarm-harness node_modules for now, to be republished. 16 new
> host tests (transport + bridge register/unregister/forward/dispose); full
> src/host + src/acp + src/swarm gates green (955 passed). The outbound sidecar
> (dial-back to a hub) + full task/mail bridges are the remaining follow-ons
> beyond the OpenHive-hosted path.

Today swarm-harness is MAP-client-only over a shim. Build the server.

**New / modified**
- Add `@multi-agent-protocol/sdk` dep (D3); **replace** `src/swarm/adapters/
  map-protocol.ts` shim usages with the SDK.
- `src/host/map-server.ts` — MAP **server** (inbound WS) on `base+2` at `/map`;
  the hub's `MAPClientManager` connects here.
- `src/host/map-sidecar.ts` — upgrade `MapAdapter` (`map-adapter.ts`, currently
  connection-level `capabilities:{swarm:true}`) to **dial back to the hub**
  (`openhive_url`/`preauth_key`/`swarm_id` from bootstrap) and do **per-agent
  registration** `map/agents/register` with `protocols:['acp']` for coordinators,
  driven by lane/lifecycle events (`worker-lifecycle`, lane events).
- task bridge + mail-push bridge (map agent-inbox/opentasks events onto MAP),
  mirroring macro `src/map/{task-bridge,mail-bridge,lifecycle-bridge}.ts`.

**Acceptance:** OpenHive (or a MAP SDK test client) connects to `base+2`, sees the
swarm register, sees coordinators/workers appear via `map/agents/register` with
correct capabilities, and receives task/mail/lifecycle events. Wire-parity tested
against the SDK.

---

## P8 — CONVERGENCE: cascade actions + `_macro/spawnAgent` (H5) _(M)_ — ✅ DONE (2026-06-10)

> **P8 — ✅ DONE (2026-06-10).** The end-to-end "swarm-harness hosted by
> OpenHive" milestone. `src/host/macro-methods.ts`: `_macro/spawnAgent`
> (→ `StandaloneHost.spawn`, long-lived, tracks the handle) + `_macro/terminateAgent`
> (→ `handle.kill()`), registered as MAP `additionalHandlers` (request/response);
> param names match macro-agent so an OpenHive client speaks to either backend.
> `src/host/cascade-actions.ts`: `registerCascadeActions` wires per-connection
> `x-cascade/request.*` notifications → Track-A primitives — `merge` →
> `host.mergeStreamIdIntoBranch` (added as a host passthrough + adapter-interface
> method), `resolve` → `host.resolveConflict` (the P2 coordinator signal),
> `abandon` → emit abandoned; `commit`/`pause`/`resume`/`push` emit a structured
> `unsupported` (swarm-harness's leaner adapter); every action emits an
> `x-cascade/stream.*` result back on the MAP bus. `boot.ts` registers both when
> `map:true`, and now attaches a `GitCascadeBranchPolicyAdapter` to the hosted
> host when `cwd` is a git repo (so cascade merges operate on real git;
> degrades to `unsupported` outside a repo). Verified end-to-end: a MAP client's
> `x-cascade/request.merge` over WS reaches the handler → the git adapter
> (`missing_source` on a nonexistent stream in a repo; `unsupported` outside
> one). 16 new host tests; full src/host + src/swarm + src/acp gates green
> (887 passed).

Wire OpenHive's hub buttons to Track A's primitives. Needs P1 (recovery) + P4
(landing) + P7 (MAP).

**New**
- `src/host/macro-methods.ts` — MAP extension handlers `_macro/spawnAgent`
  (spawn coordinator/agent with loadout defaults → orchestrator) and
  `_macro/terminateAgent` (real termination).
- `src/host/cascade-actions.ts` — handlers for `merge | push | commit | abandon |
  pause | resume | resolve`:
  - `merge`/`push`/`commit`/`abandon` → the `BranchPolicyAdapter` landing
    primitives (Track A).
  - `resolve` → completes a P1 `escalate` (the human-in-the-loop path) by calling
    the resolver/`resolve_conflict` flow.
  - `pause`/`resume` → stream pause/resume.

**Acceptance:** from an OpenHive-style client, spawning a coordinator, merging a
member's stream, and resolving an escalated conflict all succeed over MAP. This is
the end-to-end "swarm-harness hosted by OpenHive" milestone.

---

## Out of scope (D2 — do not build)

`auto-resolve` · `direct-push`/`optimistic-push` · declarative workspace DSL (W4)
· capability→tool map (C1) · foreign-agent wrapping (R1/R2) · REST CRUD API ·
cross-instance federation · networked control server · cognitive/analyst backend
(N5, deferred). The openswarm *adapter* (Path A) is a cheap later add once
`boot()` exists, not in this plan.

## Test strategy

- **Unit**: registry select/dispatch, each landing + recovery strategy, the
  `attach` branch policy, MAP message shapes against the SDK.
- **E2E (git)**: forced-conflict → defer/escalate/spawn-resolver; queue drain with
  contention; cascade-rebase debounce. Mirror macro's
  `conflict-resolution-git.e2e.test.ts` / `real-git-operations.e2e.test.ts`.
- **E2E (hosting)**: boot 3 ports → health → MAP register → ACP connect/resume →
  cascade action, with a MAP SDK test client standing in for the hub.
- **Live**: full autonomous resolver + a real OpenHive spawn, behind the usual
  live-agent flag.

## Status

Draft plan (2026-06-09). Phases are independently shippable; flip items to ✅ in
[`43-macro-agent-parity.md`](./43-macro-agent-parity.md) with a commit ref as they
land. Recommended first PRs: **P0** (seam, zero-risk) and **P5** (host skeleton)
in parallel.

### Track A hardening pass — ✅ DONE (2026-06-09)

Multi-agent review of P0–P4 surfaced a confirmed RCE + correctness/robustness
bugs. Fixed in priority order, each with regression tests; full `src/swarm` gate
green (707 passed, 1 skipped):

- **CRITICAL — shell injection** in the adapter: every `execSync(\`git …\`)` with
  interpolated refs converted to `execFileSync("git", argv)`. Injection
  regression tests via a malicious `targetBranch`. _(commit 67f0a46)_
- **Adapter data-loss / leaks**: merge/CAS split so a concurrent advance is
  `stale` (retryable) not a false conflict; finalize re-verifies a conflict-free
  tree + empty-oldSha guard; worktree removal only on success; tmp-worktree
  registration-before-add; dispose skips already-removed worktrees. _(67f0a46)_
- **HIGH — host coordination & kill** _(commit 832137b)_: conflict waiters are a
  Set (concurrent waits all woken); `resolvedConflicts` buffer bounded (LRU,
  cap 256); timers `.unref()`'d; worker `kill` registers the exit listener
  before signalling and escalates SIGTERM→SIGKILL on a bounded grace window.
- **CRITICAL — conflictId collision** _(commit bdf0259)_: per-invocation
  `…:${randomUUID()}` so a stale buffered resolution can't satisfy a later
  distinct conflict; **HIGH** `conflictRecovery.maxRecoveryDepth` now folds into
  `strategyConfig` (was silently dropped); per-member `land() === null` now
  `continue`s instead of aborting the cohort.
- **HIGH — resolver-timeout worktree leak** _(commit 40372a5)_:
  `discardConflictWorktree` (idempotent) wired as a `cleanupWorktree` dep called
  on timeout so the git worktree registration doesn't leak.
- **Test gaps** _(commit 11478b1)_: mergeStreams/conflictRecovery zod validation;
  unregistered-strategy defer; non-conflict `git_error` + `failOnConflict`.

#### Lower-priority pass (MEDIUM/LOW) — ✅ DONE (2026-06-09)

All actionable MEDIUM/LOW review items (the cosmetic `void out`/`msg.slice` nit
was the only deliberate skip — the review itself said to ignore it):

- **Observability** _(c78967d)_: `resolveConflict` emits a `team_note` for both
  waiter-woken (`conflictSignal:"resolved"`) and no-waiter (`"buffered"` — the
  resolve-before-wait OR dropped post-timeout signal) paths, so an orphaned/late
  signal is no longer silent (MEDIUM: timeout-race surface + swallowed signals).
- **Adapter robustness** _(df90479)_: `missing_source` errorType when
  `stream/<id>` doesn't exist (likely under streamId-keyed drain); `agentStreams`
  pruned + worktree torn down on a landed stream (bounds the map); `fast-forward`
  ⊥ `retainOnConflict` documented.
- **Resolver diagnostics + polish** _(89389b3)_: one-time `team_note` when
  spawn-resolver is selected below `danger-full-access` (resolver can't `exec`,
  so it degrades to escalate — now visible); 10s bound on the `resolve_conflict`
  IPC ack; tool reuses `TaskResolveConflictParamsSchema` (no schema drift).
- **Resolver reap** _(f78204b)_: resolver subprocess killed on every post-spawn
  path (success/failure/timeout), not just timeout — no lingering process per
  resolved conflict on a persistent team.
- **Deferred-semantics clarity** _(15b3d41)_: `abandoned` note says "work left
  unmerged on its branch"; escalate `mode:"async"` annotated as P8 forward-decl;
  `select` duplicate-role and `enqueueMerge` required-targetBranch documented.
