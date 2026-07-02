# OpenSwarm Audit Remediation Plan

**Date:** Jul 1, 2026 · **Baseline:** branch `hive-aware` @ `3922efa`, vitest green (3,324 passed / 20 skipped) · **Source:** `openswarm-audit.md`

Every phase gates on the full vitest suite staying green. Work lands as small, single-concern PRs in the order below; later phases assume earlier ones merged.

## Decisions log (owner-confirmed, all ambiguities resolved)

| # | Decision | Outcome |
|---|---|---|
| D1 | Stranded/unwired modules | **Archive to `experimental/`**, not delete — unwired from main path, revisitable; catalogued in `experimental/BACKLOG.md` |
| D2 | Archive persistence for memory lifecycle | **Use minimem's mechanisms** via the MemoryCoordinator provider fan-out, not the parallel StateDB archive store |
| D3 | Merge-queue landing | **Finish** (MemberSpec.landing + integrator drain) |
| D4 | Safety modules | **Wire banned-prefixes** into bash gate; **secrets.ts → experimental** |
| D5 | Legacy `SWARM_*` env vars + `.swarm/` paths | **Hard rename** to `OPENSWARM_*` / `.openswarm/`, no fallback (pre-1.0) |
| D6 | `tool_search` | **Wire now** — populate registry in `buildAgentRuntime()` |
| D7 | `request_permissions` | **Unregister now**, wire in Phase 4 with permission work |
| D8 | committee / critic-loop topologies | **Enable** in CLI parser |
| D9 | Quirks (`quirks.ts`) + `RetryingProvider` | **Move to `experimental/`**; xai/dashscope quirks stay inline, documented |
| D10 | `AuthSource.headers()` | **Narrow the contract** (`isAuthenticated()` + env); unconsumed pieces → experimental |
| D11 | Daemon `stop` | **Implement real worker drain** (the promised 4D drain frame) |
| D12 | ACP `TEAM_DEFAULT` | **Keep `true`** — team coordinator stays the default; `--single` opt-out |
| D13 | Skipped `<markdown>` streaming tests | **Timeboxed fix attempt**; document as upstream OpenTUI race if it fails |
| — | `--framework auto` | **HardenedNativeEngine** for non-Claude models (earlier decision) |
| — | Codex stance | **codex-native primary**; codex-chatgpt for teams until parity (earlier decision) |
| — | Lockfiles | **Keep both** (npm = CI installs, bun = binary compile); document the policy (earlier decision) |
| — | Memory lifecycle | **Finish** the wiring (earlier decision, refined by D2) |

## The `experimental/` convention (D1)

- Top-level `experimental/` directory, outside `tsconfig.build.json` (same pattern as `eval/`), with its own `tsconfig.json`. Not shipped in the npm package.
- Modules move **with their tests**; imports rewritten to be self-contained (no imports from `experimental/` back into `src/`; `experimental/` may import from `src/`).
- `experimental/BACKLOG.md` catalogues every archived feature: what it was, why it was unwired, what re-promoting it to `src/` would entail, and the commit that moved it.
- CI gets a typecheck step for `experimental/` (bundled with the `eval/` typecheck step from 0.1) so archived code doesn't rot silently.
- Trivial non-features (dead branches, empty generators, unused barrels, stale type stubs) are deleted outright, not archived — the backlog notes them under a "removed outright" section for the record.

---

## Phase 0 — Mechanical fixes (no design decisions, low risk)

**0.1 Fix eval harness imports** — ✅ DONE (Jul 1, 2026)
- Rename `swarmHarness` → `openSwarm`, `swarmHarnessSpec` → `openSwarmSpec`, `swarmHarnessParse` → `openSwarmParse` in `eval/experiments/fixit.ts:39`, `eval/experiments/h1-single-vs-team.ts:25`, `eval/harness/local.ts:14`, `eval/harness/swarm-coordinator-adapter.ts:15,121`; update `eval/README.md:31-32`.
- Bump `package.json` `swarmkit-eval` to `^0.0.7`.
- Add CI step: `bunx tsc --noEmit` for `eval/tsconfig.json` (and later `experimental/tsconfig.json`).
- Accept: eval typecheck passes; `eval/experiments/smoke.ts` still runs.
- Completed: renames applied in the 4 eval files + `eval/README.md` + 2 stale mentions in `docs/45-adaptive-orchestration-design.md`; `swarmkit-eval` bumped to `^0.0.7` (lockfile updated, local symlink to sibling checkout preserved); CI "Type-check eval harness" step added. Verified: `tsc -p eval/tsconfig.json --noEmit` clean, smoke experiment runs ("9 cells graded — wiring OK"), zero residual `swarmHarness` references, full vitest green (3,358 passed / 20 skipped).

**0.2 Rename-residue sweep — hard rename (D5)** — ✅ DONE (Jul 1, 2026)
- Smoke scripts: `SWARM_CODER_TEST_SCRIPT` / `SWARM_CODER_PLUGINS_DIR` / `SWARM_CODER_CONFIG_DIR` / `SWARM_CODER_SKIP_LIVE` / `SWARM_CODER_SKIP_INTEGRATION_BUILD` → `OPENSWARM_*` equivalents (all `scripts/smoke-*.sh`, incl. CI-active `smoke-opentui.sh:47,93`).
- Fix dead test path in `scripts/smoke-m4b.sh:133` (`src/auth/openai-oauth.test.ts` → `openai-codex-oauth*.test.ts`).
- Hard-rename functional legacy env vars, **no fallback**: `SWARM_MEMORY_PROVIDERS` → `OPENSWARM_MEMORY_PROVIDERS` (`src/memory/lifecycle.ts:43,60`), `SWARM_WEB_SEARCH_BASE_URL` → `OPENSWARM_WEB_SEARCH_BASE_URL` (`src/tools/tier1/web_search.ts:124,306`), `SWARM_MAP_SERVER` → `OPENSWARM_MAP_SERVER` (`src/cli/argv.ts:1234-1235`), `SWARM_ACP_LIVE` → `OPENSWARM_ACP_LIVE` (`src/acp/e2e.test.ts:11,282`).
- Hard-rename `.swarm/` paths → `.openswarm/`: **AMENDED during execution** — `.swarm-base` marker renamed to `.openswarm-base` (openswarm-owned, no external consumers found in sibling repos). `.swarm/openswarm/sessions` and `.swarm/opentasks` are **cross-repo contracts** (sessionlog's openswarm adapter hardcodes `SESSIONS_SUBDIR = .swarm/openswarm/sessions`; opentasks' client/discover use `.swarm/opentasks`) — left in place; renaming them requires a coordinated sessionlog + opentasks migration, tracked as follow-up.
- `docs/26-team-orchestration-spikes.md:37,74`: `SWARM_CODER_ALLOW_PEER_TASK_STOP` → `OPENSWARM_ALLOW_PEER_TASK_STOP`.
- Changelog entry listing every renamed var/path (breaking, pre-1.0).
- Completed: all `SWARM_CODER_*` in 8 smoke scripts → `OPENSWARM_*`; `smoke-m4b.sh` [O6] dead test path fixed; `SWARM_MEMORY_PROVIDERS`, `SWARM_WEB_SEARCH_BASE_URL`, `SWARM_MAP_SERVER`, `SWARM_ACP_LIVE`, `SWARM_ACP_BENCH(_N)` hard-renamed in src/test + current docs (32/33/39/40/44); `CHANGELOG.md` created with the breaking-change list and the two intentionally-deferred cross-repo paths.

**0.3 Stale-comment purge** — ✅ DONE (Jul 1, 2026; all 15 items, incl. dead `LEGACY_MCP_PREFIX` branch removal; `--ecosystem` note and native-framework error strings rewritten with their test assertions updated; verified with clean build + full vitest 3,385 passed / 20 skipped)
- `src/swarm/team-daemon.ts:6-7` ("stubbed until 5E.4"), `src/swarm/host.ts:164` ("askUser Phase 0 stubs throw"), `src/swarm/orchestrator.ts:200` ("4C only supports fanout"), `src/swarm/inbox.ts:15`, `src/swarm/topologies/index.ts:9-10` ("land later in 4E").
- `src/cli/argv.ts:1046-1047` ("v0.5 stubs"), `src/cli/argv.ts:732` (`--ecosystem` "land in v0.5+"), `src/cli/slash/index.ts:2,104` ("14-command"), `src/cli/team.test.ts:11` ("stub functions"), `src/cli/runtime.ts:352-354` ("M4a"/"M4b" user-facing error strings).
- `src/acp/agent.ts:4-7` ("no-op until Step 3"), `src/ui/repl-solid/index.ts:8-9,14-17` ("Node → Ink", "Deferred"), `src/ui/repl/state.ts:2-5` ("ink REPL"), `src/tools/tier1/skill.ts:25-26` ("Phase 7 not yet wired").
- `src/engine/claude-agent-sdk.ts:34-38`: remove dead `LEGACY_MCP_PREFIX` branch while here.

**0.4 Repo hygiene** — ✅ DONE (Jul 1, 2026)
- Deleted empty `.gitmodules`; dropped `submodules: recursive` from CI checkout.
- Added `*.tgz` to `.gitignore` (root `openswarm-0.3.5.tgz` was untracked; now ignored everywhere — `eval/.artifacts/` pack destination already covered).
- Dual-lockfile policy documented in README § Contributing → Package management (npm canonical, bun feeds `build:compile`); CI now runs `bun install --frozen-lockfile --dry-run` after `npm ci` so a stale `bun.lock` fails the build. `bun.lock` was resynced (it had drifted after the 0.1 `swarmkit-eval` bump — the new guard caught it immediately).
- Docs reorganized: 26 historical docs (08–24, 26/26b/27, 30/32–35, 38) moved to `docs/archive/` via `git mv`; `docs/README.md` rewritten as a full categorized index (foundations / teams / engines / memory / ACP / TUI / archive / research). All intra-repo references updated — markdown links in docs (both directions across the archive boundary) and `docs/NN` prose citations in `src/`, `test/`, and root README (121 files). Verified: link checker reports zero broken relative `.md` links; clean build; full vitest 3,385 passed / 20 skipped. External (out-of-repo) inbound links to old paths are accepted breakage per decision.

---

## Phase 1 — Externally visible contract fixes

**1.1 Enable committee / critic-loop from the CLI (D8)** — ✅ DONE (Jul 1, 2026)
- `DEFERRED_TOPOLOGY_KINDS` removed; committee/critic-loop folded into `SUPPORTED_TOPOLOGY_KINDS`; unknown-kind error message lists all six. Rejection tests flipped to acceptance tests.

**1.2 Adapter flags on the topology/team path** — ✅ DONE (Jul 1, 2026)
- New shared assembly module `src/cli/adapter-host.ts` (`buildAdapterHost()`) extracted from `runSwarm()`; `swarm run`, `topology`, and `team start` all consume it, so the three entry points accept identical flags and emit identical enablement notices. Parse results + `main.ts` dispatch + `TeamStartOptions`/`TopologyRunOptions` extended. `team start --detach` + adapter flags → explicit exit-2 error (daemon builds its own host; threading flags through daemon env is Phase 4.1 territory). Parse-level tests added for both subcommands.

**1.3 Tool registration honesty (D6, D7)** — ✅ DONE (Jul 1, 2026)
- `tool_search` wired: `buildAgentRuntime()` calls `setToolRegistry(dispatcher.list())` after the full tier0+tier1+plugin+MCP assembly; worker entry does the same with its tier0+tier2 post-allowlist surface. `setToolRegistry` kept as the (now production) seam — the existing test exercises the same function production calls.
- `request_permissions` unregistered from `buildTier0Tools()` with a comment pointing at Phase 4.1; module + tests kept. README tool table updated (14 built-ins; also removed the listed-but-nonexistent `skill_save` row and added the missing `apply_patch` row); `docs/04-tool-tiers.md` annotated.

**1.4 Provider auth symmetry (grok / gemini / dashscope)** — ✅ DONE (Jul 1, 2026)
- `authFactory` added to the grok (XaiApiKeyAuth), gemini (GoogleApiKeyAuth), and qwen/kimi (`OpenAICompatApiKeyAuth("DASHSCOPE_API_KEY", "dashscope")`) routes, mirroring litellm/azure. `GOOGLE_GENERATIVE_AI_API_KEY` + `DASHSCOPE_API_KEY` added to `detectAuth`. Routing tests assert authFactory presence + providerId per route.
- Verified: clean build, full vitest 3,407 passed / 20 skipped.

---

## Phase 2 — Runtime consistency

**Status: ✅ DONE (Jul 2, 2026). How each item landed:**

- **2.1 Unify engine selection.** New pure resolver `src/cli/select-engine.ts` (`planEngine(input) → {ok, plan, effectiveModelId} | {ok:false, message}`). It calls `resolveProvider` internally and returns a discriminated `EnginePlan` (`scripted | claude-sdk | codex-chatgpt | codex-native | native{hardened}`) as data only; each caller still constructs its engine (CLI defers via `makeEngine(sessionId)`, workers build eagerly on `agentId`). Both `runtime.ts` and `worker-entry.ts` switch over the plan. Workers gained the `codex-native` branch (`buildCodexNativeWorkerEngine`, HardenedNativeEngine over the codex Responses transport, compaction sized to the real window). **auto + non-Claude → HardenedNativeEngine everywhere** (Q2); `--framework native` is the explicit non-hardened escape hatch; explicit `native`/`hardened-native` + a Claude model is now a **hard error** in the worker too (was a silent Agent-SDK fallback). Precedence preserved: codex frameworks are selected before scripted mode (the codex-native unit test builds the codex engine under `OPENSWARM_TEST_SCRIPT`). Baseline comment at `hardened-native.ts` updated. Tests: `src/cli/select-engine.test.ts`.
- **2.2 Team framework forwarding.** The spawn→worker plumbing already existed end-to-end (`SpawnRequest.framework` → `standalone-host` → `subprocess-spawner` → `OPENSWARM_FRAMEWORK`); the gaps were (a) `TeamSession.spawnMember` dropped `spec.framework` — now forwarded — and (b) the daemon `send_prompt` ad-hoc member didn't inherit the template's `model`/`framework` — now inherited. The `framework` union was widened at all three type sites (`team-spec.ts`, `host.ts` `SpawnRequest`, ipc `protocol.ts`) to the worker-validated set `claude-agent-sdk | codex-chatgpt | codex-native | native | hardened-native` (omit for `auto`). Tests: `team-session.test.ts` (framework threading), `team-spec.test.ts` (enum acceptance).
- **2.3 Consolidate duplicated layers.** Error classification: `src/providers/error-classifier.ts` is now the single classifier. It exports the shared `httpStatusToProviderCode()` table, `isRetryableError()` (moved from `retry-policy.ts`), and the `CONTEXT_OVERFLOW_PATTERNS`/`NETWORK_ERROR_PATTERN` constants. `codex-responses/errors.ts` reuses the table (keeping its codex-specific usage-limit/auth friendly messages ahead of the generic tail). The former `retry-policy.ts` passthrough + engine-boundary "unrecognized ⇒ transport/retryable" semantic is folded in via a `{ fallbackCode: "transport" }` option (the per-caller mapping); `retry-policy.ts` now owns only `RetryPolicy`/`DEFAULT_RETRY_POLICY`; `hardened-native.ts` imports classification from the shared module. `AuthSource.headers()` removed from the interface and all impls (Q5 — no production consumer; env transports read their key directly, codex uses `getCredentials()`); tests updated. (`quirks.ts` + `retrying-provider.ts` were already archived to `experimental/` in Phase 3; the archived `retrying-provider` was repointed to the shared classifier.)
- **2.4 Codex stance.** README rewritten to present `codex-native` as the primary ChatGPT-subscription path and `codex-chatgpt` as the team-execution path; `--framework` help lists the full set. Status notes added to `docs/42` and `docs/25 §8a`. `CodexFrameworkEngine` retained (re-evaluate archiving after codex-native soaks as a team peer — Q6).

**Verification:** full `npx tsc -p tsconfig.build.json` + `experimental/tsconfig.json` clean; full vitest **3475 passed / 20 skipped / 0 failed**. Four tests updated for the intended auto→hardened change (`main.test.ts` dump-engine + two sessionId-forwarding tests switched to explicit `--framework native`; `test/integration/framework-inheritance.test.ts` rewritten to test the CLI's argv `--framework` selection since the CLI never read `OPENSWARM_FRAMEWORK` — only workers do).

<details><summary>Original plan (for reference)</summary>

**2.1 Unify engine selection (CLI ↔ worker)**
- Extract shared selection logic from `src/cli/runtime.ts:300-393` and `src/cli/worker-entry.ts:466-529` into one module.
- Add the missing worker `codex-native` branch.
- Replace the worker's silent Claude-SDK fallback (`worker-entry.ts:492-513`) with the same hard error the CLI raises.
- **Auto default → hardened:** `auto` + non-Claude model builds `HardenedNativeEngine`; `--framework native` stays as the explicit escape hatch; update the baseline comment at `src/engine/hardened-native.ts:9-10`.
- Accept: same model+framework+env inputs produce the same engine in CLI and worker; unit tests over the shared selector.

**2.2 Team framework forwarding**
- Thread `MemberSpec.framework`, `model`, `longLived` through `TeamSession.spawnMember()` (`src/swarm/team-session.ts:101-112`), spawn IPC (`src/swarm/ipc/protocol.ts:345-355`), and daemon `send_prompt` ad-hoc spawns (`src/swarm/team-daemon.ts:536-542`).
- Widen the member framework union only to what workers actually support after 2.1 (add `hardened-native`/`native`/`codex-native` as validated).

**2.3 Consolidate duplicated layers (D9, D10)**
- Error classification: fold `src/engine/retry-policy.ts:40` and `src/providers/codex-responses/errors.ts:28` semantics into `src/providers/error-classifier.ts`; one classifier, per-caller mapping.
- **Move to `experimental/`:** `src/providers/quirks.ts` (unused centralized quirk system) and `src/providers/retrying-provider.ts` (superseded by inline hardened retry). xai/dashscope quirks stay inline per-transport with a short comment naming the quirk and why it's inline.
- **Narrow the `AuthSource` contract** (`src/auth/index.ts:14-31`): documented surface becomes `isAuthenticated()` + env-based credential delivery; drop `headers()` from the interface (no production consumer). Any auth machinery left with no consumer after 1.4 wiring moves to `experimental/`.

**2.4 Codex stance (codex-native primary)**
- Document `codex-native` as the primary ChatGPT-subscription path (README + `docs/`); mark `codex-chatgpt` as the team-execution path pending 2.1/2.2 making codex-native available to workers.
- After 2.1 lands, evaluate archiving `CodexFrameworkEngine` to `experimental/` once codex-native covers team spawns.

</details>

---

## Phase 3 — Finish, wire, or archive to `experimental/` (decisions final)

**Status: ✅ DONE (Jul 1, 2026) — archive migration + deletes AND the finish/wire pass (B1–B4) complete.**

- `experimental/` scaffold created: own `tsconfig.json` (noEmit, outside
  `tsconfig.build.json`), CI type-check step added, vitest `include` extended so
  archived tests **keep running** (decision Q1). `experimental/BACKLOG.md`
  catalogs every archived module (what/why/how-to-revive), the outright
  deletions, and the explicit keeps.
- 14 modules (+ their 14 test files) moved with mechanical import rewrites;
  mirrored directory layout under `experimental/` so moves are reversible.
- **Deviation from the original table:** `src/tools/tier0/secrets.ts` was NOT
  archived — verification showed `redactSecrets` is live via
  `output-cleanse.ts` (bash/shell output redaction), and `detectSecrets`/
  `containsSecrets` are its internals. The audit's "stranded" call was wrong;
  recorded under "Explicitly NOT archived" in BACKLOG.md.
- Deletes went slightly deeper than listed: `inbox()` was removed from the
  `SwarmHost` **interface** plus both host impls and the tier2 fake host (all
  were empty generators), along with the now-orphaned `InboxEvent` type.
- StateDB cleanup: goals table DDL, CRUD, `GoalRecord`/`GoalStatus`, and the
  dead `getStateDB`/`setStateDB`/`resetStateDB` singleton all removed;
  `state.test.ts` Goals block dropped (−3 tests).
- Smoke scripts: `smoke-m3b.sh` O3 (stale-branch from `dist/`) records a skip;
  `smoke-m4b.sh` O7 points at `experimental/providers/quirks.test.ts`.
- Verified: clean build (no archived output in `dist/`), experimental
  typecheck green, full vitest 3,404 passed / 20 skipped (289 files — delta vs
  3,407 baseline is exactly the 3 removed goal-CRUD tests; all relocated
  suites still run).

**Decisions recorded for the finish/wire pass (from Jul 1 discussion):**

- Q1: archived tests keep running (cheap).
- Q2: session-end semantics per surface as proposed.
- Q3: `onCompaction` plumbing confirmed during implementation (may touch
  engine event surfaces).
- Q4: session-end archive = compact summary; **when configured, a subagent is
  triggered to produce the summary** (not just static truncation).
- Q5: `memory_search` fan-out — minimem is the primary search-capable
  provider; when multiple search-capable providers are registered, group
  results by provider with source labels, no cross-provider ranking.
- Q6: `MemberSpec.landing?: "merge-to-parent" | "queue-to-branch"`.
- Q7: banned-broad-prefix allow rules: per-session approval supported;
  persistent always-allow refused, **bypassable via an explicit
  yolo/danger-style config flag**.

**Finish / wire in `src/` — ✅ DONE (Jul 1, 2026). How each landed:**

| Item | Action | Landed as |
|---|---|---|
| Memory lifecycle hooks (B1) | Wire `onAfterTurn` post-turn and `onSessionEnd` at session close in `cli/main.ts`, `cli/worker-entry.ts`, `acp/agent.ts`; `onCompaction` where compaction fires. | New `src/memory/turn-observer.ts`: `observeTurnEvents()` wraps one engine.run() event stream — collects tools used + final assistant text, fires `onAfterTurn` on stream end (via `finally`, so aborts count), and forwards `compaction` phase-end NormalizedEvents to `onCompaction` (Q3 confirmed: engines already emit a `compaction` event; no engine change needed). Wired: headless main.ts (wraps the one-shot run), REPL (new `RunReplConfig.wrapTurnEvents` seam so the UI layer stays memory-free), worker-entry (wraps each executeTurn run; records on `TurnContext.memoryTurns`), ACP (wraps each prompt run). Session end per surface (Q2): headless → after run; REPL → after `runRepl` resolves; worker → before exit (both one-shot and long-lived drain paths); ACP → `process.beforeExit` catch-all. |
| Archive persistence (B2, D2) | Route session-end archiving through the MemoryCoordinator provider fan-out; repoint `memory_search`. | `onSessionEnd` now (1) saves via `archiveSession` — whose store is upgraded from in-memory to a durable `FileArchiveStore` JSONL (`~/.openswarm/memory/session-archive.jsonl`) installed by `FileMemoryProvider.initialize` via a new non-clobbering `installDefaultArchiveStore()` (test doubles via `setArchiveStore` still win; vitest never touches the real home dir) — and (2) fans the summary out via `coordinator.onMemoryWrite` so minimem persists it through `appendToday`. `endMemorySession()` composes the summary (Q4: static final-text+tools by default; `OPENSWARM_MEMORY_SUMMARIZER=subagent` runs a one-shot tool-less subagent turn, falling back to static on failure) under a hard 5s timeout (Q2: never hang exit). `MemoryProvider` gains optional `search()`; minimem + file providers implement it; `MemoryCoordinator.search()` fans out and groups by provider (Q5); `memory_search` uses it, falling back to the archive store when no search-capable provider is registered. |
| Merge-queue landing (B3, D3) | Add `MemberSpec.landing`; peer-team selects per member; integrator drain. | `MemberSpec.landing?: "merge-to-parent" \| "queue-to-branch"` (Q6) + zod schema. Peer-team selects the strategy per member from the registry (default unchanged); queue-to-branch success means *enqueued* — after the whole cohort lands, one `drainMergeQueue()` call drains in order, outcome surfaced as a `team_note`; drain failures throw only under `failOnConflict: true`. |
| banned-prefixes (B4, D4) | Wire `checkBannedPrefix()` into the bash gate. | Per the corrected framing (it vets *allow-rules*, not commands): new `src/permissions/session-rules.ts` `SessionAllowRules` — in-memory, session-scoped "always allow" rules keyed on the command's 2-token prefix. Surfaces: REPL `[a]` key, ACP `allow_always` option (previously accepted-and-ignored), headless `a`/`always` stdin answer — all flow a `BridgeDecision.alwaysAllow` marker to the bash gate, which records a rule on approved Warns and skips the repeat prompt on later matches. `tryAdd` refuses banned-broad prefixes via `checkBannedPrefix` (Q7); `danger-full-access` mode bypasses the veto (the yolo flag). Rules only silence Warn prompts — Block results and mode denials are never overridden; nothing persists to disk. |

Verified (Jul 1, 2026 — PM): clean `npm run build` (no experimental output in
`dist/`), experimental typecheck green, full vitest **3,443 passed / 20
skipped (298 files), 0 failures** — +39 tests over the post-archive baseline
(new suites: `turn-observer`, `file-archive-store`, `session-rules`/bash-gate
B4 block, coordinator search, memory_search grouping, peer-team landing).
One stale expectation fixed en route: `acp/permission.test.ts` "maps
allow_always to allow" now asserts the `alwaysAllow: true` marker. A first
full-suite run also hit 14 known-flaky timing failures (shell-session
timing + real-git suites under parallel load); all passed in isolation and
in a clean full rerun.

**Archive to `experimental/` (with tests + BACKLOG.md entries):**

| Item | From |
|---|---|
| ContextBuilder + fragment library | `src/context/` |
| Goals engine | `src/core/goal.ts` (+ remove goal table CRUD from `src/state/index.ts:321-382` and the dead `getStateDB`/`setStateDB`/`resetStateDB` singleton at `:707-725`; goal schema noted in BACKLOG) |
| Agent-scope shared memory | `src/memory/agent-scope.ts` |
| StateDB memory stores | `src/memory/state-store.ts` |
| stale-branch policy | `src/swarm/git/stale-branch.ts` (remove `scripts/smoke-m3b.sh:152` reference) |
| Guardian | `src/tools/tier0/guardian.ts` |
| ~~Secrets detect/redact (D4)~~ | ~~`src/tools/tier0/secrets.ts`~~ **kept in src** — `redactSecrets` is live via `output-cleanse.ts` (see status note above) |
| Network proxy | `src/tools/tier0/network-proxy.ts` (`network-policy.ts` stays — it's live) |
| Mention syntax | `src/tools/tier1/mention-syntax.ts` |
| Image-gen instructions | `src/tools/tier1/image-gen-instructions.ts` |
| ApprovalPolicy | `src/permissions/approval-policy.ts` (+ exec-policy gate hooks; `getExecPolicy` consumers go with ContextBuilder) |
| Centralized quirks + RetryingProvider (D9) | `src/providers/quirks.ts`, `src/providers/retrying-provider.ts` |

**Delete outright (trivial non-features; recorded in BACKLOG "removed outright"):**

- `sub_agent_result` IPC stub (`src/swarm/ipc/protocol.ts:46,111`) — never emitted or handled.
- `src/host/index.ts` barrel — zero internal imports.
- Empty `inbox()` generator (`src/swarm/standalone-host.ts:1226-1227`) — live path is `drainInbox`.
- `createStubSlashRegistry` (`src/ui/repl/state.ts:306-311`) — move into its test file.
- Dead `LEGACY_MCP_PREFIX` branch (done in 0.3).

**Keep in place with clarifying header:**

- ACP rich-client stack (`src/acp/rich-client.ts`, `rich-view.ts`, `rich-format.ts`) — reference client/dev tooling; header states that.
- Orphan-worker scan opt-in (`standalone-host.ts:216-223` + `host/boot.ts:135`) — document the opt-in.

---

## Phase 4 — Daemon completion & test debt

**4.1 Team daemon: close protocol/behavior gap** (after 2.2)
- `status` RPC: return real member states instead of `members: []` (`team-daemon.ts:413-421`).
- **`stop`: implement real worker drain (D11)** — the 4D drain frame the protocol comments promise (`team-daemon.ts:218-235`), draining in-flight workers before socket close.
- Make `permissionMode` and `concurrency` configurable instead of hardcoded (`team-daemon.ts:272-277`); surface the spawn-resolver/`workspace-write` degradation in `team-daemon start` output, not just `team_note` events.
- `team_event` subscribe RPC or officially bless the `events.jsonl` tailing contract (`team-daemon-protocol.ts:16-21`).
- **Re-register `request_permissions` (D7):** wire `setPermissionRequestHandler` to the appropriate bridge per surface (REPL `PermissionBridge`, ACP bridges, worker escalation path), then restore the tool in `buildTier0Tools()`.

**4.2 Test debt (highest-risk untested prod modules)** — ✅ DONE (Jul 2, 2026)
- `src/providers/azure-transport.ts` — new `azure-transport.test.ts` (env helpers, `azureFetch` headers/query/auth-strip, `create()` guards, `stream()` event mapping with `ai.streamText` mocked).
- `LiteLLMTransportProvider.create()`/`stream()` — extended `litellm-transport.test.ts` (missing base URL / unauthenticated guards; `stream()` mapping + option forwarding).
- `src/swarm/adapters/opentasks-client.ts` — new `opentasks-client.test.ts` (in-process Unix-socket JSON-RPC server; ping/create/update/get/query/link happy paths, never-throw failure modes, socket discovery).
- `src/swarm/session-checkpointer.ts` — new `session-checkpointer.test.ts` (`sessionlog` mocked; SessionStart/TurnStart on begin, TurnEnd/SessionEnd on finish, idempotency, disabled/missing-agent nulls, error swallowing).
- `src/cli/host.ts` — new `host.test.ts` (`runHost` boots with resolved defaults, boot-failure → exit 1, graceful SIGTERM/SIGINT shutdown via captured handlers, explicit cwd/host/permissionMode + adapter log).
- `main.test.ts` — added subcommand-dispatch cases: `topology <kind> --spec` → `runTopology`, `team send <name> <prompt>` → `runTeamSend` (joined prompt), `host --port` → dynamically-imported `runHost`.
- `hardened-native.test.ts` — added `RunConfig.host` threading block (batched dispatch ctx default path, host-absent case, eager dispatch ctx).
- **Skipped `<markdown>` streaming tests (D13): both re-enabled.** The root cause for _both_ skips was the same **capture race** — `<markdown>` paints its content a tick after mount (deferred stream-init), so a single `renderOnce()` + immediate `captureCharFrame()` misses the text. Fixed by polling with `waitForContent` (renderOnce + flush loop): `e2e.test.tsx "full turn"` and `transcript.test.tsx "bare-Transcript"` both pass (5/5 stable each). The earlier "bare-render SIGBUS crash" claim was **inaccurate** — the bare `Transcript` renders fine without App composition once capture polls for the paint. Bun UI suite: **155 pass / 1 skip** (the lone skip is the LIVE `cli-bun` model test, unrelated to D13).

**Phase 4 verification (Jul 2, 2026):** clean `npm run build` + `experimental/tsconfig.json` typecheck; full vitest **3,553 passed / 20 skipped / 0 failed** (+3 `main.test.ts` dispatch cases); bun UI suite **155 pass / 1 skip** (both D13 `<markdown>` skips now resolved; the remaining skip is the LIVE model test). The full-suite run surfaced one **latent 4.1e regression**: `acp/e2e.test.ts` "honors a reject" set `permEngine=read-only` but `opts=workspace-write`, relying on the gate's *frozen* engine mode; since 4.1e the gate reads the **live** `currentMode` (so `/permissions` + `request_permissions` elevation work), so the gating tests now drive a read-only `currentMode` (production always pairs engine mode with current mode) — fixed via a dedicated `gatingOpts`.

**4.3 Event-translation dedup (stretch)** — ✅ DONE (Jul 2, 2026)
- Assessment: the three `NormalizedEvent` consumers emit into genuinely different
  targets — ACP → `SessionUpdate` (protocol), repl-solid → `ReplEvent[]` (reducer
  actions), headless → raw JSONL. A single shared "display-model" across
  repl-solid ↔ ACP was **assessed and declined**: repl-solid deliberately
  forwards raw deltas to its reducer (which accumulates tool args in the UI store
  for live chip rendering via `tools/streaming.ts`), while ACP assembles the full
  input at `tool_use_end` to derive title/kind/locations/diff/plan. Forcing a
  neutral middle layer would be a leaky abstraction with no logic to share.
- What was actually shared: the **tool-input reassembly + parse** state machine,
  which headless (`ui/headless.ts`) and ACP (`acp/normalized-translate.ts`) each
  reimplemented. New `src/core/tool-input.ts`: `parseToolInput(raw, fallback)`
  (fallback `"undefined"` for headless — omit the field; `"empty-object"` for ACP)
  + `ToolInputAccumulator<M>` (id → fragment buffer with optional metadata = tool
  name). Headless uses it internally; ACP's `EmitOptions.open` is now a
  `ToolInputAccumulator<string>` (replacing the ad-hoc `OpenTool` map), consumed
  identically by `translator.ts` and `lane-translator.ts`. Headless stays a
  passthrough. Tests: `src/core/tool-input.test.ts` (12 cases).

**Explicitly out of scope (decided):** ACP `TEAM_DEFAULT` stays `true` (D12) — no change; document `--single` prominently in ACP docs instead.

---

## Sequencing summary

| Order | Work | Risk | Depends on |
|---|---|---|---|
| 1 | 0.1 eval fix + CI typecheck step | none | — |
| 2 | 0.2–0.4 hard rename sweep, comments, hygiene | low (breaking renames, pre-1.0) | — |
| 3 | 1.1–1.4 contract fixes (incl. tool_search wiring) | low | — |
| 4 | Phase 3 experimental migration + BACKLOG.md | low | experimental/ convention set up |
| 5 | Phase 3 finish items (memory lifecycle via minimem, merge-queue, banned-prefixes) | medium | experimental migration (StateDB stores moved) |
| 6 | 2.1 engine selection unification (incl. hardened auto) | medium | — |
| 7 | 2.2 team framework forwarding | medium | 2.1 |
| 8 | 2.3 classifier consolidation + AuthSource narrowing, 2.4 codex docs | low-med | 2.1, 1.4 |
| 9 | 4.1 daemon completion (drain, status, request_permissions re-wire) | medium-high | 2.2 |
| 10 | 4.2 test debt, 4.3 dedup | low | any time |
