# OpenSwarm coding-agent product review and roadmap

**Status:** Product audit and proposed direction
**Date:** 2026-07-22
**OpenSwarm snapshot:** local `pareto` at `3b844b5`, npm `0.3.9`; evaluation docs cited as 55–57 on `origin/pareto`, since merged to `main` and renumbered 59–61
**Competitor snapshot:** Claude Code `2.1.217`, Codex `0.145.0`, OpenCode `1.18.4`, Reasonix `1.17.19`

## Purpose

This document reviews OpenSwarm as a coding-agent product, not only as a multi-agent framework. It compares the shipped experience with Claude Code, Codex, OpenCode, and DeepSeek Reasonix; records source-audited correctness and security gaps; and proposes a product roadmap.

The ratings are evidence-backed product judgment, not a cross-product task benchmark. Competitor implementations were reviewed through current public documentation; OpenSwarm received the deeper source audit.

## Executive verdict

OpenSwarm is an impressive multi-agent systems project, but the reviewed release is not yet a safe or reliable replacement for Claude Code, Codex, OpenCode, or Reasonix as a daily interactive coding agent.

The orchestration architecture is ahead of the core conversational product. Its strongest use today is explicit, inspectable, mixed-provider team experimentation in a controlled environment.

| Dimension | Assessment |
|---|---:|
| Daily interactive coding agent | **4–5/10** |
| Headless or one-shot coding agent | **6–7/10** |
| Multi-agent architecture | **7–8/10** |
| General coding-quality improvement from teams | **Unproven** |

### Appropriate uses today

- Explicit multi-agent experiments with inspectable topology and cost.
- Mixed-model teams that need worktree isolation.
- Headless orchestration in a trusted, controlled environment.
- Research into routing, escalation, handoff fidelity, and agent-team protocols.

### Do not use as-is for

- Untrusted repositories.
- Long interactive coding conversations.
- Security-sensitive autonomous execution.
- Workflows that assume teams generally outperform one strong agent.

## Recommended product position

OpenSwarm should position itself as a **coordination control plane for coding agents**, not as another general coding-agent loop.

The defensible product is:

> Run, isolate, observe, steer, recover, and measure teams of coding agents, including agents from different providers.

Where licensing and protocols permit, mature Claude Code, Codex, OpenCode, and Reasonix loops can become worker adapters. OpenSwarm should own:

- task graphs and team topology;
- capability-aware routing;
- worktree and branch isolation;
- event provenance and observability;
- budgets and live cost accounting;
- durable task, inbox, and result state;
- recovery and landing;
- the swarm-aware ACP convention.

Building full daily-driver parity is a valid alternative, but it requires a substantially larger session, safety, sandbox, code-intelligence, recovery, packaging, and TUI program before multi-agent breadth adds product value.

## What OpenSwarm does well

### 1. Real orchestration rather than prompt-only “agents”

OpenSwarm implements multiple explicit topologies, task registries, peer messaging, long-lived workers, a daemon, checkpoint and recovery primitives, and OpenTeams/MAP integration. These are meaningful coordination mechanisms, not only role prompts.

Relevant code:

- `src/swarm/orchestrator.ts`
- `src/swarm/standalone-host.ts`
- `src/swarm/team-session.ts`
- `src/swarm/team-daemon.ts`
- `src/swarm/topologies/`

### 2. A useful event and observability foundation

One event spine drives per-role lanes, tool calls, inline diffs, and a task board across `team watch` and ACP. Detached runs can be redirected with `team send`.

The usage data model and renderer also exist. The current gap is end-to-end wiring: detached daemons do not emit the `team_usage` snapshots that `team watch` expects, and status serialization omits the aggregator’s usage fields.

### 3. Worktree-aware parallel editing

When explicitly enabled, the git-cascade adapter gives members isolated streams and worktrees and contains commit, merge, cascade, and conflict-recovery operations. This is more sophisticated than allowing several agents to edit one checkout concurrently.

The capability is strategically valuable, although the landing race described in P0.7 must be fixed before it can be treated as safe.

### 4. Useful engine and provider abstraction

OpenSwarm supports the Claude Agent SDK, native OpenAI-compatible transports, ChatGPT subscription paths, Bedrock/Azure/LiteLLM-style routing, and per-member model selection. That gives it a credible mixed-provider team story that Claude Code and Codex do not prioritize.

### 5. Serious runtime engineering

The codebase contains thoughtful mechanisms including:

- parallel and eager tool dispatch;
- classified retry with abort-aware backoff;
- compaction and cache telemetry;
- output spill and credential redaction;
- read-before-edit contracts and atomic file writes;
- branch locks and worker termination escalation;
- IPC framing limits and timeout cleanup.

These mechanisms show strong systems ambition. Several are not yet composed into one authoritative end-to-end contract across root, worker, daemon, SDK, and native paths.

### 6. Unusually candid evaluation

The project corrected a false team-inferiority result after finding a spawn bug, repaired broken cost telemetry, and later published a non-replication showing that cascade savings depended on workload composition.

That record is a product strength: it supports narrower claims instead of preserving a favorable headline.

## Competitive comparison

“Leading” below means broad and usable in the reviewed release. It does not imply that every competitor implementation received an equivalent source audit.

| Dimension | OpenSwarm | Claude Code | Codex | OpenCode | Reasonix |
|---|---|---|---|---|---|
| Core interactive coding loop | Weak today | Leading | Leading | Strong | Strong |
| Multi-agent control plane | Leading design; incomplete operations | Strong; shared teams experimental | Strong; v1 stable | Subagents, less team control | Moderate |
| Provider and model choice | Strong | Claude only | OpenAI-first | Leading | Leading |
| Sandbox and permissions | Weak | Strong | Leading | Weak–mixed | Strong on macOS/Linux |
| Context, memory, recovery | Weak–mixed | Leading | Leading | Good | Leading |
| Extensions and integrations | Mixed | Leading | Strong | Leading | Strong |
| TUI, IDE, desktop, remote | Early; core input defects | Leading | Leading | Leading | Leading |
| Evaluation transparency | Leading candor | Not assessed | Not assessed | Not assessed | Not assessed |
| Distribution and maturity | Early alpha | Mature | Mature | Mature | Fast-moving; mature surface |

### Product choice

- **Claude Code:** best default when Claude quality, terminal and IDE polish, plugins, hooks, skills, and the Agent SDK matter most. The tradeoff is model-vendor lock-in; shared agent teams remain experimental.
- **Codex:** best default for OpenAI models, strong cross-platform sandboxing, mature CLI/app/cloud workflows, and stable v1 collaboration. It remains OpenAI-first.
- **OpenCode:** best provider-agnostic general agent with a mature TUI, desktop app, server, SDK, and plugin ecosystem. Its permissions are policy, not built-in OS containment.
- **Reasonix:** best DeepSeek/cache-first long-session experience, with a strong TUI, desktop/ACP support, rewind, LSP, diagnostics, and recovery. Windows shell execution is explicitly unconfined.
- **OpenSwarm:** best fit when the experiment itself is observable, mixed-provider multi-agent work. The P0 findings below should be fixed before general daily-driver positioning.

Parallel agents and worktrees are no longer unique to OpenSwarm. Its meaningful distinction is declarative topology breadth, heterogeneous routing, and git-cascade landing/recovery—not demonstrated task-quality superiority.

## P0: broad-launch blockers

These are source-path findings, not requests for additional polish.

### P0.1 Interactive conversation continuity is broken

The TUI and ACP call `engine.run()` once per prompt, while resume state is consumed once and cleared. Native engines initialize messages inside each run when `resumeFrom` is absent; Claude resumes only when `config.resumeFrom` is supplied. Ordinary follow-up turns therefore begin without prior conversation context.

Evidence:

- `src/ui/repl-solid/index.ts:119–132`
- `src/cli/main.ts:607–656`
- `src/acp/agent.ts:159–190`
- `src/engine/native.ts:160–191`
- `src/engine/hardened-native.ts:250–284`
- `src/engine/claude-agent-sdk.ts:370–390`

Required acceptance test: a two-turn TUI and ACP test on Claude SDK, native, hardened-native, and codex-native proves that turn two can cite a fact supplied only in turn one.

### P0.2 Project code can execute before a trust decision

Hooks and MCP are enabled by default. Project-local `.openswarm` and `.claude` configuration is loaded automatically; MCP commands can spawn at startup and hook commands execute through unsandboxed Bash with provider credentials still present. A content-hash verifier exists but is not invoked by production code. MCP can also infer `"none"` permission from tool-name heuristics, and its list/call operations have no timeout.

Evidence:

- `src/cli/argv.ts:323–329`
- `src/hooks/config.ts:4–23` and `245–298`
- `src/mcp/config.ts:4–23`
- `src/cli/runtime.ts:177–199` and `253–307`
- `src/hooks/runtime.ts:320–350`
- `src/mcp/bridge.ts:35–84`
- `src/mcp/client.ts:125–158`

Required fix: bind approval to canonical repository root plus configuration hash, prevent process creation before approval, default MCP tools to prompt-required, and add bounded call timeouts.

### P0.3 Workspace confinement is inconsistent

Read-only mode permits reads without inspecting tool arguments. `grep`, `glob`, `view_image`, and `notebook_edit` accept arbitrary paths without workspace authorization. Several Tier-0 file tools check only the final path for a symlink, allowing a normal file reached through a symlinked parent directory to escape the workspace.

Evidence:

- `src/permissions/index.ts:30–54`
- `src/tools/tier0/grep.ts:64–99`
- `src/tools/tier0/glob.ts:52–70`
- `src/tools/tier1/view_image.ts:45–80`
- `src/tools/tier1/notebook_edit.ts:80–94` and `212`
- `src/tools/tier0/read_file.ts:92–114`
- `src/tools/tier0/edit_file.ts:148–170`
- `src/tools/tier0/multi_edit.ts:93–113`
- `src/tools/tier0/apply_patch.ts:231–247`

Required fix: one canonical path-authorization service for every file tool, including parent-symlink and TOCTOU defenses.

### P0.4 Shell containment has a fail-open path

The persistent-shell path uses synchronous sandbox startup. If detection has not run, `spawnSandboxedSync` executes the original command even when policy is `require`. `shell_exec` also bypasses the Bash-specific destructive-command validator. Bash does not supply `networkAccess`, causing the bubblewrap path to share host networking.

Evidence:

- `src/tools/tier0/sandbox.ts:230–234` and `600–629`
- `src/tools/tier0/shell-session.ts:93–122`
- `src/permissions/bash-gate.ts:100–110`
- `src/tools/tier0/shell.ts:69–80`

Required fix: one shell execution broker for Bash and persistent sessions, fail-closed `require` behavior, process-group cancellation, and explicit approval for any unconfined fallback.

### P0.5 Default teams cannot complete build-and-test work

The default `workspace-write` mode permits edits but denies `exec`. Built-in team presets advertise Bash to implementers, while detached workers have no interactive approval broker. A default fix team can modify code but cannot run its tests unless started with `danger-full-access`.

Evidence:

- `src/permissions/index.ts:48–55`
- `src/swarm/openteams/presets.ts:83–108`
- `src/cli/worker-entry.ts:276–302`
- `src/swarm/worker-host.ts:347–357`

Required fix: a daemon-backed approval broker with visible approve/deny decisions and command-scoped grants.

### P0.6 The primary TUI input model is internally inconsistent

`Ctrl+A` is both line-home and the global agent-view shortcut. Arrow keys mutate reducer history while also moving an uncontrolled textarea. Reducer value changes are not applied back to the textarea, and plain Tab is not forwarded to the completion handler.

Evidence:

- `src/ui/repl-solid/app.tsx:371–382`
- `src/ui/repl/state.ts:704–711`
- `src/ui/repl-solid/input.tsx:240–275`

Required fix: one owner for input value, cursor, history, completion, and keybinding dispatch, verified with focused PTY tests.

### P0.7 Task and Git landing state can violate correctness

`StandaloneHost.spawn()` records ownership without atomically moving a task out of `pending`, so it can be claimed twice. Terminal worker results do not authoritatively persist registry state.

The git-cascade landing path checks out the target before establishing the expected base SHA. A concurrent branch advance can therefore be lost by a later CAS, and a direct ref update can desynchronize another checked-out worktree.

Evidence:

- `src/swarm/standalone-host.ts:783–823` and `1019–1124`
- `src/swarm/task-registry.ts:84–131`
- `src/swarm/adapters/git-cascade-branch-policy.ts:743–840`

Required fix: transactional task transitions and detached-worktree landing from one captured target SHA, followed by CAS against that same SHA.

### P0.8 Provider retries can repeat irreversible tool side effects

Hardened native execution can dispatch a tool before stream completion. If the provider fails, retry bookkeeping discards the stale result but does not cancel or roll back the first operation. The same non-idempotent call can run twice.

Evidence:

- `src/engine/hardened-native.ts:420–518` and `630–709`
- `src/engine/hardened-native.test.ts:933–981`

Required fix: classify tool idempotency, disable eager dispatch where unsafe, and use attempt-scoped cancellation plus stable idempotency keys.

## P1: high-value product and implementation gaps

| Gap | Why it matters |
|---|---|
| In-session swarm view is half wired | The REPL creates a live `SwarmHost` and event source, but the normal runtime does not register Tier-2 agent/task tools. Detached watch can show lanes, but the daemon does not emit `team_usage`, and status drops usage fields. |
| Curated memory is not durable | `memory_manage` advertises cross-session persistence, but `curated.ts` defaults to `InMemoryStore` and production does not install `StateDB`. CLI turns omit the `projectRoot`/`userId` scope required by `FileMemoryProvider`, so memory is not normally reinjected. Archive search is linear substring matching rather than the documented FTS5 path. |
| Hook surface is partly declarative | The schema accepts 11 events while SDK hook construction exposes six. `PermissionRequest`, subagent lifecycle, and compact lifecycle events lack a production invocation path; hash verification has definitions and tests but no production caller. |
| Sandbox coverage trails competitors | Bash isolation is Linux-only and defaults to `prefer`; lack of a backend falls through to unconfined execution. OpenSwarm has no macOS or Windows backend. |
| Extension configuration does not compose | Hooks and MCP use first-match-wins instead of layered merge. MCP ignores project-root `.mcp.json`, is stdio-only, does not expose resources, and reduces image results to text markers. Plugins can run unsandboxed or full-privilege in-process. |
| Code intelligence and recovery are below baseline | There is no LSP tool path, code-plus-conversation rewind, generic session branching, or native multimodal result path. `view_image` turns up to 20 MiB into roughly 27 MiB of base64 text, while capability filtering is a no-op. |
| Provider metadata and resume are brittle | Capabilities and aliases are hardcoded. `SessionStore` always constructs a Claude SDK snapshot; native snapshots are engine-specific, and root engines lack a session directory. |
| Distribution is narrow | npm ships macOS arm64/x64 and Linux x64 interactive binaries. CI covers macOS/Linux, and the only live provider smoke test is Anthropic. |
| Web SSRF protection does not cover the connection | `web_fetch` validates the initial hostname, then follows redirects and resolves DNS again. Redirect hops, DNS rebinding, and all A/AAAA results are not bound to the validated decision. |
| Supervision and resource bounds are topology-specific | The worker pool is not enforced in `StandaloneHost.spawn`; mid-run abort does not terminate all active workers; heartbeat expiry is absent; inboxes are in-memory; several buffers are unbounded; stale PID fallback can signal a reused unrelated PID. |
| Worker capability parity is incomplete | Team workers build Tier 0 plus Tier 2 only, omitting web, skills, plugins, and MCP. Permission, hook, budget, and dispatch composition differs across SDK, native, worker, and daemon paths. |
| Budget and error semantics are not authoritative | Workers ignore task turn and cumulative limits; successful fanout attempts can finish over budget. CLI swarm checks cost only after all workers finish and can count appended prior-run results. Structured retryable provider errors bypass hardened retry, while an OpenAI error finish reason can become apparent worker success. |
| Task authorization is enforced too late | Tier-2 tools perform some ancestry checks, but the parent accepts caller-supplied scope, identity, and transitions. Identity and ACLs should derive from authenticated transport context. |
| Notebook editing is neither scheduled nor atomic | `notebook_edit` performs read-modify-direct-write without declaring file access or disabling concurrency. Missing access declarations are treated as conflict-free, and the Claude SDK path bypasses dispatcher scheduling. |
| Worktree isolation remains opt-in | git-cascade defaults off, leaving concurrent write-capable workers on the identity adapter and shared working directory unless the operator explicitly enables isolation. |
| Communication policy is descriptive, not enforced | Team communication enforcement, subscriptions, and emissions are schema and prompt guidance; runtime policy materialization remains a documented placeholder. |
| User documentation still overstates partial paths | `docs/USAGE.md` presents all 11 hook events as live and describes SQLite goals/state and `src/context`; `memory_manage` claims cross-session persistence despite the in-memory production default. |

## Architecture assessment

| Layer | Score | Assessment |
|---|---:|---|
| Engine integration | 6/10 | Useful abstraction and provider breadth; session continuity, retry semantics, and capability authority are weak. |
| Tool execution | 6/10 | Strong Tier-0 contracts and dispatcher mechanics; path policy, shell unification, and worker parity remain inconsistent. |
| Permissions and trust | 3/10 | Mode gating exists, but repository trust, project extension execution, and cross-platform containment are not production-safe. |
| Swarm orchestration | 7/10 | The most differentiated layer; operational correctness, approval flow, global supervision, and landing safety need work. |
| Memory and sessions | 4/10 | Good architecture documents and archive primitives; durable curated memory and ordinary conversation continuity do not match the claims. |
| CLI and TUI | 4/10 | Broad surfaces and a useful team board; the main input path and in-session team execution are not dependable. |
| Observability | 6/10 | Strong event model, lanes, usage aggregation, and eval instrumentation; detached live usage is incomplete. |
| Extensibility | 5/10 | Hooks, MCP, plugins, skills, ACP, and MAP are broad; trust, merge semantics, event completeness, and worker exposure are uneven. |
| Packaging and operations | 5/10 | Compiled binaries and release tooling exist; platform matrix and live provider coverage are narrow. |

The strongest layer is the swarm architecture and event model. The weakest layer is the trust boundary around repository-controlled execution, followed by session continuity.

The main design smell is that broad documented surfaces exist before one coherent product contract spans every engine, frontend, and worker composition root.

## What the evaluation record actually supports

| Study | Result | Supported conclusion |
|---|---|---|
| [docs/47](./47-h1-experimental-findings.md), hard 9 | Single 1/9; functioning team 1/9 on two model families | No observed advantage in an underpowered one-seed study—not evidence of parity. Best-of-5 single reached 2/9. |
| [docs/54](./54-hard-slice-findings.md), selected hard slice | All main arms q0.31; `τ0.5` 21.9M vs mono-large 22.6M tokens | Failure-selected, two-seed evidence; the cost-pipeline claim was superseded by docs/59. |
| [docs/59](./59-powered-frontier-findings.md), favorable three-task mix | Cascade q0.80 at $2.38 vs mono-large q0.80 at $2.82 | Directional 15% saving after cost-axis bugs were fixed; pilot scale only. |
| [docs/60](./60-gap-regime-findings.md), pure gap slice | Cascade q0.90/$1.23 vs mono-large q1.00/$1.25 | No frontier expansion; the cheap attempt roughly broke even with handoff benefit. |
| [docs/61](./61-composition-sweep-findings.md), random eight-task slice | Cascade q0.95/$1.51 vs mono-large q1.00/$1.42 | Dominance did not replicate: approximately 6% higher cost; handoff bloat can make escalation worse. |

The honest claim boundary is:

> Heterogeneous routing can save money on favorable workloads. The project does not yet have robust evidence that swarms generally improve coding quality or Pareto-dominate a strong single agent.

The selected parity gate uses a mixed corpus, capability-specific preregistered comparators, paired seeds, and the same exact provider/model where possible. Task success is non-inferior only when the paired 95% bootstrap lower bound is above −5 percentage points; median single-agent wall time must be at most 1.25× and model cost at most 1.15× the comparator. Safety/correctness remains a 100% gate.

## Roadmap

The product decision is to pursue full daily-driver parity despite this review’s control-plane-first recommendation. Dependency and capacity review produced a 50-week baseline with three engineers; four provide enough capacity for 39 weeks, but that variant still needs a separate dependency schedule. The detailed capability contract, work packages, gates, and staffing model are in [63-product-parity-roadmap.md](./63-product-parity-roadmap.md).

Resolved product-policy defaults:

- Full encrypted session history with automatic 90-day purge; if no secure key provider exists, use an explicit ephemeral session and never plaintext.
- Exact certified provider/model/API identifiers; other models remain usable but visibly `unverified` and excluded from parity claims.
- Session-scoped exact-resource/operation approval grants by default.
- Selective OpenCode alignment for configuration, provider/model selection, permission presentation, MCP UX, and explicit sharing—not weaker trust or containment assumptions.
- OpenSwarm-native extensions, remote MCP OAuth/named-secret tokens, and explicit source/content-hash-pinned plugin trust.
- Provisional reader output with automatic revalidation; N/N−1 persisted-state compatibility.
- Local-only telemetry/diagnostics by default; redacted transmission requires explicit opt-in.

### 0–30 days: correctness and trust

Do not add more topologies during this phase.

1. Persist and auto-resume conversation state after every interactive and ACP turn.
2. Add repository trust for hooks, MCP, and project plugins.
3. Centralize canonical path authorization for every file tool.
4. Unify Bash and persistent-shell execution and make isolation fail closed.
5. Add a daemon-backed team approval broker.
6. Replace the split TUI input model.
7. Guard eager retries with idempotency and attempt-scoped cancellation.
8. Make task transitions and Git landing authoritative.
9. Align documentation and tool descriptions with production-path tests.

Exit criteria:

- all four interactive engine paths pass a two-turn continuity suite;
- a fresh clone cannot start a project-controlled process before trust approval;
- parent-symlink, absolute-path, and TOCTOU cases fail across all file tools;
- default fix/review teams can request and receive scoped test execution;
- concurrent claims are at-most-once and target-branch races cannot lose commits;
- non-idempotent tool calls execute at most once per logical call.

### 30–90 days: daily-agent baseline

- **Permissions:** last-match `allow`/`ask`/`deny` rules by tool, command, path, domain, and external directory; explicit deny always wins and approvals default to session scope.
- **Isolation:** Seatbelt on macOS, WSL2/container-backed Windows execution, sandboxed hooks/MCP/plugins, network proxy policy, and secret-read denies. Shared workspace remains the default with one writer; overlapping reader output remains provisional until automatic revalidation. Explicit worktree mode permits parallel writers with serialized landing.
- **Recovery:** code-plus-conversation checkpoints, rewind, fork/copy session, durable native snapshots, encrypted 90-day default storage, secure-key providers, ephemeral no-key behavior, and crash-safe ownership.
- **Supervision:** one global worker quota, heartbeat expiry, live budget enforcement, bounded buffers, abort propagation, and authenticated daemon ownership.
- **Team UX:** emit live usage snapshots; show cost in watch/status; add drill-down, patch review, conflict resolution, and steering receipts.
- **Code intelligence:** optional LSP diagnostics, definitions, references, and rename with bounded startup.
- **Multimodal:** typed image blocks through provider transports, clipboard/file attachments, bounded storage, and capability-gated registration. Broad notebook parity is deferred; the existing tool remains disabled by default until centrally authorized and atomic.
- **Extensions:** OpenCode-inspired layered configuration and MCP UX; stdio/streamable HTTP MCP with OAuth/named-secret tokens; hash-pinned native plugins; trust diagnostics, complete hook events, and compatibility tests.
- **Distribution:** Windows and Linux arm64 interactive binaries plus a provider-by-platform live smoke matrix.

### 90+ days: complete full daily-driver parity

- Finish canonical sessions, recovery, headless/ACP parity, typed media, LSP, platform packaging, and release migration.
- Certify exact Anthropic, OpenAI, and Gemini model IDs; label other models `unverified`.
- Run the mixed-corpus non-inferiority and efficiency gates; publish only capability-linked claims.
- Add resumable team sessions with durable inboxes and ambiguity-aware result semantics.
- Add per-member pause, resume, replace, and delivery receipts.
- Add interactive merge queues and conflict resolution.
- Use capability discovery to select workers from real certified features rather than declared model names.
- Bound handoff context and route from calibrated confidence/task shape, but make no general swarm-quality claim without new evidence.

## Verification status

This was a static audit. Tests were not executed because the workspace rule requires repository commands to run through Docker Compose and this repository contains no Compose definition.

Important missing regression coverage includes:

- ordinary two-turn continuity on every engine and frontend;
- duplicate task claiming and terminal registry transitions;
- mid-flight abort of active topology workers;
- successful over-budget runs;
- concurrent target-branch advance during landing;
- redirect-to-private-host and DNS-rebinding fetches;
- synchronous `require` sandbox startup;
- concurrent and interrupted notebook edits;
- concurrent writers with git-cascade omitted;
- duplicated eager side effects across provider retry.

## Current external references

- [Claude Code documentation](https://code.claude.com/docs/en/overview)
- [OpenAI Codex documentation](https://developers.openai.com/codex/)
- [OpenCode documentation](https://opencode.ai/docs)
- [DeepSeek Reasonix `main-v2` documentation](https://github.com/esengine/DeepSeek-Reasonix/tree/main-v2/docs)
