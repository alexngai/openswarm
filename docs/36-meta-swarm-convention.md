# The `_meta.swarm` convention (v1) — rich multi-agent rendering over ACP

**Status:** open convention, v1. Stable; evolves via the `v` field.
**Audience:** authors of [Agent Client Protocol](https://agentclientprotocol.com) (ACP) clients who
want to render multi-agent ("swarm" / team) sessions richly — per-member lanes, a task board,
mid-turn steering. Also the agent-side contract for anyone emitting it.

This is **not** an ACP spec amendment. ACP's `_meta` field is *reserved for exactly this* —
implementations attaching additional metadata without protocol changes
([Extensibility](https://agentclientprotocol.com/protocol/extensibility)). `_meta.swarm` is a
documented, versioned convention layered on top: a swarm-aware client re-expands it; a stock client
ignores it and renders the session collapsed. One agent-side emission surface, two client fidelities.

> Why a convention rather than a standard? We control a reference agent and a reference client, so
> interop with us needs no committee. Publishing the schema lets a *third-party* client adopt it
> without coordinating with us. The `v` field is the hedge: if a concrete partner ever wants it
> formalized, the version lets it evolve or migrate cleanly. (Decision: docs/31 Q5.)

---

## 0. The hard invariant (read this first)

**Stripping every `_meta` from a session MUST leave a valid, trust-coherent single-agent session.**
Enrichment is *additive*; the standard fields beside it always carry a coherent baseline. Concretely:

- Member identity for any `request_permission` is ALSO in the **standard** `toolCall.title`
  (e.g. `"[architect] edit src/auth.ts"`), never in `_meta` alone — a vanilla client must show the
  human *which member* they are authorizing. `_meta`-only identity would be a trust regression.
- Every member tool call is a standard `tool_call` with a correct `title` / `kind` / `locations` /
  `diff`. Plan entries render from standard `content` / `priority` / `status`.

A conforming agent is testable against this: strip all `_meta`, assert the result is a coherent
baseline session whose trust-relevant meaning is unchanged.

---

## 1. The schema

```typescript
/** Attached as `_meta.swarm` on the structures in §2. Stripping it must leave a
 *  valid single-agent session (§0). */
interface SwarmMeta {
  /** Schema version. v1 today; consumers should ignore unknown future fields. */
  v: 1;
  /** The member this update / permission / voice belongs to. Absent ⇒ the
   *  orchestrator/team itself (e.g. a board-only `plan` update). */
  member?: {
    id: string;        // stable member id within the team
    name: string;      // human label, e.g. "architect"
    role?: string;     // "lead" | "worker" | …
    worktree?: string; // absolute worktree path, if git-cascade is active
    stream?: string;   // git-cascade stream id, if any
  };
  /** Team/task context for board rendering + dependency edges. */
  task?: {
    id: string;
    parentId?: string;
    dependsOn?: string[];
    topology?: string; // active topology, e.g. "coordinator"
  };
}
```

Unknown fields and unknown `v` values: ignore gracefully (forward-compatible).

---

## 2. Where it rides

| Carrier (standard ACP) | `_meta.swarm` placement | A rich client uses it to… |
|---|---|---|
| `session/update` — `agent_message_chunk` | `update._meta.swarm.member` | lane the member's voice |
| `session/update` — `tool_call` / `tool_call_update` | `update._meta.swarm.member` | group the tool call under its member's lane |
| `session/update` — `plan` entries | `entry._meta.swarm` (per entry) | link board rows to members + draw `dependsOn` edges |
| `session/prompt` → `request_permission` | `toolCall._meta.swarm.member` | laned / grouped approvals (identity ALSO in `title`, §0) |

A `plan` update itself carries no top-level `member` (it's a board update); the per-entry `_meta`
provides member linkage.

---

## 3. Capability negotiation

- **Agent → client (`initialize` response):** a swarm-aware agent advertises
  `agentCapabilities._meta = { swarm: { v: 1 } }`. A rich client detects this to enable lane
  rendering; a stock client ignores the key.
- **Client → agent (`initialize` request):** a rich client MAY send
  `clientCapabilities._meta = { swarm: { memberText: "interleave" } }` to opt into streamed,
  speaker-labeled member text. Default is `"collapse"` — only the lead narrates; member work is
  visible as attributed `tool_call`s. (`_meta` itself is ignore-safe, so this only governs the
  baseline *text* stream; a rich client lanes by `_meta.swarm.member` regardless.)

---

## 4. Steering — the `swarm/steer` ext method

ACP has no native "inject mid-turn", so steering is a custom **ext method** (domain-prefixed per ACP
guidance; `Agent.extMethod`):

```jsonc
// client -> agent
"swarm/steer": { "message": "focus on the auth module first", "target": "lead" }
// -> { "delivered": true, "to": "role:lead" }
```

- `target` (optional): `"lead"` (default), a role name, `"*"` (broadcast), or a member id.
- Delivery is **cooperative**: the message lands in the member's inbox and is seen on its next
  inbox check — mid-turn, no turn boundary. It is not a forcible interruption.
- A stock client never calls it (unknown method, harmless) and steers via `session/cancel` +
  re-`prompt` instead.

---

## 5. Client rendering model (informative)

A minimal rich client folds the `session/update` stream into:

- **Lanes**, keyed by `_meta.swarm.member.id` (absent ⇒ an orchestrator lane). Each lane accumulates
  the member's text, its tool calls (keyed by `toolCallId`, mutated in place by `tool_call_update`),
  and its role/name for the header.
- **A task board** from `plan` entries, each linked to a member via `entry._meta.swarm.member`.

Stripping `_meta` collapses every update into a single lane — exactly the baseline view. So the same
stream drives both fidelities with no agent-side branching.

---

## 6. Versioning & compatibility

- `v: 1` is current. Additive fields may appear within v1; consumers ignore unknown keys.
- A breaking shape change bumps `v`. A client should treat an unrecognized `v` as "no swarm meta"
  (degrade to baseline) rather than error.
- Trust-relevant meaning never moves into `_meta` across versions (§0 is permanent).

---

## 7. Reference implementation

- Agent emission: `src/acp/swarm-meta.ts` (builder + attach), `src/acp/lane-translator.ts`,
  `src/acp/team-permission.ts`, `src/acp/capabilities.ts`, `src/acp/team-agent.ts` (`extMethod`).
- Client rendering: `src/acp/rich-view.ts` (renderer), `src/acp/rich-format.ts`,
  `src/acp/rich-client.ts`, `scripts/acp-rich-client.ts` (reference client).
- Design + rationale: [docs/31](31-teams-acp-design.md) (§4 schema, §7 steering, Q3/Q5),
  [docs/archive/34](archive/34-acp-b1-meta-swarm-plan.md) (B1), [docs/archive/35](archive/35-acp-b2-rich-client-plan.md) (B2).
