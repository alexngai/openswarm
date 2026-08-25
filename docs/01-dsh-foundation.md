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
- **Phase 2 — git layer + subprocess members. DONE (first cut, 2026-08-23).**
  [`packages/git`](../packages/git/): per-task worktrees on
  `swarm/<teamId>/<taskKey>` branches, auto-commit of dirty trees
  (configurable off for agent-decided commits), and a sequential merge queue
  operating in a dedicated target worktree — default target is a fresh
  `swarm/<teamId>/integration` branch (task branches occupy the ref
  directory, so the integration ref lives beside them), configurable to any
  branch, and a target checked out elsewhere fails loud with git's own
  error. Conflicted merges are aborted and the branch + worktree retained,
  never auto-resolved. In `packages/swarm`, `RunTeamOptions.worktrees` makes
  member runs execute as full peer harnesses in subprocesses: one
  dynamically mounted `subagent-dsh-sdk` provider instance per run
  (`cwd` = the task worktree, disposed after — Cordis reversible mounting,
  quietly the first real F3 exercise). Topology runs thread a `taskKey`:
  same key shares a worktree (cascade tiers continue each other's work, a
  critic reads the worker's tree, pipeline stages chain), no key runs at the
  repo root (judge/plan/synthesis). Member composition defaults to the
  shipped `member.cordis.yml` and is overridable per team
  (`worktrees.member.configPath`/`env`/model route) for richer members.
  Validated by 5 git-layer unit tests on scratch repos plus 2 keyless E2E
  tests driving real subprocess harnesses whose scripted bash edits land in
  the right branches — merged content verified in the integration branch,
  conflict retention verified, and the user's checkout untouched. Not
  supported yet: worktrees × messaging peer-teams (in-process peers share
  the lead's execution world; converges with cross-process delivery per the
  ledger).
- **Phase 3 — LLM adapters. Azure DONE (first cut, 2026-08-23);
  Anthropic/Bedrock remain.** The rung-0 probe settled the design: Azure's
  `/openai/v1` surface accepts plain Bearer chat-completions (200 on first
  try), but the stock `llm-deepseek` adapter cannot serve it — its
  `resolveModel` intrinsically advertises a default reasoning effort, so
  every request carries a `thinking` field gpt-5.5 rejects
  (`Unknown parameter`), and caps serialize as the rejected `max_tokens`.
  [`packages/llm-openai`](../packages/llm-openai/) is therefore a rung-5
  subclass, not a rewrite: `OpenAiChatAdapter extends DeepSeekAdapter`
  drops the reasoning advertisement and strips effort/cap at the
  prepared-call boundary (the agent loop streams through
  `prepareCall().stream`, not `adapter.stream()` — learned the hard way),
  keeping the published SSE/StreamChunk machinery. Routes, models, and
  env-driven base URL/credentials are config; the worktree
  `member.cordis.yml` now mounts it (`OPENSWARM_LLM_BASE_URL` /
  `OPENSWARM_LLM_API_KEY` / `DSH_MODEL`). Validated keyless against the
  upstream mock with wire assertions (no `thinking` / `reasoning_effort` /
  `max_tokens` on any request; tool-call round trip) and **live against
  Azure gpt-5.5**: an in-process member turn and the full worktree E2E —
  subprocess member, real bash, auto-commit, merge — both green
  (`OPENSWARM_LIVE=1`, local-only). `openai-responses` is deliberately
  skipped unless a feature gap forces it. LiteLLM: expected to work on the
  same routes (plain chat-completions Bearer); unverified until an endpoint
  is at hand.
- **Phase 4 — cross-process, multi-turn peer messaging. DONE (first cut,
  2026-08-23).** Prioritized ahead of the eval repoint. `RemotePeer` owns a
  long-lived `dsh-jsonrpc-agent` subprocess through the published SDK client:
  briefing, every task, and every waking peer message land on ONE session,
  so members keep true multi-turn memory across the process boundary (turn
  serialization via a promise chain; the durable turn reason folds into
  `stopReason`, so an errored member turn is never reported as success —
  learned from a silent-failure debug). `SwarmServer` is the F2 seed: the
  lead's loopback TCP endpoint framed by the published `JsonRpcLineTransport`
  with one method, `swarm/send`, feeding the durable mailbox; sender identity
  comes from per-member spawn tokens, never caller fields.
  `openswarm-swarm-member` mounts `swarm_send_message` inside the member
  composition (silent no-op without `OPENSWARM_SWARM_URL`/`_TOKEN`, so one
  yml serves all modes). `peer-team { messaging: true } + worktrees` now runs
  members in per-MEMBER worktrees (member-lived branch, merged on finish) —
  the previously ledgered combination. Member session logs write outside the
  worktree (`DSH_SESSION_ROOT`), or auto-commit sweeps them into the branch —
  found and fixed for one-shot worktree runs too. 3 keyless E2E tests:
  multi-turn memory proven from captured request history; a scripted
  `swarm_send_message` tool call crossing member→socket→mailbox→target
  wakeup; and the full topology with member-keyed merge. Delivery contract
  for remote wakeups: durable prompt acceptance is the ack boundary.
- **Phase 5 — eval repoint + discrimination-set rerun. DONE (2026-08-24;
  results in [docs/02](02-discrimination-rerun.md) — the rewrite replicates
  legacy run-2's solve sets AND failure signatures exactly).** The eval seam turned
  out to be a CLI contract, not adapter surgery: the legacy CascadeAdapter's
  `bin` is `CS_BIN`-overridable, so [`packages/cli`](../packages/cli/)
  implements the exact legacy `openswarm topology cascade` invocation — the
  legacy team.json spec shape (members-as-tiers + coordination escalation
  fields), the `openSwarmParse` stdout JSONL (`text_delta` /
  `tool_use_start` / `message_stop{usage}` / `error`), the
  `{type:'team_usage', byModel, team}` results line (legacy UsageTotals
  field names, per-model `calls`), and the `after N escalation(s)` trace
  line. Members run in-process over the real spine with persistent bash +
  editor in the sandbox cwd; `azureoai/<m>` maps to the Azure route, bare
  models to the generic OPENSWARM_LLM_* route (LiteLLM/mock), and
  Bedrock/Anthropic ids fail loud until Phase 3b. The cascade topology
  gained the eval's command-confidence gate (`confidence: {commands, tau}`,
  weakest-link over exit codes, feedback threads upward — takes precedence
  over the LLM gate); usage folds from `assistant/message` session events
  per member session. Validated: 3 keyless contract tests (including a real
  gate-failure escalation where tier-1's bash creates the marker tier-0
  lacked) and a live Azure gpt-5.5 cascade with a real command gate.
  **E2B smoke: PASSED (2026-08-23)** — django__django-11179, mono
  `azureoai/gpt-5.5` through the UNCHANGED legacy CascadeAdapter, graded by
  the held-out swebench tests: **Success 1.00**, 65.7s agent latency, 20 LLM
  calls, 137k tokens (115k cache-read — prompt caching live), per-model
  usage attributed, 0% env errors. Deployment recipe
  (`scripts/bundle-cli.mjs` + `legacy/eval/experiments/dsh-smoke.ts`):
  esbuild single-file ESM bundle with node-pty AND koffi external
  (installed beside the bundle — ESM import resolution ignores NODE_PATH),
  sandbox node ≥ 22.15 (node:zlib zstd APIs), and dsh-llm's runtime
  version-require inlined at build time. Four import-time failures found
  and fixed by cheap zero-token smoke iterations. Remaining: the
  discrimination-set sweep itself (multi-instance, multi-arm; needs the
  Bedrock small tier from Phase 3b for the heterogeneous arms — the
  azure-only arms can run now).
- **Phase 6 — deletion.** Remove `legacy/` once nothing references it.

## Deferred work ledger

Deliberate deferrals, each with the phase that picks it up. Anything cut in a
later phase gets a row here, so nothing is dropped silently.

| Deferred item | Why deferred | Lands in |
|---|---|---|
| **Cross-process message delivery** — mailbox delivery to subprocess/remote members | `subagent-dsh-sdk` has no continuable capability, so the seam cannot follow up a subprocess child; delivery rides our app-server wire instead (a `swarm/deliver` method on the extended protocol — the F2 remote-member convergence) | Phase 2/3 (app-server) |
| **Full-duplex request/reply** — correlated ask-and-wait between peers | One-way messages + the board cover current coordination patterns; blocking replies add deadlock/timeout surface with no consumer yet. Message ids already give correlation | later, on demand |
| **Self-directed messaging peers + `report` completion** — members that loop on the board themselves | v1 is lead-driven (`askPeer` per claimed task, awaited turn ends); self-directed members need the child-scoped `report` tool and roster-drain semantics | with full-duplex |
| **Board/mailbox `waitForChange`** — peers poll the board at 10ms in-process (`ponytail:` marker in topologies.ts) | fine in-process; needed when the board is read across processes | Phase 2/3 |
| **Structured critic/gate verdicts via `outputSchema`** — verdicts are the plain-text `APPROVED`/`REVISE:` protocol | text protocol is provider-portable and mock-scriptable today | Phase 3+ |
| **`ctx.commands` entry point** — no human command drives `runTeam` yet | tests drive the service directly; the real entry is the app-server | Phase 2/3 |
| **Explicit peer drain/disposal** — messaging peers are cleaned up by lead disposal, not drained explicitly | acceptable while teams die with the lead; long-lived leads need drain | Phase 2 |
| **Upstream issue: continuable capability for `subagent-dsh-sdk`** | wire already supports it (`session/prompt` on an existing session); provider lacks `prepareContinuable` | file when we open upstream dialogue |
| **Upstream issue: method-registry seam on the SDK server** | method table is a closed switch; we wrap the exported class meanwhile (spike probe 3) | file when we open upstream dialogue |
| **Upstream gap: wire approval flows** — server→client requests are dead capability on both wire ends | headless-with-policy works; a prompting client needs it | before any interactive UI |
| ~~Worktrees × messaging peer-teams~~ **resolved in Phase 4** — remote members run in per-member worktrees | — | done |
| **Swarm socket hardening** — loopback + per-member UUID tokens only; no TLS, no member→lead methods beyond `swarm/send` (board ops, task claiming from inside the member are natural next methods) | minimal F2 seed first; grows with the app-server | app-server phase |
| **Remote peer lifecycle** — no idle timeout, no crash-restart of a member subprocess mid-team, `deliver` ack is prompt acceptance (not turn completion) | happy path first | Phase 4 follow-up |
| **Crash/abort hygiene for worktree runs** — an aborted or crashed team leaves task worktrees, provider mounts, and the target worktree behind; no orphan sweep on startup | happy path first; `git worktree prune` + team-dir sweep + signal-path finalize are mechanical | Phase 2 follow-up |
| **Sibling visibility** — task worktrees are cut from `baseRef`, so a task never sees another task's merged work; sequential topologies that want it must share a `taskKey` | independent-cut is the safe default; a cut-from-integration / re-base option changes merge semantics and deserves its own design | Phase 2 follow-up |
| **Agent-driven conflict resolution** — a retained conflict branch could feed a critic-loop/cascade run that resolves it | it is a topology pattern over existing pieces, not merge-queue machinery | Phase 3+ |
| **Subprocess concurrency cap** — a 50-task fanout spawns 50 member harnesses | worker-pool cap is a small scheduler in front of `runMember` | Phase 2 follow-up |
| **`.swarm/` ignore guidance** — default worktree dir sits inside the user's repo and shows as untracked | document + optional auto-append to `.git/info/exclude` | Phase 2 follow-up |
| **No output cap or reasoning-effort control on openai routes** — `openswarm-llm-openai` strips both rather than translating (`max_completion_tokens`, bare `reasoning_effort`) | requires our own request serializer or an upstream PR making thinking-field emission provider-configurable; upstream issue candidate | when caps/effort matter (effort sweeps are research-relevant) |
| **LiteLLM route unverified** — same wire dialect, expected to work on `openswarm-llm-openai` | no live LiteLLM endpoint at hand during Phase 3 | first LiteLLM deployment |
| ~~Anthropic/Bedrock adapters~~ **done (Phase 3b, 2026-08-24)** — `openswarm-llm-anthropic` wraps the official SDK (`@anthropic-ai/bedrock-sdk` bearer-token backend + direct-API backend); translation to StreamChunk is pure/unit-tested; live: haiku tool-work tier AND a heterogeneous haiku→gpt-5.5 cascade with cross-provider per-model usage. v1 ceilings: no extended thinking, no image input (ledgered) | — | done |
| **Anthropic adapter v1 ceilings** — extended thinking unsupported (reasoning ad absent, historical reasoning blocks dropped), image input rejected | eval arms need neither; thinking support interacts with tool-use signature rules and deserves its own pass | when research wants thinking sweeps |
| Eval harness repoint + discrimination-set rerun | needs subprocess members first | Phase 4 |
| `legacy/` deletion | kept for porting reference | Phase 5 |

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
