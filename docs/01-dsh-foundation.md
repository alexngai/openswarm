# 01 — OpenSwarm on DeepSeek Harness

Status: **accepted** · 2026-08-23 · branch `ds-harness`

## Decision

Rebuild OpenSwarm as a set of **out-of-tree plugins on
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** (`dsh`,
Cordis-based, MIT) instead of maintaining our own engine, provider, tool, and
session stack. dsh replaces ~110k LOC of harness plumbing; we keep and port the
swarm layer, which is our actual differentiator. The v0.x implementation lives
in [`legacy/`](../legacy/) for reference until the port no longer needs it.

We consume dsh from npm at a **pinned exact version**, not a fork. Fork
trigger: an upstream change breaks a seam we depend on twice in a row without
a migration path.

Rejected alternatives:

- **Full rewrite inside a dsh fork** — inherits their rc breaking-change
  treadmill and contribution ceremony; we'd rebuild worktrees against a team
  model that assumes one shared checkout.
- **Steal the ideas, keep our runtime** — zero dependency risk, but leaves us
  maintaining 165k LOC of harness that is not the product.

## What dsh provides (seams we consume)

Everything in dsh is a Cordis plugin: services on `ctx.<key>`, typed events,
reversible registrations, config-composed boot (profiles → bundles → patch
layers). The seams we build on:

| Seam | What we get |
|---|---|
| `ctx.subagents` | Member runtimes. `subagent-dsh-sdk` runs each member as a **complete peer harness in its own subprocess** with a per-member `cwd` — the worktree isolation hook. `subagent-claude-code` / `subagent-codex` cover delegated-product members. |
| Session log | Append-only durable `SessionEvent` log; "model-visible means logged" is runtime-asserted. State = projection over events; replay/fork/recovery are free. Our coordination board adopts this pattern. |
| `packages/sdk` | Newline-delimited JSON-RPC 2.0 app-server (initialize → `session/prompt` → streamed `session.event`), TS + Python clients, **caller-owned byte streams** (transport-agnostic). Our external interface extends this. |
| `vendor/hmr` + `watchUserPatches` | Live plugin-tree recomposition on patch-file edit; a bad patch leaves the last-good tree running. Hot-load with rollback is the boot path, not a feature we add. |
| `ctx.tools`, `ctx.llm`, `ctx.commands`, `ctx.jobs`, `ctx.fs`, `ctx.sandbox` | Tool registry + guarded pipeline, model adapter seam, human commands, background work, fs/sandbox policy. |

What we deliberately do **not** build on: the experimental `ctx.agentTeams`.
It is in-process only, capped at 8 members, and explicitly disclaims
worktrees, remote members, merges, and locks — the exact things we exist for.
We watch it; if it grows worktree support upstream we reassess convergence.

## Focus features

### F1 — Peer and hierarchical multi-agent

Hierarchy is native to dsh (`ctx.subagents`, depth budgets, continuable
children). We add the peer layer as our own `ctx.swarm` service:

- **Roster + topology** — TeamSpec, roles, and the topology set (fanout,
  critic-loop, cascade, committee, pipeline, peer-team, coordinator) ported
  from `legacy/src/swarm/`. Members are handles over `ctx.subagents`
  providers, so one roster mixes in-process, subprocess, claude-code, codex,
  and (later) remote members without topology code caring.
- **Coordination board** ("semi-shared memory") — a `SwarmBoard` seam. First
  implementation: durable events in the lead's session log, folded into
  roster / task DAG / mailbox projections (dsh's `foldTeam()` pattern, our
  shapes). Task claims use compare-and-set revisions. Not opentasks/minimem
  shaped; those adapters retire. A sqlite or CRDT backend can slot in behind
  the same interface if cross-process contention demands it.
- **Escalation/cascade layer** — escalation gate, cascade scheduler, usage
  aggregator port on top unchanged in spirit; this is the heterogeneous-swarm
  research asset.

Multi-process from day one via `subagent-dsh-sdk`; networking arrives via F2.

### F2 — App-server interface (codex app-server shaped)

No UI of our own. One JSON-RPC interface that any UI/TUI connects to later:

- `openswarm-app-server` mounts dsh's SDK server plus a swarm method
  extension (`swarm/spawnTeam`, `swarm/listMembers`, task and mailbox ops,
  swarm event notifications) via declaration merging on
  `HarnessSdkRequestMap`.
- A socket/WS transport plugin when networked clients matter; the protocol
  already frames over caller-owned streams.
- **Convergence with F1:** a remote swarm member is a subagent provider that
  connects to another machine's app-server instead of spawning a subprocess —
  same protocol, two roles.

Known upstream gap: server→client requests are carried by the transport but
unimplemented on both ends, so interactive approval flows over the wire don't
exist yet. Headless-with-policy works today; a prompting TUI needs us to
implement that (additive, reserved in the protocol).

### F3 — Dynamic extensibility: agents authoring plugins

Cordis makes hot-loading safe-by-construction (reversible effects,
transactional recomposition, last-good-tree rollback). We add:

- A `swarm_plugin` model-facing tool: agent writes a plugin module →
  validation load → patch-row append → HMR mounts it.
- **Blast-radius policy:** agents freely author and hot-load plugins into
  **their own child harness** (worker subprocess, worktree cwd); mounting
  into the **lead harness requires human approval**. Self-modification with a
  containment hierarchy.

## Target package layout

Out-of-tree npm packages in this repo, consumed by a dsh profile:

| Package | Contents |
|---|---|
| `openswarm-swarm` | `ctx.swarm`: roster, TeamSpec, roles, topologies, SwarmBoard, escalation/cascade |
| `openswarm-git` | worktree lifecycle, git-cascade branch policy, merge queue, conflict coordination |
| `openswarm-tools` | `swarm_*` model-facing tools on `ctx.tools` |
| `openswarm-app-server` | SDK server + swarm method extension + socket transport |
| `openswarm-llm-*` | model adapters: Azure OpenAI first (Responses-API shaped), then a LiteLLM-shaped adapter for coverage, then Anthropic/Bedrock |
| `openswarm-bundle` | `"dsh": { "bundle": ... }` stacking the above on `dsh-base` |
| `openswarm` bin | thin launcher: install profile, run headless / app-server |

## Known gaps and risks

- **LLM adapters are the largest new-code item.** dsh ships only
  `llm-deepseek` and `llm-pi-ai`. Priority: Azure gpt-5.5 (research arm,
  uncapped) before Bedrock haiku (daily-quota constrained).
- **rc treadmill.** dsh is `0.1.x-rc` and promises breaking changes. Pin
  exact versions; keep a dsh checkout under `references/` for source reading;
  bump deliberately behind a compat smoke suite.
- **TUI retired** with the v0.x tree; the app-server is the replacement seam.
- **Eval harness** (`legacy/eval/`) is kept and repointed at the dsh SDK in
  Phase 4; the discrimination-set rerun is the acceptance test that the
  rewrite didn't regress the research harness.
- **Parity manifest** (legacy docs/67) measured parity against the product we
  are no longer building; retired with the legacy tree.

## Phases

- **Phase 0 — spike (kill criteria below).**
- **Phase 1 — swarm kernel. DONE (first cut, 2026-08-23).**
  [`packages/swarm`](../packages/swarm/) provides `ctx.swarm` with fanout and
  critic-loop over `ctx.subagents`; per-member `agentOptions` give
  heterogeneous model routing; member personas embed in the prompt text (the
  seam's `persona` capability is not portable to the dsh-sdk provider).
  Validated in-process by vitest over the real spine + agent loop + stock
  adapter + scripted mock LLM (5 tests: fanout collection/personas,
  unknown-member rejection, per-member model override, critic approve-round-1,
  feedback threading to maxRounds).

  **Second cut (same day): SwarmBoard + all seven topologies.** The board is
  log-backed as designed: every mutation appends a whole-snapshot
  `swarm/task` event (`SessionEventMap` extension) to the lead session and
  flushes; reads fold the log; mutations serialize through a per-board
  transaction tail with compare-and-set revisions (`SWARM_TASK_STALE_REVISION`
  et al.); a fresh board over the same session replays to identical state and
  continues the id sequence. Topologies added: committee (parallel answers +
  optional judge synthesis), pipeline (stage-output threading), cascade
  (tiered escalation with optional gate, feedback threads upward),
  coordinator (numbered-plan decomposition, round-robin workers, synthesis),
  and peer-team (work-stealing loops over the board; claim order provably
  respects `blockedBy` in the durable log). 21 tests: pure topology units
  over a scripted runner plus board and end-to-end runs through the real
  spine.

  **Third cut: durable mailbox + peer messaging (in-process).** Two more
  lead-log events (`swarm/message/queued` / `swarm/message/delivered`,
  queued-minus-delivered is the recovery mailbox); `wakeup` delivery rides
  `ctx.subagents.followup` as the target's next FIFO turn, `quiet` mail stays
  durably queued and rides in front of the next waking delivery. Members in
  `peer-team { messaging: true }` are continuable children; the
  `swarm_send_message` tool installs through the activation setup registry
  (`registerContinuableSetup`) with sender identity resolved from the
  executing agent against the roster. Three residency lessons learned the
  hard way, now encoded: continuable activations are TRANSIENT (the manager
  disposes them after each settled turn and cold-resumes on the next waking
  delivery), so peers are addressed by durable child id, never a captured
  Agent; child-scoped tools must install per-activation, not per-spawn; and
  immediate `inject` into a resident activation is an acked-but-lost delivery
  when the activation is disposed — quiet mail therefore never injects. Also:
  `suppressSettlementTurns` rejects the lead's reactive model turns for
  child-settlement notices via `agent/pre-step` (a service-driven lead never
  pays a model call per child turn). 25 tests total, incl. a model-driven
  send through the real tool pipeline. Deferred: cross-process delivery
  (rides the F2 app-server wire; `subagent-dsh-sdk` has no continuable
  capability — upstream issue candidate), request/reply correlation, board
  `waitForChange`, and the `ctx.commands` entry point.
- **Phase 2 — git layer.** Worktree lifecycle + cascade + merge queue; member
  spawn → worktree create → merge on complete.
- **Phase 3 — LLM adapters.** Azure → LiteLLM shape → Anthropic/Bedrock.
- **Phase 4 — eval repoint + discrimination-set rerun.**
- **Phase 5 — deletion.** Remove `legacy/` once nothing references it.

## Phase-0 spike — RESULTS (2026-08-23)

**All four probes passed against the published npm distribution
(`0.1.1-rc.2` era); no dsh patches were needed.** Details and re-run
instructions: [`spike/README.md`](../spike/README.md).

1. **Bundle mechanics — PASS.** `dsh plugin add file:…` joins the layer
   stack; `--dump-config` shows our rows with provenance headers.
2. **Worktree isolation (F1, kill criterion) — PASS.** Two SDK-driven child
   harnesses with `cwd` = two git worktrees; each child's real
   persistent-bash execution was rooted in its own worktree.
3. **SDK drive (F2) — PASS, one red flag.** Handshake and typed
   unknown-method rejection work. The server's method table is a closed
   switch (no registration seam) — but `HarnessSdkJsonRpcServer` is exported
   and transports are caller-owned streams, so our app-server wraps it:
   `swarm/*` handled locally, the rest delegated. Upstream issue candidate:
   a method-registry seam.
4. **Hot-load (F3) — PASS.** Live patch edit replugged our plugin without a
   restart; a broken patch left the last-good tree running.

Spike-confirmed policy: **pin exact aligned versions** — the npm dist-tags
are stale and resolve pre-rename `0.0.1-rc.1` builds with unpublished
imports; at aligned versions plain npm resolves cleanly.
