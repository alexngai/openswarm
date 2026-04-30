# Phase 5 — Runtime hardening: plan + design lock

Companion to [16-parity-plan.md § Phase 5](16-parity-plan.md). This file is the execution plan + pre-implementation design lock for Phase 5 (gaps TO1, A1, A5 from [15-parity-gaps.md](15-parity-gaps.md)). Written 2026-04-30, post-Phase-4 ship.

**Status:** unstarted.

---

## Goal

Make `--headless` and unattended runs trustworthy enough to use without babysitting. Two sub-phases:

- **5a (TO1)** — Deep bash-command validation. Currently [src/tools/tier0/bash.ts](src/tools/tier0/bash.ts) does zero command-string analysis: it validates JSON shape, then spawns `/bin/bash -c <command>`. Unattended runs are one well-aimed prompt away from `rm -rf /`.
- **5b (A1, A5)** — Worker boot state machine + typed lane-event payloads. The substrate exists ([src/swarm/events.ts](src/swarm/events.ts) defines ~70 `LaneEventType` variants + 20 typed payloads), but `LaneEventPayload = unknown` defeats exhaustive type-checking, and WorkerHost has no explicit lifecycle state.

These are non-cosmetic infrastructure wins: 5a is the foundation for `--headless` trust, 5b is the foundation for telemetry + multi-pane TUI.

---

## Audit: what's already built

| Item | State | Source |
|---|---|---|
| Bash tool (Zod-validated args, spawn /bin/bash) | ✅ | [src/tools/tier0/bash.ts](src/tools/tier0/bash.ts) |
| `requiredPermission: "exec"` gate via PermissionEngine | ✅ | [src/permissions/index.ts](src/permissions/index.ts) |
| Inline approval prompt (Phase 2) | ✅ | [src/permissions/bridge.ts](src/permissions/bridge.ts) + [permission-prompt.tsx](src/ui/repl-solid/permission-prompt.tsx) |
| Headless approval (JSONL `permission_required` + stdin) | ✅ | [src/permissions/headless-prompt.ts](src/permissions/headless-prompt.ts) |
| `LaneEvent` interface with `type`, `payload`, `agentId`, `ts`, `provenance` | ✅ | [src/swarm/events.ts:14-24](src/swarm/events.ts) |
| `LaneEventType` ~70-variant string union | ✅ | [src/swarm/events.ts:26-130](src/swarm/events.ts) |
| ~20 typed payload interfaces (BranchLockAcquired, ProviderRequestSent, ErrorPayload, etc.) | ✅ | [src/swarm/events.ts:142-269](src/swarm/events.ts) |
| WorkerHost emits `lane_event` IPC notifications | ✅ | [src/swarm/worker-host.ts:109-124](src/swarm/worker-host.ts) |
| `FailureClass` enum (transport, provider, permission, tool, timeout, panic) | ✅ | [src/swarm/events.ts:256-262](src/swarm/events.ts) |
| **Bash command-string validation** (read-only / destructive / mode / sed / path / semantics) | ❌ | nothing exists — bash spawns whatever the model emits |
| **Worker lifecycle state enum** (spawning → trust_required → ready_for_prompt → …) | ❌ | WorkerHost lifecycle is implicit; no `WorkerLifecycleState` enum |
| **`LaneEventPayload` discriminated union** (exhaustive type-narrow) | ❌ | `LaneEventPayload = unknown` ([events.ts:136](src/swarm/events.ts)) |
| **Lane-event type-driven exhaustiveness check** | ❌ | no `assertNever` calls anywhere on `LaneEventType` |
| **Typed `worker_lifecycle_changed` event** | ❌ | not emitted today; `worker_spawned`/`worker_ready`/`worker_exited`/`worker_crashed` exist but transitions aren't observable as a state stream |

**Summary:** 5a is net-new (~600 lines of TS). 5b is "tighten what exists" — the events module is already large and well-organized; we add one new variant + 8-state enum + an incremental typing pass.

---

## Design lock — Phase 5 (2026-04-30)

Numbers are Phase-5-local (distinct from Q1–Q18, Phase 2's P2.Q1–10, Phase 3's P3.Q1–6, Phase 4's P4.Q1–8).

### P5.Q1 — Verbatim port of claw's constant tables, or a smaller curated set?

**Decision: port claw's constant tables verbatim.**

- WRITE_COMMANDS, STATE_MODIFYING_COMMANDS, WRITE_REDIRECTIONS, GIT_READ_ONLY_SUBCOMMANDS, DESTRUCTIVE_PATTERNS, ALWAYS_DESTRUCTIVE_COMMANDS, SEMANTIC_READ_ONLY_COMMANDS, NETWORK_COMMANDS, PROCESS_COMMANDS, PACKAGE_COMMANDS — all copied as-is into `src/tools/tier0/bash-validation/constants.ts`.
- ~100 entries total across ~10 tables. Volume is manageable; coverage is the bar.

**Rationale.** Claw's lists are battle-tested. A smaller curated set invites false negatives ("oh we forgot `pkill`"). Maintenance cost on the constants is trivial (text data, no logic).

**Claw reference.** Constant tables at [bash_validation.rs:52, 58, 97, 163, 206, 235, 389, 460, 485, 491](references/claw-code/rust/crates/runtime/src/bash_validation.rs).

**Opencode reference.** Submodule was removed from `references/` after the rename. Opencode is a TUI-first project; their bash tool relies on the SDK's exec sandbox rather than command-string validation. Not a meaningful comparison for 5a.

### P5.Q2 — Where does the validation gate fire?

**Decision: in `canUseTool` (main.ts), after `PermissionEngine.check()` returns Allow, before the PermissionBridge fork.**

Concretely: introduce a thin module-level dispatch inside the canUseTool closure: if `toolName === "bash"`, run `validateBashCommand(input.command, mode)` and route on the result (Allow → proceed; Block → return `{allow:false, reason}`; Warn → forward to PermissionBridge as if mode-deny).

**Rationale.**
- Same gate covers SDK + Native engines (both go through canUseTool).
- Reuses Phase 2's PermissionBridge for Warn → user-confirms (no second UX to invent).
- bashTool.execute stays clean (no mode coupling at the tool layer).
- Future shell-like tools (e.g. `pwsh`) can plug into the same dispatch with one branch.

**Claw reference.** Claw integrates validation at the BashTool's execute entry, not the permission layer ([bash_validation.rs](references/claw-code/rust/crates/runtime/src/bash_validation.rs) is called from `bash.rs`'s execute). We diverge intentionally — our gate is uniform across engines because of the canUseTool callback design.

### P5.Q3 — Allow / Block / Warn — what does Warn do?

**Decision: Warn routes through Phase 2's PermissionBridge as if it were a mode-deny that requires elevation.**

Mapping from validation result to canUseTool return:
- `Allow` → proceed (canUseTool returns `{allow: true}`)
- `Block { reason }` → canUseTool returns `{allow: false, reason}` immediately. SDK gets `tool_result` error; engine continues.
- `Warn { message }` → canUseTool calls `permissionBridge.request(pending)` with `pending.reason = message`. Inline y/N prompt fires (TTY) OR JSONL `permission_required` line + stdin read (headless). Same path Phase 2 wired for mode-deny.

**Rationale.** Phase 2 invented "the user has to confirm something the engine wants to do". Warn is the same concept, different trigger. Reusing the path keeps one approval UX.

**Claw reference.** Claw's bash_validation returns `ValidationResult::Warn` and the prompter ([main.rs:7375-7411](references/claw-code/rust/crates/rusty-claude-cli/src/main.rs)) shows the same y/N prompt. Behavior parity.

### P5.Q4 — Failures surface where: `tool_result` error or typed `LaneEvent`?

**Decision: both.**

- The model sees the error via the SDK's `tool_result` (path: canUseTool returns `{allow:false, reason}` → SDK creates a tool_result error with the reason → next assistant turn gets it).
- The orchestrator sees a typed `LaneEvent` for telemetry / UI status. New event variants:
  - `bash_validation_blocked` (payload: `{ command: string, submodule: string, reason: string }`)
  - `bash_validation_warned` (payload: `{ command: string, submodule: string, message: string, decision: "approved" | "denied" }`)
- Events are emitted from canUseTool's bash branch, before/after the bridge call.

### P5.Q5 — `CommandIntent` classifier even when no submodule consumes it?

**Decision: yes. Implement as part of the `commandSemantics` submodule.**

- 8-variant enum matching claw: `ReadOnly | Write | Destructive | Network | ProcessManagement | PackageManagement | SystemAdmin | Unknown`.
- `commandSemantics` exports `classifyCommand(command: string): CommandIntent`.
- Other submodules can use it (`destructiveCommandWarning` checks `intent === "Destructive"`).
- Telemetry value: every `bash_validation_blocked` / `bash_validation_warned` event carries the intent classification. Useful even if 5a doesn't act on it directly.

**Claw reference.** [bash_validation.rs:30-44](references/claw-code/rust/crates/runtime/src/bash_validation.rs) — same 8 variants. Direct port.

### P5.Q6 — Test corpus

**Decision: both — port ~15 claw test cases + add ~10 swarm-harness-specific integration tests.**

- **Ported claw cases** (one-to-one tests of each submodule): destructive command rejection (`rm -rf /`), path traversal (`../etc/passwd`), in-place sed (`sed -i`), package install in read-only mode (`npm install`), network in read-only (`curl`), git read vs write subcommands. Per-submodule unit tests.
- **swarm-harness integration tests:** canUseTool integration (mode-allow + Warn → bridge → user-decides), headless mode (Warn → JSONL line → stdin EOF = deny), lane event emission verified end-to-end, FailureClass propagation.

### P5.Q7 — WorkerLifecycle state enum membership

**Decision: 8 states, matching doc 16 verbatim.**

```
type WorkerLifecycleState =
  | "spawning"
  | "trust_required"
  | "ready_for_prompt"
  | "prompt_accepted"
  | "running"
  | "blocked"
  | "finished"
  | "failed";
```

`trust_required` is **reserved** — Claude Agent SDK doesn't surface a trust prompt, so this state is never visited in current swarm-harness. Documented in the type's jsdoc as a future-proofing reservation. Honors doc 16's acceptance criterion ("trust_required → failed visible in lane events") without inventing a fake trust UI.

**Claw reference.** Claw's `WorkerStatus` ([worker_boot.rs](references/claw-code/rust/crates/runtime/src/worker_boot.rs)) has more states (e.g. distinct `Spawning`, `TrustRequired`, `ReadyForPrompt`, etc., plus claw-specific ones for git lane orchestration). We adopt the doc-16 subset; the rest are claw-internal concerns.

### P5.Q8 — How is the state surfaced?

**Decision: lane events as the canonical source + a synchronous accessor on WorkerHost for tests + UI.**

- New lane event variant: `worker_lifecycle_changed`, payload `{ from: WorkerLifecycleState, to: WorkerLifecycleState, failureClass?: FailureClass, reason?: string }`. Emitted on every transition.
- `WorkerHost.getLifecycleState(): WorkerLifecycleState` returns the most recently transitioned-to state. Backed by a private field updated atomically with the lane event emission.
- No separate `WorkerLifecycle` class. Logic lives in WorkerHost; the lane events ARE the audit trail.

### P5.Q9 — Tightening `LaneEventPayload` from `unknown`?

**Decision: incremental migration. Start with the new `worker_lifecycle_changed`, `bash_validation_blocked`, `bash_validation_warned` variants — type them strictly. Existing 70+ variants stay `unknown` for now.**

- New variants get a discriminated-union entry in a new `TypedLaneEvent` union (parallel to the existing `LaneEvent` interface).
- `assertNever` exhaustiveness check added in switch statements that branch on `TypedLaneEvent.type`.
- Existing variants keep `LaneEventPayload = unknown` — converting all 70 in one pass is a multi-day diff with no acceptance-criterion benefit.
- Documented as "Phase 5 typed-event migration; older variants will be tightened as they're touched."

### P5.Q10 — Schema versioning?

**Decision: no. Additive-by-convention, per doc 17 Q7.**

- Adding new fields to existing payloads is OK if optional.
- Adding new `LaneEventType` variants is OK; consumers ignore unknown types.
- Renaming or removing variants is forbidden.
- No `schema_version` field added to `LaneEvent`.

### P5.Q11 — Trust prompt — port `WorkerTrustResolution` or skip?

**Decision: skip the enum. Use the lifecycle's `trust_required` state as a reserved placeholder (P5.Q7).**

- Claw's `WorkerTrustResolution` is tightly coupled to claw-CLI's UX for accepting host-machine claude-code trust state. swarm-harness inherits Anthropic auth via the SDK; there's no equivalent UX surface.
- If a future SDK release adds a trust callback, we can revisit and emit a `trust_required` transition then.

### P5.Q12 — When does bash-validation fire in the engine flow?

**Decision: in `canUseTool` (resolved by P5.Q2 above).**

Restating for clarity: validation runs after `PermissionEngine.check` returns Allow, before the PermissionBridge fork. If `toolName === "bash"`, route the input.command through the validator. The validator's result drives canUseTool's return value.

This is the unified gate — both SDK and Native engines see the same protection.

---

## Stage breakdown

Four stages, each independently shippable. Sequenced so 5a (the headless trust win) lands first.

### Stage A — Bash validation: 6 submodules + canUseTool wiring (TO1) · ~1.5–2d

**Files:**
- New module: `src/tools/tier0/bash-validation/` directory:
  - `constants.ts` — ported claw constant tables (~10 arrays)
  - `intent.ts` — `CommandIntent` enum + `classifyCommand(command): CommandIntent`
  - `read-only.ts` — `validateReadOnly(command, mode): ValidationResult`
  - `destructive.ts` — `validateDestructive(command): ValidationResult`
  - `mode.ts` — `validateMode(command, mode): ValidationResult`
  - `sed.ts` — `validateSed(command): ValidationResult`
  - `path.ts` — `validatePath(command, cwd): ValidationResult`
  - `index.ts` — `ValidationResult` discriminated union + top-level `validateBashCommand(command, mode, cwd): { result, submodule }`
- Tests: `src/tools/tier0/bash-validation/*.test.ts` for each submodule + integration test in `src/cli/main.test.ts` for canUseTool wiring.
- Edit: `src/cli/main.ts` — extend the canUseTool closure to dispatch on `toolName === "bash"` after `PermissionEngine.check` returns Allow.
- Edit: `src/swarm/events.ts` — add `bash_validation_blocked` + `bash_validation_warned` to `LaneEventType` + payload interfaces.

**API sketch:**
```ts
// src/tools/tier0/bash-validation/index.ts
export type ValidationResult =
  | { kind: "allow" }
  | { kind: "block"; reason: string; submodule: string }
  | { kind: "warn"; message: string; submodule: string };

export function validateBashCommand(
  command: string,
  mode: PermissionMode,
  cwd: string,
): ValidationResult;
```

**Wiring in main.ts canUseTool:**
```ts
if (toolName === "bash" && modeDecision.allow) {
  const cmd = (input as { command?: string }).command ?? "";
  const v = validateBashCommand(cmd, currentPermissionMode, process.cwd());
  if (v.kind === "block") {
    // emit lane event + return
    return { allow: false, reason: `[${v.submodule}] ${v.reason}` };
  }
  if (v.kind === "warn") {
    // route through PermissionBridge with v.message as reason
    return await permissionBridge.request({
      ...pendingFromMode,
      reason: `[${v.submodule}] ${v.message}`,
    });
  }
  // fall through to normal Allow
}
```

**Acceptance:**
- `swarm-harness --permission-mode read-only --headless "say rm -rf /"` blocks with structured error naming the submodule (`destructive`).
- `--headless` `rm /tmp/foo` (mode workspace-write, path inside cwd) → Warn → JSONL `permission_required` → EOF on stdin → deny.
- TTY mode same case → inline y/N prompt with the submodule + message.
- Per-submodule unit tests covering ~15 ported claw cases.

### Stage B — Worker lifecycle state machine (A1) · ~0.5–1d

**Files:**
- New: `src/swarm/worker-lifecycle.ts` — exports `WorkerLifecycleState` type + transition validation table (which states can transition to which).
- Edit: `src/swarm/worker-host.ts` — add private `_lifecycleState` field, public `getLifecycleState()` accessor, internal `_transitionTo(next, opts?)` method that validates the transition + emits `worker_lifecycle_changed` lane event.
- Edit: `src/swarm/standalone-host.ts` — same pattern for the in-process host.
- Edit: `src/swarm/events.ts` — add `worker_lifecycle_changed` to `LaneEventType` + `WorkerLifecycleChangedPayload` interface.
- Tests: `src/swarm/worker-lifecycle.test.ts` covers transition validation + invalid-transition rejection.

**API sketch:**
```ts
// src/swarm/worker-lifecycle.ts
export type WorkerLifecycleState =
  | "spawning"
  | "trust_required"
  | "ready_for_prompt"
  | "prompt_accepted"
  | "running"
  | "blocked"
  | "finished"
  | "failed";

const TRANSITIONS: Record<WorkerLifecycleState, ReadonlyArray<WorkerLifecycleState>> = {
  spawning: ["trust_required", "ready_for_prompt", "failed"],
  trust_required: ["ready_for_prompt", "failed"],
  ready_for_prompt: ["prompt_accepted", "failed", "finished"],
  prompt_accepted: ["running", "failed"],
  running: ["blocked", "finished", "failed"],
  blocked: ["running", "failed", "finished"],
  finished: [],
  failed: [],
};

export function isValidTransition(
  from: WorkerLifecycleState,
  to: WorkerLifecycleState,
): boolean;

export interface WorkerLifecycleChangedPayload {
  readonly from: WorkerLifecycleState;
  readonly to: WorkerLifecycleState;
  readonly failureClass?: FailureClass;
  readonly reason?: string;
}
```

**Acceptance:**
- Invalid transitions throw at the call site (asserts at dev time, no-op in production with a warning lane event).
- WorkerHost.getLifecycleState() returns the latest state.
- `worker_lifecycle_changed` lane events fire on every transition; visible in `--headless` JSONL.

### Stage C — Typed lane events (A5, incremental) · ~0.5–1d

**Files:**
- Edit: `src/swarm/events.ts` — introduce `TypedLaneEvent` discriminated union for the 3 new variants:
  - `{ type: "bash_validation_blocked", payload: BashValidationBlockedPayload }`
  - `{ type: "bash_validation_warned", payload: BashValidationWarnedPayload }`
  - `{ type: "worker_lifecycle_changed", payload: WorkerLifecycleChangedPayload }`
- Add a `narrowLaneEvent(event: LaneEvent): TypedLaneEvent | undefined` helper that returns the typed shape if the event matches one of the new variants, else undefined.
- Add `assertNever` exhaustive checks in any switch statement that branches on `TypedLaneEvent.type` (likely zero callers in v0; wire one in a smoke test to prove the compile-error story works).
- Documentation: header comment in events.ts explaining the incremental migration policy.

**Acceptance:**
- Adding a new `TypedLaneEvent` variant without updating the smoke-test switch is a compile error (proves the exhaustiveness gate works — doc 16 acceptance criterion).
- Existing 70+ variants compile without changes.

### Stage D — Documentation + parity-gap updates · ~0.25d

- Mark TO1, A1, A5 as ✅ in [docs/15-parity-gaps.md](docs/15-parity-gaps.md) with stage citations.
- Add an "Implementation note" block in [docs/16-parity-plan.md § Phase 5](16-parity-plan.md) pointing at this doc.
- Update this doc's status from "unstarted" to "shipped" with the commit range.
- (Optional) Update README's "Not in M0" or status section if relevant — likely not, since 5a/5b are infrastructure not user-visible features. Defer per Q17.

---

## Acceptance criteria (Phase 5 as a whole)

From [docs/16-parity-plan.md:240-244](16-parity-plan.md):

1. ✅ `swarm-harness --headless` with a destructive prompt blocks at the validation layer with a structured error naming the rejecting submodule. (Stage A)
2. ✅ A worker that fails during the trust-prompt path surfaces `trust_required → failed` in the lane event stream. (Stage B + C — note: `trust_required` is reserved per P5.Q11; the test exercises a synthetic transition rather than an actual SDK trust failure.)
3. ✅ Adding a new `LaneEvent` variant to the typed union without updating its consumers is a compile error. (Stage C)

---

## Estimate

**~3 days** total. Within doc 16's 3–5d range, biased toward the lower end because Stage B/C build on the existing events.ts substrate.

| Stage | Estimate |
|---|---|
| A — bash validation + canUseTool wiring | 1.5–2d |
| B — worker lifecycle state machine | 0.5–1d |
| C — typed lane events (incremental) | 0.5–1d |
| D — docs + parity-gap updates | 0.25d |

---

## Risks

- **Constant-table maintenance.** Ported claw constants drift from upstream over time. Mitigation: comment each constant table with its claw source line so future syncs are mechanical.
- **Lane event taxonomy bloat.** Adding 3 new variants pushes us past 70. Mitigation: explicit "Phase 5 — runtime hardening" subsection header in events.ts so the boundary is visible. No structural refactor.
- **canUseTool growing into a god-function.** Already ~40 lines after Phase 2; Stage A adds ~15 more for the bash dispatch. Mitigation: extract `validateBashCanUseTool(input, mode, cwd, bridge): Promise<PermissionDecision>` if it grows past 30 lines, but inline first.
- **Warn UX collision with mode-deny prompt.** Both end up in the same y/N inline prompt, indistinguishable. Mitigation: prefix the `reason` field with `[${submodule}]` so the user sees "[destructive] rm -rf /tmp/* will…" instead of a bare reason.
- **`trust_required` reserved-but-untestable.** No real SDK callsite means we can only smoke-test it via a synthetic transition. Acceptable for v0; flag as v0.2 follow-up if the SDK ever surfaces a trust callback.

---

## Out of scope (defer to v0.2 or later)

- **Full claw `lane_events.rs` port.** That file is 2509 lines including business logic for roadmap/ship/blocker tracking. Phase 5 only adds 3 new typed variants; the rest is claw-specific orchestration we don't need.
- **`WorkerRegistry` + `Worker` struct port.** swarm-harness already has `WorkerHost` + `Orchestrator`. Adding claw's parallel registry would be redundant.
- **Big-bang migration of all 70+ existing `LaneEventType` variants to typed payloads.** Incremental per P5.Q9.
- **`pdf_extract`, `repl`, `powerShell` tools (TO3, TO4, TO5).** Tier 3 / windows; deferred elsewhere.
- **MCP lifecycle hardening (TO2).** Separate gap with its own scope; not in Phase 5.
- **A2 branch lock detection refinements.** Has its own M3a/M3b plan trail.
- **Sandbox abstraction (A6).** Platform-specific; deferred indefinitely.

---

## Definition of done

1. All four stages merged and passing CI.
2. `npm test` (vitest) and `bun test` (Solid TUI) both green.
3. Phase 5 acceptance criteria met (manual smoke: `--headless --permission-mode read-only` with `rm -rf /` returns structured block error; new lane events visible in JSONL).
4. Doc 15 (parity gaps) updated to mark TO1, A1, A5 as ✅.
5. Doc 19 (this file) gets a "shipped" status header at the top with the commit hash range.
