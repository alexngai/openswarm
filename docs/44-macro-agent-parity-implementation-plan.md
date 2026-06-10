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
> **P2b — TODO (needs live validation).** Real `ResolverSpawner` in peer-team
> (spawn resolver into the live team, place it on the conflict, await
> `waitForConflictResolution`, retry the merge); WorkerHost→orchestrator IPC for
> `resolve_conflict`; the resolver-worktree mechanism (likely retain the
> conflicted merge worktree instead of cleaning it up); a live-agent e2e.


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

### P3 — Cascade auto-rebase (W5) _(S–M)_

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

### P4 — Merge queue + integrator (W2) _(M)_

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

### P5 — `boot()` host entry + bootstrap + health (H0/H4/H3) _(M)_

swarm-harness's analog of macro's `bootV2` — binds its own ports, reads bootstrap.

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

### P6 — ACP-over-WebSocket (+ ACP-over-MAP) (H1) _(M)_

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

### P7 — MAP server + per-agent register + sidecar (H2) _(L — dominant cost)_

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

## P8 — CONVERGENCE: cascade actions + `_macro/spawnAgent` (H5) _(M)_

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
