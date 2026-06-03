# Stage B1 implementation plan — `_meta.swarm` enrichment + team `session/load`

Execution companion to [docs/31-teams-acp-design.md](31-teams-acp-design.md) (Stage B design, `_meta.swarm`
schema §4, Q1–Q5) and [docs/33-teams-acp-implementation-plan.md](33-teams-acp-implementation-plan.md)
(B0, shipped + hardened). B0 delivers the **Baseline** tier — a coordinator team drivable from stock
Zed via collapse-to-single-voice. **B1 adds the Rich tier's data layer**: per-member `_meta.swarm`
enrichment on every relevant emission, capability negotiation, and team transcript replay
(`session/load`). It does **not** build the rich client (that is B2) — B1's job is to make the
agent-side emission surface rich enough that a swarm-aware client *could* re-expand it, while stock
Zed is byte-for-byte unchanged (it ignores `_meta`).

**Authoring date:** 2026-06-03.
**Status:** B1 complete (B1.0–B1.4 + live context-resume). One *prose*-fidelity follow-on remains
(replay the lead's narration text, not just the tool/plan timeline); see §8. B2 (rich client +
`session/steer`) is the next sub-stage.
**Prerequisite:** B0 shipped (B0.0–B0.6 + two hardening rounds).

---

## 0. Goals & non-goals

**Goals**
1. Attach versioned `_meta.swarm` (docs/31 §4) to every `session/update`, `plan` entry, and
   `request_permission` that carries member work — *additively*, beside the standard fields B0 already
   emits.
2. **Capability negotiation:** advertise the agent's `_meta.swarm` support at `initialize`; read the
   client's capability to decide whether to enable the one rich behavior that changes the *standard*
   stream — optional member-text streaming (`acp.memberText: "interleave"`). Default stays collapse.
3. **Team `session/load`:** wall-clock transcript replay for a team session (Q4), advertised on for
   team mode once it lands (B0 advertises it off).

**Non-goals (deferred)**
- The rich client and `session/steer` ext (B2).
- Upstreaming `_meta.swarm` (B3 — skipped per Q5).
- Subtree-drain quiescence, `ask_user_question` over ACP, the Q2 escalation queue — tracked
  separately in [docs/33 §9](33-teams-acp-implementation-plan.md).

---

## 1. The hard invariant (carried from B0, must not regress)

**Stripping `_meta` must leave a valid, trust-coherent single-agent session.** Concretely:
- Member identity for any `request_permission` stays in the **standard** `toolCall.title`
  (`[role] …`) — `_meta.swarm.member` is *additional*, never the only carrier (docs/31 §6 safety).
- Every member tool call keeps its standard `tool_call` + `[role]` title + `kind`/`locations`/`diff`.
- The plan board renders from standard `content`/`priority`/`status`; `_meta` only adds linkage.

B1's acceptance test (the §4 gate) asserts this mechanically: take a recorded session, strip every
`_meta`, and assert the result is still a coherent baseline session whose trust-relevant meaning is
unchanged.

---

## 2. The `_meta.swarm` v1 schema

Verbatim from docs/31 §4 — implemented once as a typed builder so the agent never hand-rolls the
shape:

```typescript
/** Versioned swarm enrichment. Stripping this must leave a valid single-agent session. */
interface SwarmMeta {
  v: 1;
  member?: { id: string; name: string; role?: string; worktree?: string; stream?: string };
  task?: { id: string; parentId?: string; dependsOn?: string[]; topology?: string };
}
```

New module `src/acp/swarm-meta.ts`:
- `swarmMemberMeta(member: MemberInfo, ctx): SwarmMeta` — builds `{ v: 1, member, task? }` from a
  roster entry. `member.id` = `MemberInfo.memberId`, `name`/`role` = role, `worktree`/`stream` from
  the member's BranchPolicy resolution when git-cascade is active (else omitted).
- `wrapMeta(update, meta): SessionUpdate` — attaches `update._meta = { swarm: meta }` (the ACP SDK
  types already expose an optional `_meta` on update/plan/toolCall structures — verified against
  `@agentclientprotocol/sdk` `types.gen.d.ts`). **Confirm exact placement** (update object vs the
  `SessionNotification` wrapper) during B1.0 and pin it in one helper.

---

## 3. Where it rides — the emission seam

B0 funnels **all** member emissions through `emitNormalizedEvent(ne, opts)`
([normalized-translate.ts](../src/acp/normalized-translate.ts)); `EmitOptions` already carries the
per-member context (`idPrefix`, `titlePrefix`, `suppressText`). B1 threads the meta through the same
funnel — one seam, no scatter.

1. **`EmitOptions.meta?: SwarmMeta`** (new). When present, `emitNormalizedEvent` attaches it to every
   `send(update)` it produces via `wrapMeta`. This covers `agent_message_chunk`, `tool_call`,
   `tool_call_update` automatically.
2. **Lane translator** ([lane-translator.ts](../src/acp/lane-translator.ts)) builds the meta per event
   from the roster it already looks up (`deps.getRoster()?.get(event.agentId)`), passing it as
   `opts.meta`. The lead's meta has `member.role = "lead"`; the orchestrator's own updates carry no
   `member` (absent ⇒ orchestrator, per schema).
3. **Plan entries.** `emitPlan` already maps the roster → `PlanEntry[]`; B1 adds
   `entry._meta = { swarm: { v: 1, member, task } }` per entry, including `task.dependsOn` once the
   topology exposes edges (coordinator: none in v1; leave `dependsOn` omitted until peer-team).
4. **Permissions.** [team-permission.ts](../src/acp/team-permission.ts) already resolves the member
   from `req.agentId` for the `[role]` title; B1 also sets `toolCall._meta = { swarm: swarmMemberMeta(...) }`.
   Title stays the authoritative identity (invariant §1).

This is the bulk of B1 and is purely additive — every change sits beside an existing standard-field
emission.

---

## 4. Capability negotiation + optional member-text streaming (Q3)

`_meta` is ignore-safe, so the agent **always** emits it; "negotiation" only gates the one behavior
that changes the *standard* stream — interleaved member text.

- **`initialize`:** advertise an agent capability `agentCapabilities._meta = { swarm: { v: 1 } }` (or
  the SDK's capability `_meta` slot) so a rich client can detect us. Read `req.clientCapabilities` for
  a reciprocal marker.
- **`acp.memberText` setting (Q3):** default `"collapse"` (B0 behavior — `suppressText` for non-lead).
  `"interleave"` streams non-lead text as `**[role]**: …` chunks (flip `suppressText` off and prefix).
  This is an explicit setting, **not** adaptive by topology. Plumb it via a `CommonOpts`/session field;
  rich clients may request it, baseline never does.
- Rich clients always get clean per-member lanes from `_meta.swarm.member` regardless of this setting;
  the setting only governs the *baseline* text stream.

`capabilities.ts.initializeResponse` grows a `swarmMeta?: boolean` option (team mode passes true).

---

## 5. Team `session/load` (Q4)

B0 advertises `loadSession: false` in team mode ([capabilities.ts](../src/acp/capabilities.ts),
[team-agent.ts](../src/acp/team-agent.ts)). B1 implements wall-clock re-projection.

**Prerequisite — persist the spine.** The ACP team runner currently wires `resultsOut: NullWritable`
and **does not set `eventsOut`** ([team-runner.ts](../src/acp/team-runner.ts)), so no `events.jsonl`
is written for an ACP team today. B1.0 must give each ACP session a persisted, per-session
orchestration spine (an `events.jsonl` via `Orchestrator` `eventsOut`, scoped to the session dir).
Q4 verified the spine is sufficient and fully attributed: every persisted `LaneEvent` carries `ts`
(epoch ms) + `agentId`, and the recorded/live filter drops by *type* only, never stripping
attribution ([events.ts](../src/swarm/events.ts), [wire-protocol.ts](../src/swarm/wire-protocol.ts)).

**Replay projection (Q4):**
- **Baseline:** collapsed stream — the lead's narration + every member's attributed `tool_call`s in
  **wall-clock** order, reconstructed from the spine + the lead's session JSONL. (`text_delta` is
  live-only / not on the spine, so baseline prose comes from the lead's session log.)
- **Rich:** per-member lanes carrying `_meta.swarm`, wall-clock **within** each lane; per-member prose
  reads each member's session JSONL in addition to the spine.
- **Reject** per-member-then-merged ordering (breaks causal reading — Q4).
- Replay is projected through the **active mode**, reproducing what the session looked like live.

`AcpTeamAgent.loadSession` mirrors Stage A's ([agent.ts](../src/acp/agent.ts)) `SessionStore`-backed
flow: re-emit the projected `session/update` stream for `req.sessionId`, then arrange context resume
on the next prompt. Flip the advertised capability to `loadSession: true` for team mode once green.

---

## 6. Build sequence (each behind a green checkpoint)

- **B1.0 — Schema + meta builder + seam plumbing.** ✅ `swarm-meta.ts` (`SwarmMeta`,
  `swarmMemberMeta`, `withSwarmMeta`); `EmitOptions.meta`; `_meta` rides the inner update object.
  *Checkpoint met: `emitNormalizedEvent` with `meta` attaches `_meta.swarm` to each update; without
  it, byte-identical to B0.*
- **B1.1 — Tag updates + plan + permissions.** ✅ Lane translator passes per-member meta into the
  funnel; `emitPlan` wraps each `entry._meta`; the permission router adds `toolCall._meta`.
  *Checkpoint met: the strip-`_meta` invariant test (§1, `strip-meta.test.ts`) passes — member
  identity stays in standard `toolCall.title`.*
- **B1.2 — Capability negotiation + `acp.memberText`.** ✅ `initialize` advertises
  `agentCapabilities._meta.swarm` and reads the client's `memberText`; the translator implements
  collapse (default, == B0) vs interleave (non-lead text streams, one `**[role]**:` prefix per run).
  *Checkpoint met.*
- **B1.3 — Persist the team spine.** ✅ `spine.ts` subscribes the lane bus and writes a per-session
  `events.jsonl` (keyed by sessionId; metadata header; recorded events only). *Checkpoint met:
  integration test writes an attributed spine (ts + agentId per event) from a real team run.*
- **B1.4 — Team `session/load` replay.** ✅ `team-history.ts` re-projects the spine (B1.3) through the
  collapsed translator in wall-clock order; `AcpTeamAgent.loadSession` replays then registers the
  session; team advertises `loadSession: true`. *Checkpoint met for transcript replay (tool calls +
  results + plan board, `[role]`-attributed, `_meta`-enriched), verified against a real persisted
  spine.* **Fidelity follow-on (§8):** prose + tool args aren't on the spine, and a loaded session's
  next prompt starts a fresh root — full prose replay + live engine context-resume need the lead SDK
  session id persisted.

Sequence keeps the deterministic suite green throughout; B1.0–B1.2 are additive (stock Zed unchanged),
B1.3–B1.4 add the replay path.

---

## 7. Acceptance gates (from docs/31 §10)

- [x] **Strip-`_meta` coherence.** `strip-meta.test.ts` asserts every member-work `session/update`
      has both a coherent standard-field projection (strip `_meta` ⇒ valid single-agent session) and a
      correct `_meta.swarm`; no swarm info survives the strip.
- [x] **Permission identity invariant.** Member identity present in `toolCall.title` for every
      `request_permission`, independent of `_meta` (team-permission + strip-meta tests).
- [x] **Capability negotiation.** `initialize` advertises `_meta.swarm`; `acp.memberText` toggles
      interleave vs collapse; default collapse equals B0 (capabilities + lane-translator tests).
- [x] **Team `session/load` (transcript replay).** A prior team session replays in wall-clock order
      (baseline collapsed: tool calls + results + plan board, `[role]`-attributed); team mode
      advertises `loadSession: true`. Verified against a real persisted spine.
- [x] **Team `session/load` (live context-resume).** The next prompt after a load resumes the prior
      conversation's engine context (not just the transcript), via the lead session sidecar (§8).
      Verified by a real two-process integration test (persist `sess-1` → fresh process resumes it).

---

## 8. Risks & open items

- **`session/load` live context-resume — DONE.** A loaded session's next prompt resumes the prior
  engine context via the **lead session sidecar** (`src/cli/session-sidecar.ts`): the root worker
  writes its SDK session id to a per-session sidecar after each turn and reads it on its first turn,
  so a fresh process resumes the prior conversation. No worker→host IPC was needed — the sidecar path
  is threaded per-spawn to the root, and the worker persists/reads it autonomously. Verified by a real
  two-process integration test.
- **`session/load` prose replay (remaining follow-on).** Replay still re-projects the orchestration
  spine (tool calls/results + plan board), not the lead's narration prose or tool arguments (live-only,
  not on the spine). With the lead session id now persisted (sidecar), prose replay can read the lead's
  session JSONL and interleave it with the spine in wall-clock order — the last fidelity slice.
- **`_meta` placement.** Pinned to the inner update object (ContentChunk / ToolCall / ToolCallUpdate /
  PlanEntry all expose `_meta`); routed through the single `withSwarmMeta` helper.
- **Spine completeness for rich prose.** Baseline replay needs only the spine + lead log; rich
  per-member prose needs each member's session JSONL — confirm those persist for ACP-spawned workers
  (they run from `dist/cli.js`; verify the session store path is reachable from the orchestrator).
- **Interleave under heavy fan-out.** `"interleave"` jumbles by arrival order at high parallelism
  (Q3 documents this); it stays opt-in and is not the default.
- **Worktree/stream context.** `member.worktree`/`stream` only populate under git-cascade; omit
  cleanly otherwise (don't emit empty strings).

---

## Key references
- [docs/31-teams-acp-design.md](31-teams-acp-design.md) — `_meta.swarm` schema (§4), projection (§5),
  Q1–Q5 (esp. Q3 member-text, Q4 session/load).
- [docs/33-teams-acp-implementation-plan.md](33-teams-acp-implementation-plan.md) — B0 (shipped),
  §9 follow-on backlog.
- Seam: [normalized-translate.ts](../src/acp/normalized-translate.ts) (emission funnel),
  [lane-translator.ts](../src/acp/lane-translator.ts), [team-permission.ts](../src/acp/team-permission.ts),
  [capabilities.ts](../src/acp/capabilities.ts), [team-runner.ts](../src/acp/team-runner.ts) (eventsOut),
  [agent.ts](../src/acp/agent.ts) (Stage A session/load to mirror).
