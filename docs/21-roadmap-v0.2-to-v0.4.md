# Roadmap — v0.2 → v0.3 → v0.4

Companion to [docs/20-v0.1-launch.md](20-v0.1-launch.md). After v0.1 ships, this is the planned order of releases. Three releases, sequenced for compounding value: v0.2 closes documented gaps, v0.3 unblocks the last roadmapped phase, v0.4 makes the vision tagline real.

**Authoring date:** 2026-04-30.
**Status:** v0.2 shipped 2026-04-30 (commits `deaf038..5ba50ff` + Stage 2G — see git log); v0.3 + v0.4 scoped.
**Anchor:** [docs/00-vision.md](00-vision.md) — "One agent is a tool. N coordinated agents is the product."

---

## Sequencing rationale

| Order | Why this first |
|---|---|
| 1. v0.2 (Fork A — cleanup) | Every deferred item from Phases 2/4/5/5.5 + the design-promised-but-unbuilt features (worker state file, budget enforcement, branch-lock audit). Cheap individually; together they take the project from "v0.1 with documented holes" to "v0.2 with no known holes." Strict prereq for confident downstream work. |
| 2. v0.3 (Fork C — OpenAI OAuth) | The one remaining roadmapped phase. Blocked on an external spike (operator-captured Codex SSE trace), so it sits behind v0.2 even though it's narrow scope once unblocked. Slots in cleanly when the spike resolves. |
| 3. v0.4 (Fork B — swarm story) | The biggest ambition: turn `swarm run tasks.jsonl` from a single command into a real product surface. Depends on v0.2's worker state file + budget enforcement to feel polished. Largest scope of the three; postpone until the foundation is clean. |

**Total estimated runway:** 5–8 weeks, depending on how big v0.4 grows and whether the v0.3 spike unblocks promptly.

---

# Release v0.2 — Deferred-items cleanup (Fork A)

**Goal:** Take the project from "v0.1 with documented holes" to "v0.2 with no documented holes." Close the partial gaps, wire the design-promised features, fix the cosmetic warts surfaced by smoke.

**Estimate:** ~1.5 weeks, 6 stages.

## Audit — what's deferred or partial today

Pulled from doc 15 + doc 16 + Phase 5/5.5 design locks + smoke pass:

| ID | Description | Current state | Source of deferral |
|---|---|---|---|
| **#1** | bash-validation never fires in `danger-full-access` (SDK bypassPermissions) | Documented in [src/cli/main.ts:469](src/cli/main.ts) | P2.Q10 + Phase 5 design lock |
| **#2** | Worker state file (`.swarm-harness/workers/<agentId>.json`) | Design promises it ([05-swarm-model.md:109](05-swarm-model.md)); not implemented | docs vs code |
| **#3** | A2 branch-lock audit (claw has 3 modules; we have partial M3a stubs) | Marked ⚠️ in doc 15 | doc 16 timeline — never scheduled |
| **#4** | Standalone binary `SDK vunknown` cosmetic in doctor output | Found by v0.1 smoke pass | smoke report |
| **#5** | Two-prompt UX when validation Warn approved + mode-deny | v0.1 close-out fix accepted as v0.2 polish | code comment in main.ts |
| **#6** | Incremental migration of 70+ untyped `LaneEventType` variants | 3 typed today via TypedLaneEvent; rest are `unknown` | P5.Q9 |
| **#7** | A8 server-side token preflight via Anthropic `count_tokens` | Marked ⚠️ in doc 15 | doc 16 — never scheduled |
| **#8** | D2 session-trajectory smoke suite — audit + formalize | Marked ⚠️ | doc 16 — never scheduled |
| **#9** | T8 spinner polish (transitions to ✔/✘ like claw) | Marked ⚠️ XS | doc 16 — never scheduled |
| **#10** | Real Alt+F bun input test | Skipped with TODO | Phase 4 follow-up — depends on OpenTUI |
| **#11** | Serial-pool the subprocess-spawning test suites | v0.1 close-out shipped a 60s timeout band-aid | code comment in test/integration/swarm.test.ts |
| **#12** | Standalone binary as the swarm-spawner target (currently only Node `dist/cli.js` works) | Implicit limitation | smoke pass observation |
| **#13** | Budget enforcement at the orchestrator (`--max-tokens`, `--max-cost` per task / aggregate) | Design promises it ([05-swarm-model.md:169](05-swarm-model.md)); not implemented | docs vs code |

## Design lock — v0.2

### v0.2.Q1 — `danger-full-access` and bash-validation (#1)

**Decision: drop SDK `bypassPermissions` mapping. Always use SDK `default` mode so canUseTool fires; PermissionEngine returns Allow for everything in danger mode; bash-validation runs and can Block / Warn destructive commands even in danger mode.**

Reverses Phase 2 P2.Q10. The original concern was "user opted into bypass." Counter-argument: users in danger mode still want a sanity check on `rm -rf /etc/passwd`. Bash-validation Block / Warn becomes the safety floor across all modes.

Side effect: in danger-full-access, every tool call goes through canUseTool. For non-bash tools, validation falls through (returns null per bashValidationGate spec). For safe bash, validation Allow → mode Allow → no prompt. For destructive bash, validation Warn → prompt. **Strict UX improvement** — only adds prompts on validation Warn paths.

### v0.2.Q2 — Worker state file (#2)

**Decision: implement per [05-swarm-model.md:109](05-swarm-model.md). Atomic write at `.swarm-harness/workers/<agentId>.json` on every lifecycle transition (post-Phase 5.5a).**

Schema:
```ts
interface WorkerStateFile {
  readonly agentId: string;
  readonly pid: number;
  readonly startedAt: number;
  readonly lifecycleState: WorkerLifecycleState;  // from Phase 5b
  readonly lastTransitionAt: number;
  readonly taskId?: string;
  readonly parentAgentId?: string;
  readonly failureClass?: FailureClass;
  readonly reason?: string;
}
```

Wire `_transitionTo()` to write the file atomically (write to temp + rename). Orchestrator can read these for crash recovery: any worker file with `lifecycleState !== "finished" && !isProcessAlive(pid)` is recoverable.

### v0.2.Q3 — A2 branch-lock audit (#3)

**Decision: audit-then-decide. Read `src/swarm/git/branch-lock.ts` against claw's three modules (`branch_lock.rs`, `stale_base.rs`, `stale_branch.rs`). Score gap. Port what's load-bearing for concurrent worker safety; defer the rest.**

Audit deliverables:
- Function-by-function comparison table (claw vs our impl).
- List of correctness gaps (missing locks, race conditions, broken stale-base detection).
- Estimate for closing the load-bearing subset.

If the audit finds <0.5d of work, ship in v0.2. If >1d, file a v0.3+ ticket and document what we know.

### v0.2.Q4 — Standalone binary `SDK vunknown` (#4)

**Decision: bake the SDK version into the build. Read `node_modules/@anthropic-ai/claude-agent-sdk/package.json` during `tsc` (or as a pre-build step), inject as a constant in `src/auth/status.ts`. No runtime fs read.**

Cosmetic-only fix; user value low but cheap.

**Shipped — already in tree (commit `1b0c6eb`, Phase 0 follow-ups).** `scripts/build-binary.ts` reads the SDK version from package.json and injects it via `Bun.build({ define: { __SWARM_HARNESS_AGENT_SDK_VERSION__: ... } })`. `src/cli/doctor.ts` uses the injected constant with a runtime-fs-walk override for the Node path. The v0.1 smoke pass saw "vunknown" only because the smoke build invoked `bun build --compile` raw instead of going through `scripts/build-binary.ts`. Stage 2D's only deliverable is verifying the right path is documented — done.

### v0.2.Q5 — Two-prompt UX collapse (#5)

**Decision: when validation Warn is approved AND mode would also deny, treat the validation approval as covering the mode-deny prompt for the same tool call.**

Threading: `bashValidationGate` returns `{allow: true, validationApproved: true}` when Warn-then-approved. canUseTool short-circuits the mode-deny prompt when `validationApproved === true`.

Result: one prompt per tool call instead of two. Doesn't subvert the mode model — the user explicitly approved the destructive action.

### v0.2.Q6 — Incremental TypedLaneEvent migration (#6)

**Decision: type 10 more high-traffic variants per release. Not all 70 in one go.**

Priority order (most-emitted first):
1. `text_delta`, `tool_use_start`, `tool_use_input`, `tool_use_end`, `tool_result`, `message_stop` (turn primitives)
2. `task_created`, `task_updated`, `task_completed`, `task_failed`

Other variants tighten when touched. Update doc 5 + Phase 5 design lock to reflect the rolling policy.

### v0.2.Q7 — Budget enforcement (#13)

**Decision: implement per [05-swarm-model.md:169](05-swarm-model.md). New CLI flags `--max-tokens N`, `--max-cost-usd N` on `prompt` and `swarm run`. Aggregate across all turns; per-task in swarm runs. On exceed, emit `budget_exceeded` lane event + abort the worker with a structured failure.**

Cost calculation uses model-pricing tables (lookup by model id). For unknown models, accept token limits only.

### v0.2.Q8 — Out of scope for v0.2

- Tier 3 / Tier 4 / Tier 5 tools (deferred to v0.4 or later)
- Phase 6 OpenAI OAuth (v0.3)
- Real Alt+F bun input test (#10) — blocked on OpenTUI; revisit if upstream lands `onCursorChange` exposure
- Serial-pool subprocess test suites (#11) — band-aid is sufficient until it bites again
- Standalone binary as swarm spawner (#12) — design item; defer until a user requests
- Anthropic API-key path without Agent SDK (P5) — edge case; defer

## Stage breakdown

Six stages, sequenced for independence. Each ends in a shippable state.

### Stage 2A — bash-validation in danger-full-access (v0.2.Q1) · ~0.5d

- Edit `src/engine/claude-agent-sdk.ts`: drop `bypassPermissions` mapping; always use `default`. Drop the `allowDangerouslySkipPermissions` flag.
- Edit `src/permissions/index.ts`: PermissionEngine.check() returns Allow for everything in `danger-full-access` mode (already does this; verify).
- Tests: integration test that exercises bash-validation Block under danger-full-access.
- Update P2.Q10 in doc 17 with a "REVISITED 2026-XX-XX" entry citing this v0.2 reversal and the rationale.

### Stage 2B — Worker state file (v0.2.Q2) · ~0.5d

- New: `src/swarm/worker-state-file.ts` — atomic writer + reader.
- Edit `src/swarm/worker-host.ts` `_transitionTo()`: write the state file after every transition.
- Edit orchestrator: on startup, scan `.swarm-harness/workers/` for orphan files where `pid` is not alive — emit a `crash_detected` lane event.
- Tests: state-file round-trip + orchestrator orphan-detection.

### Stage 2C — A2 branch-lock audit (v0.2.Q3) · ~0.5–1d

- Read `src/swarm/git/*` files. Compare to claw's `runtime/branch_lock.rs`, `stale_base.rs`, `stale_branch.rs`.
- Write `docs/22-a2-branch-lock-audit.md` with the function-by-function gap table.
- Decide port-vs-defer per gap. Implement in-scope items inline.
- Update doc 15 row A2.

### Stage 2D — Bake SDK version into build (v0.2.Q4) · ~0.25d

- Add a build-time codegen step: read SDK package.json → write `src/core/sdk-version.ts` constant.
- Edit `src/auth/status.ts`: import the constant instead of reading at runtime.
- Verify standalone binary doctor reports the real version.

### Stage 2E — Two-prompt collapse + budget enforcement (v0.2.Q5 + v0.2.Q7) · ~1d

- Edit `bashValidationGate` return type: add `validationApproved?: boolean` to the Allow case.
- Edit `canUseTool` in main.ts: when validationApproved, skip the mode-deny prompt.
- New: `src/core/budget.ts` — token + cost accounting + threshold checking.
- Edit `src/cli/argv.ts`: add `--max-tokens`, `--max-cost-usd` flags.
- Edit engine event loop: per-turn budget check; abort + emit `budget_exceeded` on threshold cross.
- Tests: budget enforcement unit + integration coverage.

### Stage 2F — Smaller items (#6, #7, #8, #9) · ~1d

- TypedLaneEvent: add 10 more variants (per v0.2.Q6 priority list).
- A8 token preflight: wire Anthropic `count_tokens` into compaction-trigger heuristic.
- D2 smoke suite audit: read `scripts/smoke-*.sh`, document what's covered, propose CI integration.
- T8 spinner polish: port claw's ✔/✘ transition.

### Stage 2G — Docs + parity-gap updates · ~0.25d

- Mark A2, A8, D2, T8 in doc 15 per audit outcomes.
- Add a v0.2 close-out section to doc 21 (this file) with commit range.
- Tag `v0.2`.

**Acceptance criteria for v0.2:**
- All 13 audit items either shipped, audit-completed, or explicitly re-deferred with rationale.
- Bash-validation fires in all 3 permission modes (verified by integration test).
- Worker state file present in `.swarm-harness/workers/` after a real swarm run; orphan detection works.
- Budget enforcement aborts a run that exceeds `--max-tokens` (verified by smoke).
- All test suites green.

## Definition of done — final state

| Criterion | How it was met |
|---|---|
| All 13 audit items closed | Shipped: #1 (2A), #2 (2B), #4 (2D), #5 (2E), #6 (2F), #7 (2F), #8 (2F), #9 (2F), #13 (2E). Audit-completed: #3 (2C — no code changes needed, 🟦 divergent). Re-deferred with rationale: #10 (blocked on OpenTUI), #11 (band-aid sufficient), #12 (user-driven design item). |
| Bash-validation in all 3 modes | Stage 2A dropped `bypassPermissions`; integration test `bash-validation-danger.test.ts` verifies Block under `danger-full-access`. |
| Worker state file | Stage 2B writes `~/.swarm-harness/workers/<agentId>.json` atomically on every lifecycle transition; orchestrator startup scans for orphans. |
| Budget enforcement | Stage 2E: `--max-tokens` and `--max-cost-usd` flags on `prompt` and `swarm run`; per-turn accounting aborts with exit code 3 and `budget_exceeded` lane event. |
| TypedLaneEvent migration | Stage 2F: 10 more variants typed (13 total). Rolling policy documented in design lock. |
| A8 token preflight | Stage 2F: `serverCountTokens()` in `src/engine/token-preflight.ts`; gracefully falls back to local estimate for OAuth users. |
| D2 smoke suite | Stage 2F: audited in `docs/23-d2-smoke-audit.md`; 8 scripts / 35+ trajectories documented; gaps listed with effort estimates. |
| T8 spinner polish | Stage 2F: `spinner.tsx` transitions to ✔/✘ for `transitionMs` ms; unit tests in `spinner.test.tsx`. |
| Doc 15 updated | Stage 2G: rows A2, A8, D2, T8 flipped ✅; decision-log entry with all 6 stage commits. |
| Test suites green | `tsc --noEmit` clean; `npm test` 1453+ / 0 fail; `bun test src/ui/repl-solid/` 49 / 3 / 0. |
| README updated | Stage 2G: status bumped to v0.2-ready; `--max-tokens` / `--max-cost-usd` flags documented; danger-mode validation + worker state file noted. |

---

# Release v0.3 — Phase 6 Codex App Server FrameworkProvider (Fork C)

**Goal:** Ship ChatGPT Plus / Pro subscription support for swarm-harness users. Closes gap P4.

**Estimate:** ~2.5 days. **No external operator spike required** under the new design (see below).

> **REDESIGNED 2026-04-30:** the original plan targeted the HTTP SSE endpoint at `chatgpt.com/backend-api/codex/responses`. Web research surfaced that the **officially supported integration surface is the Codex App Server (JSON-RPC over stdio), not the private browser-to-backend SSE channel.** v0.3 now pivots to the App Server approach — same end-user feature, lower risk, no SSE spike. Full plan + design lock at [docs/24-phase-6-codex-app-server-plan.md](24-phase-6-codex-app-server-plan.md).
>
> **Supersedes:** [docs/14-m4b-plan.md § Phase 5](14-m4b-plan.md) and [docs/06-open-questions.md Q20](06-open-questions.md).

## Headline

- **Integration target:** spawn the locally-installed `codex` binary as a subprocess and speak JSON-RPC over stdio (officially documented at `developers.openai.com/codex/app-server`).
- **Auth:** delegate entirely to `codex login`. swarm-harness owns zero OAuth code in this mode (deprecates `src/auth/openai-oauth.ts`).
- **Categorization:** `FrameworkProvider`, not `TransportProvider` — the App Server hosts agent threads with their own tool surface; we delegate the loop.
- **CLI:** `--framework codex-chatgpt` flag stays the same; underlying transport changes from "custom HTTP+SSE" → "App Server JSON-RPC". User-facing UX is identical.

## Stage breakdown (rewritten — see doc 24 for full detail)

| Stage | What | Estimate |
|---|---|---|
| **3.0** | Local Codex App Server JSON-RPC spike. Capture handshake + one-turn events to `test/fixtures/codex-app-server/`. | 0.25d |
| **3A** | `CodexAppServerProvider` skeleton — spawn binary, JSON-RPC framing, lifecycle. | 0.5d |
| **3B** | Agent thread + event translation. Map Codex JSON-RPC notifications → `NormalizedEvent` discriminated union. | 0.75d |
| **3C** | CLI + routing wiring. Remove the "blocked" stub at `src/cli/main.ts:388`. Login subcommand redirects to `codex login`. | 0.25d |
| **3D** | Tests + docs. 6+ tests against captured fixtures. Update doc 15 row P4 ✅, README, doc 16, doc 06 Q20, doc 14 § Phase 5 (mark superseded), this section. | 0.5d |
| **3E** | Live smoke + tag. Operator-driven verification. Bump package.json to 0.3.0. Tag v0.3. | 0.25d |

## What changed from the prior plan

| Aspect | Old plan | New plan |
|---|---|---|
| Endpoint | `chatgpt.com/backend-api/codex/responses` (private browser channel, reverse-engineered) | Local `codex` binary subprocess (officially documented integration) |
| Protocol | HTTP + SSE | JSON-RPC 2.0 over stdio |
| Auth | swarm-harness owns OAuth + reverse-engineered client_id | Delegate to `codex login`; we own zero auth code |
| Spike needed? | Yes — operator-captured SSE fixtures (BLOCKED v0.3 entirely) | No — local development verifies the documented JSON-RPC protocol |
| Risk | Browser channel can change without notice; client_id sharing is ungoverned | Officially supported, versioned protocol with public changelog |
| Estimate | 1.5d post-spike (spike was indefinite) | 2.5d total, no external dependency |

**Acceptance criteria for v0.3:** see doc 24 (8 criteria).

**Risks:** see doc 24 § Risks (codex protocol churn, binary install friction, JSON-RPC framing edges).

---

# Release v0.4 — Swarm story (Fork B)

**Goal:** Make "Multi-agent swarm orchestration is the primary product surface" (the doc 0 vision) actually visible to users beyond `swarm run tasks.jsonl`.

**Estimate:** ~2–3 weeks, 4 stages. Largest of the three releases.

## Audit — what's missing for the swarm story to land

| ID | What | Today | What v0.4 ships |
|---|---|---|---|
| Real teams | `team_create`, `team_delete`, persistence, named role overlays | Roles work via `--role` flag and TaskPacket; no team primitive | Tier 3 team tools + `.swarm-harness/teams.json` persistence |
| Budget enforcement at swarm level | Per-task token + cost limits, aggregate cap | Per-prompt only (v0.2 ships single-agent budget) | Aggregate across swarm; declarative in tasks.jsonl |
| Multi-pane swarm watcher | Single subprocess JSONL stream | None — `swarm run` is fire-and-aggregate | New `swarm watch` subcommand: OpenTUI multi-pane lane viewer |
| Mock parity harness | Live API only | Smoke scripts via `--live` | D1 — mock Anthropic service + scripted scenarios for regression coverage |

## Stage breakdown

### Stage 4A — Tier 3 teams · ~4–5d

- New: `src/tools/tier3/team.ts` — `team_create`, `team_delete` tools.
- New: `src/swarm/team-registry.ts` — persistent team store at `.swarm-harness/teams.json`.
- Schema: `{ name, members: AgentId[], roles: { architect: AgentId[], executor: AgentId[], reviewer: AgentId[], critic: AgentId[] } }`.
- Per-role system-prompt overlays + tool allowlists from `.swarm-harness/roles.json` (already partially supported in M3a Phase 6).
- Spawn integration: `task.team` field on `TaskPacket` routes the task to a team; orchestrator picks a role-matching member.
- Tests: team-creation round-trip, role-based dispatch.

### Stage 4B — Swarm-level budget enforcement · ~1–2d

- Builds on v0.2 Stage 2E budget infrastructure.
- New CLI flags on `swarm run`: `--max-tokens-per-task`, `--max-cost-per-task`, `--max-tokens-aggregate`, `--max-cost-aggregate`.
- Per-task: enforce as v0.2 does for prompt mode.
- Aggregate: orchestrator tracks cumulative; on exceed, kills in-flight workers + emits `swarm_budget_exceeded`.
- Tests: per-task abort, aggregate abort, partial-completion result.jsonl.

### Stage 4C — `swarm watch` TUI · ~5–7d

- New CLI subcommand: `swarm-harness swarm watch <results-file-or-stream>` opens an OpenTUI multi-pane viewer.
- Each worker = one pane. Shows lane events streaming, current state (from worker-state-file), token usage, status indicator.
- Pane navigation: arrow keys + tab to focus; Enter to drill into a worker's full event log.
- Built on the existing OpenTUI/Solid substrate (`src/ui/repl-solid/`); reuses the `<scrollbox>` + `<markdown>` primitives.
- Tests: bun-native render assertions for the multi-pane layout.

### Stage 4D — Mock parity harness (D1) · ~3–4d

- New: `test/mock-anthropic-service/` — deterministic mock SSE stream emitter.
- New: `test/parity/scenarios/*.json` — declarative scenarios (start with claw's 10).
- New: `test/parity/runner.ts` — clean-env CLI harness that diffs request capture against expected.
- Wire into CI: regression-protect the JSONL schema across engines.

**Acceptance criteria for v0.4:**
- `swarm-harness team create my-team --architect alice --executor bob` persists; subsequent `swarm run` with `task.team = "my-team"` dispatches by role.
- `swarm run --max-tokens-aggregate 100000 tasks.jsonl` aborts when the cap is exceeded.
- `swarm watch out.jsonl` shows a live multi-pane viewer.
- 10+ scripted parity scenarios pass; regression-fails on JSONL schema breakage.

**Risks:**
- Multi-pane TUI is the largest UI work since Phase 0. OpenTUI may surface limitations we haven't hit yet (focus management, async pane updates).
- Team persistence schema may collide with claw's; coordinate via doc-17-style design lock before implementation.
- Mock parity harness duplicates real-API smoke; manage by tagging scenarios as "mock-only" vs "live-only" with overlap on the critical paths.

---

## Cross-cutting

### Stays deferred indefinitely (per [doc 16:275-282](16-parity-plan.md))

- A3 recovery recipes, A4 policy engine, A6 sandbox, A7 green contract
- PS3 cron scheduler, PS4 `/ultraplan`, PS5 `/teleport`, PS6 deeper `/plan`
- TO3 pdf_extract, TO4 repl tool, TO5 powerShell

These remain usage-driven. Pull forward only if a real user asks.

### Cumulative test posture target

Each release should preserve the green-baseline:

| Suite | v0.1 baseline | v0.2 target | v0.3 target | v0.4 target |
|---|---|---|---|---|
| `tsc --noEmit` | clean | clean | clean | clean |
| `npm test` | 1393 / 0 fail | 1450+ / 0 fail | 1480+ / 0 fail | 1550+ / 0 fail |
| `bun test src/ui/repl-solid/` | 46 / 0 fail | 50+ / 0 fail | 50+ / 0 fail | 70+ / 0 fail (swarm watch tests) |
| Live SDK smoke | 4 categories pass | 5 categories pass (validation in danger mode added) | 6 categories pass (Codex framework) | 7 categories pass (swarm watch + budget + teams) |

### Definition of done per release

1. All planned stages merged on `mvp`.
2. Test posture meets the per-release target above.
3. Acceptance criteria met (manual smoke).
4. Doc 15 updated with shipped items.
5. This doc (21) gets a "shipped" entry per release with commit range.
6. README updated to reflect new surface.
7. CHANGELOG.md entry.
8. Tag + push.

### Sign-off section

Updated as each release ships:

- **v0.2 — released:** 2026-04-30 (commits `deaf038..5ba50ff` + Stage 2G)
- **v0.3 — released:** _(pending — gated on operator SSE spike)_
- **v0.4 — released:** _(pending)_
