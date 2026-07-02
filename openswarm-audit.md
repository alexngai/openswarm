# OpenSwarm Harness — Repo-Wide Audit

**Date:** Wednesday, Jul 1, 2026 · **Branch:** hive-aware · **Package version:** 0.3.5 · **Audit scope:** Read-only repo/code audit; this markdown document records the findings.

## Table of Contents

- [0a. Verification & Delta Pass (Jul 1, 2026 — PM)](#0a-verification--delta-pass-jul-1-2026--pm)
- [0. Follow-Up Consolidation (Jul 1, 2026)](#0-follow-up-consolidation-jul-1-2026)
- [1. Executive Summary & Cross-Cutting Findings](#1-executive-summary--cross-cutting-findings)
- [2. Orchestration Core](#2-orchestration-core)
  - [Overview](#overview)
  - [Dead Code](#dead-code)
  - [Experimental / Unstable](#experimental--unstable)
  - [Fragmentation & Tech Debt](#fragmentation--tech-debt)
  - [Stability Assessment](#stability-assessment)
  - [Top 5 Concerns](#top-5-concerns)
- [3. Engine / Providers / Auth](#3-engine--providers--auth)
  - [Overview](#overview-1)
  - [Dead Code](#dead-code-1)
  - [Experimental / Unstable](#experimental--unstable-1)
  - [Fragmentation & Tech Debt](#fragmentation--tech-debt-1)
  - [Stability Assessment](#stability-assessment-1)
  - [Top 5 Concerns](#top-5-concerns-1)
- [4. Interface / Protocol](#4-interface--protocol)
  - [Overview](#overview-2)
  - [Dead Code](#dead-code-2)
  - [Experimental / Unstable](#experimental--unstable-2)
  - [Fragmentation & Tech Debt](#fragmentation--tech-debt-2)
  - [Stability Assessment](#stability-assessment-2)
  - [Top 5 Concerns](#top-5-concerns-2)
- [5. Capabilities & Repo Hygiene](#5-capabilities--repo-hygiene)
  - [Overview](#overview-3)
  - [Dead Code](#dead-code-3)
  - [Experimental / Unstable](#experimental--unstable-3)
  - [Fragmentation & Tech Debt](#fragmentation--tech-debt-3)
  - [Repo Hygiene / Cruft](#repo-hygiene--cruft)
  - [Stability Assessment](#stability-assessment-3)
  - [Top 5 Concerns](#top-5-concerns-3)
- [Recommended Priorities](#recommended-priorities)
- [Methodology](#methodology)

---

## 0a. Verification & Delta Pass (Jul 1, 2026 — PM)

A second multi-agent pass (4 read-only lanes at HEAD `3922efa` "Hard cut OpenSwarm namespace", branch `hive-aware`) re-verified 54 claims from the earlier sections of this document and swept for new findings, with special attention to the `eval/` directory (recent TAC/FixIt commits postdate the earlier pass) and residue from the `swarm-coder → openswarm` rename. A full `npx vitest run` was executed as a stability baseline.

### Test baseline (new evidence)

**284 test files passed, 7 skipped (291); 3,324 tests passed, 20 skipped (3,344); duration 100s; exit 0.** The suite is green at HEAD. Known noise: `WorkerPool: warning — token released more than once (no-op)` and Node experimental-SQLite warnings.

### Verification outcome

Nearly all previously documented claims **remain accurate at HEAD** — the two audits are consistent. Corrections and refinements found by the verification lanes:

- **Spawn-resolver degradation is no longer silent** (refines §2 Top Concern 5): `peer-team.ts:535-547` now emits a diagnostic `team_note` when `spawn-resolver` is selected below `danger-full-access`. The functional gap remains — under the daemon default `workspace-write` (`team-daemon.ts:272,277`) resolution still degrades to escalate — but operators do get a signal.
- **Phase-5 REPL panels are wired at runtime, not test-only** (refines §4 Top Concern 5): Ctrl+A/T view switching and the agent/task views are live in `src/ui/repl-solid/app.tsx:252-263,324-340`. What's missing is (a) host injection for `/tasks` (`main.ts:346-359` still omits it) and (b) any keybind-level E2E coverage (`e2e.test.tsx:652-656` admits the limitation).
- **"Three NormalizedEvent pipelines" is closer to two-and-a-half** (refines §4): single-agent and team ACP share one emitter (`normalized-translate.ts`, fed by `translator.ts:31-39` and `lane-translator.ts:24`); `ui/headless.ts` is a JSONL passthrough rather than a real translator. The REPL `translateEngineEvent` (`app.tsx:436-531`) remains the genuinely divergent second pipeline.
- **CI is materially stronger than §5 implied**: `.github/workflows/ci.yml:40-59` runs `npm run build`, full `npm test` (vitest incl. integration with PTY), `bun test src/ui/repl-solid/`, and `smoke-opentui.sh --offline` — not just the one smoke script. The unmaintained-milestone-smoke-scripts point stands (14 scripts, 1 in CI).
- **Docs index has improved**: `docs/README.md` now links 33 of 57 docs (was ~22); the "docs 11–29 not yet listed" note at `docs/README.md:21-22` persists.
- All other spot-checked claims (goal engine dead, `getStateDB` dead, merge-queue never selected, daemon `members: []`, routed-but-unauthable providers, dual codex architectures, `AuthSource.headers()` never called, `request_permissions`/`tool_search` broken-at-runtime, ContextBuilder unwired, memory lifecycle half-wired, no-sandbox plugins, dual lockfiles, empty `.gitmodules`) — **VERIFIED unchanged**.

### New finding 1 — eval harness is broken by the harness-API rename (highest-priority delta)

**Confidence: High.** `package.json:76` declares `swarmkit-eval: ^0.0.6`, but `node_modules/swarmkit-eval` is a symlink to `../swarmkit/src/eval` at **0.0.7**, whose exports were renamed `swarmHarness* → openSwarm*` (`openSwarm`, `openSwarmSpec`, `openSwarmParse`). Four eval files still import the old names and fail at module load:

- `eval/experiments/fixit.ts:39`, `eval/experiments/h1-single-vs-team.ts:25`, `eval/harness/local.ts:14`, `eval/harness/swarm-coordinator-adapter.ts:15` (+ stale `eval/README.md:31-32`).
- Still runnable: `eval/experiments/smoke.ts` (MockAdapter), the TAC stack (`tac.ts`, `tac-pool.ts`, `tac-arms.ts` — no harness imports), and MAST post-hoc analysis (`mast-analysis.ts`, `compare-traces.ts`).
- **CI cannot catch this**: `eval/` is outside `tsconfig.build.json` and no workflow step typechecks or runs it. This confirms and sharpens follow-up finding #9 in §0 — the breakage is an export rename, not a version-range technicality.
- Also noted: operator-specific defaults hardcoded in eval (`fixit.ts:103` AWS region, `tac.ts:60` `~/GitHub/TheAgentCompany`, `tac-pool.ts:17` user path); `eval/harness/swarm-modes.ts:10-12` self-describes as unvalidated.

### New finding 2 — rename residue is concentrated in smoke scripts and legacy env prefixes

**Confidence: High.** Production `src/` is clean of `swarm-coder`/`SWARM_CODER` strings. The functional residue:

- **Broken (set but never read):** milestone smoke scripts set `SWARM_CODER_TEST_SCRIPT`, `SWARM_CODER_PLUGINS_DIR`, `SWARM_CODER_CONFIG_DIR`, `SWARM_CODER_SKIP_LIVE`, `SWARM_CODER_SKIP_INTEGRATION_BUILD` (e.g. `scripts/smoke-repl.sh:62,129`, `scripts/smoke-opentui.sh:47,93`) while code reads only `OPENSWARM_*` equivalents (`src/engine/test-engine.ts:60`, `src/cli/runtime.ts:152`, `src/hooks/config.ts:110`). Even the CI-active `smoke-opentui.sh` sets a dead skip var (CI's own env block uses the correct `OPENSWARM_*` names, so CI behaves; local runs of the scripts don't).
- **Legacy-but-functional `SWARM_*` prefixes:** `SWARM_MEMORY_PROVIDERS` (`src/memory/lifecycle.ts:43,60`), `SWARM_WEB_SEARCH_BASE_URL` (`src/tools/tier1/web_search.ts:124,306`), `SWARM_MAP_SERVER` (`src/cli/argv.ts:1234-1235`), `SWARM_ACP_LIVE` (`src/acp/e2e.test.ts:11,282`).
- **Legacy `.swarm/` path prefixes:** session recorder dir (`src/swarm/session-recorder.ts:7,34`), OpenTasks socket search (`src/swarm/adapters/opentasks-client.ts:56-62`), stale-base marker (`src/swarm/git/stale-base.ts:6,61`).
- **Stale doc env var:** `docs/26-team-orchestration-spikes.md:37,74` documents `SWARM_CODER_ALLOW_PEER_TASK_STOP`; code reads `OPENSWARM_ALLOW_PEER_TASK_STOP` (`src/tools/tier2/task_stop.ts:45`).

### Other new findings by lane

**Orchestration core** (`src/swarm`, `src/core`, `src/state`, `src/session`):

- Daemon `send_prompt` ad-hoc spawns copy role/policies from `spec.members[0]` but drop `framework`, `model`, and `longLived` (`team-daemon.ts:536-542`) — compounds the TeamSession framework-forwarding gap.
- Duplicate `GoalStatus` enums with no bridge: `src/core/goal.ts:17-23` vs `src/state/index.ts:45-51`; the whole `getStateDB`/`setStateDB`/`resetStateDB` singleton API is production-dead (`src/state/index.ts:707-725`).
- Untested production modules: `src/swarm/adapters/opentasks-client.ts` (JSON-RPC client used from `cli/swarm.ts:24`, only exercised via mocks) and `src/swarm/session-checkpointer.ts` (integration test soft-skips when the sessionlog adapter is absent). ~17 swarm sources lack co-located tests (mostly types/barrels/recovery one-liners).
- Reserved lane-event shapes never emitted (`src/swarm/events.ts:455-483`); daemon `team_event` subscribe still deferred, clients tail `events.jsonl` (`team-daemon-protocol.ts:16-21`).
- Test ratios healthy: ~73 source / ~72 test files across the scope.

**Engine/providers/auth:**

- A **fourth** error classifier exists: `classifyCodexHttpError` (`src/providers/codex-responses/errors.ts:28`), on top of the two `classifyProviderError` variants.
- **Grok asymmetric auth gate:** `detectAuth` accepts `XAI_API_KEY` (`status.ts:64-67`) but engine construction throws for grok models since `XaiApiKeyAuth` is never wired — users pass the CLI gate then fail downstream.
- Coverage gaps: `AzureTransportProvider` has zero tests; `litellm-transport.test.ts` covers only env helpers, not `create()`/`stream()`; `hardened-native.test.ts` has no `RunConfig.host` threading test (native.test.ts does).
- Worker `auto` always builds non-hardened `NativeEngine` (`worker-entry.ts:87-88,521-525`); workers get retry/eager only via `OPENSWARM_FRAMEWORK=hardened-native`, never from CLI flags.
- Stale milestone strings in user-facing CLI errors ("M4a"/"scheduled for M4b", `runtime.ts:352-354`).

**Interface/protocol:**

- `--ecosystem` stderr claims adapters "land in v0.5+" (`argv.ts:732`) while `swarm run` already supports them — adapter flags are parsed globally (`argv.ts:304-314`) but attached only to the `swarm-run` result (`:1024-1028`).
- More stale headers: `src/swarm/topologies/index.ts:9-10` ("committee/critic-loop land later in 4E" — both exported), `src/cli/team.test.ts:11` ("stub functions" — real impls at `team.ts:475-560`), `src/ui/repl/state.ts:2-5` ("ink REPL"), `repl-solid/index.ts:8-9` ("Node → Ink" fallback that no longer exists).
- Untested CLI shims: no `src/cli/host.test.ts` (signal handling untested), no `src/cli/acp.test.ts`; `main.test.ts` has no topology/team-send/host subcommand cases.

**Capabilities/hygiene:**

- Beyond `redactSecrets`, the entire `secrets.ts` API (`detectSecrets`/`containsSecrets`) and the `Guardian` class are production-dead.
- No TODO/FIXME markers at all in `src/tools`, `src/memory`, `src/hooks`, `src/plugins`, `eval/` — drift lives in stale prose headers, not TODO comments.
- This audit file itself is the only untracked file at repo root.

### Updated priorities (delta over §0/§"Recommended Priorities")

1. **Fix the eval import rename now** (`swarmHarness* → openSwarm*` in 4 files + `eval/README.md`) and add an `eval/` typecheck step to CI — cheapest high-value fix; everything H1/FixIt is dead until then.
2. **Sweep rename residue:** fix or delete the `SWARM_CODER_*` env vars in smoke scripts (they silently no-op today), decide whether legacy `SWARM_*` prefixes and `.swarm/` paths get aliased or renamed, fix `docs/26` env var.
3. **Close the grok/gemini/dashscope auth asymmetry** — either wire `authFactory` for those routes (classes already exist) or remove them from routing and `detectAuth`.
4. Prior priorities stand: topology parser vs implemented topologies, team framework forwarding (now including daemon `send_prompt` field drops), memory lifecycle wiring, registered-but-broken tools, engine-selection consistency (worker `auto` hardened gap).

### Methodology (this pass)

Four parallel read-only explore subagents (orchestration core; engine/providers/auth; interface/protocol; capabilities/eval/hygiene), each given the prior claims to verify with file:line evidence plus a fresh sweep mandate. One full `npx vitest run` for baseline evidence. No files modified except this document.

---

## 0. Follow-Up Consolidation (Jul 1, 2026)

This section adds the latest multi-agent review pass to the existing audit without replacing the subsystem detail below. Four lanes reviewed the runtime map, architecture fragmentation, test/stability evidence, and dead/experimental code paths. One fast explorer role failed because its configured model deployment was unavailable; it was replaced by an analyst lane. The final source check found no tracked worktree changes before writing this document.

### Updated Overall Read

OpenSwarm is not in a broken or abandoned state. The core harness has a real runtime shape, broad tests, and mature pieces around `swarm`, `tools`, `engine`, `providers`, `acp`, and `cli`. The dominant current risk is fragmentation from additive milestone work: the same concepts now exist across multiple runtimes, transports, daemon modes, protocol projections, and docs.

The highest-risk areas are not raw missing implementation. They are mismatches between:

- advertised product surface and parser/runtime access,
- team/topology capabilities and adapter flag wiring,
- engine/framework choices at top level vs spawned workers,
- protocol comments and daemon behavior,
- validation scripts and the test code they are supposed to exercise,
- eval harness imports and the installed `swarmkit-eval` API.

### Ranked Follow-Up Findings

1. **Topology surface is inconsistent: implemented but CLI-dead paths.**  
   **Confidence:** High.  
   **Evidence:** README advertises six topologies, including `committee` and `critic-loop` (`README.md:151-162`). `TopologyKind` and `Orchestrator.pickTopology()` support all six (`src/swarm/team-spec.ts:110-125`, `src/swarm/orchestrator.ts:292-306`). `CommitteeTopology` and `CriticLoopTopology` have concrete implementations (`src/swarm/topologies/committee.ts:32`, `src/swarm/topologies/critic-loop.ts:28`). But the CLI parser still marks them as deferred and rejects them before `runTopology()` (`src/cli/argv.ts:209-217`, `src/cli/argv.ts:1175-1179`), with tests encoding the rejection (`src/cli/team.test.ts:131-145`).  
   **Inference:** These topologies are reachable programmatically or via openteams extension mapping, but dead from the advertised direct `openswarm topology` CLI surface.

2. **Team/topology adapter flags are fragmented.**  
   **Confidence:** High.  
   **Evidence:** README shows `openswarm topology peer-team --spec ./team.yaml --git-cascade --agent-inbox --map ...` (`README.md:170-177`). The parser tracks `--opentasks`, `--agent-inbox`, `--git-cascade`, and `--cleanup-worktrees` for `swarm-run` (`src/cli/argv.ts:120-133`, `src/cli/argv.ts:1024-1028`), and `runSwarm()` builds a custom `StandaloneHost` for those adapters (`src/cli/swarm.ts:197-245`). The `topology` parsed result and `runTopology()` options carry only map/model/trace/budget fields (`src/cli/argv.ts:151-165`, `src/cli/main.ts:452-464`, `src/cli/team.ts:168-189`).  
   **Inference:** Worktree isolation, persistent inbox, and opentasks mirroring are wired for `swarm run`, but not for the direct topology/team path where the docs suggest they work.

3. **Engine/tool/swarm boundaries leak through `RunConfig.host`.**  
   **Confidence:** High.  
   **Evidence:** `AgentEngine` imports `SwarmHost` and `RunConfig` has an optional `host` specifically because native engines bypass SDK wrappers and otherwise Tier 2 team tools fail with `requires SwarmHost` (`src/engine/index.ts:38-40`, `src/engine/index.ts:171-180`). Both `NativeEngine` and `HardenedNativeEngine` manually inject `config.host` into tool dispatch contexts (`src/engine/native.ts:370-400`, `src/engine/hardened-native.ts:386-421`, `src/engine/hardened-native.ts:681-708`). The H1 experiment doc records the exact prior failure mode for GPT teams (`docs/47-h1-experimental-findings.md:40`).  
   **Inference:** The generic engine/tool contract now carries swarm orchestration semantics. This is pragmatic, but it is a fragile boundary and explains prior team-spawn regressions.

4. **Team member framework support is narrower than top-level framework support.**  
   **Confidence:** High.  
   **Evidence:** Top-level `FrameworkChoice` includes `native`, `hardened-native`, `claude-agent-sdk`, `codex-chatgpt`, `codex-native`, and `auto` (`src/cli/argv.ts:29`). `MemberSpec`, `SpawnRequest`, and spawn IPC only allow `claude-agent-sdk | codex-chatgpt` (`src/swarm/team-spec.ts:44-45`, `src/swarm/host.ts:213-220`, `src/swarm/ipc/protocol.ts:345-355`). `TeamSession.spawnMember()` forwards `model`, `longLived`, `cwd`, and `sessionSidecarPath`, but not `spec.framework` (`src/swarm/team-session.ts:101-112`).  
   **Inference:** Mixed-engine teams are partially modeled but not consistently executable. In-process `codex-native` is a top-level CLI path, not a team-member framework path.

5. **Runtime assembly is duplicated across prompt runtime and worker runtime.**  
   **Confidence:** Medium-high.  
   **Evidence:** `buildAgentRuntime()` loads hooks, plugins, skills, MCP, tier0/tier1 tools, aliases, auth, and engine factories (`src/cli/runtime.ts:96-417`). `worker-entry.ts` separately builds dispatcher/tools/auth/engine from env and registers tier0+tier2 tools (`src/cli/worker-entry.ts:451-529`).  
   **Inference:** Workers and top-level prompt runs can drift in provider behavior, tool availability, hook behavior, and framework support. Some divergence is intentional, but the current split is broad enough to be a maintenance risk.

6. **Detached team daemon protocol overstates behavior.**  
   **Confidence:** Medium-high.  
   **Evidence:** `send_prompt.target` documents entry/broadcast/agent routing (`src/swarm/team-daemon-protocol.ts:134-153`) and `stop` documents graceful drain via 4D drain frame (`src/swarm/team-daemon-protocol.ts:162-166`). Implementation notes that stop closes sockets while in-flight workers continue and real drain is future work (`src/swarm/team-daemon.ts:218-223`). Production daemon construction hardcodes `workspace-write` and `concurrency: 1` (`src/swarm/team-daemon.ts:262-282`). `send_prompt` spawns an ad-hoc member from `spec.members[0]` and returns a delivery count through that path (`src/swarm/team-daemon.ts:484-505`).  
   **Inference:** Operators can get successful-looking daemon responses without the routing/drain guarantees implied by the protocol comments.

7. **Codex support has two product surfaces with different semantics.**  
   **Confidence:** Medium.  
   **Evidence:** `codex-chatgpt` delegates to the Codex App Server subprocess (`src/engine/codex-framework.ts:1-8`, `src/providers/codex-app-server.ts:73-98`). `codex-native` uses `CodexResponsesTransportProvider` through `HardenedNativeEngine` (`src/cli/runtime.ts:300-331`, `src/providers/codex-responses/index.ts:1-17`). Dynamic tools require experimental App Server capabilities (`src/providers/codex-app-server.ts:313-320`, `src/providers/codex-app-server-types.ts:59-65`), while the Responses path sends `OpenAI-Beta: responses=experimental` to the ChatGPT backend (`src/providers/codex-responses/headers.ts:16-27`). Codex peers expose only a subset of Tier 2 tools (`src/tools/codex-peer-tools.ts:1-9`, `src/tools/codex-peer-tools.ts:20-29`).  
   **Inference:** This is useful experimentation, but it increases routing, auth, tool-surface, resume, and retry drift. The repo needs an explicit product stance on whether both paths are durable.

8. **Validation harness has concrete stale env vars and paths.**  
   **Confidence:** High.  
   **Evidence:** Integration global setup respects `OPENSWARM_SKIP_INTEGRATION_BUILD` (`test/integration/global-setup.ts:15-23`), but several smoke scripts set `SWARM_CODER_SKIP_INTEGRATION_BUILD` (`scripts/smoke.sh:82-85`, `scripts/smoke-m4a.sh:97`, `scripts/smoke-m4b.sh:91`). Bun live tests check `OPENSWARM_SKIP_LIVE` (`src/ui/repl-solid/cli-bun.test.ts:25-29`), while `scripts/smoke-opentui.sh` sets `SWARM_CODER_SKIP_LIVE` (`scripts/smoke-opentui.sh:47`). `scripts/smoke-m4b.sh` runs `src/auth/openai-oauth.test.ts`, but current tests use `openai-codex-oauth*.test.ts` names (`scripts/smoke-m4b.sh:131-137`).  
   **Inference:** Local smoke runs can perform unexpected live calls, repeat builds the setup meant to skip, or fail on dead paths. CI may still be healthier than the milestone scripts.

9. **Eval harness is broken against the installed `swarmkit-eval`.**  
   **Confidence:** High for this workspace.  
   **Evidence:** `package.json` declares `swarmkit-eval: ^0.0.6` (`package.json:70`), while `npm ls swarmkit-eval --depth=0` reports local `swarmkit-eval@0.0.7` invalid against that range. Eval files import `swarmHarness`, `swarmHarnessSpec`, and `swarmHarnessParse` from `swarmkit-eval` (`eval/experiments/h1-single-vs-team.ts:18-30`, `eval/harness/swarm-coordinator-adapter.ts:14-22`). The dead/experimental review lane ran `bunx tsc -p eval/tsconfig.json --noEmit` and it failed on missing exports.  
   **Inference:** Current eval experiments are not type-safe/runnable in this workspace without pinning a compatible `swarmkit-eval` API or migrating the imports.

10. **TeamSession still exposes placeholder lifecycle surfaces.**  
    **Confidence:** Medium.  
    **Evidence:** `TeamSession.spawnMember()` records member state as `"running"` with a comment that full lifecycle states are future work (`src/swarm/team-session.ts:130-136`). `events()` immediately returns with no yielded events (`src/swarm/team-session.ts:192`), and tests encode that placeholder behavior (`src/swarm/team-session.test.ts:484`).  
    **Inference:** Most topology paths rely on host lane events instead, so blast radius is bounded, but direct TeamSession consumers get incomplete status/event signals.

### Validation Notes From Follow-Up

- Main audit actions remained read-only; this document update is the only intended file change.
- `git status --short` before writing this update showed no tracked changes and `openswarm-audit.md` as untracked.
- One reviewer ran validation despite the read-only brief:
  - `npm run build`: passed.
  - `npx vitest run src/swarm/team-daemon.test.ts src/providers/codex-app-server-dynamic-tools.test.ts src/cli/team.test.ts`: passed, 64 tests.
  - `bunx tsc -p eval/tsconfig.json --noEmit`: failed on missing `swarmkit-eval` exports.

### Priority Adjustments From Follow-Up

1. **Fix externally visible mismatches first:** topology parser vs implemented topologies, README YAML/adapter examples vs actual JSON-only/topology options, and daemon protocol comments vs behavior.
2. **Decide team framework semantics:** either wire `MemberSpec.framework` through `TeamSession`/IPC/worker for the intended framework set, or narrow the schema/docs to what is actually supported.
3. **Unify runtime assembly seams:** factor shared tool/auth/provider setup where possible, and document intentional differences between top-level runs and workers.
4. **Stabilize smoke/eval harnesses:** rename env vars consistently, fix dead smoke test paths, and pin or migrate `swarmkit-eval` imports.
5. **Choose a Codex product stance:** document which of `codex-chatgpt` and `codex-native` is primary for users, teams, and future hardening.

---

## 1. Executive Summary & Cross-Cutting Findings

**Overall state:** The harness is production-capable along a narrow "happy path" (Claude Agent SDK / OpenAI-API-key single-agent + team CLI, with ~1:1 test ratios in core dirs), but carries a large half-integrated periphery from successive parity pushes (macro-agent, hardened-engine, codex-native, ACP teams, memory). The dominant pattern across all four areas: modules are built, unit-tested, and registered, but never wired into a runtime call path. Dead code here isn't rot — it's stranded ambition.

### Cross-cutting theme #1 — "Registered but unreachable" (highest-value cleanup target)

- **Tools exposed to the model that silently fail:** `request_permissions` (no handler) and `tool_search` (empty registry) are advertised to the LLM but always error/return empty.
- **Providers routed but unauthable:** grok/gemini/qwen/kimi are in `routing.ts` but `buildAuthForProvider`/`buildWorkerProviderAuth` only wire OpenAI + litellm/azure; `GoogleApiKeyAuth`/`XaiApiKeyAuth` are test-only.
- **Landing strategy registered but never selected:** `QueueToBranchStrategy` exists; peer-team hardcodes merge-to-parent; `drainMergeQueue()` has no caller.
- **Memory lifecycle never fires:** `onAfterTurn`/`onSessionEnd`/`onCompaction` have zero production callers, so the archive store `memory_search` queries is always empty.

### Cross-cutting theme #2 — Competing/duplicated implementations (fragmentation)

- Two error classifiers (`providers/error-classifier.ts` vs `engine/retry-policy.ts`) and two same-named `retry-policy.ts` (swarm vs engine) with different semantics.
- Three quirk systems (`openai-quirks` / unused `quirks.ts` / per-transport inline).
- Three `NormalizedEvent` translation pipelines (headless JSONL / ACP / repl-solid reducer) with no shared module.
- Three permission surfaces (`PermissionBridge` / `AcpPermissionBridge` / `AcpPermissionRouter`), and the production gate ignores `ExecPolicy`/`ApprovalPolicy` entirely.
- Two goal models (`core/goal.ts` engine vs `state/index.ts` SQLite table) with no bridge.
- Two memory-surfacing designs (`enrichTurnInputs` live vs `ContextBuilder` fully disconnected).
- Dual Codex ChatGPT architectures (subprocess `CodexFrameworkEngine` vs in-process `CodexResponsesTransportProvider`).

### Cross-cutting theme #3 — Monoliths concentrating risk

- `swarm/standalone-host.ts` (1791 LOC) — owns IPC, inbox, git, conflicts, tasks, merge queue.
- `swarm/adapters/git-cascade-branch-policy.ts` (1280 LOC).
- `cli/argv.ts` (1305 LOC) — all flag parsing/dispatch in one switch, with stale inline docs contradicting shipped behavior.
- `native.ts` vs `hardened-native.ts` — ~800 lines of parallel turn loops; `--framework auto` picks the "reference/test-baseline" `NativeEngine`, while codex-native explicitly uses `HardenedNative` — inconsistent production behavior.

### Cross-cutting theme #4 — Silent degradation (stability landmines)

- `spawn-resolver` silently no-ops unless `danger-full-access`, but the team daemon defaults to `workspace-write` → operators get escalate-not-resolve with no clear signal.
- Worker vs CLI divergence: workers lack the codex-native branch and silently fall back to Claude SDK for native+Claude-model combos (CLI errors instead).
- ACP defaults to team coordinator (`TEAM_DEFAULT=true`) — vanilla ACP clients get orchestrator infra unless they pass `--single`.
- Interactive REPL is Bun-only with 2 skipped `<markdown>` streaming tests → the assistant render path is fragile/unverified in CI.

### Documentation drift (pervasive, low-severity but corrosive)

Many stale headers actively mislead: "stubbed until 5E.4", "Stage 4C only supports fanout", "askUser Phase 0 stubs throw", "14-command registry" (actually 13) — all contradict shipped code. Repo hygiene: dual lockfiles (npm + bun, CI uses npm), empty tracked `.gitmodules` (CI still does `submodules: recursive`), ~25 unindexed docs, 12+ milestone smoke scripts of which CI runs only one.

---

## 2. Orchestration Core

### Overview

The orchestration core is a mature topology-pluggable shell (Orchestrator → 6 topologies) with solid IPC/worker-pool foundations and heavy unit-test coverage (~63 source / ~62 test files under `src/swarm/`). Production entrypoints are wired: `cli/swarm.ts` → legacy `Orchestrator.run()`, `cli/team.ts` / `acp/team-runner.ts` → `runTeam()`, `cli/team-daemon-entry.ts` → `TeamDaemon`. Macro-agent parity (docs/44) left half-integrated subsystems: merge-queue landing, goal persistence, stale-branch policy, and daemon observability. God files (`standalone-host.ts` 1791 LOC, `git-cascade-branch-policy.ts` 1280 LOC) concentrate coupling and regression risk.

### Dead Code

- `src/core/goal.ts:1` — entire Goals engine (`Goal`, `GoalRegistry`, `getGoalRegistry`) has zero imports outside `src/core/goal.test.ts`; parallel `GoalRecord` CRUD lives in `src/state/index.ts:321` instead.
- `src/state/index.ts:707` — `getStateDB()` singleton exported but never called from production `src/` (only `state/state.test.ts`, `memory/state-store.test.ts` construct `StateDB` directly).
- `src/swarm/git/stale-branch.ts:1` — not imported by any `src/` orchestration code; only `scripts/smoke-m3b.sh:152` + `stale-branch.test.ts` reference it (fanout uses stale-base at `fanout.ts:27`, not stale-branch).
- `src/swarm/topologies/peer-team.ts:476` — always selects `DEFAULT_LANDING_STRATEGY` ("merge-to-parent"); `QueueToBranchStrategy` registered at `landing/index.ts:27` but never chosen (no `MemberSpec` landing field in `team-spec.ts:32`).
- `src/swarm/standalone-host.ts:528` — `drainMergeQueue()` defined but no caller in `src/swarm/topologies/` or CLI; integrator drain loop absent despite `roles.ts:172` integrator role.
- `src/swarm/landing/queue-to-branch.ts:13` — `land()` can enqueue via `enqueueMerge`, but unreachable in production because peer-team hardcodes merge-to-parent (`peer-team.ts:476`).
- `src/swarm/standalone-host.ts:1226` — `inbox()` is an empty async generator (`return; // M3b+`); live path uses `drainInbox` + `sub_agent_event` instead.
- `src/swarm/standalone-host.ts:216` — orphan-worker scan disabled at construction; `scanForOrphanWorkers()` only opt-in via `src/host/boot.ts:135`.
- `src/swarm/ipc/protocol.ts:46` — `sub_agent_result` notification typed but no handler/emission anywhere in `src/swarm/` (M1 future stub).
- `src/swarm/team-daemon.ts:419` — status RPC always returns `members: []` with comment deferring wiring to 5E.5 despite 5F shipping `send_prompt`.
- `src/swarm/host.ts:164` — stale JSDoc claims `askUser` "Phase 0 stubs throw"; implemented at `standalone-host.ts:1278` and `worker-host.ts:473`.
- `src/swarm/orchestrator.ts:200` — stale comment "Stage 4C only supports fanout"; `pickTopology()` dispatches all 6 kinds at `orchestrator.ts:292`.

### Experimental / Unstable

- `src/swarm/events.ts:549` — **Med:** TODO(phase-5-future): add Zod parse for typed lane events; payloads cast with `as` at `:555`.
- `src/swarm/team-spec.ts:44` — **Med:** `framework` field marked "deferred; placeholder" on `MemberSpec`.
- `src/swarm/team-daemon.ts:6` — **Med:** file header still says RPC handlers "stubbed with UNKNOWN_METHOD until 5E.4"; stop/kill/send_prompt implemented at `:426`/`:441`/`:459`.
- `src/swarm/recovery/index.ts:28` — **Med:** spawn-resolver "inert until topology injects ConflictContext.spawnResolver"; degrades to escalate without injection.
- `src/swarm/topologies/peer-team.ts:535` — **High:** spawn-resolver silently ineffective when `permissionMode !== "danger-full-access"`; team daemon defaults "workspace-write" at `team-daemon.ts:272`.
- `src/swarm/recovery/resolver-spawner.live.test.ts:26` — **High:** real LLM resolver tests gated on `OPENSWARM_LIVE_RESOLVER=1` + `describe.skipIf(!LIVE)`.
- `src/swarm/session-recorder.ts:26` — **Low:** session recording opt-in via `OPENSWARM_RECORD_SESSIONS=1` or `OPENSWARM_SESSION_DIR`.
- `src/swarm/depth-limit.ts:4` — **Low:** recursion cap override via `OPENSWARM_MAX_DEPTH` env.
- `src/swarm/inbox.ts:15` — **Low:** stale comment "6A.2 will add AgentInboxBackend" though adapter ships at `adapters/agent-inbox-backend.ts:67` and CLI `--agent-inbox` at `cli/swarm.ts:223`.

### Fragmentation & Tech Debt

- `src/swarm/standalone-host.ts:1` (1791 LOC) vs `src/swarm/worker-host.ts:1` (537 LOC) — God file: spawn, IPC routing, inbox, git-cascade delegation, conflict coordination, permission escalation, merge queue all in `StandaloneHost`.
- `src/swarm/adapters/git-cascade-branch-policy.ts:1` (1280 LOC) — branch policy, merge, queue, integrator streams, conflict retain/finalize in one adapter; competes conceptually with raw git paths in fanout.
- `src/core/goal.ts:56` vs `src/state/index.ts:53` — dual goal models: in-memory state machine + SQLite goals table with no bridge; `Goal.toRecord()` never consumed.
- `src/swarm/retry-policy.ts:20` vs `src/engine/retry-policy.ts:10` — same module name, different semantics (task escalation vs provider stream retry).
- `src/session/store.ts:1` vs `src/swarm/session-recorder.ts:1` + `session-checkpointer.ts:1` — parallel session persistence: SDK JSONL vs worker events.jsonl + sessionlog checkpointing.
- `src/swarm/topologies/fanout.ts:68` — explicit "copy of legacy Orchestrator.run() body" after 4C refactor; legacy `Orchestrator.run()` still active at `orchestrator.ts:167`, called from `cli/swarm.ts:267`.
- `src/swarm/recovery/spawn-resolver.ts:25` vs `resolver-spawner.ts:1` — strategy/coordinator split with confusing naming; wired only in `peer-team.ts:506`.
- `src/swarm/inbox.ts:99` vs `adapters/agent-inbox-backend.ts:67` — pluggable inbox backends; default in-memory, library backend CLI-opt-in only.
- `src/swarm/task-registry.ts:1` vs `adapters/opentasks-task-registry.ts:49` — `TaskAPI` with optional OpenTasks mirror (`cli/swarm.ts:217`).
- `src/swarm/orchestrator.ts:107` vs `topologies/coordinator.ts:184` — competing persistent semantics: orchestrator comment says "only PeerTeamTopology honors persistent"; coordinator also skips `dispose()` when `ctx.persistent` but daemon `send_prompt` rejects non-peer topologies at `team-daemon.ts:526`.

### Stability Assessment

- `src/swarm/` (top-level IPC/pool/orchestrator/fanout/pipeline) — **stable:** well-tested dispatch, SIGINT handling, worker lifecycle; legacy `run(tasks)` path still primary for swarm run.
- `src/swarm/topologies/` — **mixed:** fanout/pipeline/coordinator reasonably tested; peer-team fragile/in-flux (726 LOC, merge+recovery+cascade, 1313-line test file).
- `src/swarm/adapters/` + `landing/` + `recovery/` — **in-flux:** git-cascade surface large; queue-to-branch/recovery partially wired; spawn-resolver permission-sensitive.
- `src/swarm/team-daemon.ts` — **fragile:** lifecycle/RPC work but incomplete observability (`members: []`), hardcoded `concurrency: 1`, persistent limited to peer-team for ad-hoc prompts.
- `src/core/` — **stable types/budget, orphaned goal engine:** `types.ts` heavily imported; `budget.ts` used by CLI; `goal.ts` test-only.
- `src/session/` — **stable:** thin SDK wrapper, 2 test files for 1 source file.
- `src/state/` — **stable module, fragile integration:** 734 LOC SQLite + migrations tested, but `getStateDB()` unused outside tests; consumed only via injected `StateDB` in memory layer.
- `src/hooks/` — **stable:** wired through `cli/runtime.ts:42` and `engine/claude-agent-sdk.ts:44`; 1:1 test ratio including trust/hash verification.

### Top 5 Concerns

1. **Merge-queue landing half-shipped** — `QueueToBranchStrategy` registered (`landing/index.ts:27`) but peer-team always picks merge-to-parent (`peer-team.ts:476`); `drainMergeQueue` has no topology caller (`standalone-host.ts:528`); docs/43 marks integrator drain ❌.
2. **StandaloneHost monolith (1791 LOC)** — single class owns IPC, inbox, git, conflicts, tasks; high regression surface with uneven colocated test coverage vs. line count (`standalone-host.test.ts` 1241 LOC but many code paths).
3. **Goals engine disconnected from orchestration** — `core/goal.ts` fully implemented/tested but never imported by runtime; `state/index.ts:321` persists goals separately with no engine integration.
4. **stale-branch unwired from spawn path** — module exists with 16 tests but fanout only runs `stale-base.check` (`fanout.ts:159`); branch-freshness policy intents never applied during orchestration.
5. **spawn-resolver silent degradation + daemon defaults** — resolver requires `danger-full-access` (`peer-team.ts:537`) but production daemon uses `workspace-write` (`team-daemon.ts:272`); operators get escalate-not-resolve without clear failure unless they read `team_note` events.

---

## 3. Engine / Providers / Auth

### Overview

The layer defines a stable `AgentEngine` boundary (`src/engine/index.ts:49-89`) with four production engine implementations plus a test-only fifth: `ClaudeAgentSdkEngine`, `NativeEngine`, `HardenedNativeEngine`, `CodexFrameworkEngine`, and `ScriptedTestEngine`. Engine selection is env/CLI-fixed via `OPENSWARM_FRAMEWORK` (workers) and `--framework` (single-agent CLI in `src/cli/argv.ts:29`); the agent tool's framework param was removed (`src/tools/tier2/agent.ts:16-21`). Maturity is bifurcated: Claude SDK + OpenAI-api-key native paths are wired end-to-end with strong test coverage; codex-native (in-process ChatGPT subscription via `CodexResponsesTransportProvider`) is CLI-only and actively developed; codex-chatgpt (subprocess App Server) works for teams but lacks resume; several routed AI-SDK providers (grok/gemini/qwen/kimi) are registered in routing but fail at auth assembly in production entrypoints.

### Dead Code

- `src/providers/retrying-provider.ts:30` — `RetryingProvider` is exported and tested but never imported outside its own test file; `HardenedNativeEngine` implements retry inline instead (`src/engine/hardened-native.ts:50-55`).
- `src/providers/quirks.ts:29` — `resolveQuirks` / `applyQuirks` are only referenced from `quirks.test.ts`; no transport imports them (DashScope inlines the same Kimi quirk at `src/providers/dashscope-transport.ts:53-57`).
- `src/auth/google-api-key.ts:7` / `src/auth/xai-api-key.ts:7` — `GoogleApiKeyAuth` / `XaiApiKeyAuth` exist and have unit tests but are never constructed in `runtime.ts` or `worker-entry.ts` (only in `*.test.ts`).
- `src/providers/routing.ts:81-115` — grok/gemini/qwen/kimi routes are registered but unreachable from CLI/worker because `buildAuthForProvider` (`src/cli/runtime.ts:58-60`) and `buildWorkerProviderAuth` (`src/cli/worker-entry.ts:62-72`) only wire OpenAI (`gpt|o[134]`) plus routing's authFactory (litellm/azure).
- `src/cli/worker-entry.ts:466-529` — codex-native framework branch is absent; only handled in `src/cli/runtime.ts:300-331`, so swarm workers cannot use the in-process codex provider path.
- `src/tools/framework-filter.ts:23-29` — `filterToolsForFramework` is a documented no-op kept "for future framework-specific filtering" after v0.4 stage 4G.
- `src/providers/index.ts:59-60` — `FrameworkProvider` interface is commented as "future M4b" but never defined; Codex App Server bypasses the Provider interface entirely via `CodexFrameworkEngine`.
- `src/engine/claude-agent-sdk.ts:34-38` — `LEGACY_MCP_PREFIX` and `MCP_PREFIX` are identical strings; the legacy branch is unreachable dead code.
- `src/auth/index.ts:56-68` — `InteractiveAuth` interface is only implemented by `OpenAICodexAuth`; the commented `AnthropicOAuthAuth` (`src/auth/index.ts:75`) was never implemented.
- `src/index.ts:54` — public library surface exports only `ClaudeAgentSdkEngine`; `NativeEngine`, `HardenedNativeEngine`, `CodexFrameworkEngine`, and all transports are CLI-internal.

### Experimental / Unstable

- `src/engine/native.ts:262-265` — **Med:** reasoning-delta events silently dropped with `TODO(M4b): extend NormalizedEvent with reasoning_delta`; same drop in `src/engine/hardened-native.ts:339-340`.
- `src/engine/codex-framework.ts:241-249` — **Med:** resume explicitly rejected ("resume is not supported in codex-framework mode"); engine enters terminal dead state on any error (`src/engine/codex-framework.ts:196-197, 286-288`).
- `src/engine/codex-framework.ts:73-82` — **Med:** hardcoded `CODEX_CHATGPT_DEFAULT_MODEL = "gpt-5.5"` with comment that plan-dependent backend rejects gpt-5.4 and -codex variants.
- `src/cli/runtime.ts:300-331` — **Med:** codex-native path is new/in-flux; defaults non-gpt models to "gpt-5.5", uses experimental websocket transport option (`src/cli/argv.ts:73`); live tests gated on `CODEX_LIVE=1` (`src/providers/codex-responses/index.live.test.ts:21`).
- `src/auth/openai-codex-oauth.ts:37` — **Med:** full OAuth stack (PKCE, device flow, JWT parsing, token store, TLS preflight) is openswarm-owned and plan-sensitive; most stable when using existing codex login tokens.
- `src/providers/codex-responses/index.ts:44` — **Med:** hits undocumented ChatGPT backend endpoint `https://chatgpt.com/backend-api/codex/responses`; capabilities hardcoded at `src/providers/codex-responses/index.ts:78-88`.
- `src/providers/dashscope-transport.ts:56-57` — **Low:** Kimi `is_error` strip marked "Phase 6 will centralize this quirk; for now it's inlined here."
- `src/swarm/team-spec.ts:44-45` — **Low:** `framework` on members is `"claude-agent-sdk" | "codex-chatgpt"` only — no codex-native / hardened-native, limiting mixed-engine team configs.
- `src/cli/worker-entry.ts:500-512` — **Low:** hardened-native/native with a Claude model silently falls back to `ClaudeAgentSdkEngine` instead of erroring (unlike CLI `runtime.ts:340-356`).

### Fragmentation & Tech Debt

- `src/engine/native.ts:1-526` vs `src/engine/hardened-native.ts:1-852` — ~800-line parallel turn loops; comment at `hardened-native.ts:9-10` says `NativeEngine` is "reference/test baseline" but `--framework auto` still builds `NativeEngine` for non-Claude models (`src/cli/runtime.ts:377-393`), while codex-native uses `HardenedNative` (`src/cli/runtime.ts:317-329`).
- `src/providers/error-classifier.ts:42` vs `src/engine/retry-policy.ts:40` — two different `classifyProviderError` implementations; AI-SDK transports use the rich classifier; `HardenedNative` + dead `RetryingProvider` use the simpler engine-level one.
- `src/providers/openai-quirks.ts:18-32` vs `src/providers/quirks.ts:29-53` vs inline normalizers — three competing quirk systems (`openai-quirks`, unused `quirks.ts`, per-transport inline logic in `xai-transport.ts:57-71`, `dashscope-transport.ts:58-71`).
- `src/providers/openai-transport.ts:85-88` vs `src/auth/openai-env.ts:19-22` — `AuthSource` stored but OpenAI SDK reads `OPENAI_API_KEY` from env directly via `openai(modelId)`; same pattern in `google-transport.ts:87`, `xai-transport.ts:115`, `dashscope-transport.ts:117` — `headers()` on `AuthSource` is often unused at wire time.
- `src/cli/runtime.ts:58-61` vs `src/providers/routing.ts:21-122` — routing knows 8+ provider prefixes; auth assembly knows two (OpenAI regex + routing authFactory for litellm/azure only).
- `src/auth/status.ts:34-101` vs provider-specific keys — `detectAuth` checks `XAI_API_KEY`, `LITELLM_API_KEY`, `AZURE_OPENAI_API_KEY` (`src/auth/status.ts:64-67`) but not `GOOGLE_GENERATIVE_AI_API_KEY` or `DASHSCOPE_API_KEY`, so Gemini/DashScope-only users fail the CLI auth gate even before routing.
- `src/engine/index.ts:11-27` vs actual wiring — module docs still describe "swapping engines is transparent" and list M4b future providers, but `CodexAppServerProvider` is not a Provider (`src/providers/codex-app-server.ts:1-13`) and competes with `CodexResponsesTransportProvider` for ChatGPT subscription use cases.
- `src/engine/index.ts:119-121` vs `src/engine/native.ts:119` — `capabilities.compaction: false` means "outer code does not drive compaction," not "no compaction"; misleading for capability consumers.
- `src/cli/runtime.ts:466-529` vs `src/cli/worker-entry.ts:466-529` — duplicated engine-selection logic with different branches (worker lacks codex-native; different retry/eager defaults via env in worker only).

### Stability Assessment

| Path | Status | Evidence |
|------|--------|----------|
| Claude Agent SDK (ClaudeAgentSdkEngine) | stable | Default `--framework auto` + claude models; extensive integration tests (`src/engine/claude-agent-sdk.test.ts`); token preflight wired (`src/engine/claude-agent-sdk.ts:443-444`). |
| OpenAI API key (OpenAITransportProvider + NativeEngine via auto) | stable | Routed at `routing.ts:68-78`; auth wired in `runtime.ts:59`; 20+ transport unit tests. |
| OpenAI API key hardened (`--framework hardened-native`) | stable | 56+ unit tests + integration suite; worker gets retry via env (`worker-entry.ts:90-99`). |
| LiteLLM gateway (`litellm/*`, `gateway/*`, `bedrock/*`, `azure/*`) | fragile | Routed with authFactory (`routing.ts:25-36`); generic capabilities (`litellm-transport.ts:33-42`); no end-to-end CLI integration test found. |
| Azure OpenAI direct (`azureoai/*`) | fragile | Implemented (`azure-transport.ts`) and routed (`routing.ts:42-53`) but no dedicated `azure-transport.test.ts`. |
| xAI Grok (XaiTransportProvider) | fragile | Transport + tests exist; production auth never wired (`runtime.ts:60`, `worker-entry.ts:72`). |
| Google Gemini (GoogleTransportProvider) | fragile | Same auth gap; additionally absent from `detectAuth` (`status.ts:64-67`). |
| DashScope qwen/kimi (DashScopeTransportProvider) | fragile | Routed + preflight + tests; no authFactory, no detectAuth key, no runtime auth wiring. |
| codex-chatgpt (CodexFrameworkEngine + App Server subprocess) | fragile | Team/worker wired (`worker-entry.ts:481-491`); no resume (`codex-framework.ts:246`); depends on external codex binary; dead-after-error semantics. |
| codex-native (CodexResponsesTransportProvider + HardenedNativeEngine) | in-flux | CLI-only (`runtime.ts:300-331`); live e2e gated (`test/integration/codex-native.e2e.test.ts`); websocket/auto transport experimental (`codex-responses/index.ts:47-48`). |
| ScriptedTestEngine | stable (test infra) | Used across integration tests via `OPENSWARM_TEST_SCRIPT` (`src/engine/test-engine.ts:60`). |
| RetryingProvider wrapper | dead | Test-only (`retrying-provider.test.ts`); not composed into any runtime path. |

**Test coverage snapshot** (colocated `*.test.ts`): engine 13/28 files, providers 24/51 files (gap: `azure-transport.ts`), auth 14/29 files; live codex tests require `CODEX_LIVE=1`.

### Top 5 Concerns

1. **Routed-but-unwired providers (grok/gemini/qwen/kimi)** — `routing.ts:81-115` registers four provider factories, but `buildAuthForProvider` (`runtime.ts:58-60`) and `buildWorkerProviderAuth` (`worker-entry.ts:69-72`) throw for all non-OpenAI models without authFactory; `GoogleApiKeyAuth`/`XaiApiKeyAuth` never used in production paths.
2. **`--framework auto` uses NativeEngine, not HardenedNativeEngine** — Production OpenAI path via auto selects the "reference/test baseline" (`runtime.ts:389-391`) while codex-native explicitly uses `HardenedNative` (`runtime.ts:317`); retry/eager/mid-turn compaction only on explicit flags or codex-native, creating inconsistent production behavior.
3. **Dual Codex ChatGPT architectures** — `CodexFrameworkEngine` (subprocess JSON-RPC, `codex-framework.ts:2-8`) and `CodexResponsesTransportProvider` (in-process HTTPS+SSE/WS, `codex-responses/index.ts:1-17`) both target ChatGPT subscription with different model defaults, auth, resume, and team support; codex-native absent from workers.
4. **Dead abstraction layer (RetryingProvider, quirks.ts, FrameworkProvider, filterToolsForFramework)** — Planned composable pieces from hardened-engine design were superseded by inline `HardenedNativeEngine` retry and never integrated; quirks centralized in `quirks.ts` but transports duplicate logic inline.
5. **Duplicate error classification + leaky AuthSource** — Two `classifyProviderError` functions with different semantics (`error-classifier.ts:42` vs `retry-policy.ts:40`); most transports ignore `AuthSource.headers()` and read env directly in constructors, undermining the auth abstraction documented in `auth/index.ts:14-31`.

---

## 4. Interface / Protocol

### Overview

The interface layer has largely completed the Ink → OpenTUI/Solid cutover: `src/cli/main.ts:310` lazy-loads `repl-solid/` as the only TTY path; the legacy Ink renderer is gone and `src/ui/repl/` retains only the shared reducer (`state.ts`). ACP is production-wired via stdio (`openswarm acp`) and host WebSocket (`openswarm host`), with team mode as the default (`src/acp/index.ts:26-31`). The library entrypoint (`src/index.ts`) exports engine/session/auth only — no CLI/ACP/UI surface. Test density is high in `acp/` (20/21 files) and `host/` (13 test files), moderate in `cli/`, and uneven in `repl-solid/` (several UI components lack direct tests; 2 skipped e2e cases).

### Dead Code

- `src/ui/repl/index.ts` — file absent; `repl-solid/index.ts:4-9` still references the deleted Ink entry; Ink UI is dead, only `state.ts` survives.
- `src/ui/repl/state.ts:306-311` — `createStubSlashRegistry()` exported but never called in production; only `src/ui/repl/state.test.ts:545,551` uses it. Runtime uses `buildDefaultRegistry` at `repl-solid/index.ts:71-72`.
- `src/cli/slash/commands/tasks.ts:15-19` — `/tasks` always returns "task inspection not yet wired (no host in this REPL)" because `main.ts:346-359` slashDeps omits host; `SwarmHost` is never injected into the interactive REPL.
- `src/acp/rich-client.ts:35` + `rich-view.ts` + `rich-format.ts` — not imported by CLI/host/REPL; only consumed by `scripts/acp-rich-client.ts:24` and ACP unit tests.
- `src/host/index.ts:1-35` — public re-export barrel with zero internal imports; consumers import `boot.js`, `map-sidecar.js`, etc. directly.
- `src/ui/repl/state.ts:181` — legacy tool-entry reducer branch kept for backward compat; comment says `translateEngineEvent` no longer emits it (`app.tsx:436+` uses rich tool-call events instead).
- `src/cli/argv.ts:1046-1047` — stale comment claims team send/list/stop/kill are v0.5 stubs; `team.ts:475-525` implements real RPC daemons — comment is dead documentation, not dead code, but misleads maintainers.

### Experimental / Unstable

- `src/acp/index.ts:26-31` — **High:** `TEAM_DEFAULT = true`; `openswarm acp` serves coordinator team unless `--single`; single-agent path is opt-in (`argv.ts:422-430`).
- `src/cli/argv.ts:209,217,1175-1179` — **Med:** committee / critic-loop topology kinds parse then error as "deferred to v0.5".
- `src/ui/repl-solid/e2e.test.tsx:126-133` — **Med:** skipped test "full turn: submit → streaming → engine text_delta → assistant text renders" — bun:test capture race with `<markdown>` streaming.
- `src/ui/repl-solid/transcript.test.tsx:45-48` — **Med:** skipped "renders assistant `<markdown>` entry in bare-Transcript frame" — same capture race.
- `src/ui/repl-solid/input.test.tsx:111-116` — **Low:** TODO for Alt+B/Alt+F word-motion; bindings wired but `onCursorChange` not hooked to `onChange`.
- `src/acp/e2e.test.ts:282,285+` — **Med:** live ACP tests gated on `SWARM_ACP_LIVE=1`; several subtests (`BUN ? it : it.skip`).
- `src/host/map-acp-bridge.live.test.ts:24,39` — **Med:** live MAP+ACP integration gated on `OPENSWARM_LIVE_ACP_MAP=1`.
- `src/ui/repl-solid/cli-bun.test.ts:15,26,81` — **Med:** live CLI agent tests require auth + skip when `OPENSWARM_SKIP_LIVE=1`.
- `src/ui/repl-solid/transcript.tsx:32,83` — **Low:** tree-sitter syntax highlighting disabled via `OPENSWARM_DISABLE_TREE_SITTER=1`.
- `src/acp/agent.ts:4-7` — **Low:** stale header still says prompt turn is "clean no-op until Step 3"; `agent.ts:108-168` fully implements prompt+translator (doc drift, not runtime stub).
- `src/ui/repl-solid/index.ts:14-17` — **Low:** stale "Deferred" comment for slash registry + onSessionId; both wired.
- `src/cli/slash/commands/cost.ts:3-4` — **Low:** hardcoded placeholder pricing table; comment says "Phase 5 wires the real getter."

### Fragmentation & Tech Debt

- `src/ui/repl/state.ts:1-5` vs `src/ui/repl-solid/` — competing-impl resolved but fragmented: Ink deleted; 851-line pure reducer (`state.ts`) still labeled "ink REPL"; Solid UI imports types/events from `../repl/state.js` across ~20 files.
- `src/cli/argv.ts` — 1305 lines; monolithic parser for prompt, swarm, team, topology, acp, host, worker, plugin, worktree, login — single switch-dispatch god file.
- `src/cli/main.ts:521` + `src/cli/argv.ts:234` vs `src/cli/worker-entry.ts:91-477` — duplicated configuration: interactive CLI uses `parseArgv`/`CommonOpts`; worker subprocess reads dozens of `OPENSWARM_*` env vars independently.
- **Triple `NormalizedEvent` translation:** (1) `src/ui/headless.ts:8-32` → JSONL; (2) `src/acp/normalized-translate.ts:78+` + `lane-translator.ts:135+` → ACP session/update; (3) `src/ui/repl-solid/app.tsx:436-531` `translateEngineEvent` → REPL reducer events — no shared module.
- **Triple permission surfaces:** `PermissionBridge` (REPL, `permissions/bridge.ts:18`), `AcpPermissionBridge` (single ACP, `acp/permission.ts:23`), `AcpPermissionRouter` (team ACP, `acp/team-permission.ts:38`) — all funnel through `makeCanUseTool` but with different bridges.
- `src/acp/index.ts:58-111` vs `src/host/acp-ws-server.ts:103+` — dual ACP transports (stdio ndjson vs WebSocket); shared team wiring via `team-connection.ts:24-57` but separate entry paths.
- `src/cli/slash/index.ts:2,104` — comment says "14-command registry" and "ink REPL"; array at `:111-125` lists 13 commands.
- `src/cli/main.ts:198-205` — TUI requires Bun (`process.versions.bun`); Node/compiled-non-bun falls back to headless with stderr warning — platform split at UI boundary.

### Stability Assessment

- `src/acp/` — **in-flux:** Team-default ACP (`index.ts:26`), rich ext methods only on team agent (`team-agent.ts:293-307`); single-agent path tested but secondary; 20 test files, strong coverage; `team-connection.ts` / `content.ts` lack dedicated unit tests.
- `src/cli/` — **stable core, fragile edges:** `main.ts` dispatch is clean; `argv.ts` is the risk surface; slash commands well unit-tested (13/13 have `.test.ts`); stale comments in `argv.ts` and `slash/index.ts`.
- `src/ui/` — **fragile:** `repl-solid/` is production TTY but Bun-gated; 2 skipped markdown capture tests; ~10 TSX components lack dedicated tests (partially covered by `e2e.test.tsx`); `headless.ts` stable and tested.
- `src/host/` — **in-flux, well-tested:** docs/44 OpenHive track; `boot.ts:315` lines orchestrates health/ACP-WS/MAP/sidecar; 13 test files including gated live tests; trajectory extension fallback at `map-sidecar.ts:181-182`.
- `src/mcp/` — **stable:** 3 source files, 3 test files; wired only through `cli/runtime.ts:38-40`; bridge handles legacy MCP result shape at `bridge.ts:117-118`.
- **Entrypoints** — **stable:** `cli.ts:25-31` → `main()` only; JSX preload Bun-only (`cli.ts:17-23`); `index.ts` library exports exclude interface layer entirely.

### Top 5 Concerns

1. **ACP defaults to team coordinator, not single agent** — `src/acp/index.ts:26-31` + `:58-60`: baseline ACP clients expecting a single session/agent must pass `--single`; team mode enforces one session per connection (`team-agent.ts:107-111`) and spawns orchestrator infrastructure — higher complexity and different failure modes than Stage A.
2. **`argv.ts` god file (1305 lines) with stale inline docs** — `src/cli/argv.ts:234-1305`: all CLI routing, flag parsing, subcommand dispatch in one module; stale stub comment at `:1046-1047` contradicts implemented team send/list/stop/kill; high regression risk on any flag change.
3. **Three parallel event-translation pipelines** — `headless.ts:14-31`, `acp/normalized-translate.ts:78+` / `lane-translator.ts`, `repl-solid/app.tsx:436-531`: `NormalizedEvent` → output diverges per surface; parity bugs require triple maintenance.
4. **Interactive REPL is Bun-only with known test gaps** — `main.ts:198-205` degrades to headless without Bun; skipped tests at `e2e.test.tsx:133` and `transcript.test.tsx:48` document unresolved `<markdown>` capture races — assistant streaming render path is fragile/unverified in CI.
5. **Half-wired multi-agent REPL features** — Phase 5 views (`app.tsx:252-341`, Ctrl+A/T agent/task panels) and `/tasks` (`tasks.ts:15-19`) depend on `SwarmHost` + swarm `NormalizedEvents`, but `main.ts:346-359` never injects host into slash deps; agent/task UI only exercised in tests, not standard single-agent CLI sessions.

---

## 5. Capabilities & Repo Hygiene

### Overview

OpenSwarm's capability subsystems are registry-driven and mostly tested, but several modules are implemented and registered without runtime wiring. Tier 0/1 tools assemble in `buildAgentRuntime()` (`src/cli/runtime.ts:145-197`); Tier 2 only mounts in swarm workers (`src/cli/worker-entry.ts:203-204`). Memory reaches production via `enrichTurnInputs()` (`src/cli/main.ts:251`), not via the parallel `ContextBuilder` path. Permissions are live but M0-thin: mode gate + bash validation; `ApprovalPolicy` and exec-policy auto-allow logic are test-only. Repo hygiene is mostly sound (artifacts gitignored), but dual lockfiles, an empty tracked `.gitmodules`, a 47-doc corpus with a 22-entry README index, and 13 milestone smoke scripts add maintenance drag.

### Dead Code

- `src/context/index.ts:264-277` — `getContextBuilder()` / `ContextBuilder.build()` never imported outside `src/context/context.test.ts`; `buildSystemPrompt()` in `src/cli/main.ts:220` bypasses it entirely.
- `src/memory/lifecycle.ts:148-189` — `onAfterTurn`, `onCompaction`, `onSessionEnd` exported but zero production call sites (only `src/memory/lifecycle.test.ts`); session archives never populate in live runs → `memory_search` (`src/tools/tier0/memory_search.ts:61`) searches an empty store.
- `src/memory/agent-scope.ts:38` — `publishSharedMemory` / `getSharedMemory` only referenced from `src/memory/agent-scope.test.ts`.
- `src/memory/state-store.ts:13` — `StateDBCuratedStore` / `StateDBArchiveStore` only used in `src/memory/state-store.test.ts`; production uses in-memory singletons in `curated.ts` / `archive.ts`.
- `src/tools/tier0/guardian.ts:319` — `getGuardian()` / `setGuardian()` only imported by `src/tools/tier0/guardian.test.ts`.
- `src/tools/tier0/secrets.ts:187` — `redactSecrets()` only imported by `src/tools/tier0/secrets.test.ts`.
- `src/tools/tier0/network-proxy.ts:47` — `startProxy()` only imported by `src/tools/tier0/network-proxy.test.ts` (`network-policy.ts` is wired into web_fetch/web_search).
- `src/tools/tier0/banned-prefixes.ts:118` — `checkBannedPrefix()` only imported by `src/tools/tier0/banned-prefixes.test.ts`; not used by exec-policy or bash-gate.
- `src/tools/tier1/mention-syntax.ts:34` — `parseMentions` / `resolveMentions` only imported by `src/tools/tier1/mention-syntax.test.ts`.
- `src/tools/tier1/image-gen-instructions.ts:33` — `buildImageGenContext` only imported by `src/tools/tier1/image-gen-instructions.test.ts`.
- `src/permissions/approval-policy.ts:43` — `ApprovalPolicy` only imported by `src/permissions/approval-policy.test.ts`; `makeCanUseTool` (`src/permissions/gate.ts:51`) never uses it.
- `src/tools/tier0/request_permissions.ts:94-100` — tool registered in `buildTier0Tools()` (`src/tools/tier0/index.ts:38`) but `setPermissionRequestHandler()` has no production callers (only `request_permissions.test.ts:25`); always returns "not available".
- `src/tools/tier1/tool_search.ts:31-35` — `_toolRegistry` never populated in runtime; `setToolRegistry()` only called from `tool_search.test.ts:17` → live searches return empty.
- `src/tools/framework-filter.ts:23-29` — intentional no-op kept for signature compatibility; all filtering logic removed v0.4.
- `src/plugins/index.ts:144-148` — legacy `PluginRegistry` interface superseded by class in `src/plugins/registry.ts:24`; runtime imports class only (`cli/runtime.ts:32`).
- `src/index.ts:63-66` — public package API exports only `buildTier0Tools` + `PermissionEngine`; tier1/2, memory, context, plugins, skills not exported (library consumers can't reach half the harness).

### Experimental / Unstable

- `src/tools/tier1/skill.ts:25-26` — **Med:** stale comment "Phase 7 not yet wired"; registry is wired when `--skills` on (`cli/runtime.ts:186-188`), but comment signals incomplete ownership.
- `src/tools/tier0/request_permissions.ts:94-100` — **Med:** registered tool that always errors without handler wiring.
- `src/tools/tier1/tool_search.ts:64-74` — **Med:** registered tool with empty registry at runtime.
- `src/memory/providers/minimem-provider.ts:5-9` — **Med:** optional dynamic import of minimem; graceful degrade to skip, but embedding config surface is large and env-driven (`SWARM_MEMORY_PROVIDERS`).
- `src/permissions/index.ts:5-7` — **Med:** "M0 does not implement claw's full rule grammar… lands in M2"; mode-only gating remains.
- `src/plugins/claude-code-source.ts:9-16` — **High:** in-process plugin execution explicitly "NO sandbox"; capability is production-exposed via `--plugins`.
- `docs/45-adaptive-orchestration-design.md:3` — **High:** "Draft for discussion" — active research direction driving `eval/` but not productized.
- `docs/46-sessionlog-trajectory-ingest.md:3` — **Med:** "design / Layer 0 kickoff" — producer-side learning loop not built.
- `docs/26b-spike-track-b-codex-protocol.md:24` — **Med:** Codex dynamicTools API marked experimental; spike COMPLETE, implementation partial.
- `docs/47-h1-experimental-findings.md:3` — **Low:** experimental findings doc (complete first pass); authoritative for H1, not runtime code.
- `src/tools/tier2/_fake-host.ts:194` — **Low:** test-only stub with `send` not implemented (intentional test double).

### Fragmentation & Tech Debt

- **Dual memory surfacing:** `enrichTurnInputs()` injects coordinator fragments at turn time (`src/memory/lifecycle.ts:105-137`, wired from `src/cli/main.ts:251`); parallel `curatedMemoryFragment` lives in `ContextBuilder.DEFAULT_FRAGMENTS` (`src/context/index.ts:188-199`) but that builder is unwired — two L1 injection designs, one active.
- **Skills loaded twice:** runtime `SkillRegistry` + skill tool (`cli/runtime.ts:187-188`) and read-only `SkillProvider` in memory coordinator (`src/memory/lifecycle.ts:56-62`).
- **Duplicate ClaudeCodeSource:** plugins register two sources scanning `~/.openswarm/plugins` + default `~/.claude/plugins` (`cli/runtime.ts:161-164`); skills have separate `src/skills/claude-code-source.ts` with overlapping filesystem scan logic.
- **Exec overlap:** both `bash` (`src/tools/tier0/bash.ts`) and persistent `shell_exec`/`shell_write`/`shell_list` (`src/tools/tier0/shell.ts:2-6`) registered together in `buildTier0Tools()`.
- **Exec-policy orphaned:** `getExecPolicy()` only consumed by dead `ContextBuilder` fragments (`src/context/index.ts:140`) and test-only `ApprovalPolicy`; permission gate uses bash-validation + mode only (`src/permissions/gate.ts:65-84`), not exec-policy rules.
- **Tier-2 split across runtimes:** single-agent `buildAgentRuntime()` = tier0 + tier1 + plugins + MCP, no tier2 (`cli/runtime.ts:145-197`); workers get tier0+tier2 (`worker-entry.ts:203-204`); `codex-peer-tools.ts` further subsets tier2 for Codex peers.
- **PluginRegistry naming collision:** interface in `src/plugins/index.ts:144` vs class in `src/plugins/registry.ts:24`.
- **Docs index gap:** `docs/README.md:21-22` admits docs 11–29 "not yet listed"; 57 markdown files tracked, ~25 unindexed.
- **Smoke-script drift:** most scripts invoke `node dist/cli.js` (`scripts/smoke.sh:46`); CI builds `dist/openswarm` binary (`scripts/smoke-opentui.sh:76`, `.github/workflows/ci.yml:43-46`).

### Repo Hygiene / Cruft

- `dead-letter.jsonl` / `results.jsonl` — 0 lines, gitignored (`.gitignore:9-10`), not tracked; local smoke artifacts only.
- `dist/` — gitignored (`.gitignore:2`), not committed; correct.
- `.DS_Store` — gitignored (`.gitignore:5`); present locally under `references/` but that dir is gitignored.
- **Dual lockfiles:** both `package-lock.json` and `bun.lock` tracked; CI installs via `npm ci` (`.github/workflows/ci.yml:37-38`) while `build:compile` uses Bun — two sources of truth.
- `.gitmodules` — tracked, 0 bytes (empty placeholder); checkout uses `submodules: recursive` in CI (`.github/workflows/ci.yml:21-24`) despite no submodules.
- `AGENTS.md == CLAUDE.md` — byte-identical (SwarmKit wiki stub only).
- `references/` — gitignored (`.gitignore:19`); local clone farm (claw-code, macro-agent, openclaw, etc.), not vendored.
- `eval/` — committed research/test infra (`eval/README.md:5`: outside `tsconfig.build.json`, not in npm package); 25 tracked files.
- `.eval-runs/` — gitignored (`.gitignore:12`); ~50 local run dirs (TAC/H1 artifacts), not committed.
- **Docs — current vs superseded:**
  - **Current/shipped:** `25-team-orchestration.md` (shipped v0.4), `30-36` ACP docs, `37-39` hardened engine + codex parity, `40-memory-system-design.md` (all 5 phases complete), `47-h1-experimental-findings.md`.
  - **Complete spikes (historical):** `26-team-orchestration-spikes.md`, `26b-spike-track-b-codex-protocol.md` (both Status: COMPLETE).
  - **Draft/active research:** `45-adaptive-orchestration-design.md`, `43-macro-agent-parity.md`, `44-macro-agent-parity-implementation-plan.md`, `46-sessionlog-trajectory-ingest.md`, `41-tui-redesign.md`.
  - **Superseded/historical milestones:** `08-14` M-plans still marked "draft" but features largely landed; `16-parity-plan.md` Phase 0 bundler instructions partially stale vs current tsc+Bun compile; `21-roadmap-v0.2-to-v0.4.md:259` preserves original v0.4 sketch as historical.
- **Scripts — stale/abandoned candidates:**
  - **CI-active:** `scripts/smoke-opentui.sh` only (`.github/workflows/ci.yml:58-59`).
  - **Milestone gates, not in CI:** `smoke.sh`, `smoke-swarm.sh`, `smoke-repl.sh`, `smoke-swarm-m3a.sh`, `smoke-m3b.sh`, `smoke-m4a.sh`, `smoke-m4b.sh`, `smoke-team.sh`, `smoke-codex-team.sh`, `smoke-codex-consultant.sh`, `smoke-acp.sh`, `smoke-team-daemon.sh`, `smoke-v07-git-cascade.sh` — chained by `smoke.sh --all` but unmaintained in CI.
  - **Spike probes:** `scripts/codex-app-server-spike.mjs`, `scripts/codex-app-server-dynamic-tool-spike.mjs` — referenced by docs/26b as research artifacts.

### Stability Assessment

| Subsystem | Assessment |
|---|---|
| `src/tools/tier0` | Stable — core file/bash/edit tools + bash-validation wired; several parity modules (guardian, secrets, network-proxy, banned-prefixes) are dead weight. |
| `src/tools/tier1` | Fragile — web_fetch/search/skill/notebook/view_image work; tool_search and mention/image-gen modules unwired or test-only. |
| `src/tools/tier2` | Stable in swarm path — fully registered in workers; absent from single-agent runtime by design. |
| `src/memory` | Fragile — enrichTurnInputs live; lifecycle hooks, archive persistence, agent-scope, StateDB adapters, and ContextBuilder path incomplete. |
| `src/skills` | Stable — registry + ClaudeCodeSource wired when `--skills` on. |
| `src/plugins` | Stable but risky — registry + install lifecycle wired; in-process plugins unsandboxed. |
| `src/permissions` | Fragile — gate + bash-gate + bridge live; ApprovalPolicy/exec-policy auto-allow layer unused. |
| `src/context` | In-flux — complete fragment library, zero production integration. |

**Test coverage (scope dirs):** tools 59/126 test files (~47%), memory 11/23, skills 2/5, plugins 7/16, permissions 5/11, context 1/2.

### Top 5 Concerns

1. **Memory lifecycle half-wired** — `onSessionEnd`/`onAfterTurn`/`onCompaction` never called (`src/memory/lifecycle.ts:148-189`); `memory_search` and archive layer are effectively dead in production while `enrichTurnInputs` masks the gap.
2. **ContextBuilder completely disconnected** — `src/context/index.ts` models Codex-style composable prompts but nothing feeds `buildSystemPrompt()`; duplicates memory/policy surfacing already handled elsewhere.
3. **Registered-but-broken tools at runtime** — `request_permissions` (no handler, `request_permissions.ts:94`) and `tool_search` (empty registry, `tool_search.ts:31`) are exposed to models as tier0/1 tools.
4. **Permission stack fragmentation** — production gate ignores `ExecPolicy`/`ApprovalPolicy` (`gate.ts:65-84`); exec-policy only affects dead context fragments; M0 mode matrix is the only live layer beyond bash validation.
5. **Repo maintenance debt** — dual lockfiles + empty `.gitmodules` + 25 unindexed docs + 12+ unmaintained smoke scripts create drift risk; CI validates only `smoke-opentui.sh`, not the milestone gates the scripts claim to enforce.

---

## Recommended Priorities

1. **Purge or wire the "registered-but-unreachable" set** — especially the two broken tools exposed to the model (correctness/UX bug) and the four unauthable providers (wire auth or remove from routing).
2. **Fix the memory lifecycle wiring** — otherwise the entire archive/memory_search subsystem is dead in production.
3. **Resolve engine selection inconsistency** — decide whether auto should use Hardened vs Native, and add the missing worker codex-native branch.
4. **Consolidate the triplicated layers** — event translation, error classification, and permission surfaces are the highest-leverage dedup targets.
5. **Decide the fate of stranded subsystems** — merge-queue landing, ContextBuilder, core/goal.ts, stale-branch are finish-or-delete decisions.
6. **Cheap hygiene wins** — drop one lockfile, remove/populate `.gitmodules`, prune stale doc headers, reconcile smoke scripts with CI.

---

## Methodology

This audit was produced by 4 parallel read-only subagents, each scoped by subsystem (Orchestration Core; Engine / Providers / Auth; Interface / Protocol; Capabilities & Repo Hygiene). Findings were then synthesized into the cross-cutting themes and recommended priorities above. No files were modified during the audit.
