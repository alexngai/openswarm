# 04 — Positioning: a meshable multi-agent cluster harness

Status: **draft for discussion** · 2026-09-19 · branch `claude/openswarm-positioning-metrics-z9cm4m`

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

Sourced from a web survey run for this doc on 2026-09-19 (primary sources
where reachable; star counts are as fetched that day). Numbers are quoted for
direction, not precision; the skeptical reading is deliberate.

### 4.1 The protocol layer is settled, and empty where we need it

| Protocol | Status | What it covers | What it does not |
|---|---|---|---|
| **MCP** | AAIF (Linux Foundation) since 2025-12; spec **2026-07-28** made it stateless, moved Tasks to an extension, deprecated Sampling; ~0.5B SDK downloads/month claimed | agent → tool/context | no agent-to-agent, no shared state, no work queue |
| **A2A** | LF since 2025-06, AAIF-hosted since 2026-08; **v1.0** in 2026 (signed Agent Cards, task negotiation, gRPC + JSON-RPC); 150+ orgs, native in Azure AI Foundry, Bedrock AgentCore, Gemini Enterprise; 25.9k★ | pairwise client → remote-agent delegation with discovery via Agent Cards | no task board, no claim/lease, no broadcast, no merge semantics; N² connectivity in naive use |
| **IBM ACP** | merged into A2A 2025-08; dead | — | — |
| **AGNTCY** (Cisco, LF) | ACP archived 2026-04; surviving `dir` (190★), `slim` (219★), `oasf` (334★) | directory, identity, group messaging | negligible adoption |
| **ANP / NANDA** | academic; 1.4k★ / <150★ | DID identity, registries-of-registries | no vendor adoption |

Sources: <https://blog.modelcontextprotocol.io/posts/2026-07-28/>,
<https://blog.modelcontextprotocol.io/posts/mcp-roadmap/>,
<https://github.com/a2aproject/A2A>, <https://github.com/agntcy>.

**Conclusion:** nobody standardizes the layer we build — a shared, durable
task board with compare-and-set claims, a mailbox, and a merge queue. That
is good news for differentiation and a warning about interop: our mesh
semantics will have to be *ours*, carried over A2A/MCP as the transport and
identity substrate rather than competing with them. The MCP roadmap
(agent identity, server-initiated events) and A2A's `QuerySkill()` will move
under us within a year; the coordination seam must stay pluggable.

### 4.2 Every vendor "team" is one lead, one machine, one vendor

| Harness | Team primitive | Worktrees | Across machines |
|---|---|---|---|
| Claude Code | subagents GA; **agent teams experimental**: one team per session, no nesting, no resume, JSON-file mailboxes | native `--worktree` | only via Anthropic's Remote Control relay (cross-session messaging, 2026-08) |
| Codex | subagents (≤6 concurrent), app-server JSON-RPC | automatic | cloud tasks, no team across machines |
| Gemini CLI | subagents; **remote subagents over A2A** | not native | yes, any A2A server — the only vendor-neutral hook |
| Cursor 3 / Copilot app / Devin Desktop | up to 8 parallel agents, "Agent HQ", command centre | yes | vendor cloud only |
| **dsh** | `ctx.agentTeams` experimental: durable roster, task board, mailbox, folded from **one root session log**; "no explicit support for distributed sessions across machines"; third-party `dsh-agent-teams` (1.7k★) states concurrent processes are not coordinated | third-party plugins | none |
| Cline, Amp, Kiro, OpenHands, mini-swe-agent | subagents or none | mixed | no |

Sources: <https://code.claude.com/docs/en/agent-teams>,
<https://code.claude.com/docs/en/cross-session-messaging>,
<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/agent-team.md>,
<https://geminicli.com/docs/core/remote-agents/>.

Worktree isolation became table stakes in 2026. A **merge queue** did not:
only Gas Town ships one (Bors-style, bisecting). A **vendor-neutral team
that crosses a process boundary** is a gap in every product above,
including dsh itself, whose 230k★ launch is both our substrate and our
distribution channel.

### 4.3 Frameworks converged on A2A; durable execution is where the money went

LangGraph (42k★, A2A on the managed platform), CrewAI (59k★), Microsoft Agent
Framework 1.0 (A2A + MCP native), Google ADK (A2A native), OpenAI Agents SDK
(30k★, handoffs; Swarm deprecated), Mastra (28k★). Underneath them, Temporal
raised $550M at $12.55B (2026-09) on agent workloads, Dapr Agents went GA
(CNCF), Restate ships a durable coding-agent demo. None provides a cross-org
shared work queue. Read: buyers pay for **durability and auditability**, and
a harness whose state is an append-only log is already speaking that
language.

### 4.4 The research consensus: centralize verification, not agents

- Anthropic's research system: a lead plus subagents beat a single model by
  90 % on a *research* eval at ~15× tokens, and the post warns against
  multi-agent for tightly coupled coding.
- Google, "Towards a Science of Scaling Agent Systems" (arXiv 2512.08296):
  uncoordinated multi-agent amplified errors **17.2×** vs **4.4×** with a
  central orchestrator; gains range +81 % (decomposable) to −70 %
  (sequential planning).
- MAST (arXiv 2503.13657): 41–87 % failure rates across 7 frameworks;
  37 % of failures are inter-agent misalignment, 21 % verification.
- Cognition, 2026 follow-up: "writes stay single-threaded and the additional
  agents contribute intelligence rather than actions"; unstructured swarms
  are "mostly a distraction".
- Our own record agrees: docs/47 parity, docs/60 cascade ties mono-large on
  gap tasks, docs/62 the deployable agentic signal degenerates.

Routing/cascade evidence is strong on **cost** for QA-shaped work (40–85 %
cost cuts at ~95 % quality) and absent for agentic SWE quality; there is
**no accepted team-of-agents coding benchmark** (Agyn's 72 % Verified is
model-matched, well under single-model SOTA). SWE-bench Pro (~61 % public
leader) and Terminal-Bench 4.0 (Sept 2026) are where the headroom is.

### 4.5 Where multi-agent sits on the diffusion curve

| Segment | Evidence | Rogers stage |
|---|---|---|
| Coding-agent parallelism inside one vendor (worktrees, subagents) | shipped by every major harness; default-on in Codex | **Early majority** among AI-using developers |
| Single-org multi-agent orchestration | ~15 % of enterprises at scale (McKinsey, Deloitte 2026); Gartner 2026 Hype Cycle puts agentic AI at the peak, >40 % of projects cancelled by 2027 | **Late early adopters**, entering the chasm |
| Cross-runtime, cross-machine teams in one org | Gemini CLI A2A subagents, Gas Town's DoltHub "Wasteland", GNAP's git-as-bus (86★); no vendor team does it | **Early adopters**, thin |
| Cross-org agent federation | A2A 1.0 shipped; registries (AWS 2026-08, Microsoft Entra Agent ID 2026-05, Gemini Enterprise, Solo.io→CNCF) are single-tenant catalogs; no named production cross-company networks | **Innovators** (<2.5 %) |

The OSS "swarm" vocabulary is owned by Ruflo (73k★, unverified federation
claims, no reproducible eval) and "merge queue + federation" by Gas Town
(18k★, tmux + worktrees + Bors-style queue + DoltHub-linked towns). Solace
Agent Mesh (A2A over a broker) deprecated its OSS line on 2026-09-17.

## 5. Where OpenSwarm is best positioned

**Position: the verifiable, runtime-neutral cluster layer for coding
agents — durable board, mailbox, and merge queue that any harness's agents
can join.** In one line for the README: *"Federated agent teams for dsh:
one task board, one merge queue, any runtime, any host."*

Why this and not the alternatives:

| Option | Verdict |
|---|---|
| **"Swarm / hive-mind" framing** | Owned by Ruflo's marketing, discredited by the research consensus (§4.4), and our own evals say topology mechanism is not the lever. Do not compete for it. |
| **Another coding-agent loop** | Legacy docs/58 already rejected this; dsh now owns the loop and we ride it. |
| **Cross-org federation first** | Innovators stage, no buyers, protocol still moving. Roadmap, not lead. |
| **Cluster layer over dsh, runtime-neutral, verifiable** | dsh has no cross-process story, no vendor has a vendor-neutral team, no standard covers the board/queue/merge layer, and the buyer signal is durability and auditability. Our log-backed kernel and merge queue are exactly the pieces. |

The three claims we can make credibly, each backed by something that exists
on `main` or is one phase away:

1. **Verifiable.** Every coordination decision is a replayable event; merges
   are gated and conflicts are retained, never auto-resolved; per-model usage
   is attributed. This is the answer to Gartner's cancellation wave and to
   MAST's verification failures.
2. **Runtime-neutral.** A dsh worker, a Claude Code reviewer, and a Codex
   tester on one task DAG and one merge queue. Nobody ships this; the dsh
   `subagent-claude-code` / `subagent-codex` providers make it a wiring job.
3. **Meshable.** Two independently launched swarms share a board and a merge
   queue. The honest version of this claim for the next two quarters is
   *cross-host inside one trust domain*, carried by a replicated board and an
   A2A Agent Card for discovery; cross-org is the phase after.

What we should *not* claim: that teams raise resolve rate. Our number is
parity (docs/47); the industry's is "only when decomposable". The value
proposition is throughput, cost, isolation, and auditability at parity
quality — the north star in §3.3.

**Distribution.** dsh's launch velocity is our channel. Publishing
`openswarm-bundle` as *the* team plugin for dsh, and upstreaming the three
ledgered issues (continuable `subagent-dsh-sdk`, method registry on the SDK
server, resume-on-miss), buys more adoption than any protocol work.

## 6. What this implies for the next phases

Ordered by leverage per unit of work; each maps to a §1 capability and a
§3.1 metric so progress is measurable.

| Priority | Move | Raises | Metric it moves |
|---|---|---|---|
| 1 | **Board replication.** A second backend behind `SwarmBoard`/`SwarmMailbox` (sqlite on shared storage or a git/object-store journal, the GNAP/Gas Town pattern) so a board is readable and CAS-writable from more than one lead process. The fold and CAS already exist; this is the transport. | M3 → 3, M1 → 2 | task-loss across host loss, replay fidelity |
| 2 | **Members do board ops.** Extend `SwarmServer` beyond `swarm/send` (claim, complete, list) and bind it to a non-loopback host behind the existing token scheme. Pairs with the ledgered "self-directed peers + `report`" row. | M3, M6 | time-to-join, scaling efficiency |
| 3 | **Attach, not just spawn.** `RemotePeer.attach(url)` so a member that already runs on another host joins a roster; the SDK wire already supports `session/prompt` on an existing session. | M1, M6 → 3 | time-to-join, MTTR |
| 4 | **Runtime-neutral roster.** Exercise `subagent-claude-code` and `subagent-codex` as members in a test and a live run; one A2A client member. | M7 → 3 | runtime coverage |
| 5 | **Cross-team merge.** Let two teams target one integration branch through one queue; add the cut-from-integration option (ledgered "sibling visibility"). | M4 → 3 | landing rate/latency |
| 6 | **Coordination overhead in every run's result.** Split usage into coordination vs task tokens in `TeamResult`; it is the single metric the whole field lacks and docs/61 says it is the dominant cost. | M8 | overhead ratio |
| 7 | **A2A Agent Card + trace ids.** Publish a signed card for a swarm (discovery, identity); thread a mesh-wide trace id through session events. Skip AGNTCY/NANDA/ANP. | M2, M9 → 3, M8 | trust rejections |
| 8 | **Join policy.** Per-swarm principal and a policy hook for join/claim/message, reusing the F3 approval seam for the gated cases. Prerequisite for any cross-org claim. | M5 → 3/4 | trust rejections |
| 9 | **A published team benchmark.** One reproducible multi-runtime team result on SWE-bench Pro or Multi-SWE-bench with cost per landed task. The field has none. | effectiveness | quality at cost |

Deliberately deferred: cross-org federation (Innovators stage, protocol in
motion), our own UI (dsh's surfaces render our command), and any further
topology mechanism (docs/02's conclusion stands until the escalation signal
problem is solved).
