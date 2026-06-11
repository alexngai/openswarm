# 43 — macro-agent Parity Gap Analysis

Living tracker of disparities between `swarm-harness` (TS) and
`references/macro-agent/` (TS orchestration system). Companion to
`15-parity-gaps.md` (claw-code parity) and `39-codex-parity-gap-analysis.md`
(Codex parity).

**swarm-harness is the spiritual successor to macro-agent.** macro-agent is a
*server/orchestrator* that wraps third-party agent binaries (Claude Code, etc.)
over ACP and invests everything in coordination, git-workspace topology, and
platform surfaces. swarm-harness is a *self-contained agent binary* that builds
its own engine + tools and orchestrates them natively. The goal of this doc is
**full feature parity** so swarm-harness can eventually subsume macro-agent and
users can migrate off it.

Because the two have different identities, "parity" here means **the capability
is available**, not that the implementation matches. Several macro-agent
features are realized differently in swarm-harness (e.g. a local Unix-socket
daemon vs. a networked REST/control server) — those are tracked as ⚠️ partial or
🟦 divergent rather than ✅, with a note on what closing the gap requires.

## Legend

| Status | Meaning |
|---|---|
| ❌ missing | No equivalent exists in swarm-harness |
| ⚠️ partial | Functionally present but narrower / shallower than macro-agent |
| ✅ parity | Capability available; behaviorally equivalent or superior |
| 🟦 divergent | Intentionally different design; revisit before porting |
| 🔵 swarm-lead | swarm-harness has it; macro-agent doesn't (not a gap — context) |

**Priority:** `P0` (blocks migration) · `P1` (meaningful gap) · `P2` (nice-to-have) · `P3` (deferred / unclear value)

**Effort:** `XS` (<0.5d) · `S` (0.5–1d) · `M` (1–3d) · `L` (3–7d) · `XL` (>1w)

Reference paths below are relative to `references/macro-agent/`.

---

## 1. OpenHive hosting-adapter contract _(was: networked servers)_

The original N1–N5 "servers buffet" resolves, per OpenHive's actual usage
(`references/openhive`), into **one bounded thing: be a hostable OpenSwarm
adapter.** OpenHive doesn't *connect to* a swarm — it **spawns** it as a child
subprocess on 127.0.0.1 (`src/swarm/providers/local.ts` `LocalProvider`,
`spawn(bin, ['--port','--host','--adapter','macro-agent'])`), binds **three
consecutive ports** (`manager.ts:2836`, `swarm-bridge.ts:619`), and drives it
over **MAP + ACP — never REST CRUD, never peer federation**:

- `base` → **ACP WebSocket** at `/acp` (live sessions; `/sessions/acp-connect`, resume by `provider_session_id`)
- `base+1` → **gateway HTTP** `/health` (+metrics; health-probed before connect)
- `base+2` → **MAP server** at `/map` (coordination; `_macro/spawnAgent` / `_macro/terminateAgent`, task bridge, mail-push)

Control is MAP extension methods; cascade actions (`merge|abandon|pause|resume|
resolve|push|commit`, `useApi.ts:2225`) are OpenHive's human-facing surface over
the git-workspace layer — `resolve` = human-in-the-loop conflict resolution in
the hub UI (the escalate target for hosted teams; ties to W1).

| # | Piece | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| H0 | **Programmatic `boot()` host entry** (binds the three ports from flags + bootstrap env) | ❌ | P1 | M | Foundational — swarm-harness's analog of macro-agent `bootV2()`; none exists today. Per **D3 Path B**, swarm-harness binds its **own** ports (no openswarm gateway); OpenHive spawns it via `spawn_command_override`. |
| H1 | **ACP-over-WebSocket** on `--port` at `/acp` (+ ACP-over-MAP) | ❌ | P1 | M | Primary live channel. Wrap the existing stdio `AcpAgent` (`src/acp/index.ts`) in a WS transport — reuses shipped ACP + `session/load`/resume + `_meta.swarm` work. (was N2) |
| H2 | **MAP server** on `--port+2` at `/map` + bridges | ⚠️ | P1 | L | **Dominant cost.** Hub's `MAPClientManager` connects here. Today swarm-harness only forwards *outbound* over a shim (`map-adapter.ts`); gap = *hosting* a MAP server via **`@multi-agent-protocol/sdk`** (D3, replaces `map-protocol.ts`) + per-agent register (`map/agents/register`, `protocols:['acp']`) + sidecar dial-back + task/mail bridges. (subset of old O1) |
| H3 | **Health/metrics HTTP** on `--port+1` | ❌ | P2 | S | `/health` probed by the hub (`deriveHealthUrls`). Trivial — **not** the full REST CRUD. |
| H4 | **OpenSwarm bootstrap protocol** | ❌ | P2 | S | `--port/--host/--adapter` flags + env (`OPENSWARM_BOOTSTRAP_TOKEN`, `OPENSWARM_DATA_DIR`, `MACRO_BOOTSTRAP_COORDINATOR/CWD`, `MACRO_BOOTSTRAP_REHYDRATE=all` → restore full agent tree on restart). |
| H5 | **Cascade-action handlers** (`merge/abandon/pause/resume/resolve/push/commit`) | ❌ | P1 | M | The hub's buttons over the git-workspace layer. `resolve` = escalate-to-human (links W1); `merge/push/commit/abandon` call the same landing primitives as W1/W2/W5. Build alongside §2. |
| ~~N1~~ | ~~REST/HTTP CRUD API~~ | 🚫 | — | — | **Rejected.** OpenHive uses MAP for agent/task/team ops; only `/health`+metrics over HTTP (→ H3). |
| ~~N3~~ | ~~Cross-instance federation~~ | 🚫 | — | — | **Rejected.** OpenHive *is* the coordination/federation plane; a hosted child never peer-federates. |
| ~~N4~~ | ~~Standalone networked control server~~ | 🚫 | — | — | **Rejected.** Control is MAP `_macro/*`; the local unix-socket team-daemon already covers CLI control. |
| N5 | **cognitive-core / analyst backend** (`src/cognitive/`) | ⏸️ | P3 | XL | Defer. Only powers OpenHive's separate learning/analyst feature (`openhive/src/learning/swarm-agent-backend.ts`), not hosting. |

---

## 2. Git workspace topology & landing

macro-agent's centerpiece: a declarative per-role YAML grammar driving stream
placement, landing, and conflict recovery. swarm-harness has git-cascade
worktree isolation + `mergeStreams`, but the recovery/queue depth and the
declarative DSL are thinner. This is the highest-leverage cluster for migration.

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| W1 | **Conflict-recovery dispatch** — `defer / abandon / escalate / auto-resolve / spawn-resolver` (incl. spawning an LLM resolver agent) | ❌ | P0 | M (sync strats) + M–L (spawn-resolver) | swarm only surfaces conflicts as a `team_note` then gives up at `peer-team.ts:469` (`if (!result.success)`). **Injection point confirmed: that block.** Port macro's `ConflictRecoveryStrategy` (`workspace/recovery/`, types in `conflict-recovery.md` §3) into a new `src/swarm/recovery/`. `defer/abandon/escalate` are near-free. **`auto-resolve` (`-X ours\|theirs\|union`) is CUT** (D2): cheap to build but actively harmful — blind side-picking silently drops code changes and produces a green-but-wrong merge. Autonomous teams get `spawn-resolver` (understands the conflict) or `escalate`; never blind resolution. `spawn-resolver` needs W1b primitives (attach-to-conflicted-branch BranchPolicy). For OpenHive-hosted teams, `escalate` surfaces via the MAP cascade `resolve` action (H5). |
| W2 | **Merge-queue + integrator-drain landing** (`queue_to_branch`, `merge_queue.drain`) | ❌ | P1 | M | **No dep bump needed — verified the full queue ships in the pinned `git-cascade@0.0.7`** (`tracker.d.ts:298–333`): `addToMergeQueue` / `getNextToMerge(targetBranch?)` / `markMergeQueueReady` / `processMergeQueue` (the drain → `ProcessQueueResult {merged[], failed[], skipped[]}`) / cancel / remove / position, with statuses `pending\|ready\|merging\|merged\|failed\|cancelled` and `x-cascade/queue.*` events for free. So the ordering/persistence/drain are **done in the dep**; remaining work is just: (1) surface these on `BranchPolicyAdapter`, (2) a `queue-to-branch` LandingStrategy = `addToMergeQueue`, (3) give the `integrator` role (model B, `longLived: true`, `MemberSpec:55`) a drain loop calling `processMergeQueue`. Drain `failed[]` entries feed the W1 recovery dispatcher. `ProcessQueueOptions.strategy` = `merge-commit\|squash\|rebase`. |
| W3 | **`LandingStrategy` seam** (keep) + `direct_push` / `optimistic_push` (cut) | ⚠️→🚫 | P1 | S (seam) | **Seam: keep** — introduce the `LandingStrategy` interface (port `types-v3.ts:146`) and refactor inline `maybeMergeStreams` into a no-op-change `MergeToParentStrategy` (this is the step-1 refactor; W2 needs it too). **`direct-push`/`optimistic-push`: CUT** (D2) — no trunk-based workflow in scope; add only if one appears. |
| W4 | **Declarative per-role workspace DSL** (`workspace:` / `stream_lineage:` / `landing:` / `on_conflict_recovery:` in team YAML) | 🚫 | P3 | L | **Rejected** (D2) — code topologies + openteams templates already serialize; a hand-rolled `workspace:` grammar is large surface for marginal benefit. Revisit only if wire-submittable per-role team configs become a need. |
| W5 | **Cascade rebase on parent advance** (`cascade_on_parent_update`, `on_parent_advanced: sync_with_parent`, 2s-debounced) | ⚠️ | P1 | S–M | **Primitive already shipped**: `GitCascadeBranchPolicyAdapter.cascadeRebase()` (adapter:421) wraps `tracker.cascadeRebase` with `stop_on_conflict/skip_conflicting/defer_conflicts`. Gap is purely the trigger — after a merge advances a parent stream, call it (+ 2s debounce). `defer_conflicts` feeds each failed stream into the W1 dispatcher (`conflict-recovery.md` E5). Add `member.onParentAdvanced?: "sync"`. |
| W6 | **`resolve_conflict` MCP tool** (resolver reports resolution back) | ❌ | P1 | S | New `src/tools/tier2/resolve_conflict.ts` next to `commit_changes.ts`. **Gating already solved** by swarm's model — just add `"resolve_conflict"` to the resolver role's `allowedTools` (`roles.ts:38`); macro's `capability → CAPABILITY_TOOL_MAP` indirection is unnecessary here. |

---

## 3. Agent runtime model

The deepest structural difference. macro-agent **detects and wraps installed
CLI agents** as black boxes; swarm-harness **is** the agent. Full parity here is
a product decision, not just engineering.

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| R1 | **Foreign CLI-agent detection & wrapping** (`src/agent-detection/`, drives Claude Code / arbitrary CLI agents via `acp-factory`) | 🚫 | — | XL | **Rejected** (D2) — directly contradicts swarm-harness's vision of building its own agent (`00-vision.md`). "Remote orchestration" (§1) ≠ wrapping foreign CLIs. swarm-harness keeps its own `AgentEngine` + the one Codex framework. |
| R2 | **`acp-factory`-based session/handle abstraction** for heterogeneous agents | 🚫 | — | L | **Rejected** with R1. swarm-harness's `AgentEngine` seam is the equivalent. |

---

## 4. Observability (MAP)

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| O1 | **Deep MAP integration** (macro `src/map/`: server, sidecar, multiple bridges, cascade-diff-server — ~16 files) | ⚠️ | P2 | L | swarm-harness is **outbound-only**: forwards lane events via `--map ws://` (`src/swarm/adapters/map-adapter.ts` + `map-protocol.ts`). Gap = hosting/serving the MAP surface (diff server, sidecar, richer bridges). |
| O2 | **Trajectory / coordination / cascade-diff bridges** | ⚠️ | P2 | M | Subset of O1; macro has dedicated bridges (`trajectory-reporter.ts`, `coordination-handler.ts`, `cascade-diff-server.ts`). swarm-harness emits events but doesn't reconstruct trajectories/diffs server-side. |

---

## 5. Roles & capabilities

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| C1 | **Per-role capability gating in YAML** (`capabilities: [workspace.commit, workspace.land, ...]` gating MCP tools) | 🟦 | P2 | S | **~80% already met, divergently.** swarm gates per-role via `Role.allowedTools: readonly string[]` (`roles.ts:38`) + the dispatcher's `allowedTools` set (`dispatcher.ts:58`) — it lists tool *names* directly instead of macro's `capability → CAPABILITY_TOOL_MAP → tools` indirection (`capabilities.ts:157`). New tools (`resolve_conflict`, `drain_queue`) are already listable there. Named capability *groups* are optional sugar over `allowedTools`; not required for parity. |
| C2 | **Capability-gated `spawn_agent`** (depth/permission via capability, not just depth-limit) | ⚠️ | P2 | S | swarm-harness has `depth-limit.ts` + ancestry; macro additionally gates spawn via role capability. Align the gating model. |

---

## 6. Team configuration & templates

| # | Gap | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| F1 | **`.multiagent/teams/<name>/` layout** (team.yaml + `roles/*.yaml` extending base roles + `prompts/*.md`) | ⚠️ | P2 | M | swarm-harness uses openteams templates + inline `TeamSpec`. Gap = the role-extends-base + split-prompt-file convention. Decide whether to adopt macro's layout or map it onto openteams. |
| F2 | **Role inheritance** (`grinder` extends `worker`, `judge` extends `monitor`) | ❌ | P2 | S | No role-extends-base mechanism in swarm-harness role registry. |
| F3 | **`on_team_complete` / `on_team_stop` team-stream policy** (keep / merge_to_main / abandon) | ⚠️ | P2 | S | swarm-harness has merge-to-target on completion; the keep/abandon team-stream lifecycle policy is partial. |

---

## Already at parity (context, not gaps)

| Capability | Status | Notes |
|---|---|---|
| agent-inbox messaging | ✅ | `src/swarm/adapters/agent-inbox-backend.ts`. |
| opentasks task daemon | ✅ | `--opentasks`, `opentasks-client.ts`, `opentasks-task-registry.ts`. |
| git-cascade worktree isolation + stream merge | ✅ | `--git-cascade`, `git-cascade-branch-policy.ts` (minus §2 depth). |
| Roles + topologies + team YAML / openteams templates | ✅ | `src/swarm/roles.ts`, `topologies/`, `team-spec.ts`. |
| ACP editor integration | ✅ | stdio (N2 is the WS gap), plus `_meta.swarm` convention macro lacks. |
| MAP event forwarding | ✅ | outbound (O1 is the server-side gap). |

## swarm-harness leads (🔵 — macro-agent has no equivalent)

These are *why* swarm-harness can be the successor — it owns the vertical stack
macro-agent delegates to wrapped binaries: its own pluggable `AgentEngine`
(Claude Agent SDK + native Vercel-AI-SDK + Codex), 15 native Tier-0 tools,
multi-provider transports (Anthropic/OpenAI/xAI/Google/DashScope), an
interactive OpenTUI/Solid TUI, a 4-layer memory system, OS-level sandboxing +
bash validation, plugins/skills/hooks discovery, and the published `_meta.swarm`
ACP convention. Do not regress these while closing parity.

---

## Migration design decisions

### D1 — Landing model: **Hybrid (A now, B later)** _(decided 2026-06-09)_

The load-bearing choice for the whole §2 cluster. The two systems land work
differently:

- **macro-agent is agent-centric.** Each agent calls a `done()` MCP tool → a
  role-specific **done handler** runs `LandingStrategy.land()` → on conflict the
  handler dispatches a `ConflictRecoveryStrategy`. Per-agent, self-triggered.
- **swarm-harness is topology-centric.** Members run and exit; the **topology
  executor** merges streams afterward. The entire landing path is
  `PeerTeamTopology.maybeMergeStreams()` (`peer-team.ts:428`) — a loop over
  members calling `ctx.host.mergeStreamForAgent` / `mergeStreamToBranchForAgent`.
  `mergeStreams` (targetStream XOR targetBranch) is the **only** landing mode;
  there is no `done()` tool, no per-agent landing strategy, no recovery.

**Decision:** build the `LandingStrategy` + `ConflictRecoveryStrategy`
**registries** once (same shape as macro's), wire them into the **topology
executor** first (model **A** — fast W1 win at `peer-team.ts:469`), and add a
per-agent `done()`-handler **trigger** later (model **B**) when W2's
merge-queue/integrator needs it. Strategies are written once; only the *trigger*
evolves. This avoids a big up-front `done()` refactor while not boxing us out of
the faithful macro model.

**Consequences:**
- W1/W6/W5 land under model A (topology-driven dispatch).
- W2/W3 introduce the `LandingStrategy` seam and the model-B `done()` trigger.
- swarm has no `ConflictRecord`/`conflictId` (git-cascade surfaces `conflicts:
  string[]` paths only) — the new `src/swarm/recovery/` registry **synthesizes
  and owns `conflictId`s** locally rather than porting macro's ConflictRecord.

### D2 — Scope: "cover what users actually do," pruned within clusters _(decided 2026-06-09)_

Migration bar = **cover real workflows, not feature-complete parity.** All four
candidate workflows were confirmed near-term real (autonomous teams, many-writer
→ one branch, stacked streams, remote/hosted via OpenHive), so no cluster is
rejected wholesale — but each is built in its **minimal viable** form, and
several macro-agent-isms are cut outright:

**Cut / rejected (🚫):**
- **`auto-resolve`** (W1) — harmful blind side-picking; `spawn-resolver`/`escalate` cover it.
- **`direct-push` / `optimistic-push`** (W3) — no trunk-based workflow in scope (the `LandingStrategy` *seam* is kept).
- **Declarative workspace DSL** (W4) — code topologies + openteams templates suffice.
- **Capability→tool map** (C1) — `Role.allowedTools` already gates per-role; map is sugar.
- **Foreign-agent wrapping** (R1/R2) — contradicts the build-our-own-agent vision.
- **REST CRUD API, federation, networked control server** (old N1/N3/N4) — OpenHive uses MAP+ACP and *hosts* the swarm; see §1.

**Deferred (⏸️, build when a consumer appears):**
- **cognitive/analyst backend** (N5) — only for OpenHive's learning feature.

**Kept, minimal:** the §1 hosting-adapter contract (H1–H5), §2 W1(defer/escalate
/abandon + bounded spawn-resolver)/W2/W5/W6, and the `LandingStrategy` seam.

The §1 hosting work and §2 git-workspace work **converge**: OpenHive's cascade
actions (`merge/push/commit/abandon/resolve`) are the hub UI over the same
landing/recovery primitives W1/W2/W5 build (H5). Build them together.

### D3 — OpenHive hosting: Path B (direct-spawn) + real MAP SDK _(decided 2026-06-09)_

OpenHive hosts swarms via `openswarm` (a gateway + TUI) that loads a
`MAPServerAdapter` plugin — macro-agent plugs in as `src/hosting/adapters/
macro-agent.ts` (~340 lines of glue) whose `bootV2()` binds the three ports.
swarm-harness is a *full product* (own TUI/engine/binary), not a headless
backend, so:

- **Path B (direct-spawn, standalone)** — swarm-harness binds its **own** three
  ports and speaks MAP; OpenHive spawns it via `LocalProvider`'s
  `spawn_command_override` (the path already reserved for "non-openswarm kinds").
  No `openswarm` dependency. A thin openswarm adapter can come later for free
  once the `boot()` core exists, but is not the target.
- **Adopt `@multi-agent-protocol/sdk`** for the MAP layer (H2), replacing the
  in-house `map-protocol.ts` shim — guarantees wire parity with the hub for the
  server, `map/agents/register`, and ACP-over-MAP paths.

**Already-have head starts:** ACP agent + `session/load` + engine resume
(`src/acp/agent.ts:85`) maps to OpenHive's resume-by-`provider_session_id`; the
`_meta.swarm` ACP convention; outbound MAP client (`map-adapter.ts`, to be
upgraded to a server); lane/lifecycle events for the bridge; git-cascade
primitives for cascade actions.

**Dominant cost = H2** (become a MAP *server* with per-agent registration +
ACP-over-MAP). Today swarm-harness only *emits* MAP outbound over a shim. H1
reuses the ACP work; H3/H4 are mechanical; H5 converges with §2.

## Status

Draft — gap capture + design review (2026-06-09). Sequencing reflects D1:

1. **Seam refactor** — introduce `LandingStrategy` + `ConflictRecoveryStrategy`
   registries (interfaces only) and refactor `maybeMergeStreams` into a
   behavior-preserving `MergeToParentStrategy`. Creates both seams, no behavior
   change. (Unblocks W1, W3.)
2. **W1 sync strategies** — `defer / abandon / auto-resolve / escalate` +
   recovery dispatch at `peer-team.ts:469` + TeamSpec fields (`member.onConflict`,
   `coordination.conflictRecovery`). First user-visible win.
3. **W6 + W1 `spawn-resolver`** — the `attach`-to-conflicted-branch BranchPolicy
   (W1b primitive), resolver role, `resolve_conflict` tool, recovery coordinator.
4. **W5** cascade auto-rebase wiring (primitive already exists; add the trigger
   + debounce).
5. **W2 / W3** queue-to-branch + integrator (model B); verify/bump `git-cascade`
   for the built-in merge queue.
6. **W4** declarative DSL last, over the now-proven primitives.
7. **N1/N2/N4** networked servers — only if remote/multi-client is required.
8. **R1, N3, N5, O1** — large, scope-dependent; decide intent before sizing.

When a gap closes, flip its Status and add a commit/file reference in Notes
(mirror the `15-parity-gaps.md` convention).
