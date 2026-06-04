# Stage B implementation plan — drive a team from an ACP session

Execution companion to [docs/31-teams-acp-design.md](31-teams-acp-design.md) (Stage B design,
locked decisions) and [docs/32-acp-implementation-plan.md](32-acp-implementation-plan.md) (Stage A,
shipped). Stage A serves one agent over ACP; Stage B makes the ACP session a **team**.

**Authoring date:** 2026-06-02.
**Status:** B0 implemented (B0.0–B0.6 shipped + live-verified). See §6 for the per-step status.
**Scope:** the B0 cut of Stage B per the product decisions below, sequenced to keep the
deterministic e2e suite green throughout. `_meta.swarm` rich-mode enrichment + team `session/load`
(B1, [docs/34](34-acp-b1-meta-swarm-plan.md)) and the swarm-aware client (B2,
[docs/35](35-acp-b2-rich-client-plan.md)) followed — both shipped.

---

## 0. Product decisions (chosen 2026-06-02)

| Decision | Choice | Consequence |
|---|---|---|
| Session ↔ team binding | **Team by default** | `acp` serves a coordinator team; single-agent (Stage A) is kept as a `--single` escape hatch + the fast path for deterministic tests. |
| First topology | **Coordinator** | The session is a long-lived **root member** that spawns peers via `agent({team:"self",…})`. You converse with the lead. |
| Run model | **Persistent team + steering** | `session/new` stands up a persistent coordinator; the first prompt runs the team, later prompts steer the long-lived root (`run_more`). |
| Member permissions | **Route per-member now** | Each member's permission escalation is routed to the ACP client. This is **net-new IPC** (§4) — the long pole. |

These four together are an ambitious first increment. §6 sequences them so each lands behind a green
checkpoint rather than integrating all at once.

---

## 1. Verified integration seam (ground truth)

| Concern | Reality (file:line) |
|---|---|
| Run a team in-process | `new Orchestrator(opts).runTeam(spec): Promise<TeamResult>` — [orchestrator.ts:136,187](../src/swarm/orchestrator.ts). No CLI/subprocess needed. |
| Event stream | `StandaloneHost.events` EventEmitter emits `"lane_event"` — [standalone-host.ts:128,426](../src/swarm/standalone-host.ts). `LaneEvent { agentId, ts, type, payload }` ([events.ts:19](../src/swarm/events.ts)), same event *types* as `NormalizedEvent` + task/worker lifecycle, tagged by member `agentId`. |
| Coordinator lead | Spawns **one long-lived root**; root's prompt is augmented to spawn peers via the `agent` tool — [topologies/coordinator.ts](../src/swarm/topologies/coordinator.ts). Root runs as a worker; its events carry the root's agentId. |
| Persistent + steering | `Orchestrator({persistent:true})` → `getActiveTeam(): TeamSession` — [orchestrator.ts:96,179](../src/swarm/orchestrator.ts). `TeamSession.spawnMember/send` ([team-session.ts:82,171](../src/swarm/team-session.ts)). Long-lived worker accepts more prompts via the `run_more` IPC method ([ipc/protocol.ts:23](../src/swarm/ipc/protocol.ts)). |
| Member roster | `TeamSession.members: Map<AgentId,{memberId,role,state}>` — for agentId→role attribution. The lead is the root member's agentId. |
| Quiescence | `runTeam` resolves when the topology's `CompletionRule` is met; per-prompt completion is the root's `task_result` (`rootHandle.wait()`) plus a `drainPeers` await over non-lead members, so detached `agent({wait:false})` peers drain within the prompt (§3, §8). |
| Permission today | Worker `canUseTool` is **mode-based only**, synchronous, no prompt, no IPC — [worker-entry.ts:110](../src/cli/worker-entry.ts). `permission_prompt/granted/denied` lane types are declared but unused. |
| Permission precedent | `ask_user_question` is a fully-wired worker→orchestrator **synchronous request/response** with a correlation id — [worker-host.ts:459](../src/swarm/worker-host.ts), [standalone-host.ts:1327](../src/swarm/standalone-host.ts). The exact template for §4. Caveat: its headless handler currently errors ([standalone-host.ts:936](../src/swarm/standalone-host.ts)) — Stage B adds an injectable handler. |

**Architectural consequence:** team-mode `prompt` does **not** use Stage A's `engine.run` /
`NormalizedEvent` translator / `AcpPermissionBridge`. It consumes the **`LaneEvent` bus** and routes
permissions over **IPC**. Stage A's path is retained behind `--single`.

---

## 2. Module layout

```
src/acp/
  team-agent.ts      AcpTeamAgent — session lifecycle bound to an Orchestrator
  lane-translator.ts LaneEvent -> session/update (collapsed; member attribution via roster)
  team-config.ts     resolve the bound team (default coordinator template / --team / --topology)
  index.ts           runAcp branches: team (default) vs single (--single -> Stage A AcpAgent)
src/swarm/
  ipc/protocol.ts    + "permission.request" method + param/result schemas (§4)
  worker-host.ts     + proxyPermissionRequest() (mirrors ask_user_question proxy)
  worker-entry.ts    canUseTool: on mode-deny, escalate via IPC instead of hard-deny
  standalone-host.ts + handle "permission.request" -> injected interaction handler
  host.ts / orchestrator.ts  + an injectable `interactionHandler` option
```

Reuse from Stage A unchanged: `tool-kind.ts` (kind/title/locations/diff), `content.ts`, `history.ts`,
`capabilities.ts` (extended), the e2e harness.

---

## 3. Session lifecycle (team mode)

- **`initialize`** — advertise `agentCapabilities`; Stage B keeps `loadSession` and adds (B1) a
  `_meta.swarm` agent capability. For B0, unchanged surface.
- **`session/new`** — resolve the bound team (§team-config). Construct `Orchestrator({persistent:true,
  permissionMode, interactionHandler})`. **Do not** spawn yet (lazy until first prompt) — store the
  orchestrator + a per-session `AbortController` on the session record.
- **`session/prompt`** —
  - *first prompt*: build the coordinator `TeamSpec` with the root member's `prompt` = the user text;
    subscribe to the lane bus; `runTeam(spec)`; translate lane events (collapsed); resolve when the
    root's turn completes. The prompt resolves on the root's `task_result` (`rootHandle.wait()`) **and**
    after draining any still-running non-lead peers (`drainPeers`). The `agent` tool blocks by default
    (`wait:true`), so the root already awaited its peers; the drain covers the residual detached
    `agent({wait:false})` case so the prompt's induced subtree is quiescent before it resolves (Q1).
  - *subsequent prompts*: the root is long-lived (idle awaiting input) → deliver via `run_more`
    (or `team.send` to the root) → translate until that turn drains. This is steering.
- **`session/cancel`** — trip the session `AbortController`; the orchestrator aborts the run; resolve
  the in-flight prompt as `cancelled`.
- **`session/load`** — defer to B1 (team transcript replay is doc 31 Q4); B0 advertises it off in
  team mode.

**Per-prompt quiescence (doc 31 Q1):** the boundary resolves when the root's per-prompt task is
terminal **and** no peer it spawned is still running. As built, that's the root's `task_result` plus a
`drainPeers` await over non-lead members — the practical equivalent for the coordinator, where the
root is the only spawner and peers are depth-1.

---

## 4. The long pole — per-member permission routing (new IPC)

Model it exactly on `ask_user_question`:

1. **IPC method** ([ipc/protocol.ts](../src/swarm/ipc/protocol.ts)): add `"permission.request"`
   (worker → orchestrator) with `PermissionRequestParamsSchema { toolName, input, requiredPermission,
   currentMode }` and a result `{ outcome: "allow" | "deny", reason? }`. Correlation-id round-trip
   (the transport already supports request/response, per host.ts:441).
2. **Worker side** ([worker-entry.ts:110](../src/cli/worker-entry.ts)): change `canUseTool` — when
   `permissionEngine.check()` denies (or a tool is escalation-class), proxy a `permission.request`
   through the host ([worker-host.ts](../src/swarm/worker-host.ts), mirroring the `ask_user_question`
   proxy at :459) and **await** the decision instead of hard-denying.
3. **Orchestrator side** ([standalone-host.ts:1327](../src/swarm/standalone-host.ts)): handle
   `permission.request` by delegating to an **injectable `interactionHandler.requestPermission(req)`**
   (new option on `OrchestratorOptions`/`StandaloneHost`). Emit a `permission_prompt` lane event
   (finally using the declared type) for observability.
4. **ACP bridge** (`team-agent.ts`): supply `interactionHandler.requestPermission` =
   build a `ToolCallUpdate` (reuse `tool-kind.ts` for title/kind, tag `[role]` via the roster) →
   `conn.requestPermission({sessionId, toolCall, options})` → map the outcome back to
   `allow|deny`. Mode-based trust still applies first (so this fires only for escalations, per
   doc 31 §6); concurrent requests are serialized through the handler.

**Why this is the long pole:** it touches the IPC schema, the worker loop, the host dispatch, and a
new injection point — and it must be cancellation-safe (a cancel mid-permission resolves the request
as denied/cancelled). It is verifiable in isolation (§6 B0.3) before the ACP bridge is attached.

---

## 5. Lane translator (collapsed — B0)

`makeLaneTranslator(conn, sessionId, roster)` consumes `LaneEvent`s and emits `session/update`:

| LaneEvent (by `agentId`) | Collapsed B0 mapping |
|---|---|
| lead `text_delta` | `agent_message_chunk` (the single narrating voice) |
| member `text_delta` | **suppressed** (doc 31 Q3 default `collapse`) |
| any `tool_use_start/input/end` | `tool_call` / `tool_call_update`, **title prefixed `[role]`** via roster lookup; reuse `tool-kind.ts` (kind/locations/diff) |
| any `tool_result` | `tool_call_update` (completed/failed) |
| `task_created/updated/completed` | maintain a plan; emit `plan` (the team/task board) |
| `worker_*` lifecycle | drop in B0 (or `_meta` in B1) |
| permission (via §4, not the bus) | `request_permission` round-trip |

Single emission chokepoint `send()` — B1 attaches `_meta.swarm.member` here. Roster lookup
(`agentId → role`, and `agentId === root` ⇒ lead) comes from `TeamSession.members`.

---

## 6. Build sequence (each behind a green checkpoint)

- **B0.0 — Single-agent escape hatch.** Add `--single` so Stage A's path stays reachable; make the
  deterministic + subprocess e2e run under `--single` so they stay green while team mode is built.
  *Checkpoint: existing e2e pass via `--single`.*
- **B0.1 — Team plumbing, no permissions.** `team-config.ts` (default coordinator template),
  `AcpTeamAgent` session lifecycle, construct the persistent orchestrator on `session/new`. First
  `prompt` → `runTeam` a single-root coordinator under **mode-based** permissions (no routing yet).
  *Checkpoint: a scripted/echo team run resolves a prompt over ACP.*
- **B0.2 — Lane translator (collapsed).** `lane-translator.ts` + roster attribution + plan board.
  *Checkpoint: e2e (in-process) — a coordinator run streams `agent_message_chunk` + `[role]` tool
  calls + a `plan`; resolves `end_turn`.*
- **B0.3 — Permission IPC (isolated).** Add the `permission.request` method + worker change + host
  handler + injectable `interactionHandler`; unit/integration test it with a **fake** handler
  (no ACP). *Checkpoint: a worker mode-deny round-trips to a handler and the decision is honored.*
- **B0.4 — Wire permissions to ACP.** `interactionHandler.requestPermission` → `conn.requestPermission`.
  *Checkpoint: e2e — a member escalation surfaces a titled `request_permission`; allow/deny honored.*
- **B0.5 — Persistence + steering.** ✅ (`5c13b67` + `e7c3a86`) Coordinator honors `persistent` +
  `onTeamCreated`; first prompt `runTeam`, subsequent prompts steer the root via
  `AgentHandle.runMore`; `session/cancel` tears down the team (B0-hardening R2 — was "kills the root").
  Long-lived workers now resume their session across `run_more`, so **conversation context carries
  across steering turns** (the live "remember 42" smoke passes). *Originally a B1 follow-up; pulled
  forward here.*
- **B0.6 — Default flip + docs + live.** ✅ `acp` defaults to team (`--single` for Stage A); README
  "team over ACP"; committed live e2e (`SWARM_ACP_LIVE`) for the coordinator turn, the permission
  round-trip, and two-prompt steering with context retention. *Note: workers spawn from `dist/cli.js`,
  so a live team run needs `npm run build` first (the test globalSetup rebuilds).*

- **B0 hardening — post-review fixes.** ✅ Functional fixes from the Stage B review: plan board no
  longer stuck `in_progress` (B1), `session/cancel` propagates via a threaded `AbortSignal` (B2),
  resume-failure no longer bricks a long-lived root (B3), failed turns map to `refusal` not `end_turn`
  (B4), cancel disposes the whole team (R2), a 2nd `session/new` is rejected (R1). Plus a deterministic
  integration test of the real coordinator+worker+IPC permission round-trip (no model). See §8.

**Acceptance (B0):** all met.
- [x] A coordinator team is drivable over ACP end to end (in-process + subprocess e2e).
- [x] Member work surfaces as `[role]`-attributed tool calls + a live plan; the lead narrates.
- [x] A member escalation routes to the client and the decision is honored both ways.
- [x] Two prompts to one session; the second steers the long-lived root (with context); cancel works.
- [x] Nothing but JSON-RPC on stdout; tsc clean; full suite green; `--single` preserves Stage A.

---

## 7. Risks & open verification items

> Most of these were resolved in the §9 robustness pass — see §9 for status. Retained here for the
> original framing.

- **Permission IPC (long pole).** ✅ Resolved (§9): concurrent `permission.request` frames correlate by
  unique id (regression-tested); router serializes prompts so they don't stack.
- **Per-prompt quiescence boundary.** ✅ Resolved (§9): `drainPeers` awaits non-lead members after the
  root's turn — the `agent` tool blocks by default, so this only covers the detached `wait:false` case.
- **Subprocess cost.** ✅ Measured (§9): team adds ~190 ms p50 to first token vs in-process `--single`;
  acceptable for interactive use, `--single` is the escape hatch.
- **Headless `ask_user_question`.** ✅ Resolved (§9): multiple-choice routes to the client; open-ended
  parks and resumes on the next prompt (Q1).
- **Stage A divergence.** ✅ Resolved (§9 parity guard): two prompt paths (single vs team) exist; keep `send()`/permission
  shapes identical so B1 `_meta.swarm` and the client are uniform.

---

## 8. B0 hardening notes (as-built behaviors & accepted limits)

Outcomes of the post-B0 review/hardening pass. These are **intentional B0 scope cuts**, recorded so
they aren't mistaken for bugs.

- **Single session per connection (R1, guarded).** `AcpTeamAgent` binds the whole connection to one
  shared coordinator team (one active team, one permission router, one lead). A second `session/new`
  is **rejected** ([team-agent.ts](../src/acp/team-agent.ts)) rather than silently colliding. A
  separate team needs a separate `acp` connection. Multi-session-per-connection is post-B0.
- **Session resume covers every long-lived worker (R4, intended).** Long-lived workers resume their
  prior SDK session across `run_more` (`engine.getSessionId()` → `resumeFrom`,
  [worker-entry.ts](../src/cli/worker-entry.ts)). In the coordinator this means the root retains
  context turn-to-turn — the desired steering behavior — and any *other* long-lived worker gets the
  same treatment. Non-long-lived peers are unaffected (fresh per task). A resume that fails before a
  new session is established clears the stored id so the next turn starts fresh instead of re-resuming
  a dead session ([claude-agent-sdk.ts](../src/engine/claude-agent-sdk.ts), B3).
- **Per-prompt subtree quiescence.** See §3 — the prompt resolves on the root's `task_result` plus a
  `drainPeers` await over non-lead members, so detached `agent({wait:false})` peers drain within the
  prompt. (The `agent` tool blocks by default, so the root already awaits its peers; the drain covers
  the detached case.)
- **Cancel tears down the whole team (R2).** `session/cancel` disposes the active team (root + peers)
  rather than killing only the lead, so a cancelled turn can't leak peers into the next prompt's fresh
  run. The first-prompt branch also disposes any stale team before spawning.
- **Failed turns surface as `refusal`.** ACP has no generic error stop reason, so a non-success turn
  (first-turn `failed`/`timeout`, or a steered `run_more` failure/timeout/rejection) maps to
  `refusal`; `killed` → `cancelled` (B4). A rejected `run_more` also drops the root so the next prompt
  respawns a fresh team.

A second hardening round closed the robustness/doc gaps the review flagged:

- **Permission escalation is host-derived, not a process.env mutation (R-a).** Enabling worker
  escalation no longer mutates the orchestrator's `process.env`. `StandaloneHost.spawn` sets
  `SpawnWorkerArgs.permissionEscalation` (→ `SWARM_HARNESS_PERMISSION_ESCALATION=1` in *the child's*
  env) iff the host holds an `interactionHandler`. Only the ACP team path sets one, so non-ACP
  orchestrators are unaffected. [standalone-host.ts](../src/swarm/standalone-host.ts),
  [subprocess-spawner.ts](../src/swarm/subprocess-spawner.ts).
- **Permission router bound for the connection's lifetime (R-b).** The router's active session is set
  once at `session/new`, not per-prompt. A peer can still be running between prompts (long-lived team,
  or work observed after the turn resolves); clearing the session each turn would auto-deny that
  peer's escalations with "no active ACP session". Binding for the connection (safe given R1's
  single-session guarantee) lets those escalations reach the client.
- **Client `cwd` honored (R-c).** The ACP `session/new` `cwd` (the editor's project root) is threaded
  to the coordinator root via `MemberSpec.cwd` → `SpawnRequest.cwd` → the spawner, so file tools
  operate where the client expects instead of in the orchestrator's `process.cwd()`. Peers the root
  spawns via the `agent` tool still default to the orchestrator cwd unless they pass their own.

---

## 9. Follow-on backlog (tracked)

B0 is complete and shipped; nothing below is a known bug. These were the non-blocking
robustness/UX/verification items carried out of §7 and the review, plus the planned rich-mode
sub-stages. **All of it is now done** — the robustness/verification pass, the rich-mode sub-stages
(B1 + B2), and the post-review caveats (test-timeout scaling, `_meta.swarm` published as an open
convention, tool-arg replay, open-ended `ask_user_question` park-and-resume, per-member
`allow_always`). B3 (standardization) is intentionally skipped (Q5).

**Robustness / verification (done):**
- [x] **Per-prompt subtree quiescence.** `prompt()` awaits the root's `task_result` **and** drains
      non-lead members (`drainPeers`), so a detached `agent({wait:false})` peer completes within the
      prompt instead of streaming into the next one (§3/§8). The `agent` tool blocks by default, so the
      root already awaits its peers — the drain covers the residual detached case.
      [team-agent.ts](../src/acp/team-agent.ts).
- [x] **Permission IPC under concurrent escalations.** The transport correlates concurrent
      `permission.request` frames by unique id (a pending map — generic, not special-cased); guarded by
      an explicit out-of-order regression test. Prompts are **serialized** at the router (one
      outstanding to the client) so N members don't stack modals; a same-tool burst coalesces once one
      is answered `allow_always`. [team-permission.ts](../src/acp/team-permission.ts),
      [parent-transport.test.ts](../src/swarm/ipc/parent-transport.test.ts).
- [x] **`allow_always` semantics.** Persisted for the connection (was a one-shot allow): a later
      matching request is auto-allowed with no second prompt. The prompt offers **both scopes** —
      team-wide ("all members") and, when the request is attributed, **per-member** (Q2) — and the
      chosen scope is what persists. [team-permission.ts](../src/acp/team-permission.ts).
- [x] **Stage A / team parity guard.** A test asserts the single-agent and team translators emit
      identical standard-field `session/update`s for the same engine events (modulo the team's
      `[role]`/`agentId:`/`_meta` enrichment + plan board). [parity.test.ts](../src/acp/parity.test.ts).
- [x] **Headless `ask_user_question` over ACP.** Both kinds route to the client now. Multiple-choice
      maps to a `requestPermission` prompt whose options are the answer choices (serialized with
      permission prompts). **Open-ended parks (Q1 blocked-on-human):** the question is narrated, the
      turn ends `end_turn`, and the next prompt's text answers it and resumes the same run — multi-round
      Q&A works; the worker IPC timeout is the backstop. [team-permission.ts](../src/acp/team-permission.ts),
      [team-agent.ts](../src/acp/team-agent.ts).
      [team-permission.ts](../src/acp/team-permission.ts), [standalone-host.ts](../src/swarm/standalone-host.ts).
- [x] **Subprocess first-token latency.** Measured (deterministic bench,
      [acp-latency.bench.test.ts](../test/integration/acp-latency.bench.test.ts), `SWARM_ACP_BENCH=1`):
      team-by-default adds **~190 ms p50 / ~200 ms mean** to first token (spawn `dist/cli.js` root +
      `worker_ready` handshake + engine init) on a loaded shared box; `--single` runs in-process
      (sub-ms). Conclusion: ~200 ms before first token is acceptable for interactive editor use and not
      worth a warm-root/in-process fast path now; `--single` stays the escape hatch for latency-
      sensitive runs.

- [x] **Team `session/load` prose replay.** Done — the lead's prior narration is recovered from its
      session JSONL and woven into the spine (`mergeLeadProse`), so replay shows the lead's prose +
      `[role]` tool calls + plan board in wall-clock order. Residual: replayed tool calls omit
      arguments (live-only `tool_use_input`, not persisted) — low value, not planned ([docs/34
      §8](34-acp-b1-meta-swarm-plan.md)).

**Rich-mode sub-stages (planned — see docs/34 for the B1 scope):**
- [x] **B1 — `_meta.swarm` enrichment + capability negotiation + team `session/load`.** Shipped
      (B1.0–B1.4) — see [docs/34-acp-b1-meta-swarm-plan.md](34-acp-b1-meta-swarm-plan.md). Enrichment
      on updates/plan/permissions, capability negotiation + `acp.memberText`, persisted spine, and
      `session/load` transcript replay. One fidelity follow-on (live context-resume) tracked above.
- [x] **B2 — `swarm/steer` ext + swarm-aware rich client.** Shipped — see
      [docs/35-acp-b2-rich-client-plan.md](35-acp-b2-rich-client-plan.md). `swarm/steer` ext injects a
      mid-turn message to the team's inbox; `RichRenderer` + formatter fold `_meta.swarm` into
      per-member lanes + a board; `scripts/acp-rich-client.ts` is the reference client (verified by a
      live smoke).
- [x] **B3 — publish the convention (not upstream).** Standardization skipped (Q5), but the
      `_meta.swarm` + `swarm/steer` convention is **published** as a self-contained versioned spec
      ([docs/36](36-meta-swarm-convention.md)) so a third-party ACP client can adopt it without us —
      no committee, no protocol change.

---

## Key references
- [docs/31-teams-acp-design.md](31-teams-acp-design.md) — Stage B design + locked decisions (collapse, `_meta.swarm`, Q1–Q5)
- [docs/32-acp-implementation-plan.md](32-acp-implementation-plan.md) — Stage A (reused helpers + e2e harness)
- Seam: `src/swarm/orchestrator.ts`, `standalone-host.ts` (lane bus + ask_user_question), `topologies/coordinator.ts`, `team-session.ts`, `cli/worker-entry.ts` (permission), `ipc/protocol.ts`
