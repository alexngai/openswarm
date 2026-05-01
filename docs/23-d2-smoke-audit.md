# D2 Smoke-suite audit — session trajectory coverage

**Audit date:** 2026-05-01
**Auditor:** Stage 2F (v0.2)
**Parity gap:** docs/15-parity-gaps.md row D2

---

## Section 1 — Smoke scripts inventory

| Script | Purpose | When it runs | Offline? |
|---|---|---|---|
| `scripts/smoke.sh` | M0 orchestrator entry-point; delegates to all sub-scripts | Manual + CI (full smoke gate) | `--offline` |
| `scripts/smoke-swarm.sh` | M1 swarm batch runner — orchestrator dispatch, concurrency, SIGINT, output | Manual; referenced by `smoke.sh --all` | `--offline` |
| `scripts/smoke-repl.sh` | M2 REPL lifecycle — slash commands, hooks, plugins, live model flag | Manual; referenced by `smoke.sh --all` | `--offline` |
| `scripts/smoke-swarm-m3a.sh` | M3a coordination — send_message, broadcast, role routing, retry/dead-letter, role allowlist | Manual; referenced by `smoke.sh --all` | `--offline` |
| `scripts/smoke-m3b.sh` | M3b git coordination — branch lock, stale-base, notebook_edit, ask_user, parallel tool batch, preflight fallback | Manual; referenced by `smoke.sh --all` | `--offline` |
| `scripts/smoke-m4a.sh` | M4a NativeEngine — round-trips, tool calls, compactor, routing, budget; delegates to vitest | Manual; referenced by `smoke.sh --all` | `--offline` |
| `scripts/smoke-m4b.sh` | M4b provider breadth — xAI/Google/DashScope transports, plugin lifecycle, auth quirks; delegates to vitest | Manual; referenced by `smoke.sh --all` | `--offline` |
| `scripts/smoke-opentui.sh` | Phase 0 OpenTUI/Solid — bun test suite, CLI --help/doctor, binary build, PTY e2e, live Bun turn | **CI (every push/PR)** via `.github/workflows/ci.yml` | `--offline` |

### CI integration status

Only `smoke-opentui.sh` runs in CI (`.github/workflows/ci.yml`). The remaining 7 scripts are developer-run only. The CI job also runs:
- `npm test` (vitest — unit + integration + PTY e2e)
- `bun test src/ui/repl-solid/` (OpenTUI component tests)
- `tsc --noEmit` (via `npm run build`)

---

## Section 2 — Coverage matrix

| Session trajectory | Engine | Provider | Script | Mode |
|---|---|---|---|---|
| Single-worker text turn (headless) | ScriptedTestEngine | Mock | smoke.sh [1], smoke-repl.sh [O1], smoke-opentui.sh [L1] | offline + live |
| Single-worker text turn (compiled binary) | Compiled binary | Live | smoke-opentui.sh [L2] | live only |
| Multi-task batch (3 tasks) | ScriptedTestEngine → live | Mock → Anthropic | smoke-swarm.sh [O1, L1] | offline + live |
| Multi-task batch (5 tasks, concurrency=2) | ScriptedTestEngine | Mock | smoke-swarm.sh [O2] | offline |
| Multi-task batch (10 tasks, concurrency=5) | NativeEngine | Live | smoke-swarm.sh [L4] | live only |
| SIGINT mid-run | ScriptedTestEngine | Mock | smoke-swarm.sh [O3] | offline |
| Unwriteable output path | ScriptedTestEngine | Mock | smoke-swarm.sh [O4] | offline |
| Slash commands (/help) | ScriptedTestEngine | Mock | smoke-repl.sh [O2] | offline |
| Hook fixture (deny via exit 2) | ScriptedTestEngine | Mock | smoke-repl.sh [O3] | offline |
| Plugin fixture | ScriptedTestEngine | Mock | smoke-repl.sh [O4] | offline |
| send_message round-trip (2 workers) | ScriptedTestEngine → live | Mock → Anthropic | smoke-swarm-m3a.sh [O1, L1] | offline + live |
| Broadcast * (3 workers) | ScriptedTestEngine | Mock | smoke-swarm-m3a.sh [O2] | offline |
| Role broadcast | ScriptedTestEngine | Mock | smoke-swarm-m3a.sh [O3] | offline |
| task_stop by ancestor | ScriptedTestEngine | Mock | smoke-swarm-m3a.sh [O4] | offline |
| Retry policy (fail 2x, succeed) | ScriptedTestEngine | Mock | smoke-swarm-m3a.sh [O5] | offline |
| Dead-letter exhaustion | ScriptedTestEngine | Mock | smoke-swarm-m3a.sh [O6] | offline |
| Role allowlist enforcement | ScriptedTestEngine | Mock | smoke-swarm-m3a.sh [O7] | offline |
| Branch lock contention | In-process | — | smoke-m3b.sh [O1] | offline |
| Stale-base detection | In-process (temp git repo) | — | smoke-m3b.sh [O2] | offline |
| Stale-branch policy kinds | In-process | — | smoke-m3b.sh [O3] | offline |
| notebook_edit round-trip | In-process | — | smoke-m3b.sh [O4] | offline |
| ask_user_question (scripted stdin) | In-process | — | smoke-m3b.sh [O5] | offline |
| Parallel tool batch | In-process | — | smoke-m3b.sh [O6] | offline |
| Token preflight fallback (local-estimate) | NativeEngine | — | smoke-m3b.sh [O7] | offline |
| NativeEngine text round-trip | NativeEngine (vitest) | MockProvider | smoke-m4a.sh → vitest | offline |
| NativeEngine single tool call | NativeEngine (vitest) | MockProvider | smoke-m4a.sh → vitest | offline |
| NativeEngine multi-turn tool calls | NativeEngine (vitest) | MockProvider | smoke-m4a.sh → vitest | offline |
| NativeEngine compaction trigger | NativeEngine (vitest) | MockProvider | smoke-m4a.sh → vitest | offline |
| xAI provider transport | NativeEngine (vitest) | xAI mock | smoke-m4b.sh → vitest | offline |
| Google provider transport | NativeEngine (vitest) | Google mock | smoke-m4b.sh → vitest | offline |
| DashScope provider transport | NativeEngine (vitest) | DashScope mock | smoke-m4b.sh → vitest | offline |
| Plugin lifecycle | In-process (vitest) | — | smoke-m4b.sh → vitest | offline |
| PTY e2e (mount, slash dropdown, /exit, SIGINT) | Compiled binary | — | smoke-opentui.sh [O5] | CI |
| Nested spawn (parent → sub-agent) | NativeEngine | Live | smoke-swarm.sh [L2] | live only |
| Permission gating (read-only mode) | NativeEngine | Live | smoke-swarm.sh [L3] | live only |
| Prompt cache hit | SDK engine | Live | smoke-m3b.sh [L1] | live only |

---

## Section 3 — Gaps

The following session trajectories have no smoke coverage:

| Gap | Severity | Notes |
|---|---|---|
| **Token preflight server path** (`source: "server"`)  | Low | v0.2.Q6 Stage 2F adds `serverCountTokens()` gated on `ANTHROPIC_API_KEY`. No smoke scenario exercises the server path — only the local-estimate fallback is tested (smoke-m3b.sh [O7]). A live test gated behind `ANTHROPIC_API_KEY` would be straightforward to add. |
| **Crash recovery / orphan detection** (`crash_detected` event) | Low | Stage 2B added `crash_detected` lane event. No smoke script verifies orphan-scan-on-startup behavior. Covered by vitest unit tests but not by any smoke trajectory. |
| **Budget enforcement abort** (`budget_exceeded` / `swarm_budget_exceeded`) | Medium | v0.2.Q7 added budget gates. No smoke trajectory exercises a budget-exceeded abort path. Could be added to smoke-m4a.sh as an offline scenario using MockProvider with a very low token ceiling. |
| **Worker lifecycle state machine transitions** (full 8-state path) | Low | smoke-swarm.sh covers spawned → ready → finished implicitly, but the unhappy paths (trust_required, crashed) have no dedicated trajectory. Covered in vitest unit tests. |
| **SDK engine vs NativeEngine cross-comparison** | Medium | All offline smoke tests use ScriptedTestEngine or MockProvider. No smoke trajectory runs the same task through both engines and compares output. (Deferred to mock-parity harness, gap D1.) |
| **OpenAI / non-Anthropic providers in multi-worker swarm** | Low | smoke-m4b.sh exercises provider transports in isolation. No multi-worker swarm trajectory uses xAI or Google as the engine. Live-only gap. |
| **MCP tool execution in a real turn** | Medium | MCP bridge is tested in unit suites. No smoke trajectory drives a live MCP tool call end-to-end. Blocked on TO2 (MCP lifecycle hardening). |
| **Permission-prompt inline flow (headless JSONL)** | Low | Phase 2 Stage 2F added headless approval via JSONL + stdin. The smoke-repl.sh [O3] hook fixture only tests exit-2 deny; no offline scenario exercises the full `permission_required` → approve → continue trajectory. |

---

## Section 4 — Recommendations

| Recommendation | Effort | Action |
|---|---|---|
| **Add `budget_exceeded` offline scenario to smoke-m4a.sh** | XS | Wire `maxBudget: { tokens: 1 }` in a scripted turn; assert `budget_exceeded` event in output. Highest-value gap to close because budget gates are a user-visible v0.2 feature. |
| **Add server-token-preflight scenario to smoke-m3b.sh** (gated on `ANTHROPIC_API_KEY`) | XS | Add an `[L2]`-style scenario: if `ANTHROPIC_API_KEY` is set, call `serverCountTokens` and assert `source="server"`. No-ops in offline mode. Aligns smoke-m3b.sh with v0.2.Q6 A8 implementation. |
| **Promote smoke-opentui.sh to cover inline permission prompt** | S | Add an [O6] scenario that drives a scripted headless turn through a `permission_required` event and simulates `y` on stdin. Would close the headless-approval smoke gap. |
| **Consider promoting smoke-swarm.sh offline to CI** | M | Currently only smoke-opentui.sh runs in CI. Adding the M1/M3a offline suites would catch orchestration regressions on every PR. Requires `npm run build` in CI (already done) + running the shell scripts. Feasible but adds ~30s to CI runtime. |
| **Defer: SDK vs NativeEngine cross-comparison** | L | Belongs in mock-parity harness (D1). Not actionable in isolation. |
| **Defer: MCP end-to-end trajectory** | M | Blocked on TO2 (MCP lifecycle hardening). |

### Actionable items this stage (<0.5d)

The `budget_exceeded` scenario addition is the highest-value XS item. However, smoke-m4a.sh uses vitest as its offline runner rather than direct process invocation, and adding a budget-exceeded vitest test to the engine suite is already within the vitest suite (not smoke-specific). The smoke-m3b.sh server-preflight scenario requires `ANTHROPIC_API_KEY` and is offline-only documentation. Neither rises to the level of requiring a smoke script change in Stage 2F.

**Decision:** Document gaps above, update doc 15 D2 row, defer smoke script changes to a dedicated pass when budget enforcement is exercised end-to-end.
