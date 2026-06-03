# Stage B2 implementation plan — `swarm/steer` ext + swarm-aware rich client

Execution companion to [docs/31-teams-acp-design.md](31-teams-acp-design.md) (§7 steering, §10 B2, Q5)
and [docs/34-acp-b1-meta-swarm-plan.md](34-acp-b1-meta-swarm-plan.md) (B1, shipped). B1 made the
agent-side emission surface rich (`_meta.swarm` on every member-attributed update). **B2 adds the two
things only a *rich* client needs**: a steering channel to inject mid-turn, and a reference client
that re-expands `_meta.swarm` into per-member lanes. There is one agent-side emission surface — stock
Zed renders it collapsed; our client renders it richly (Q5).

**Authoring date:** 2026-06-03.
**Status:** B2 shipped — B2.0 (steer ext), B2.1 (rich renderer), B2.2 (formatter + RichClient +
reference binary). Verified by unit tests + a live smoke (real team → per-member lanes + board +
steer). Remaining polish (a full TUI, sub-turn diff rendering) is optional.
**Prerequisite:** B1 complete (`_meta.swarm`, capability negotiation, `session/load`).

---

## 0. Goals & non-goals

**Goals**
1. **`swarm/steer` ext** — a custom ACP ext method that injects a message to the running team (the
   lead by default, or a specific role/member) **mid-turn, without ending the turn** (docs/31 §7).
   Baseline clients never call it (unknown method, harmless); rich clients use it instead of
   cancel+reprompt.
2. **Rich renderer** — a pure, `_meta.swarm`-aware module that re-projects the collapsed
   `session/update` stream into **per-member lanes** (member voices, lane-grouped tool calls, the
   task board). The reusable core of the rich client; testable without a UI.
3. **Reference client** (B2.2) — a thin interactive client binary that connects to `acp`, drives the
   renderer, and sends `swarm/steer` from operator input. The reference rich ACP client by
   construction (Q5).

**Non-goals (deferred)**
- A full TUI/web GUI — the reference client is a terminal renderer, not a polished app.
- Forcible mid-turn *interruption* — steering is cooperative (inbox delivery; the member sees it on
  its next `check_inbox`), matching the swarm's model. True preemption is out of scope.
- Free-form `ask_user_question` park-and-resume (a separate §9 follow-on).

---

## 1. `swarm/steer` — the steering channel

ACP has no native "inject mid-turn", so steering is a **custom ext method** (the SDK exposes
`Agent.extMethod`/`extNotification`; we use a method so the client gets a delivery ack). The method is
domain-prefixed per the SDK's guidance (avoids spec collisions); docs/31 §7's conceptual name was
`session/steer`.

```jsonc
// client -> agent ext method (swarm-aware client only)
"swarm/steer": { "message": "focus on the auth module first", "target": "lead" }
// -> { "delivered": true, "to": "role:lead" }
```

- **Mechanism:** routes to `host.send(to, { from, to, content, timestamp })` — the team's inbox bus.
  `target: "lead"` (default) → `to: "role:lead"`; `target: "<role>"` → `to: "role:<role>"`; a bare
  member/agent id → that recipient. The member sees the steer on its next `check_inbox`, mid-turn, no
  turn boundary.
- **Agent side:** `AcpTeamAgent.extMethod("swarm/steer", params)` → `TeamRunner.steer(message, target)`
  → `host.send`. Returns `{ delivered, to }`. With no live team, `delivered: false`.
- **Baseline degradation:** a stock client never sends `swarm/steer`; it steers via `session/cancel` +
  re-`prompt` (loses in-flight work but stays coherent — docs/31 §7).

Cooperative, not preemptive: delivery is to the inbox; whether the lead acts on it mid-turn depends on
it polling `check_inbox` (the coordinator prompt nudges this). The mechanism is the deliverable.

---

## 2. Rich renderer — `_meta.swarm` → per-member lanes

A pure module: feed it the `session/update` notifications a client receives; it maintains per-member
lanes and returns a render model. No I/O, no terminal — so it's unit-tested directly and reused by any
front-end.

- **Lanes keyed by `_meta.swarm.member.id`** (absent ⇒ the orchestrator/lead lane). Each lane
  accumulates: the member's text (`agent_message_chunk`), its tool calls (`tool_call` /
  `tool_call_update`, keyed by `toolCallId`), and its role/name for the header.
- **Task board** from `plan` entries, each linked to its member via `entry._meta.swarm.member`.
- **Collapsed-equivalent invariant:** the renderer reads only standard fields + `_meta.swarm`; stripping
  `_meta` degrades to a single lane (the baseline view). So the same stream drives both fidelities.
- Output is a `RichView` (lanes[] + board) the front-end formats. A terminal formatter (B2.2) renders
  lanes side-by-side or stacked with `[role]` headers.

---

## 3. Build sequence (each behind a green checkpoint)

- **B2.0 — `swarm/steer` ext.** ✅ `TeamRunner.steer` (direct sends to roster-resolved member
  agentIds — `role:`/`*` won't resolve from the out-of-scope orchestrator); `AcpTeamAgent.extMethod`
  dispatch. *Checkpoint met: steer delivers to the real root's inbox; no live team ⇒ not delivered.*
- **B2.1 — Rich renderer.** ✅ `rich-view.ts` — `RichRenderer` folds `session/update`s into lanes +
  board; `plan` is board-only; strip-`_meta` ⇒ one lane. *Checkpoint met, incl. a round-trip from the
  real lane translator into 2 lanes.*
- **B2.2 — Reference client.** ✅ `rich-format.ts` (lanes → terminal lines), `rich-client.ts`
  (`RichClient implements Client`), and `scripts/acp-rich-client.ts` (spawn `acp`, repaint lanes per
  update, operator input → prompt / `/steer [@role]` / `/quit`). *Checkpoint met: live smoke shows the
  `[lead]` lane + board + a delivered steer.*

---

## 4. Acceptance gates (docs/31 §10)

- [x] **Rich client renders ≥2 concurrent member lanes** from one session (renderer round-trip test:
      the real translator's output folds into 2 lanes; the binary demonstrates it live).
- [x] **`swarm/steer` injects mid-turn** without a turn boundary (delivery to the inbox, acked —
      integration test + live smoke).
- [x] **One emission surface, two fidelities:** strip `_meta` ⇒ the renderer collapses to the baseline
      single-lane view (unit test).

---

## 5. Risks & open items

- **Cooperative steering visibility.** A steer only influences the turn if the lead polls
  `check_inbox`. The coordinator prompt should nudge periodic inbox checks; otherwise the steer applies
  on the next turn. Document the behavior; don't fake preemption.
- **Target resolution.** `role:lead` is the clean default; a bare member id requires the live roster.
  Resolve leniently (unknown target ⇒ `delivered: false`), never throw into the ext handler.
- **Client scope creep.** Keep B2.2 a thin reference renderer-to-terminal, not a product UI.

---

## Key references
- [docs/31-teams-acp-design.md](31-teams-acp-design.md) — §7 steering, §10 B2, Q5 (build our own client).
- [docs/34-acp-b1-meta-swarm-plan.md](34-acp-b1-meta-swarm-plan.md) — `_meta.swarm` schema the renderer reads.
- Seam: [team-agent.ts](../src/acp/team-agent.ts) (extMethod), [team-runner.ts](../src/acp/team-runner.ts) (steer),
  [host.ts](../src/swarm/host.ts) (`send` / inbox), [swarm-meta.ts](../src/acp/swarm-meta.ts).
