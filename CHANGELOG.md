# Changelog

## Unreleased

### Breaking — environment variable and path renames (pre-1.0 hard cut, no fallbacks)

Renamed legacy `SWARM_*` names to the `OPENSWARM_*` namespace:

- `SWARM_MEMORY_PROVIDERS` → `OPENSWARM_MEMORY_PROVIDERS`
- `SWARM_WEB_SEARCH_BASE_URL` → `OPENSWARM_WEB_SEARCH_BASE_URL`
- `SWARM_MAP_SERVER` → `OPENSWARM_MAP_SERVER` (`--map-server` alias)
- `SWARM_ACP_LIVE` → `OPENSWARM_ACP_LIVE` (test gate)
- `SWARM_ACP_BENCH` / `SWARM_ACP_BENCH_N` → `OPENSWARM_ACP_BENCH` / `OPENSWARM_ACP_BENCH_N` (bench gate)
- `.swarm-base` stale-base marker file → `.openswarm-base`

Smoke scripts: all `SWARM_CODER_*` variables (never read by the runtime since the
openswarm rename) → their functional `OPENSWARM_*` equivalents
(`OPENSWARM_TEST_SCRIPT`, `OPENSWARM_PLUGINS_DIR`, `OPENSWARM_CONFIG_DIR`,
`OPENSWARM_SKIP_LIVE`, `OPENSWARM_SKIP_INTEGRATION_BUILD`). `smoke-m4b.sh` [O6]
now runs the current `openai-codex-oauth*.test.ts` files.

**Cross-repo path migration (`.swarm` → `.openswarm`), phase 1 — dual support.**
The session (`.swarm/openswarm/sessions`) and opentasks-socket
(`.swarm/opentasks`) layouts are contracts shared with the `sessionlog` and
`opentasks` sibling repos, so they can't be hard-cut unilaterally. All three
repos now **honor both names, preferring the new `.openswarm/…` layout when it
exists** and falling back to legacy `.swarm/…`:

- openswarm: `resolveSessionsDir` and `findOpenTasksSocket` prefer `.openswarm`,
  else `.swarm` (still the fresh-create default).
- sessionlog: the openswarm adapter's `getSessionDir` / `detectPresence` check
  both layouts and `protectedDirs` now guards `.openswarm` too.
- opentasks: `resolveProjectDir`, `discover` candidates, client walk-up, and
  `deriveRepoRoot` all recognize `.openswarm/opentasks` ahead of `.swarm/opentasks`.

Migration is opt-in per project (create/move to `.openswarm/…` and every repo
follows). **Phase 2 (later)** flips the fresh-create defaults to `.openswarm`;
**phase 3** drops the `.swarm` fallbacks.

### Added

- Memory lifecycle is now fully wired (Phase 3 B1/B2). Every engine turn on
  the single-agent CLI (headless + REPL), swarm workers, and the ACP adapter
  is observed: `onAfterTurn` fires with tools used + a final-text summary,
  `onCompaction` forwards engine compaction boundaries, and session end
  archives a compact session summary. Session-end semantics per surface:
  headless after the run, REPL on exit, workers before process exit, ACP on
  `process.beforeExit` — all best-effort under a hard 5s timeout.
- Session archives are durable: `FileMemoryProvider` installs a JSONL-backed
  archive store at `~/.openswarm/memory/session-archive.jsonl` (replacing the
  volatile in-memory default), and the session summary also fans out to
  minimem (when available) via the coordinator's `onMemoryWrite`
  (`appendToday`). Set `OPENSWARM_MEMORY_SUMMARIZER=subagent` to have a
  one-shot tool-less subagent write the session summary instead of the
  static final-text truncation.
- `memory_search` now queries the MemoryCoordinator's search-capable
  providers (minimem hybrid search + the file session archive), returning
  results grouped by provider with source labels — no cross-provider
  ranking. Falls back to the archive store when no provider is registered.
- Bash "always allow (this session)": approving a bash Warn prompt with the
  new REPL `[a]` key, the ACP `allow_always` option (previously accepted but
  ignored), or a headless `a`/`always` answer records a session-scoped allow
  rule so identical-prefix commands skip the repeat prompt. Overly broad
  prefixes (`bash`, `python`, `bash -c`, `git`, …) are refused via
  `checkBannedPrefix` — the call still runs once, but no standing rule is
  created — unless the session runs in `danger-full-access` mode. Rules are
  in-memory only, never persisted, and never override Block results or mode
  denials.
- Per-member landing strategies for peer teams: `MemberSpec.landing:
  "merge-to-parent" | "queue-to-branch"`. Queue-to-branch members are
  enqueued instead of merged directly; after the cohort lands, the topology
  drains the merge queue in order (the integrator action) and reports the
  outcome as a `team_note`. Drain failures fail the topology only under
  `mergeStreams.failOnConflict: true`.
- `topology committee` and `topology critic-loop` are now accepted by the CLI
  (the topology executors shipped in v0.5; only the parser gate remained).
- The ecosystem adapter flags (`--opentasks[-socket]`, `--agent-inbox`,
  `--git-cascade`, `--cleanup-worktrees`) now work on `topology` and
  `team start`, not just `swarm run` — one shared host-assembly path
  (`src/cli/adapter-host.ts`). `team start --detach` rejects the combination
  explicitly (the forked daemon builds its own host) instead of silently
  dropping the adapters.
- `tool_search` is now wired for real: the runtime populates its registry from
  the fully assembled tool surface (tier0 + tier1 + plugins + MCP; workers:
  tier0 + tier2 post-allowlist). Previously the registry was only ever set in
  tests, so searches matched nothing.
- grok / gemini / qwen / kimi models now self-describe their auth
  (`XAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` / `DASHSCOPE_API_KEY`) via
  routing `authFactory`, and `detectAuth` recognizes the Google/DashScope keys
  — a model id with only its provider key set reaches the transport instead of
  throwing.
- The single-agent CLI and swarm workers now share one engine selector
  (`src/cli/select-engine.ts` `planEngine`), so a given model + framework + env
  resolves to the same engine on both paths (Phase 2.1). Workers gained the
  in-process `codex-native` engine, so a team member can run on a ChatGPT
  subscription without the Codex CLI.
- Team members can select their engine per member:
  `MemberSpec.framework: "claude-agent-sdk" | "codex-chatgpt" | "codex-native" |
  "native" | "hardened-native"` (omit for `auto`). The value is forwarded to the
  spawned worker via `OPENSWARM_FRAMEWORK`, and a daemon `send_prompt` ad-hoc
  member now inherits the team template's `model`/`framework` (Phase 2.2).
- Team daemon completion (Phase 4.1): the `status` RPC returns **live member
  states** (spawning/running/idle/finished/failed, driven off host lane events)
  instead of an empty list; `permissionMode` and `concurrency` are
  **configurable** via `OPENSWARM_DAEMON_PERMISSION_MODE` /
  `OPENSWARM_DAEMON_CONCURRENCY` and echoed at `team-daemon start` (with a
  spawn-resolver degradation warning when the mode can't support it); `stop`
  performs a **real worker drain** (long-lived `drain()` + bounded-timeout
  one-shot await, then force-close) while `kill` force-closes immediately.
- `events.jsonl` is now the **blessed local event-follow contract**: a metadata
  header, filtered recorded events, and a structured reader
  (`src/swarm/events-log.ts`) in lieu of a socket-based `team_event` subscribe RPC.
- `request_permissions` is **re-registered** on the single-agent REPL and
  headless paths (Phase 4.1e). The elevation handler clamps the request against
  the CLI-defined mode ceiling and prompts through the REPL `PermissionBridge`
  or the headless stdin approver; approval mutates the live session mode.

### Changed

- **`--framework auto` now builds `HardenedNativeEngine` for every non-Claude
  model** (retry + eager tool dispatch + mid-turn compaction), on both the CLI
  and workers (Phase 2.1). Claude still routes through the Agent SDK.
  `--framework native` remains the explicit non-hardened escape hatch.
- Workers now **hard-error** when an explicit `--framework native` /
  `hardened-native` is paired with a Claude model, matching the CLI, instead of
  silently downgrading to the Agent SDK (Phase 2.1).
- Error classification is consolidated into a single classifier
  (`src/providers/error-classifier.ts`): a shared HTTP-status→code table
  (`httpStatusToProviderCode`) and `isRetryableError` now back the AI-SDK
  transports, the codex Responses path, and `HardenedNativeEngine` (which opts
  into transport-fallback semantics for bare stream errors). `engine/retry-
  policy.ts` keeps only the retry-policy knobs (Phase 2.3).

### Removed

- `AuthSource.headers()` removed from the interface and every implementation —
  it had no production consumer (env-key transports read their key directly and
  the codex OAuth source exposes `getCredentials()`). `isAuthenticated()` and
  the optional `refresh()` are the remaining surface (Phase 2.3).
- 14 never-wired modules moved out of the build into `experimental/`
  (archived-but-revivable; catalogued in `experimental/BACKLOG.md`, tests
  still run in CI): ContextBuilder (`src/context/`), curated memory fragment,
  agent-scope shared memory, StateDB memory stores, the Goal/GoalRegistry
  engine, stale-branch policy, guardian, network proxy, exec-policy summary,
  mention syntax, image-gen instructions, ApprovalPolicy, centralized
  provider quirks, and RetryingProvider. `src/` never imports from
  `experimental/`.
- StateDB goal persistence removed (`goals` table DDL, CRUD methods,
  `GoalRecord`/`GoalStatus` types) along with the unused
  `getStateDB`/`setStateDB`/`resetStateDB` singleton. Existing databases keep
  their `goals` table; fresh databases no longer create it.
- `SwarmHost.inbox()` removed from the host interface, both implementations,
  and the `InboxEvent` type — every implementation was an empty generator;
  the live path is `drainInbox()` + `sub_agent_event` IPC delivery.
- `sub_agent_result` IPC notification method removed (stub-only; never
  emitted or handled). `src/host/index.ts` barrel removed (zero importers).
- `request_permissions` is no longer registered as a tier 0 tool. Its
  permission-elevation handler was never connected to a live bridge, so the
  model was offered a tool that always errored. The module and tests remain;
  it returns when the handler is wired (remediation plan Phase 4.1).

### Changed — docs reorganization

- 26 historical docs (milestone plans 08–24, team spikes 26/26b/27, ACP build
  records 30/32–35, hardened-engine plan 38) moved to `docs/archive/`. Numbers
  are stable and never reused; all intra-repo links and `docs/NN` code-comment
  citations were updated. External links to the old `docs/` paths will 404.
- `docs/README.md` rewritten as a full categorized index (previously 24 docs
  were unlisted).

### Build & CI

- Removed empty `.gitmodules` and the `submodules: recursive` checkout option.
- `*.tgz` (npm pack artifacts) now gitignored.
- CI verifies `bun.lock` freshness (`bun install --frozen-lockfile --dry-run`)
  after `npm ci`; dual-lockfile policy documented in README § Package
  management. `bun.lock` resynced with `swarmkit-eval@^0.0.7`.

### Fixed

- `eval/` harness imports updated for `swarmkit-eval@0.0.7` (`swarmHarness*` →
  `openSwarm*`); eval typecheck added to CI.
- The permission gate now checks the **live** current mode
  (`getCurrentMode()`) rather than the `PermissionEngine`'s frozen construction
  mode, so `/permissions` and `request_permissions` elevation actually reduce
  future denials mid-session (Phase 4.1e). `PermissionEngine.check()` accepts an
  optional mode override to support this.
- Re-enabled both previously-skipped `<markdown>` streaming tests (D13): the
  App-composed `e2e.test.tsx "full turn"` and the bare `transcript.test.tsx`
  case. Both were the same capture race — `<markdown>` paints a tick after
  mount, so an immediate frame capture missed the text; polling for the
  deferred render fixes them. (The prior "bare-render SIGBUS" note was
  inaccurate; bare `Transcript` renders fine without App composition.)

### Testing

- Added coverage for previously-untested prod modules (Phase 4.2):
  `azure-transport`, `litellm-transport` `create()`/`stream()`,
  `opentasks-client` (in-process JSON-RPC server), `session-checkpointer`,
  `cli/host` `runHost` signal handling, `hardened-native` `RunConfig.host`
  threading, and `main.ts` subcommand dispatch (topology / team send / host).
- Extracted the shared tool-input reassembly/parse state machine into
  `src/core/tool-input.ts` (`parseToolInput` + `ToolInputAccumulator`), consumed
  by the headless JSONL emitter and the ACP translator; the repl-solid REPL
  keeps its reducer-based accumulation (Phase 4.3).
