# Teams × ACP — driving a swarm from an editor with graceful degradation

Follow-up to [docs/30-acp-compatibility-plan.md §9](30-acp-compatibility-plan.md). Doc 30 ships
**single-agent** ACP parity (Stage A). This doc designs **Stage B** — exposing a *team* over ACP so
a developer can drive the swarm from an ACP editor (Zed, etc.) — while staying compatible with
**standard, swarm-unaware** ACP clients through deliberate degradation.

**Authoring date:** 2026-06-02.
**Status:** design proposal; §11 open questions **resolved/locked 2026-06-02** (see that section).
**Anchor:** [docs/00-vision.md](00-vision.md) — "N coordinated agents is the product."
**Product goal (locked for this doc):** *drive the swarm from the editor* — the developer prompts a
team lead, sees member work, adjudicates escalations, and steers mid-run, all from the ACP client.
**Depends on:** Stage A (doc 30) — the engine→`session/update` translator and the
`PermissionGate`→`session/request_permission` bridge.

---

## TL;DR

ACP assumes **one session = one linear update stream, one turn in flight, one narrating voice.** A
swarm is **N concurrent narratives** (parallel members, each with text, tool calls, permissions,
sometimes its own git worktree). Stage B projects N agents onto 1 ACP session.

The whole design rests on one rule:

> **`_meta` is strictly additive. The standard-field projection must be independently coherent as a
> valid single-agent session. Trust-relevant context is duplicated into standard fields, never
> `_meta`-only.**

Because ACP clients ignore `_meta` they don't understand, this gives **dual-mode compatibility**:
a swarm-aware client reads `_meta.swarm` to re-expand per-member lanes + steering; a standard client
(stock Zed) ignores `_meta` and sees a coherent **collapsed** single-agent session. The agent picks
its emission strategy from a negotiated capability at `initialize`.

The enabling move: **the baseline is "collapse to a single-agent session," not "multiplex N voices
and hope the client copes."** Degradation is then automatic-by-construction, not best-effort.

---

## 1. The tension (why this needs a design at all)

| ACP assumption | Swarm reality |
|---|---|
| One linear, ordered `session/update` stream | Members emit concurrently (fanout / peer-team / committee) |
| One narrating voice; `agent_message_chunk` has **no author field** | Many voices; interleave → garbage without attribution |
| One turn in flight per session, ending in one `stopReason` | Team reaches quiescence when the task graph drains |
| `request_permission` is per-session | Each member has its own gated tool calls — possibly concurrent |
| `locations` point into the project tree | git-cascade members edit in `.swarm-harness/worktrees/<id>/` |
| No "inject mid-turn" method | Steering (your Ctrl-S) wants to message a running team |

Every hard problem below is a facet of "project N concurrent agents onto 1 linear session without
losing who-did-what, the-right-approval, and steering."

---

## 2. Governing rule — additive `_meta`, coherent baseline

ACP `_meta` (inherited from MCP) is an arbitrary extension object; the protocol convention is that
**clients ignore unknown `_meta`** (Zed preserves/ignores it). Compatibility holds **iff** `_meta`
is never load-bearing:

1. **Standard-field projection is independently coherent.** Strip every `_meta` field and you still
   have a valid, sensible single-agent ACP session.
2. **`_meta` only re-expands.** A swarm-aware client uses it to split lanes, stream member voices,
   enable steering, and visualize worktrees/merges.
3. **Trust-relevant context is redundant in standard fields.** Member identity for a permission
   prompt lives in `toolCall.title` (standard) **and** `_meta.swarm` (structured). Never `_meta`-only
   — a vanilla client must show *who* the human is trusting (§6 is a safety constraint, not a nicety).
4. **`_meta.swarm` is versioned** (`v` field) so the convention can evolve without breaking either
   client class.

Precedent: `@agentclientprotocol/claude-agent-acp` gates a custom live-terminal channel on
`clientCapabilities._meta["terminal_output"]` and streams output over `_meta`. We use the same
mechanism for swarm enrichment.

---

## 3. Capability negotiation → emission modes

At `initialize`, inspect a custom client capability:

```jsonc
// ClientCapabilities (client → agent in `initialize`)
{
  "fs": { "readTextFile": true, "writeTextFile": true },
  "terminal": true,
  "_meta": { "swarm": { "v": 1 } }   // present ⇒ swarm-aware client
}
```

The agent then chooses how it emits for the whole connection:

| Mode | Trigger | Behavior |
|---|---|---|
| **Baseline** | `_meta.swarm` absent (stock Zed) | Collapse-to-single-voice. Orchestrator narrates; members surface as attributed `tool_call`s + a `plan` board. No member-text streaming. Steering via cancel+reprompt. |
| **Rich** | `_meta.swarm` present | Per-member lanes: member voices stream (clean text + `_meta.swarm.member`), live `session/steer`, grouped permissions, worktree/merge visualization. |

Same agent, two faithful renderings, negotiated up front. The agent advertises its own side in
`InitializeResponse`:

```jsonc
// AgentCapabilities (agent → client)
{
  "loadSession": true,
  "_meta": { "swarm": { "v": 1, "topologies": ["coordinator", "peer-team", "committee", "critic-loop"] } }
}
```

---

## 4. The `_meta.swarm` schema (v1)

Attached to `session/update` notifications, `request_permission` requests, and (for steering) a
custom method. All fields are **enrichment**; the standard fields beside them carry the coherent
baseline.

```typescript
/** Versioned swarm enrichment. Stripping this must leave a valid single-agent session. */
interface SwarmMeta {
  v: 1;
  /** The member this update/permission/voice belongs to. Absent ⇒ the orchestrator itself. */
  member?: {
    id: string;            // stable member id within the team
    name: string;          // human label, e.g. "architect"
    role?: string;         // "lead" | "worker" | ...
    worktree?: string;     // absolute path under .swarm-harness/worktrees/<id>/, if git-cascade
    stream?: string;       // git-cascade streamId, if any
  };
  /** Team/task context for board rendering + dependency edges. */
  task?: {
    id: string;
    parentId?: string;
    dependsOn?: string[];
    topology?: string;     // the active topology for this session
  };
}
```

### Where it rides
- **`session/update` (any variant):** `update._meta.swarm` — tags the producing member so a rich
  client lanes it. Baseline ignores it; the standard fields already attribute via `title` prefix
  or the single narrating voice.
- **`plan` entries:** `entry._meta.swarm` — per-entry member/task linkage and `dependsOn` edges for
  a graph view. Baseline renders the flat plan natively.
- **`request_permission`:** `toolCall._meta.swarm` — grouped/laned approvals. **Member identity is
  ALSO in `toolCall.title`** (see §6).

---

## 5. Per-update projection — baseline vs rich

| Concern | Baseline (standard fields, stock Zed) | Rich (`_meta.swarm` enrichment) |
|---|---|---|
| **Voice / attribution** | Orchestrator is the single `agent_message_chunk` voice ("architect finished auth, 3 files changed"). Members do **not** stream text. | Members stream clean text; client renders per-member lanes/avatars from `_meta.swarm.member`. |
| **Member work** | Each member tool call → standard `tool_call` with `title: "[architect] edit src/auth.ts"`, correct `kind`/`locations`/`diff`. | Same `tool_call` + `_meta.swarm.member` → grouped under the member's lane. |
| **Team / task board** | Standard `plan` entries (content / priority / status) — renders natively as a todo panel. | `_meta.swarm.task` adds member linkage, parent/child, `dependsOn` edges → graph/board view. |
| **Permissions** | `request_permission`; member named in `toolCall.title` ("architect wants to edit X"). | `_meta.swarm.member` → laned/grouped approval UI. |
| **Diffs** | Standard `diff` content blocks (render regardless of project tree). | `_meta.swarm.{worktree,stream}` → worktree/merge context. |
| **Steering** | ⚠️ no standard equivalent → `session/cancel` + re-`prompt`. | `session/steer` ext (see §7). |

### 5.1 Member text in baseline — explicit setting, default collapse (Q3 lock)
Baseline observability is an **explicit, predictable setting** — *not* adaptive by topology, because
silently changing how the stream reads based on member count is confusing.
- **`acp.memberText: "collapse"` (default):** only the orchestrator narrates; member work is visible
  as attributed `tool_call`s / diffs. Coherent by construction; raw member reasoning is a *rich-mode*
  feature (lanes), not a baseline one.
- **`acp.memberText: "interleave"` (opt-in):** stream member text as `**[architect]**: …` chunks.
  Reads like a speaker-labeled chat at low parallelism; jumbles by arrival order under heavy fan-out.
  Recommended only for narrow/conversational topologies; the user opts in knowingly.

Rich mode always gets clean per-member lanes regardless of this setting.

---

## 6. Permissions — the safety constraint + the parallelism reality

**Safety (hard):** member identity for any `request_permission` MUST appear in a **standard** field
(`toolCall.title`), not only `_meta`. A vanilla client must show the human *which member* they are
authorizing; `_meta`-only identity would be a trust regression.

**Parallelism (design reshape):** `request_permission` is per-session. N parallel members hitting
gated tools at once ⇒ a stack of concurrent modals. Per-call approval **fundamentally fights
parallelism**, so driving a swarm interactively leans on:
- **Mode-based trust set up front** via `session/set_mode` (→ `read-only` / `workspace-write` /
  `danger-full-access`, mapping our `PermissionMode`). The developer trusts the team at a level.
- **Escalation-only prompts:** `request_permission` fires for exceptions — a member wanting a higher
  mode, a destructive bash, an unresolved merge conflict — not every edit.

This holds in *both* client modes; it's a product reshape, not a protocol one.

---

## 7. Steering — the accepted baseline gap

ACP has no "inject mid-turn." Steering maps to a **custom ext notification** that injects a message
to the orchestrator without ending the turn (your existing Ctrl-S mechanism):

```jsonc
// agent-exposed ext method; swarm-aware client only
"session/steer": { "sessionId": "...", "message": "...", "target": "lead" | "<memberId>" }
```

- **Rich client:** calls `session/steer` → message routed to the orchestrator (or a specific member)
  mid-turn; no turn boundary.
- **Baseline client:** never calls it (unknown method, harmless). Degrades to `session/cancel` +
  re-`prompt` — loses in-flight work but stays coherent.

This is the single feature that is rich-mode-only. It is a graceful *missing feature*, not a break.

---

## 8. Worktrees / git-cascade in an editor

Members edit in `.swarm-harness/worktrees/<id>/`, but the editor's project tree is the **main**
worktree — so member `locations` point at paths the developer isn't viewing.

- **Baseline:** surface member changes as inline `diff` **content blocks** (render independent of the
  project tree). Only the **merged** result touches main-tree paths with real follow-along
  `locations`.
- **Rich:** `_meta.swarm.{worktree,stream}` lets the client show per-stream diffs and the merge graph.

Known rough edge: pre-merge follow-along is weak (worktree paths aren't in the project). Documented,
not hidden.

---

## 9. Per-topology mapping

Not all six topologies want interactive driving.

| Topology | ACP fit | Session = | Notes |
|---|---|---|---|
| **coordinator** | ★ flagship | the lead (dynamic spawning) | Most natural "converse with a lead" UX. |
| **peer-team** | ★ flagship | the team (lateral peers) | Label-interleave viable at ≤3 members. |
| **committee** | ◐ output-only | the synthesized verdict | Members are implementation detail → `plan`/`_meta`; surface the synthesis as the voice. |
| **critic-loop** | ◐ output-only | the executor's result | Critic passes surface as `plan` status / tool calls. |
| **fanout** | ✗ batch | (n/a) | Better as CLI/daemon than an editor session. |
| **pipeline** | ✗ batch | (n/a) | Same. |

Stage B targets **coordinator** + **peer-team** first; committee/critic-loop expose synthesized
output; fanout/pipeline stay CLI/daemon.

---

## 10. Staging

Builds on doc 30 Stage A. Each layer is independently shippable; earlier layers are not throwaway.

- **B0 — collapse-to-single-voice swarm (works in stock Zed today).**
  Session = orchestrator (coordinator/peer-team). Lead narrates; member tool calls surface
  title-prefixed (`[name] …`) with correct `kind`/`locations`/`diff`; `plan` = team/task board;
  permissions member-named in `title`; mode-based trust + escalation prompts; steering =
  cancel+reprompt. **No `_meta` required.** Acceptance: a developer drives a 2–3 member peer-team
  from stock Zed end to end.
- **B1 — `_meta.swarm` enrichment + capability negotiation.**
  Add the schema (§4), `initialize` capability sniff (§3), per-member `_meta` tagging on updates /
  plan / permissions, worktree/stream context. Stock Zed unchanged (ignores `_meta`).
- **B2 — `session/steer` ext + our swarm-aware client.**
  Implement the steer method; build **our own** swarm-aware client (TUI/web) as the home for the
  rich multi-lane experience. The client speaks **ACP-with-`_meta.swarm`** — *not* a second native
  protocol — so there is one agent-side emission surface: stock Zed renders it collapsed, our client
  renders it richly. Our client is the reference rich ACP client by construction.
- **B3 — upstream the convention (demoted; optional).** *Q5 decision: skip upstream.* We do **not**
  pursue Zed adoption of `_meta.swarm`; it stays our private enrichment convention (versioned as
  hygiene, since agent + our client version together). Revisit only if a concrete partner asks.

**Acceptance gates:**
- [ ] B0: stock-Zed drive-through of a peer-team; nothing but JSON-RPC on stdout; member-attributed
      diffs + escalation approvals work; cancel+reprompt steering works.
- [ ] B1: a swarm-aware harness test asserts every `session/update` carrying member work has both a
      coherent standard-field projection (strip `_meta` → valid single-agent session) and a correct
      `_meta.swarm`. Stripping `_meta` never changes trust-relevant meaning.
- [ ] B2: rich client renders ≥2 concurrent member lanes from one session; `session/steer` injects
      mid-turn without a turn boundary.

---

## 11. Resolved decisions (locked 2026-06-02)

- **Q1 — Quiescence = per-*prompt*, not team-lifetime.** A `session/prompt` induces a task subtree;
  tag its root task with the ACP turn id (the task registry already has ids + parent links). The
  turn resolves when that subtree is all-terminal **and** no member is still executing on it. Works
  identically for an ACP-spawned team and an ACP session attached to a long-lived daemon (session
  lifetime ≠ prompt lifetime). stopReason: all-terminal → `end_turn`; `session/cancel` →
  `cancelled`; member budget hit → `max_tokens`; member fatal failure → `tool_call_update: failed` +
  lead narration, turn still `end_turn` (ACP has no partial-failure reason). **Blocked-on-human**
  (a member asks a question): orchestrator narrates the question and ends the turn (`end_turn`); the
  member parks; the developer's next `prompt` is routed by the orchestrator to the waiting member —
  preserving ACP's linear prompt/response cadence (consistent with `AskUserQuestion` being unmapped,
  doc 30).
- **Q2 — Permissions: never a raw modal stack.** Lean on **mode-based trust** (`session/set_mode`)
  so per-call prompts are escalation-only and rare. Residual concurrent escalations are **serialized
  through an adapter queue** (one outstanding at a time) and **coalesced by tool** (e.g. "3 members
  want to `git push`: allow all / each / deny"). `allow_always` persists **team-wide** in baseline
  (per-member in rich). Member identity is duplicated into `toolCall.title` (§6 safety constraint).
- **Q3 — Member text in baseline: explicit setting, default collapse.** `acp.memberText:
  "collapse"` (default) vs `"interleave"` (opt-in). **Not** adaptive-by-topology. See revised §5.1.
- **Q4 — `session/load`: wall-clock, projected through the active mode.** Replay reproduces what the
  session looked like live: baseline → collapsed stream (lead narration + attributed tool calls) in
  wall-clock order; rich → per-member-laned with `_meta.swarm`, wall-clock within lanes. **Reject**
  per-member-then-merged (breaks causal reading). **Dependency verified (2026-06-02):** every
  persisted `LaneEvent` already carries `ts` (epoch ms) + `agentId` (the member identity — each
  member gets a stable branded `AgentId`) as base fields ([src/swarm/events.ts:19-29](../src/swarm/events.ts)),
  and the recorded/live filter (`isRecordedLaneEvent`, [src/swarm/wire-protocol.ts:211](../src/swarm/wire-protocol.ts))
  drops by *type* only — it never strips attribution/timestamp. So `events.jsonl` is a fully-attributed
  **orchestration spine** sufficient for wall-clock re-projection. Caveat: `text_delta` is *not*
  persisted to `events.jsonl` (live-only), so rich per-member **prose** replay reads the per-agent
  session JSONL stores in addition to the spine; baseline collapsed replay needs only the spine +
  the lead's session log.
- **Q5 — Rich client: build our own, skip upstream.** We build our own swarm-aware client (TUI/web)
  as the home for the rich multi-lane experience; we do **not** chase Zed adoption of `_meta.swarm`.
  Our client speaks ACP-with-`_meta.swarm` (one agent-side emission surface, two client fidelities).
  See revised §10 B2/B3. Not on the critical path: B0/B1 already deliver value in stock Zed.

### Residual follow-ups (not blockers)
- ~~Confirm `events.jsonl` persists per-event member id + timestamp (Q4 dependency).~~ **Done
  2026-06-02 — present** (`ts` + `agentId` base fields; see Q4 above). No work needed beyond reading
  per-agent session JSONL for rich prose replay.
- Define the exact `session/steer` `target` routing semantics (`"lead"` vs `"<memberId>"`) when the
  named member has already parked or terminated.
- Decide whether `acp.memberText` is a global setting or per-session (overridable via
  `session/set_config_option`).

---

## Key URLs
- <https://agentclientprotocol.com>
- <https://github.com/zed-industries/agent-client-protocol> (`schema/schema.json`, protocol v1; `_meta` convention)
- <https://github.com/agentclientprotocol/claude-agent-acp> (precedent for `_meta`-gated channels)
- [docs/30-acp-compatibility-plan.md](30-acp-compatibility-plan.md) (Stage A — single-agent parity)
- [docs/25-team-orchestration.md](25-team-orchestration.md) (topology catalog)
- [docs/29-v0.7-git-cascade-plan.md](29-v0.7-git-cascade-plan.md) (worktree-per-member)
