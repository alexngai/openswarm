# 04 — Positioning: a meshable multi-agent cluster harness

Status: **draft for discussion** · 2026-09-19 · branch `claude/openswarm-positioning-metrics`

Where OpenSwarm stands today against the goal of being a **meshable
multi-agent cluster harness** — independently launched swarms that discover
each other, share coordination state, and merge work without a restart — what
we should measure, what the industry has actually adopted, and where the
defensible position is. Architecture is [docs/01](01-dsh-foundation.md); the
research record is `legacy/docs/47–64` and [docs/02](02-discrimination-rerun.md).

## 1. What "meshable" has to mean

"Meshable" is doing a lot of work in the goal statement, so we decompose it
into nine capabilities. Each is rated on the same five-level ladder so the
scorecard in §2 is comparable across rows:

| Level | Meaning |
|---|---|
| 0 | absent |
| 1 | one process, one lead |
| 2 | many processes, one host, one lead |
| 3 | many hosts, many leads, one trust domain |
| 4 | many trust domains (cross-org), protocol-mediated |

The goal — "swarms can be seamlessly merged and coordinate" — is level 3 on
every row, with level 4 on the rows a foreign agent touches (identity,
discovery, messaging, trust).

| # | Capability | What it means concretely |
|---|---|---|
| M1 | **Swarm identity** | A swarm and each member have a stable, addressable identity that outlives a process and a run. |
| M2 | **Discovery** | A swarm can find another swarm (or a member can find a peer) by name or capability, not by a pre-shared port. |
| M3 | **Shared coordination state** | The task board and mailbox are one logical object across swarms: a task seeded by swarm A is claimable by a member of swarm B, with the same compare-and-set guarantees. |
| M4 | **Work merging** | Branches produced by members of different swarms land through one merge queue with conflict retention, and members can see each other's landed work. |
| M5 | **Trust and policy** | Who may join, claim, message, or mount a plugin is decided by policy per trust boundary, with blast-radius containment. |
| M6 | **Lifecycle** | Join, leave, split, merge, and recover while the swarm is running — no restart, no lost tasks. |
| M7 | **Heterogeneous runtimes** | A member can be a dsh harness, a Claude Code, a Codex, an OpenHands, or a foreign A2A agent, and the topology code does not care. |
| M8 | **Mesh observability** | One trace across swarms: who did what, in which worktree, at what cost, attributable per swarm, member, and model. |
| M9 | **Protocol interop** | External agents and clients speak to a swarm over a published protocol (MCP, A2A, ACP, dsh JSON-RPC) rather than a bespoke socket. |

## 2. Where we are (2026-09-19, `main` @ `9148996`)

Evidence is the code on `main`, not the docs' intent. Sizes are source lines.

| # | Capability | Level | Evidence |
|---|---|:-:|---|
| M1 | Swarm identity | **1** | `teamId` is 8 random hex per run (`worktrees.ts`); members are names within one roster; the app-server's run table is an in-memory map that dies with the process. No identity survives a run. |
| M2 | Discovery | **0** | Members reach the lead through `OPENSWARM_SWARM_URL` + a spawn-time token; the app-server is a known port. Nothing publishes or finds a swarm. |
| M3 | Shared state | **2** | The board (`board.ts`) and mailbox (`mailbox.ts`) are log-backed with CAS revisions, `waitForChange`, and replay — the right primitives — but they are a projection over **one lead's session log**. Subprocess members write to it only through `swarm/send`; there is no board operation from inside a member and no second lead can share it. docs/01 already reserves the seam for a sqlite/CRDT backend. |
| M4 | Work merging | **2** | Per-task worktrees, auto-commit, a sequential merge queue into `swarm/<teamId>/integration`, retained conflicts, orphan sweep, a concurrency cap (`git/`, `worktrees.ts`). All scoped to one team on one host; tasks are cut from `baseRef` so siblings never see each other's landed work (ledgered). |
| M5 | Trust | **2** | Loopback-only `SwarmServer` (`127.0.0.1` hardcoded), per-member UUID tokens, sender identity from the token; F3's `self`/`lead` blast radius with the human approval gate. Single-user trust; no join policy, no per-swarm principal. |
| M6 | Lifecycle | **2** | Member death detection, task re-claim, poison-task abandonment, warm restart from a log digest; graceful and hard-kill worktree hygiene. Runs are one-shot: leads are disposed on settle, nothing joins or leaves a running team, and member sessions persist but never resume (upstream gap, pinned by `member-resume.test.ts`). |
| M7 | Runtimes | **2** | In-process and `subagent-dsh-sdk` subprocess members, per-member provider/model, cross-provider usage. docs/01 names upstream `subagent-claude-code` / `subagent-codex` providers but nothing in `packages/` exercises them. |
| M8 | Observability | **2** | Everything model-visible is in a session log; per-model usage folds from events; `/swarm` runs are `ctx.jobs` rows. No cross-process trace id, no OpenTelemetry, cost is tokens-only (`costUsd` is 0 in the CLI). |
| M9 | Protocol interop | **1** | dsh's JSON-RPC SDK surface plus three `swarm/*` methods on a TCP socket. The legacy ACP `_meta.swarm` convention (legacy docs/36) was not ported; no MCP server exposure, no A2A agent card. |

**Reading the scorecard.** We are a solid **level-2 single-host cluster harness**
with an unusually good coordination kernel (durable CAS board, durable mailbox,
recovery, worktree isolation, seven topologies, heterogeneous rosters) and a
research record most projects lack. We are not yet a mesh: nothing crosses a
host, nothing outlives a run, and nothing can be found. The distance from 2 to
3 is mostly plumbing that the log-backed design was built to accept; the
distance from 3 to 4 is a protocol and a trust model, and that is where the
positioning choice in §5 actually bites.

Two strengths are worth naming because they are rare in this space and are the
basis for any mesh claim:

1. **State is a fold over an append-only log.** Replication, snapshot, fork and
   replay come for free once a second reader exists. Most competitors keep
   coordination state in process memory.
2. **Members are complete peer harnesses in their own processes and worktrees.**
   A member already is a network endpoint with a session of its own; "remote"
   is a transport change, not an architecture change.

## 3. Metrics and dimensions to optimize on

We have two kinds of metric with different owners: **mesh metrics** (product
engineering; do we work as a cluster) and **effectiveness metrics** (the
research arm; is a cluster worth having). Conflating them is how the field
produces headlines that do not replicate. The eval record (legacy docs/47,
59–62; docs/02) already disciplines the second set; the first set is new.

### 3.1 Mesh metrics (new)

| Metric | Definition | Today | Target for "meshable" |
|---|---|---|---|
| **Time-to-join** | seconds from a foreign swarm's endpoint URL to its first claimed task on our board | n/a (impossible) | < 10 s, zero config beyond the URL and a credential |
| **Task-loss rate** | tasks lost or duplicated across member death, lead death, host loss | 0 within one host; lead death = run lost | 0 across host loss, measured by a kill-test |
| **Coordination overhead ratio** | coordination tokens (briefings, board reads, messages, recovery digests) ÷ task tokens | unmeasured; legacy docs/61 found handoff bloat is the dominant cost driver | reported on every run; < 20 % for peer-team runs |
| **Landing rate and latency** | fraction of member branches merged clean; p50 seconds from task complete to integration | measured per run, not aggregated | > 90 % clean; conflicts retained and routed, never dropped |
| **Scaling efficiency** | tasks/hour at N members across H hosts ÷ (N × single-member rate) | single host only, `maxConcurrent` 8 unmeasured | > 0.7 at N = 32 across 4 hosts |
| **Mean time to recover** | seconds from member/lead/host failure to the affected task running again | member: seconds (warm restart); lead: ∞ | < 60 s for all three |
| **Replay fidelity** | fraction of mesh state reconstructable from logs alone | 100 % within a lead | 100 % across the mesh |
| **Trust rejections** | unauthorized joins/messages/claims rejected, and approval latency for gated actions | token-only, loopback-only | policy-driven, audited, per-boundary |
| **Runtime coverage** | member runtimes usable as peers | 2 (in-process, dsh-sdk) | 4+ (add Claude Code, Codex, one A2A agent) |

### 3.2 Effectiveness metrics (existing, keep)

| Metric | Definition | Status |
|---|---|---|
| **Quality at cost** | resolve-rate vs $/task and FLOPs/task, per arm, Pareto frontier | the research spine (legacy docs/50, 59, 60, 62); tokens authoritative, `costUsd` ledgered |
| **Oracle pre-check** | does `cost(cheap) < p_cheap × cost(large)` hold for a model pair | the one gate that predicts whether a cascade can pay (legacy docs/62 F1, F8) |
| **Escalation signal AUC** | how well the visible-correctness signal predicts a tier's correctness | 0.84–0.89 single-shot; **0.50 agentic** for a 3B tier (docs/62 F16) — the open problem |
| **Team vs single** | paired resolve-rate on hard SWE | parity across two families (docs/47); the honest baseline |

### 3.3 One north-star

**Landed work per dollar-hour, at zero task loss, across a heterogeneous
mesh.** "Landed" means merged into the integration branch and gate-passing,
not "member reported done". Every mesh metric above is a term in it (join
time and recovery are the denominator, landing rate and overhead are the
numerator), and the effectiveness metrics say whether the mesh should exist at
all for a given workload. It is deliberately not "resolve rate": docs/47 and
docs/60 showed that more coordination does not raise resolve rate on hard
tasks, and a north-star that pretends otherwise would push us back into the
topology-mechanism trap docs/02 warned against.

## 4. Industry adoption and diffusion (2026-09)

<!-- filled from the research brief -->

## 5. Where OpenSwarm is best positioned

<!-- filled after §4 -->

## 6. What this implies for the next phases

<!-- filled after §5 -->
