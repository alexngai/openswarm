# Stage B implementation plan — drive a team from an ACP session

Execution companion to [docs/31-teams-acp-design.md](31-teams-acp-design.md) (Stage B design,
locked decisions) and [docs/32-acp-implementation-plan.md](32-acp-implementation-plan.md) (Stage A,
shipped). Stage A serves one agent over ACP; Stage B makes the ACP session a **team**.

**Authoring date:** 2026-06-02.
**Status:** implementation plan (pre-build).
**Scope:** the B0 cut of Stage B per the product decisions below, sequenced to keep the
deterministic e2e suite green throughout. `_meta.swarm` rich-mode enrichment (B1) and the
swarm-aware client (B2) follow.

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
| Quiescence | `runTeam` resolves when the topology's `CompletionRule` is met; per-prompt completion is the root's `task_result` + drained peers. |
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
    root's turn completes + peers drain.
  - *subsequent prompts*: the root is long-lived (idle awaiting input) → deliver via `run_more`
    (or `team.send` to the root) → translate until that turn drains. This is steering.
- **`session/cancel`** — trip the session `AbortController`; the orchestrator aborts the run; resolve
  the in-flight prompt as `cancelled`.
- **`session/load`** — defer to B1 (team transcript replay is doc 31 Q4); B0 advertises it off in
  team mode.

**Per-prompt quiescence (doc 31 Q1):** tag the root's per-prompt task with the ACP turn id; the turn
resolves when that task is terminal and no peer it spawned is still running. Detected from
`task_*`/`worker_idle` lane events. This boundary detection is a B0 risk (§7).

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
- **B0.5 — Persistence + steering.** Long-lived root; subsequent prompts via `run_more`; per-prompt
  quiescence boundary; `session/cancel`. *Checkpoint: e2e — two sequential prompts to one session;
  the second steers the same root; cancel returns `cancelled`.*
- **B0.6 — Default flip + docs + live.** Make team the default (single behind `--single`); README
  "team over ACP"; live e2e (`SWARM_ACP_LIVE`) drives a real coordinator turn. *Checkpoint: doc 31
  §10 B0 acceptance; live subprocess coordinator turn passes.*

**Acceptance (B0):**
- [ ] A coordinator team is drivable over ACP end to end (in-process + subprocess e2e).
- [ ] Member work surfaces as `[role]`-attributed tool calls + a live plan; the lead narrates.
- [ ] A member escalation routes to the client and the decision is honored both ways.
- [ ] Two prompts to one session; the second steers the long-lived root; cancel works.
- [ ] Nothing but JSON-RPC on stdout; tsc clean; full suite green; `--single` preserves Stage A.

---

## 7. Risks & open verification items

- **Permission IPC (long pole).** New method across worker/host/transport; must be cancellation-safe
  and serialized. Verify the transport's request/response correlation handles a second outstanding
  request (it serializes `ask_user_question` — confirm the same holds).
- **Per-prompt quiescence boundary.** Detecting "this prompt's induced subtree drained" for a
  long-lived root that spawned peers is non-trivial. Prototype with task-id tagging; fall back to
  "root idle + no running peers in scope" if tagging is unavailable.
- **Subprocess cost.** Team-by-default routes even trivial prompts through a spawned root worker
  (heavier than Stage A's in-process engine). `--single` is the escape hatch; measure first-token
  latency.
- **Headless `ask_user_question`.** Today it errors headless ([standalone-host.ts:936](../src/swarm/standalone-host.ts));
  the new injectable handler should also back `ask_user_question` so members can ask the ACP user
  (natural follow-on, not B0-blocking).
- **Stage A divergence.** Two prompt paths (single vs team) now exist; keep `send()`/permission
  shapes identical so B1 `_meta.swarm` and the client are uniform.

---

## Key references
- [docs/31-teams-acp-design.md](31-teams-acp-design.md) — Stage B design + locked decisions (collapse, `_meta.swarm`, Q1–Q5)
- [docs/32-acp-implementation-plan.md](32-acp-implementation-plan.md) — Stage A (reused helpers + e2e harness)
- Seam: `src/swarm/orchestrator.ts`, `standalone-host.ts` (lane bus + ask_user_question), `topologies/coordinator.ts`, `team-session.ts`, `cli/worker-entry.ts` (permission), `ipc/protocol.ts`
