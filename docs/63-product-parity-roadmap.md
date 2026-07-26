# OpenSwarm product-parity roadmap

**Status:** Proposed program plan
**Date:** 2026-07-22
**Target:** Parity beta in 50 weeks; the original 39-week capacity bound requires a fourth engineer and a separate dependency schedule
**Staffing assumption:** 3 core engineers; 2 engineers require approximately 75 weeks with equivalent reserve
**Refines:** [58-coding-agent-product-review.md](./58-coding-agent-product-review.md)
**Benchmark:** Claude Code/Codex daily-driver core plus selected OpenCode/Reasonix strengths

## Decision summary

This plan deliberately chooses full daily-driver parity over the control-plane-only strategy recommended by the product review.

Parity means equivalent user outcomes and safety properties. It does not require copying competitor command names, keybindings, screen layouts, proprietary session formats, or plugin marketplaces.

The release target is a **parity beta**, not a compatibility-stable 1.0. Dependency and capacity review invalidated the original nine-month date under the fixed three-engineer scope; the executable baseline is 50 weeks. Breaking changes remain allowed before 1.0, but migrations must be explicit, reversible, and non-permission-broadening.

### Locked product decisions

- Surfaces: CLI/TUI, headless JSONL, and ACP/IDE.
- Deferred surfaces: desktop, remote execution, and hosted/cloud control planes.
- Providers: Anthropic, OpenAI, and Gemini.
- Languages: TypeScript, Python, and Go.
- IDE client: Zed through ACP.
- Platforms: macOS arm64/x64, Linux x64/arm64, and Windows 11 x64 through WSL2/container isolation.
- Mandatory selected strengths: provider portability, safe extensions, rewind/fork, core LSP, and image attachments.
- Shared workspace remains the default.
- Shared mode permits one writer; read-only agents may overlap the writer. Reader output streams as provisional, revalidates automatically, and becomes terminal only after verification.
- Explicit isolated-worktree mode permits parallel writers with serialized compare-and-swap landing.
- Autonomous network and secret access are denied by default and require explicit grants.
- Approval grants default to the current session and bind the exact resource plus operation class; one-shot and trust-bound persistent grants remain explicit alternatives.
- Headless approvals deny by default; an authenticated local approval API may wait for a bounded period.
- Session storage is configurable. With no configuration, OpenSwarm retains full encrypted history for 90 days. If no secure key provider is available, it uses an ephemeral session with a clear warning and never falls back to plaintext.
- Each provider certifies an exact model/API identifier. Uncertified models remain usable with a visible `unverified` label and cannot support parity or compatibility claims.
- OpenCode is the reference for configuration layering, provider/model selection, permission presentation, MCP UX, and explicit sharing. OpenSwarm retains stricter trust, encryption, containment, provenance, and certification contracts.
- Parity beta guarantees OpenSwarm-native skills/hooks/plugins and core MCP over stdio and streamable HTTP. Remote MCP supports OAuth and static tokens delivered through the named-secret broker.
- Native plugins require explicit install/trust plus source and content-hash pinning. Signatures are optional in beta; content changes invalidate trust.
- Every beta schema reads N and N−1 and writes only N; older state is archived read-only or rejected explicitly.
- Telemetry and diagnostics stay local by default. Redacted transmission requires explicit opt-in.
- Parity uses a mixed corpus of deterministic fixtures, pinned public repositories, and an optional private holdout.
- Every workflow preregisters one capability-specific comparator and uses the same exact provider/model where possible.
- Task success must be non-inferior by five percentage points: the paired 95% bootstrap lower confidence bound must remain above −5 points.
- Single-agent median wall time must be at most 1.25× and model cost at most 1.15× the comparator.
- Existing topology breadth is frozen through parity beta.
- No product claim may state that teams improve solution quality without new evidence.

## Feasibility

The fixed scope requires:

- 102 core person-weeks of feature/work-package delivery;
- 36 person-weeks explicitly allocated to integration, tests, migration, documentation, remediation, and release quality;
- 12 person-weeks of true contingency;
- an external security review;
- periodic UX/QA support around the alpha, preview, and beta gates.

Three engineers over 50 weeks provide 150 person-weeks. Four engineers provide enough gross capacity for the original 39-week target, but that variant still requires a resource-constrained dependency schedule. Two engineers require about 69 weeks for committed work or 75 weeks with equivalent contingency.

Dates move before mandatory safety, session, support-matrix, or verification gates are weakened.

## Principles

1. Safety and recoverability precede autonomy.
2. One canonical session, policy, workspace, and event contract serves every surface.
3. Unsupported environments fail closed.
4. Parity is demonstrated through workflows and conformance evidence.
5. Existing swarm breadth is maintained but not expanded until the core is trustworthy.

## Capability contract

Every mandatory capability has a stable ID, comparator version, supported matrix, owner, automated evidence, and release gate. A weighted average cannot hide a failed safety or correctness capability.

### Daily-driver core

| ID | Required outcome | Beta evidence |
|---|---|---|
| `DDP-CORE-01` | Inspect, search, edit, diff, execute, and test TypeScript, Python, and Go repositories | Standard fix journey passes with one certified model from each provider |
| `DDP-CONV-01` | Automatic conversation continuity | Ten turns retain prior text and tool results without `/resume` |
| `DDP-HDL-01` | Versioned non-interactive protocol | Deterministic JSONL, exit codes, cancellation, sessions, resume, attachments, and approval outcomes |
| `DDP-ACP-01` | Zed ACP daily-driver workflow | Streaming, tools, diffs, approvals, cancellation, images, resume, and errors round-trip |

### Sessions and recovery

| ID | Required outcome | Beta evidence |
|---|---|---|
| `DDP-SES-01` | Durable crash-safe sessions | Fault injection loses no acknowledged event and blindly repeats no ambiguous side effect |
| `DDP-SES-02` | Checkpoint, conversation/code rewind, and fork | Restored state matches checkpoint hashes; original history remains intact |
| `DDP-MEM-01` | Durable curated memory and archive | Default encrypted 90-day history survives restart; configured retention/export/deletion work; unavailable secure keys produce an explicit ephemeral session |

### Safety and extensions

| ID | Required outcome | Beta evidence |
|---|---|---|
| `DDP-SAFE-01` | Trust before project automation | A malicious fresh clone starts no process, network request, or secret access before trust |
| `DDP-SAFE-02` | Canonical workspace confinement | Absolute, traversal, ancestor-symlink, broken-symlink, and swap-race corpus produces zero escapes |
| `DDP-SAFE-03` | Contained process execution | Shells, hooks, MCP, plugins, and LSP use one broker; missing isolation executes nothing |
| `DDP-SAFE-04` | Default-denied network and secrets | Only explicit domain/named-secret grants work; SSRF, rebinding, redirects, and ambient credential leaks fail |
| `DDP-SAFE-05` | Unified approvals | TTY/ACP approve; headless denies unless an authenticated, bounded request succeeds; default grants remain exact-resource, operation-class, and session scoped |
| `DDP-EXT-01` | Safe extension baseline | Skills/hooks/plugins and local/remote MCP have provenance, OAuth/named-secret auth, hash-pinned plugins, policy, time/output bounds, and cancellation |
| `DDP-PRIV-01` | Local-first diagnostics | No diagnostic, usage, transcript, or code data leaves the machine except provider calls or an explicit redacted-telemetry/share action |

### Providers, intelligence, and media

| ID | Required outcome | Beta evidence |
|---|---|---|
| `DDP-PROV-01` | Anthropic/OpenAI/Gemini portability | One exact model/API identifier per provider passes the same contract; other models are visibly `unverified` and excluded from claims |
| `DDP-LSP-01` | Core LSP | Diagnostics, definition, references, and transactional rename pass with TypeScript, Python, and Go |
| `DDP-MEDIA-01` | Image attachments | TUI, headless, and ACP send validated typed images without transcript-embedded base64 |

### Product UX and observability

| ID | Required outcome | Beta evidence |
|---|---|---|
| `DDP-UX-01` | Deterministic TUI input | Cursor, history, multiline, Tab, paste, global chords, and approval keys pass PTY tests |
| `DDP-UX-02` | Transparent execution/recovery | Tool activity, approvals, diffs, checkpoints, patches, and conflicts are inspectable |
| `DDP-UX-03` | Observable teams | Agent tree, task board, steering, usage, failures, and patch state derive from real events |
| `DDP-OBS-01` | Auditable provenance and usage | Every effect records principal, decision, grant, attempt, generation, terminal result, and redacted cost |

### Swarm and platform correctness

| ID | Required outcome | Beta evidence |
|---|---|---|
| `DDP-SWM-01` | Authorized atomic task state | One claimant wins; invalid or unauthorized transitions fail |
| `DDP-SWM-02` | Safe shared workspace | One writer; overlapping reader output is provisional, generation-stamped, automatically revalidated, and terminal only when verified |
| `DDP-SWM-03` | Safe isolated writers | Worktree writers overlap; landing is serialized and target-SHA compare-and-swap safe |
| `DDP-SWM-04` | Supervision and bounded resources | Quotas, heartbeats, queues, cancellation, cleanup, and budgets survive an eight-hour soak |
| `DDP-REL-01` | Retry-safe side effects | Committed or ambiguous mutating calls are never blindly replayed |
| `DDP-PLAT-01` | Focused platform matrix | All five platform targets pass release suites; native Windows shell execution is rejected |
| `DDP-EVAL-01` | Evidence-backed claims | Mixed-corpus paired evaluation clears the −5-point 95% confidence bound plus 1.25× latency and 1.15× cost guardrails; every claim links to evidence |

## Scope boundaries

### In scope

- One authoritative runtime contract across root agents, workers, daemons, TUI, headless, and ACP.
- Safe local single-agent and existing team workflows.
- Shared workspace and explicit isolated worktrees.
- Durable sessions, checkpoints, rewind, fork, memory, encrypted 90-day default retention, configurable storage policy, and ephemeral fail-closed behavior when no secure key exists.
- Safe skills, hooks, MCP, and native OpenSwarm plugin execution.
- MCP stdio and streamable HTTP tools/resources needed by the certified test set, including remote OAuth and named-secret bearer tokens.
- OpenCode-inspired configuration/provider/permission/MCP UX with OpenSwarm-specific safety enforcement.
- Local-only diagnostics by default with explicit redacted telemetry/sharing opt-in.
- TypeScript via `typescript-language-server`, Python via Pyright, and Go via `gopls`.
- Typed image attachments and bounded content storage.
- Provider-specific state where needed, with provider-neutral canonical events.

### Explicitly deferred

- Desktop applications, remote execution, cloud hosting, and OpenHive Track B.
- Native PowerShell/CMD autonomous execution.
- New topologies and adaptive-topology productization.
- Claims that swarms outperform a strong single agent.
- Broad notebook UX; the existing notebook tool is disabled by default until centrally authorized and atomic.
- Broad Claude/OpenCode plugin compatibility or a marketplace.
- Server-initiated MCP sampling/elicitation and other advanced primitives beyond the certified core.
- Providers, languages, ACP clients, and platforms outside the focused matrix.
- Advanced LSP features such as semantic tokens, call hierarchy, and refactoring catalogs.
- Compatibility-stable 1.0 and guaranteed cross-provider transcript migration.

## Architecture decisions

### A0. Thin effect-transaction foundation

The roadmap begins with one vertical walking skeleton, not a broad platform rewrite.

`SessionKernel` delegates each effect to `EffectRuntime`. The durability order is:

1. canonicalize resources through `WorkspaceAuthority`;
2. authorize the discriminated request through `PolicyEngine`;
3. durably append `AttemptPrepared` with operation ID, idempotency class, policy decision, and expected workspace state;
4. execute through the process broker or typed tool executor;
5. durably append a terminal result or `outcome_unknown`;
6. acknowledge the effect to the engine/frontend.

An unresolved mutating attempt is never replayed automatically. Recovery requires reconciliation or an explicit user decision.

The walking skeleton proves one Linux-x64 turn through that entire order, one file write CAS, restart, and one UI/event projection before the abstractions expand to every provider and surface.

The canonical contracts frozen by this slice are:

- `EventEnvelope`
- `ContentPart`
- discriminated `OperationRequest`
- `EffectOutcome`, including `outcome_unknown`
- `ReadSet`
- opaque `EngineSessionState`

### A1. Session kernel as coordinator

Add a frontend- and provider-neutral coordinator above `AgentEngine`; do not make it a monolithic state store.

`SessionKernel` owns transaction ordering and coordinates:

- `EventStore`
- `CheckpointStore`
- `EngineSessionAdapter`
- `WorkspaceAuthority`
- `EffectRuntime`
- attachment, memory, migration, retention, and encryption services

Engines retain provider-specific compaction and opaque resume state. They do not become competing session authorities. The kernel records compaction boundaries and opaque adapter state without attempting to normalize provider internals.

`AgentEngine.run()` remains a migration adapter while engines move toward `EngineSessionAdapter.runTurn`, `snapshot`, and `restore`.

Legacy Claude imports are read-only/lossy when tool, reasoning, or attachment blocks cannot be reconstructed.

Primary touchpoints:

- `src/engine/index.ts:49-315`
- `src/engine/native.ts:160-228`
- `src/engine/hardened-native.ts:250-292`
- `src/engine/claude-agent-sdk.ts:369-430`
- `src/session/store.ts:1-15,32-53,76-150`
- `src/cli/main.ts:520-666`
- `src/acp/agent.ts:99-203`
- `docs/48-compaction-design.md:100-149`

Likely new modules:

- `src/session/kernel.ts`
- `src/session/schema.ts`
- `src/session/journal.ts`
- `src/session/checkpoints.ts`
- `src/session/crypto.ts`
- `src/session/engine-adapter.ts`

### A2. Discriminated operation policy

Every effect is represented by an `OperationRequest` variant:

- file read/query/write;
- process execution;
- network connection;
- named-secret access;
- Git-ref mutation;
- extension activation/call.

Each request carries principal, session, surface, task, canonical resource identities, side-effect class, logical operation ID, expected workspace state, and declared result type.

Unknown operations, missing side-effect declarations, and undeclared MCP effects default to deny.

Decision order:

1. explicit deny;
2. valid resource-scoped grant;
3. interactive ask;
4. default deny.

All surfaces consume one `ApprovalBroker`. Approvals bind exact resource identities/digests rather than the whole global generation.

Interactive approval defaults to a session-scoped grant for the exact resource and operation class. The UI may offer one-shot or project-persistent alternatives, but persistence requires explicit selection, remains bound to repository/configuration trust, and is revocable.

The optional headless broker is local-only, uses a Unix socket or loopback endpoint, authenticates through a capability in a `0600` token file, binds requests to nonces, defaults to 60 seconds, caps timeout at five minutes, and denies on disconnect or expiry.

Primary touchpoints:

- `src/permissions/index.ts:1-55`
- `src/permissions/gate.ts:28-121`
- `src/permissions/bridge.ts:1-92`
- `src/permissions/headless-prompt.ts:1-110`
- `src/mcp/bridge.ts:21-84`
- `src/cli/worker-entry.ts:276-302`

Likely new modules:

- `src/permissions/policy.ts`
- `src/permissions/grants.ts`
- `src/permissions/approval-broker.ts`
- `src/runtime/effect-runtime.ts`

### A3. Process broker and trust classes

All untrusted child processes pass through one broker:

- one-shot and persistent shells;
- hooks and plugins;
- MCP and LSP servers;
- controlled Git subprocesses where applicable.

Process classes have different environment/approval policy but common supervision:

- agent effect;
- workspace extension;
- provider helper;
- Git control-plane operation;
- user-interactive shell/editor process.

The broker owns environment minimization, sandbox selection, network proxying, named-secret injection, time/output limits, process groups, and cancellation. CI forbids direct child-process creation outside an explicit broker allowlist.

Provider API calls remain control-plane traffic to pinned endpoints. Tool and repository processes receive no network or secrets without grants.

Unsupported isolation fails closed:

- Linux uses bubblewrap/Landlock or the certified container path.
- macOS uses Seatbelt.
- Windows executes inside the certified WSL2/container path.
- native Windows shell startup returns a structured unsupported error.

Primary touchpoints:

- `src/tools/tier0/sandbox.ts:550-630`
- `src/tools/tier0/shell-session.ts:93-124`
- `src/tools/tier0/process-hardening.ts:10-119`
- `src/hooks/runtime.ts:310-390`
- `src/mcp/client.ts:68-159`

Likely new module: `src/tools/tier0/process-broker.ts`.

### A4. Handle-based workspace authority

One service owns canonical resource identity, handle-based file operations, read sets, write compare-and-swap, and workspace leases. Individual tools stop implementing independent boundary checks.

Canonicalization completes before policy evaluation; authorization completes before opening or mutating the resource. Operations revalidate handles/digests at use time to close authorization/use races.

Primary touchpoints:

- `src/tools/tier0/internal.ts:79-94`
- `src/tools/tier0/read_file.ts:92-116`
- `src/tools/tier0/edit_file.ts:149-220`
- `src/tools/tier0/glob.ts:45-96`
- `src/tools/tier0/grep.ts:57-101`
- `src/tools/tier1/view_image.ts:43-83`
- `src/tools/tier1/notebook_edit.ts:80-229`

Likely new module: `src/tools/tier0/path-authorizer.ts`.

### A5. Shared-workspace read sets and generations

The selected policy permits read-only agents to overlap the one shared writer.

`ReadSet` contains:

- canonical file identities and digests;
- directory-query stamps for glob/search results;
- repository/base SHA;
- executable configuration digests;
- toolchain and language-server identity.

Safety contract:

1. Every committed brokered write increments the workspace epoch.
2. Filesystem watchers are hints, not correctness authorities.
3. Reads record epoch before/after plus their `ReadSet`.
4. An epoch change during a read marks the result stale.
5. Reader output streams with a visible `provisional` state.
6. When inputs change, OpenSwarm automatically recomputes the relevant `ReadSet` and reruns affected reads/diagnostics rather than asking the user to detect staleness.
7. Only verified output becomes a terminal task result; parent/daemon—not the worker—commits that transition.
8. At write, task-completion, checkpoint, commit, and landing boundaries, the relevant `ReadSet` is recomputed regardless of watcher state.
9. Writes require the writer lease, expected epoch, and expected resource digests.
10. A reader cannot self-upgrade while another writer owns the lease.
11. Lease acquisition uses fair tickets, bounded hold time, renewable TTLs, and cancellation-safe release.
12. Provisional, stale, revalidating, and verified are first-class event/UI states.

`ToolAccesses` remains an in-process scheduling hint; it is not the cross-process correctness protocol.

Likely new module: `src/swarm/workspace-coordinator.ts`.

### A6. Harden the existing landing queue

Explicit worktree mode permits concurrent writers. Extend the existing `LandingStrategy` and queue rather than introducing a parallel subsystem.

States:

- `enqueued`
- `validating`
- `landed`
- `stale-retry`
- `conflict-retained`
- `failed`

Landing protocol:

1. enumerate worktrees and determine target ownership;
2. capture target SHA before temporary-worktree creation;
3. use ref-only CAS only when the target branch is not checked out anywhere;
4. when checked out, acquire an exclusive lease on that exact worktree, verify process identity, cleanliness, index/HEAD alignment, and expected SHA, then perform landing through the owning worktree;
5. never update a branch ref behind an unleased checked-out worktree;
6. bind validation evidence to source SHA, target SHA, merge SHA, and workspace `ReadSet`;
7. revalidate changed inputs and required tests;
8. compare target SHA and atomically land only if unchanged;
9. otherwise retry from the new target or retain a conflict.

No partial merge or stale target overwrite is allowed.

Tests cover an unowned target ref plus clean, dirty, and concurrently edited target worktrees. Dirty or unverified ownership leaves both target ref and worktree unchanged.

Primary touchpoints:

- `src/swarm/landing/types.ts:17-65`
- `src/swarm/landing/queue-to-branch.ts:1-24`
- `src/swarm/adapters/git-cascade-branch-policy.ts:719-850`

### A7. Canonical typed content

Define `ContentPart` before the session journal:

- text;
- image reference;
- resource reference;
- tool call;
- typed tool result;
- opaque reasoning reference.

Images live in a bounded content-addressed store. The journal records digest, MIME type, dimensions, size, encryption envelope, and blob location instead of base64. The blob lifecycle/schema is frozen in the walking skeleton; R5 completes policy and key-provider support without rewriting journal records.

Provider discovery may narrow the pinned certification manifest but cannot broaden certified capabilities. Unsupported content returns a structured error instead of silent conversion.

Primary touchpoints:

- `src/providers/index.ts:83-172`
- `src/providers/openai-transport.ts:123-200`
- `src/providers/message-replay.ts:40-170`
- `src/providers/capability-catalog.ts:13-208`
- `src/acp/content.ts:1-33`
- `src/acp/normalized-translate.ts`
- `src/session/store.ts:32-53`
- `src/tools/tier1/view_image.ts:43-84`

Likely new module: `src/attachments/store.ts`.

### A8. Supervised extensions and instructions

- Workspace skills, instructions, hooks, MCP, LSP, and plugins participate in provenance/trust.
- User-level extensions remain independently trusted and do not inherit workspace trust.
- Claude SDK project `settingSources` are disabled before repository trust.
- Hooks, MCP, LSP, and shell plugins run as subprocesses through the process broker.
- Existing in-process plugins are deprecated and disabled for parity beta.
- Native plugins require explicit install/trust plus source and content-hash pinning. A changed hash disables the plugin pending renewed trust; signatures are optional metadata in beta.
- Unreadable or malformed extension state fails closed.
- Workspace configuration may be parsed before trust but never activated before trust.
- User and workspace layers merge with provenance; first-match discovery is removed.
- Certified MCP includes local stdio and remote streamable HTTP. Remote servers authenticate through OAuth or static bearer tokens obtained from the named-secret broker.
- Server-initiated sampling/elicitation and primitives outside the certified core remain disabled.
- Extension calls receive time, output, network, secret, and cancellation limits.
- CI forbids direct process spawning outside the broker allowlist.

Primary touchpoints:

- `src/engine/claude-agent-sdk.ts:373-384`
- `src/hooks/config.ts:132-300`
- `src/hooks/runtime.ts:310-390`
- `src/mcp/config.ts:71-143`
- `src/mcp/client.ts:68-159`
- `src/mcp/bridge.ts:20-170`
- `src/plugins/registry.ts:124-146`
- `src/plugins/claude-code-source.ts:267-276`

### A9. Canonical journal and projections

Separate durable facts from transport/UI projections.

Canonical committed event envelope:

- schema version and `eventId`;
- stream-local sequence;
- causation and correlation IDs;
- session, agent, task, tool, operation, attempt, and policy IDs;
- principal/producer;
- workspace epoch;
- occurred and recorded times;
- typed semantic payload.

Persist semantic message, tool, decision, checkpoint, and result boundaries. Token deltas remain ephemeral.

Project committed facts to:

- existing `LaneEvent` and daemon `events.jsonl`;
- `NormalizedEvent`;
- TUI `ReplEvent`;
- headless JSONL;
- ACP updates;
- audit/usage records;
- sessionlog trajectories.

Existing wire and `LaneEvent` contracts remain versioned projections, not the canonical session journal. Durable semantic projections must be reproducible from committed facts; byte-identical replay of ephemeral token/tool-input deltas is explicitly not guaranteed.

Primary touchpoints:

- `src/swarm/events.ts:20-170`
- `src/swarm/wire-protocol.ts:25-100`
- `src/swarm/usage-aggregator.ts`
- `src/cli/team-watch.ts`
- `src/acp/rich-format.ts`
- `docs/28-v0.5-daemon-plan.md` §V0.5.Q4
- `docs/46-sessionlog-trajectory-ingest.md` §Transcript mapping and §Part 2b

### A10. Selective OpenCode design compatibility

Use OpenCode as the reference for user-facing configuration and integration patterns:

- layered configuration with provenance;
- explicit `provider/model-id` selection;
- clear `allow` / `ask` / `deny` permission presentation;
- local/remote MCP configuration, OAuth, headers, enablement, and timeouts;
- explicit session-sharing controls.

Do not inherit weaker assumptions by compatibility:

- repository-controlled configuration still waits for trust;
- session storage remains encrypted with retention controls;
- processes remain fail-closed and brokered;
- plugins remain hash-pinned;
- model certification and evidence remain OpenSwarm contracts.

This is behavioral/configuration alignment, not Claude/OpenCode plugin API compatibility.

### A11. Certification, evaluation, and privacy

- Certification pins an exact provider model/API identifier, adapter version, parameters, harness commit, fixture/task versions, platform image, and run date.
- Provider discovery may remove unsupported certified capabilities; it never broadens them automatically.
- Other models remain selectable with a visible `unverified` status and cannot contribute evidence to product claims.
- Diagnostics, traces, usage, transcripts, and code remain local by default. Redacted transmission or sharing requires an explicit user action and records consent scope.
- The mixed corpus combines deterministic fixtures, pinned public repositories, and an optional private holdout.
- Every workflow preregisters one capability-specific comparator and runs the same exact model/provider where possible.
- Task success passes only when the paired 95% bootstrap lower confidence bound is above −5 percentage points.
- Median single-agent wall time must be at most 1.25× and model cost at most 1.15× the comparator.

## Delivery model

Core ownership:

- **Engineer A — runtime/security/platform:** trust, paths, process broker, policy, network/secrets, platform isolation.
- **Engineer B — sessions/providers/intelligence:** session kernel, recovery, providers, LSP, attachments, memory.
- **Engineer C — TUI/ACP/swarm/quality:** TUI, headless, ACP, tasks, workspace coordination, events, supervision, evidence.

External support:

- security assessment and remediation verification;
- focused UX/QA engagements around R2, R4, and R6.

Calendar duration and person-week loading are separate. Package gates include package-local tests; the quality allocation covers cross-package integration, migration, platform maintenance, adversarial testing, documentation, and release evidence.

| Release | Weeks | Package estimates (person-weeks) | Feature A/B/C | Quality A/B/C | Total | Capacity | Slack |
|---|---:|---|---:|---:|---:|---:|---:|
| R1 | 1–9 | `00` 4; `01` 1; `02` 2; `03` 2; `04` 2; `05` 2; `06` 2 | 6/4/5 | 3/3/3 | 24 | 27 | 3 |
| R2 | 10–17 | `07` 3; `08` 3; `09` 2; `10` 2; `11` 3; `12` 2 | 4/6/5 | 3/1/2 | 21 | 24 | 3 |
| R3 | 18–27 | `13`–`18` 3 each | 6/6/6 | 3/3/3 | 27 | 30 | 3 |
| R4 | 28–35 | `19` 3; `20` 3; `21` 4; `22` 3; `23` 3; `24` 3 | 5/7/7 | 3/1/1 | 24 | 24 | 0 |
| R5 | 36–43 | `25` 6; `26` 4; `27` 3; `28` 4; `29` 2 | 6/7/6 | 2/1/2 | 24 | 24 | 0 |
| R6 | 44–50 | `30` 6; `31` 4; `32` 3; `33` 3 | 5/6/5 | 1/0/1 | 18 | 21 | 3 |
| **Total** | **50** |  | **32/36/34** | **15/9/12** | **138** | **150** | **12** |

Cross-owner feature splits:

- `WP-00` B2/C2; `WP-11` A2/C1.
- `WP-14` A2/C1; `WP-15` B2/C1; `WP-18` A1/B1/C1.
- `WP-19` B2/C1; `WP-20` A2/C1; `WP-21` A2/B2; `WP-22` B2/C1; `WP-23` A1/B1/C1.
- `WP-25` A3/B1/C2; `WP-26` B2/C2; `WP-27` A1/B2; `WP-28` A1/B1/C2; `WP-29` A1/B1+External.
- `WP-30` A3/B3; `WP-31` B1/C3; `WP-32` A1/B1/C1; `WP-33` A1/B1/C1.

Dependency- and owner-constrained schedule:

| Release | Feature schedule | Cross-package quality schedule | Slack |
|---|---|---|---|
| R1 | `WP-00` B/C w1–2; `01` C w3; `02` A w4–5; `03` A w6–7; `04` A w8–9; `05` B w4–5; `06` C w4–5 | A w1–3; B w6–8; C w6–8 | B w3,w9; C w9 |
| R2 | `WP-07` B w10–12; `08` B w13–15; `09` A w10–11; `11` C w10 + A w12–13; `12` C w14–15; `10` C w16–17 | A w14–16; B w16; C w11–12 | A/B w17; C w13 |
| R3 | `WP-13` A w18–20; `16` B w18–20; `14` C w21 + A w21–22; `15` C w23 + B w23–24; `17` C w24–26; `18` A/B/C w27 | A w23–25; B w21–22,w25; C w18–20 | A/B w26; C w22 |
| R4 | `WP-19` B w28–29 + C w28; `20` A w28–29 + C w29; `21` A/B w30–31; `22` C w30 + B w32–33; `23` C w31 + A w32 + B w34; `24` C w32–34 | A w33–35; B/C w35 | none |
| R5 | `WP-25` A w36–38 + B w36 + C w36–37; `26` B w37–38 + C w38–39; `27` A w39 + B w39–40; `28` A/B w41 + C w41–42; `29` external w41–43 + A/B w43 | A w40,w42; B w42; C w40,w43 | none |
| R6 | `WP-30` A/B w44–46; `31` C w44–46 + B w47; `32` A/B/C w48; `33` A/B/C 0.5 pw each in w49 and w50 with the seven-day soak spanning both weeks | A/C w47 | 0.5 A/B/C in w49–50 |

The four-engineer 39-week and two-engineer 75-week figures are capacity-only bounds, not approved dependency schedules. Either staffing variant requires its own resource-constrained schedule before commitment.

The estimates are hypotheses. `WP-00` produces a bottom-up re-estimate; see the next section for its findings. Rebaseline when committed work exceeds 102 person-weeks, quality allocation falls below 36, an owner exceeds phase capacity, or the third engineer is unavailable by R2.

### `WP-00` re-estimate

The walking skeleton is built and its gate passes: `compose.parity.yml`, `scripts/verify-parity-wp.sh`, the frozen contracts, a durable journal, canonical path authority, discriminated policy, the effect transaction with write compare-and-swap, the seven-point fault matrix, and the storage/encryption contracts. The architecture review of the transaction ordering remains outstanding, and is the one part of the gate a test cannot discharge.

Four findings change the estimates.

**The journal was an unlisted prerequisite.** `WP-00` specifies "durably append `AttemptPrepared`" as though an append primitive existed. None did. All four existing lane-event writers use `createWriteStream` with no flush discipline, and `session-recorder` opens with `flags: "w"`, truncating per session. Telemetry survives that; an attempt journal does not, because "did this effect already run?" must be answerable after a hard kill. A store with explicit commit semantics was therefore part of `WP-00` rather than of `WP-07`. Consolidating the four existing writers onto it is real work that no package currently owns.

**The estimate priced design, and the cost is adoption.** The contracts and skeleton are greenfield with zero integration, and landed well inside 4 person-weeks. That is not evidence the program is cheaper than budgeted. Nothing in `src/tools/` or `src/engine/` uses the new contracts yet: the skeleton runs beside `ToolDispatcher` and `canUseTool`, not inside them. The expensive work is migrating the six tier-0 tools that carry duplicated `path.resolve` + `isUnderCwd` logic and routing the permission gate through the discriminated `PolicyEngine` — none of which `WP-00` claimed, and all of which later packages assume is already done.

**There are two tool-execution chokepoints, not one.** `WP-03`, `WP-04`, and `WP-09` are written as though authorization and execution funnel through `ToolDispatcher`. The Claude Agent SDK path does not: its MCP handler calls `toolImpl.execute` directly, bypassing the dispatcher's hooks and dispatch-time validation. Any package that enforces policy at the dispatcher enforces it for one engine family and not the other. Each of those three packages needs a second wiring path, or an earlier package has to collapse the two.

**The audit-derived P0 list is incomplete.** Surveying the path helpers for `WP-00` surfaced a containment bug that no audit finding named: `isUnderCwd` resolves symlinks only when the leaf is a symlink, so a path through a symlinked parent directory escapes the workspace, and only `write_file` realpaths its parent. The kernel authority closes this; every tier-0 tool still carries it. Expect comparable findings during adoption, and treat the remediation allocation as a floor rather than an estimate.

Recommended adjustments:

- Add an adoption package between `WP-00` and `WP-03` that moves the production path onto the frozen contracts and consolidates the event writers. Estimate 4 person-weeks, A+C. Nothing downstream that assumes a single canonicalization or policy chokepoint is real until it lands.
- Re-scope `WP-07` to exclude journal construction, which is done, and to include migrating the existing writers.
- Add the second SDK wiring path to `WP-03`, `WP-04`, and `WP-09`, or make collapsing the two chokepoints an explicit goal of the adoption package.

Net effect on the R1 budget is approximately neutral: `WP-00` and `WP-07` both shrink, and the new adoption package absorbs the difference. The schedule risk is not the totals but the ordering, because the adoption package is on the critical path of every enforcement package that follows it.

### `WP-00a` Production adoption of the frozen contracts — 4 person-weeks, A+C

The package the re-estimate recommends. Gate: `./scripts/verify-parity-wp.sh WP-00a <cell>`, `A1`–`A8` passing. Fixtures `FX-ESCAPE-001` (containment corpus, including the symlinked-parent case) and `FX-GATE-001` (every engine gates tool calls). Delivered in well under the 4 person-weeks estimated, for a reason worth carrying forward: the estimate assumed the chokepoints had to be collapsed, and they did not.

Mapping the production surface corrected the re-estimate on three points.

**Three chokepoints, not two.** Alongside `ToolDispatcher` and the Claude SDK MCP handler there is a third: `CodexFrameworkEngine`'s dynamic-tool handler, which called `impl.execute` directly. The three are not ordered by strictness — the dispatcher validates input and runs hooks but delegates permissions to the engine, the SDK path checks permissions but skips validation and hooks, and the Codex path did none of the three — so no path can simply adopt the strictest.

**Collapsing them is the wrong first move.** Routing the SDK path through `ToolDispatcher` would fire every user `PreToolUse` hook twice, once from the SDK's own hook mechanism and once from the dispatcher's. The cheaper seam is `canUseTool`: all four engines already call it before executing anything, and its two implementations — `makeCanUseTool` and `buildWorkerCanUseTool` — already resolve the tool through `dispatcher.get`, so both can read a tool's `accesses` declaration. Making the gate resource-aware reaches every engine without touching one. Uniform hooks and validation remain a defect, but a separable one.

**Two more findings, both containment.** `notebook_edit` and `view_image` resolved absolute paths straight through with no boundary check, reaching any file on the host; `notebook_edit` is the write side and `view_image` contradicts the invariant `read_file` enforces explicitly. Separately, `bash`, `shell_exec`, and `shell_write` declared neither `accesses` nor `concurrencySafe: false`, so the scheduler's optimistic default made an arbitrary shell command eligible to run in parallel with a write to any path it might touch. This is the third pass to surface findings no audit named, which continues to argue the remediation allocation is a floor.

What landed, as gated by `A1`–`A8`:

- Resource access is declared honestly by every tool that touches files or runs commands (`A1`). The scheduler's optimistic default is correct for scheduling and unsafe for authorization, so the declarations were fixed rather than the default inverted.
- Containment is decided once, in the gate, through `WorkspaceAuthority` (`A2`, `A4`), closing the symlinked-parent gap for every tool and every engine at once.
- The Codex path is gated (`A3`).
- Calls that name their paths are authorized through the discriminated `PolicyEngine`, with `ApprovalBroker` backed by the existing TUI, headless, and ACP bridges (`A6`, `A7`). An approval now binds to a canonical resource, so it can be remembered; `rulesForMode` keeps the operation-class model in exact agreement with `PermissionMode` for the classes derived today, so the change is to when a decision is remembered rather than to whether it is allowed.
- The seven per-tool containment checks are consolidated onto one helper (`A8`).

Two limits are deliberate and carry into `WP-03`. A tool that declares `all()` or declares nothing — `bash`, plugin tools, MCP tools — is still judged by tool name alone, because central containment has no opinion on a resource it cannot name; expressing "unknown resource" as something other than silence is the remaining work. And the per-tool checks were consolidated rather than deleted: `canUseTool` decides before execution, and a path can change in between, so a second check at write time closes a race that one up-front check cannot.

## Six staged releases

### R1 — Contained foundation, weeks 1–9

Internal only; no parity claim.

#### `WP-00` Effect-transaction walking skeleton — 4 person-weeks, B+C

- Bootstrap `compose.parity.yml`, the `parity` service, and `scripts/verify-parity-wp.sh` so all repository verification runs through Docker Compose.
- Freeze `EventEnvelope`, `ContentPart`, `OperationRequest`, `EffectOutcome`, `ReadSet`, and opaque engine-state contracts.
- Prove one deterministic Linux-x64 turn through canonicalization, approval, durable attempt preparation, one file write CAS, durable terminal result, restart, and one `LaneEvent`/TUI projection.
- Freeze attachment/session encryption envelopes, the 90-day default retention policy, secure-key-provider contract, ephemeral fallback behavior, and provider-state representations before durable journal rollout.
- Produce a bottom-up dependency and person-week re-estimate.

Gate:

- The walking skeleton survives fault injection before and after every transaction transition.
- No duplicate mutation, lost committed event, or projection-only source of truth appears.
- Architecture review accepts the transaction ordering before expansion.

#### `WP-01` Capability manifest and evidence harness — 1 person-week, C

- Depends on `WP-00`.
- Own the Compose parity image, deterministic fixtures, artifact schema, and one-suite-at-a-time verbose runner.
- Encode every `DDP-*` capability, owner, release, supported cells, evidence, and status.
- Encode exact certified provider/model/API IDs; mark all other models `unverified`.
- Preregister the mixed corpus, one comparator per workflow, paired seeds, bootstrap analysis, −5-point success margin, 1.25× latency guardrail, and 1.15× cost guardrail.
- Define local-only telemetry artifacts and explicit redacted opt-in evidence.
- Add claim-to-capability validation.
- Add reproducible malicious-repository and fault-injection fixtures.

Gate:

- CI fails when a mandatory ID has no evidence owner.
- Public capability claims without an ID fail documentation validation.

#### `WP-02` Repository trust and configuration provenance — 2 person-weeks, A

Depends on `WP-01`.

- Canonical repository identity.
- Trust record bound to root and executable configuration hashes.
- Trust invalidation on relevant configuration change.
- Disable Claude SDK project `settingSources` before trust.
- Include workspace skills, instructions, hooks, MCP, plugins, and LSP configuration in provenance/trust.
- Preserve user-level trust independently from workspace trust.
- No hook, MCP, plugin, or LSP activation before trust.

Gate: malicious-clone fixtures cause zero process, network, or secret activity before trust.

#### `WP-03` Canonical path authorization — 2 person-weeks, A

Depends on `WP-01`.

- Central path authorization for every file-bearing tool.
- Parent-symlink, nearest-existing-ancestor, broken-link, external-path, and race handling.
- Permission decisions include canonical path arguments.

Gate: generated and swap-race escape corpus reports zero unauthorized access.

#### `WP-04` Process broker and fail-closed shell baseline — 2 person-weeks, A

Depends on `WP-02` and `WP-03`.

- Route Bash, persistent shell, hooks, MCP, and plugins through the broker.
- Add process-group cancellation, bounded output, and effective-isolation diagnostics.
- Remove the synchronous `require` fail-open path.

Gate: no untrusted child can launch outside the broker; unavailable required isolation runs nothing.

#### `WP-05` Retry operation ledger and cancellation barrier — 2 person-weeks, B

Depends on `WP-01`.

- Classify side effects and idempotency.
- Assign stable logical operation IDs.
- Disable eager execution for unsafe tools.
- Record `outcome_unknown` when completion cannot be proven.

Gate: fault injection around dispatch never duplicates a mutating call.

#### `WP-06` Atomic task transitions and safe target CAS — 2 person-weeks, C

Depends on `WP-01`.

- Transactional claim and terminal result persistence.
- Parent-side identity and transition authorization.
- Capture target SHA before landing-worktree creation.

Gate: 10,000 claim attempts produce one owner; a moved target loses no commit.

R1 exit:

- `DDP-SAFE-01`, `DDP-SAFE-02`, `DDP-REL-01`, and `DDP-SWM-01` pass on Linux x64.
- The effect-transaction walking skeleton and revised loading model are approved.
- No direct untrusted spawn path remains.
- No topology feature work starts.

### R2 — Stateful core alpha, weeks 10–17

Limited developer alpha.

#### `WP-07` Session schema, journal, snapshots, and importer — 3 person-weeks, B

Depends on `WP-00` and `WP-05`.

- Versioned journal and checksummed atomic snapshots.
- Import legacy Claude IDs, native snapshots, and team checkpoints where possible.
- Mark imports read-only/lossy when typed tool, reasoning, or attachment history cannot be reconstructed.
- Backup before migration and archive unsupported state.

Gate: torn-write tests preserve the last committed event.

#### `WP-08` Automatic multi-turn and crash resume — 3 person-weeks, B

Depends on `WP-07`.

- Connect TUI, ACP, headless, SDK, native, and hardened-native to the session kernel.
- Persist engine/provider resume state after every acknowledged turn.

Gate: ten-turn tests pass without manual resume; restart retains early context.

#### `WP-09` Approval broker and headless default deny — 2 person-weeks, A

Depends on `WP-02` and `WP-04`.

- Shared approval request/decision schema.
- Default session-scoped exact-resource/operation grants plus explicit one-shot and trust-bound persistent alternatives.
- Grant expiry, use limits, revocation, trust invalidation, and audit events.
- Authenticated optional headless broker.

Gate: absent, invalid, expired, replayed, disconnected, or late approvals deny.

#### `WP-10` TUI single-owner input state — 2 person-weeks, C

Depends on `WP-08` and `WP-09`.

- One owner for input value, cursor, history, completion, paste, and keybindings.
- Resolve global/action chord collisions.

Gate: component and PTY suites pass Unicode, multiline, history, Tab, resize, paste, approvals, and cancellation.

#### `WP-11` Shared writer lease and generation tracking — 3 person-weeks, A+C

Depends on `WP-03` and `WP-06`.

- Exactly one writer in shared mode.
- Overlapping readers receive complete `ReadSet` stamps.
- Stream reader output as provisional; automatically revalidate affected dependencies and emit verified terminal output only after the new read set passes.
- Recompute relevant read sets at write, task completion, checkpoint, commit, and landing.
- Parent/daemon commits terminal task state only after required revalidation.
- Add fair tickets, lease TTL/renewal, bounded holds, cancellation release, and stale-result events.

Gate: injected races mark stale reads and reject stale writes; after the active writer releases, the next queued writer starts within five seconds under 32 continuously active readers.

#### `WP-12` Audit and event projections — 2 person-weeks, C

Depends on `WP-00`, `WP-05`, `WP-06`, `WP-07`, `WP-09`, and `WP-11`.

- Project canonical committed facts to `LaneEvent`, TUI, headless, ACP, usage, audit, and sessionlog.
- Keep token deltas ephemeral and persist semantic boundaries.
- Persist policy, operation, read-set, result, usage, and redaction records.

Gate: every test side effect has correlated pre-decision and terminal facts; every durable semantic projection rebuilds from the journal. Live token/input deltas are tested for ordering and bounded loss behavior, not byte-identical replay.

R2 exit:

- `DDP-CONV-01`, `DDP-SES-01`, `DDP-SAFE-05`, `DDP-UX-01`, and `DDP-SWM-02` pass.
- TUI is usable as one continuous conversation.
- Reconcile actual R1/R2 loading against the 50-week baseline before R3 starts.

### R3 — Safe automation alpha, weeks 18–27

#### `WP-13` Domain and named-secret grants — 3 person-weeks, A

Depends on `WP-04`, `WP-09`, and `WP-12`.

- Default deny for tool/process network and secrets.
- Domain-scoped proxy grants and named-secret brokering.
- Redirect-hop, DNS-rebinding, dual-stack, and private-range enforcement.

Gate: malicious redirect, DNS, and ambient-credential fixtures cannot exceed grants.

#### `WP-14` Supervised extension execution — 3 person-weeks, A+C

Depends on `WP-02`, `WP-04`, `WP-09`, and `WP-13`.

- Apply policy, time, output, network, secret, and cancellation bounds.
- Deprecate in-process plugins.
- Require explicit native-plugin install/trust plus source/content-hash pinning; changed content disables the plugin until renewed trust.
- Make malformed/unreadable extension state fail closed while preserving independent user-level trust.
- Add a CI allowlist rule for direct process spawning.
- Route hook and subagent lifecycle events through real call sites.

Gate: malicious hook/plugin/MCP fixtures remain bounded and cancellable.

#### `WP-15` Layered extension configuration and MCP core — 3 person-weeks, B+C

Depends on `WP-14`.

- Merge user/workspace layers deterministically with provenance.
- Follow OpenCode-style local/remote MCP configuration while applying OpenSwarm trust and process policy.
- Support certified stdio and streamable HTTP tools/resources.
- Support remote OAuth and static bearer tokens obtained through the named-secret broker.
- Reject server-initiated sampling/elicitation and uncertified advanced primitives.
- Preserve typed image results.

Gate: precedence, transport, resource, timeout, cancellation, and permission contracts pass.

#### `WP-16` Typed provider contract and certification manifest — 3 person-weeks, B

Depends on `WP-07`, `WP-08`, and `WP-12`.

- One canonical content/tool/error/usage contract.
- Pin one exact certified model/API identifier per provider and record adapter/harness versions.
- Register other models as visibly `unverified`; they remain usable but cannot produce certification evidence.
- Structured unsupported-capability behavior.

Gate: Anthropic, OpenAI, and Gemini pass the same text, tool, retry, resume, usage, and error suite.

#### `WP-17` Worker composition parity and transport identity — 3 person-weeks, C

Depends on `WP-06`, `WP-09`, `WP-11`, `WP-12`, and `WP-14`.

- Build root/worker/daemon tools and gates through shared factories.
- Expose web, skills, extensions, and policy according to one capability manifest.
- Derive principal/scope from authenticated transport context.

Gate: worker and root surfaces expose identical certified capabilities; unauthorized transitions fail.

#### `WP-18` Supervision, backpressure, and aggregate budgets — 3 person-weeks, A+B+C

Depends on `WP-12` and `WP-17`.

- Global worker quota and heartbeat expiry.
- Bounded high/low priority queues and response guarantees.
- Hierarchical cancellation and descendant cleanup.
- Live per-run aggregate budgets with pre-dispatch token/cost/tool reservations.

Gate: the 16-worker quota is never exceeded; 30/60/90-second heartbeat states hold; queue service/backpressure meets the numeric defaults; cancellation meets 2s/5s; the aggregate budget fixture has zero unreserved overshoot and starts no dispatch after exhaustion.

R3 exit:

- `DDP-SAFE-03`, `DDP-SAFE-04`, `DDP-EXT-01`, initial `DDP-PROV-01`, `DDP-SWM-04`, and initial `DDP-OBS-01` pass.
- Existing topologies may enter hardening but none may be added.

### R4 — Recovery and intelligence preview, weeks 28–35

#### `WP-19` Checkpoint, rewind, and fork — 3 person-weeks, B+C

Depends on `WP-07`, `WP-08`, and `WP-11`.

- Conversation-only and code+conversation checkpoints.
- Fork preserves parent history and creates independent workspace/session lineage.

Gate: restore matches selected hashes and never mutates the original branch/session.

#### `WP-20` Harden isolated writer landing — 3 person-weeks, A+C

Depends on `WP-06`, `WP-11`, and `WP-12`.

- Extend the existing `LandingStrategy` and queue; do not create a parallel subsystem.
- Add `enqueued`, `validating`, `landed`, `stale-retry`, `conflict-retained`, and `failed` states.
- Serialize captured-SHA landing for parallel worktree writers.
- Bind evidence to source SHA, target SHA, merge SHA, and `ReadSet`.
- Revalidate after rebase/merge and preserve conflicts.

Gate: non-conflicting changes land serially; conflicts preserve both worktrees and leave target unchanged. Ref-only, clean-owner, dirty-owner, and concurrent-owner fixtures never desynchronize target HEAD/index/worktree.

#### `WP-21` Core LSP manager and tools — 4 person-weeks, A+B

Depends on `WP-03`, `WP-04`, `WP-14`, and `WP-16`.

- Managed TypeScript, Pyright, and `gopls` processes.
- Diagnostics, definition, references, and transactional rename.
- Trust, workspace, process, and output bounds.

Gate: pinned fixtures pass all four operations in each language.

#### `WP-22` Attachment store and image paths — 3 person-weeks, B+C

Depends on `WP-07`, `WP-14`, and `WP-16`.

- Bounded content-addressed attachment store.
- Implement the encryption-envelope/blob lifecycle frozen by `WP-00`.
- MIME/dimension validation and safe resizing policy.
- Typed TUI, headless, and ACP attachment flow.

Gate: valid images reach all three providers/surfaces; malformed and oversized images fail without transcript bloat.

#### `WP-23` Durable memory and archive — 3 person-weeks, A+B+C

Depends on `WP-07`.

- Install a durable curated store.
- Scope memory by canonical project/user identity.
- Crash-safe archive and indexed search.

Gate: curated entries and completed turns survive abrupt exit and restart.

#### `WP-24` Team patch, conflict, usage, and steering UX — 3 person-weeks, C

Depends on `WP-12`, `WP-17`, `WP-18`, and `WP-20`.

- Emit daemon `team_usage`.
- Drive agent tree, tasks, patches, conflicts, cost, stop, and steering from real events.
- Register Tier-2 team tools in the interactive composition root.

Gate: watch/status/TUI/ACP agree on state and usage after restart and reconnect.

R4 exit:

- `DDP-SES-02`, `DDP-LSP-01`, `DDP-MEDIA-01`, `DDP-SWM-03`, `DDP-UX-02`, `DDP-UX-03`, and durable `DDP-MEM-01` pass.

### R5 — Matrix release candidate, weeks 36–43

#### `WP-25` Platform containment, packaging, and CI — 6 person-weeks, A+B+C

Depends on `WP-03`, `WP-04`, `WP-13`, and `WP-14`.

- macOS Seatbelt.
- Linux x64/arm64 packaging and isolation.
- WSL2/container bootstrap, path mapping, signal handling, and cleanup.
- Explicit native Windows rejection.

The Compose `parity` service is the controller, not a claim that Linux containers can validate host-native controls. It dispatches a content-addressed, allowlisted job to authenticated host runners and collects signed artifacts:

| Cell | Executor | Exact controller command |
|---|---|---|
| `linux-x64` | Compose service on a native x64 Linux host | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-25 linux-x64` |
| `linux-arm64` | Compose service on a native arm64 Linux host | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-25 linux-arm64` |
| `macos-arm64` | Signed arm64 macOS host runner; Seatbelt/PTY tests execute natively | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-25 macos-arm64` |
| `macos-x64` | Signed x64 macOS host runner; Seatbelt/PTY tests execute natively | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-25 macos-x64` |
| `windows11-wsl2-x64` | Signed Windows host runner controlling the pinned WSL2 distribution/container | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-25 windows11-wsl2-x64` |

Host runners accept only the committed verification manifest and scripts, use an ephemeral job token, sign result metadata, and upload to `artifacts/parity/WP-25/<cell>.json`. An unavailable/mismatched runner fails the cell; it never skips it.

Gate: all five signed target artifacts pass package, sandbox, shell, PTY, cancellation, and cleanup tests.

The capability manifest must pin exact OS/distribution builds, Node/Bun versions, LSP server versions, provider model IDs, and certification dates. The Windows cell is “Windows 11 host + pinned Linux distribution under WSL2/container,” not native Windows execution.

#### `WP-26` Headless and Zed ACP completion — 4 person-weeks, B+C

Depends on `WP-08`, `WP-09`, `WP-19`, and `WP-22`.

- Versioned JSONL and deterministic exit behavior.
- Session, approval, attachment, cancellation, diff, reconnect, and error parity.

Gate: headless and Zed pass the same daily-driver journeys as TUI.

#### `WP-27` Retention, purge, export, and encryption — 3 person-weeks, A+B

Depends on `WP-07`, `WP-19`, `WP-22`, and `WP-23`.

- Configurable retention and storage modes.
- Full encrypted history with automatic 90-day purge as the no-config default.
- Authenticated encryption and OS/headless key-provider abstraction.
- Explicit ephemeral-session fallback with a warning when no secure key is available; no plaintext fallback.
- Export, deletion, and cryptographic tamper detection.

Gate: configured policies survive restart; no-config key absence selects the warned ephemeral mode; configurations that require durable encryption fail closed on missing keys; tampering always fails closed.

#### `WP-28` Full matrix and evidence ledger — 4 person-weeks, A+B+C

Depends on `WP-10`, `WP-15`, `WP-16`, `WP-18`, `WP-19`, `WP-20`, `WP-21`, `WP-22`, `WP-23`, `WP-24`, `WP-25`, `WP-26`, and `WP-27`.

- Run the focused matrix.
- Run the preregistered mixed corpus with paired seeds and capability-specific comparators.
- Attach automated/manual artifacts to every capability ID.
- Compare product behavior using the same exact provider/model where possible.

Gate: every capability has named evidence; deterministic conformance passes 100%; the paired 95% bootstrap lower bound is above −5 points; median wall time is at most 1.25× and model cost at most 1.15× the comparator.

#### `WP-29` External security review — 2 core person-weeks + 3 calendar weeks external, A+B+External

Review start depends on `WP-14`, `WP-20`, `WP-25`, and `WP-27`. The signed final report additionally depends on `WP-28`.

- Review trust, path races, containment, SSRF, secrets, extensions, approvals, encryption, and daemon authorization.

Gate: a signed report is delivered and every finding has severity, reproduction, owner, and remediation disposition. A critical finding stops release work, but `WP-30` remains authorized so remediation cannot deadlock.

R5 exit:

- All mandatory capabilities are feature complete.
- Feature additions stop; only remediation, migration, performance, documentation, and release work continue.

### R6 — Parity beta, weeks 44–50

#### `WP-30` Security remediation and adversarial rerun — 6 person-weeks, A+B

Depends on `WP-29`.

Gate: no open critical/high finding; each medium has mitigation, owner, and retest date.

#### `WP-31` UX/QA, performance, and soak — 4 core person-weeks, B+C+External

Preparation depends on `WP-28` and `WP-29`. The final signed UX/performance/soak artifact must run against the post-remediation SHA that passes `WP-30`.

Gate:

- all daily-driver journeys pass against the post-remediation SHA;
- eight-hour team/session soak drops no semantic event and leaves no orphan;
- key-to-paint p95 is below 50 ms;
- 10 MB session resume p95 is below two seconds on reference Linux x64.

#### `WP-32` Migration, documentation, and claims audit — 3 person-weeks, A+B+C

Depends on `WP-15`, `WP-18`, `WP-20`, `WP-23`, `WP-24`, `WP-25`, `WP-26`, `WP-27`, `WP-28`, `WP-30`, and `WP-31`.

- Document OpenCode-inspired configuration/permission/MCP conventions and the stricter OpenSwarm trust differences.
- Audit `verified`/`unverified` model labels, telemetry consent, storage defaults, grant lifetime, MCP auth, and plugin hash invalidation.

Gate: every public claim cites a passing `DDP-*` ID; unsupported behavior is removed or explicitly marked; no local-only data path transmits without an explicit consent artifact.

#### `WP-33` Release-candidate matrix and beta publication — 3 core person-weeks across 2 calendar weeks, all

Depends on `WP-30`, `WP-31`, and `WP-32`.

Calendar sequence:

1. Build/sign RC1 at the start of week 49 and begin the seven-day soak.
2. Any code/config change invalidates RC1 and restarts the seven-day clock.
3. At the end of the unchanged soak, rerun the release matrix and build/sign RC2 in week 50.
4. Publish only after RC2, backup/rollback rehearsal, and final defect review pass.

Gate:

- two consecutive clean release candidates;
- seven-day beta soak;
- signed artifacts;
- migration backup and rollback rehearsal;
- no Sev-1/Sev-2 defects.

R6 result: a parity beta, explicitly not compatibility-stable 1.0.

## Critical paths

Security:

`WP-00 → WP-01 → WP-02/WP-03 → WP-04 → WP-09 → WP-13 → WP-14 → WP-25 → WP-29 → WP-30 → WP-32 → WP-33`

Sessions:

`WP-00 → WP-05 → WP-07 → WP-08 → WP-19 → WP-26 → WP-28 → WP-29 → WP-31 → WP-32 → WP-33`

Swarm correctness:

`WP-01 → WP-06 → WP-11 → WP-17 → WP-18 → WP-24 → WP-28 → WP-29 → WP-31 → WP-32 → WP-33`

Isolated landing joins that path through `WP-11 → WP-20 → WP-24`.

Providers/intelligence:

`WP-00 → WP-07 → WP-08 → WP-16 → WP-21/WP-22 → WP-26 → WP-28 → WP-29 → WP-31 → WP-32 → WP-33`

Rules:

- Failed release gates consume schedule buffer; they do not authorize dependent work.
- Trust, confinement, session integrity, retry safety, and containment are not waivable.
- Book the external review by week 12.
- Provision all platform runners during R1; waiting until R5 is a schedule failure.

## Capacity

Three engineers over 50 weeks provide 150 gross person-weeks. The loading model allocates 102 to feature packages, 36 to explicit cross-package quality work, and 12 to true contingency.

Four engineers have enough capacity for the original 39-week target but require a separate dependency schedule. Two engineers require approximately 69 weeks for committed work or 75 weeks with equivalent contingency.

`WP-00` and R1 replace planning estimates with measured loading. Rebaseline beyond 50 weeks when:

- committed package work exceeds 102 core person-weeks;
- cross-package quality work exceeds 36 person-weeks;
- any owner exceeds phase capacity;
- true reserve drops below twelve person-weeks;
- any required platform runner is unavailable at the start of week 10;
- the third engineer is unavailable at week ten.

Do not preserve the date by dropping safety or the fixed matrix.

### Deferral order

1. New topologies, adaptive-routing productization, and team-quality experiments.
2. Desktop, remote/cloud, and OpenHive Track B.
3. Notebook UX and broad plugin compatibility.
4. Non-matrix providers, languages, platforms, and ACP clients.
5. Advanced LSP and cross-provider fork migration.
6. Cosmetic UI convergence without user-outcome impact.

## Verification strategy

### Numeric beta defaults

These defaults make “bounded,” “timely,” and “under load” testable:

- child stdout/stderr: 1 MiB in-memory ring per stream, spill up to 100 MiB per process, then terminate the process group with `output_limit`;
- global live-worker quota: 16 across all teams and root agents for one user/runtime; additional spawns queue;
- worker heartbeat: every 30 seconds; mark suspect after 60 seconds and expired after 90 seconds;
- daemon/event queues: maximum 10,000 frames or 64 MiB, whichever comes first;
- queue saturation: coalesce/evict low-priority deltas first; otherwise apply producer backpressure for at most five seconds, then durably record and cancel the offending producer with `backpressure_exceeded`; committed semantic facts remain in `EventStore` and projections catch up from the journal;
- high-priority approval/cancel/task-result frames begin service within 250 ms under standard load; low-priority deltas are serviced or coalesced within two seconds;
- approval wait: 60 seconds default, 300 seconds maximum;
- hooks: 30-second default and 300-second absolute deadline;
- MCP: 10-second connect, 60-second call default, 300-second absolute deadline;
- LSP: 10-second startup, 30-second request, and 5-second shutdown deadline;
- workspace lease: 30-second TTL, renewal every 10 seconds, 30-minute hold before an explicit extension is required;
- writer fairness: after the current writer releases, the next queued writer starts within five seconds under 32 continuously active readers;
- standard event load: 16 workers, 100 semantic events/second, 4 KiB average payload, for 10 minutes;
- aggregate budget fixture: 100,000 total tokens, USD 5, 30 wall-clock minutes, and 500 tool calls; the broker reserves each request’s declared maximum before dispatch, so no unreserved overshoot is accepted;
- cancellation: descendants receive termination within two seconds and no descendant remains after five seconds;
- image attachment: 20 MiB and 4096×4096 default maximum before policy-specific resizing;
- session performance: 10 MiB journal resumes at p95 below two seconds on reference Linux x64;
- TUI latency: key-to-paint p95 below 50 ms under standard event load.

Configuration may tighten these defaults. Relaxation requires an explicit policy grant and remains subject to absolute safety caps.

### Product-parity evaluation gate

- The corpus contains deterministic synthetic/security fixtures, pinned public TypeScript/Python/Go repositories, and an optional private holdout.
- Every workflow preregisters its capability-specific comparator, exact provider/model, repository snapshot, task version, parameters, seeds, and expected manual-intervention policy.
- OpenSwarm and the comparator run paired on the same model/provider. Infrastructure/provider failures are classified separately and never counted as product successes.
- Task success passes only when the paired 95% bootstrap lower confidence bound for `OpenSwarm − comparator` is above −5 percentage points.
- Sample size expands according to the preregistered power rule until the result passes, fails, or remains explicitly inconclusive; an inconclusive result cannot support a parity claim.
- Median single-agent wall time must be at most 1.25× the comparator.
- Median model cost must be at most 1.15× the comparator using provider-reported uncached/cached usage and the pinned price sheet.
- Deterministic safety/correctness capabilities remain 100% gates and cannot be averaged into these comparative metrics.

### Per-work-package verification contract

`WP-00` creates the missing Compose harness. Every package runs exactly one verbose suite at a time through:

`docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh <WP> <cell>`

The script writes `artifacts/parity/<WP>/<cell>.json`, exits nonzero on a failed threshold, and records fixture IDs, image digest, commit, platform, runtimes, provider/model where applicable, duration, and result.

| WP | Exact verification command | Primary fixtures | Threshold |
|---|---|---|---|
| `WP-00` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-00 linux-x64` | `FX-EFFECT-001`, `FX-CRASH-001`, `FX-STORAGE-DEFAULT-001` | Durability invariant passes; encrypted 90-day default and secure-key-missing ephemeral behavior are explicit |
| `WP-01` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-01 linux-x64` | `FX-MANIFEST-001`, `FX-CLAIM-001`, `FX-EVAL-PLAN-001` | Every ID has evidence ownership; corpus, comparator, model IDs, statistics, and guardrails are preregistered |
| `WP-02` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-02 linux-x64` | `FX-TRUST-001..006` | Zero pre-trust process, network, secret, or project-setting activation |
| `WP-03` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-03 linux-x64` | `FX-PATH-001..020`, generated corpus | Zero escapes across at least 10,000 path/symlink/race cases |
| `WP-04` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-04 linux-x64` | `FX-PROC-001..012` | Zero direct untrusted spawns; all unavailable `require` paths execute nothing |
| `WP-05` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-05 linux-x64` | `FX-RETRY-001..010` | Zero duplicate mutating dispatches; unresolved attempts remain `outcome_unknown` |
| `WP-06` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-06 linux-x64` | `FX-CLAIM-002`, `FX-CAS-001` | One owner across 10,000 claims; no moved target commit is lost |
| `WP-07` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-07 linux-x64` | `FX-JOURNAL-001..012`, `FX-MIG-SESSION-001` | Every torn-write boundary retains the last committed event; N/N−1 rules pass |
| `WP-08` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-08 linux-x64` | `FX-CONV-001..004` | Ten-turn and restart continuity pass on all engine adapters |
| `WP-09` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-09 linux-x64` | `FX-APPROVAL-001..012` | Default grants are session/resource/operation scoped; missing, expired, replayed, disconnected, and late decisions deny 100% |
| `WP-10` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-10 linux-x64-pty` | `FX-TUI-KEYS-001..014` | Zero dropped input; all key/history/paste/approval cases pass |
| `WP-11` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-11 linux-x64` | `FX-RW-001..012` | Stale output remains provisional, revalidates automatically, and cannot become terminal; queued writer starts within five seconds |
| `WP-12` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-12 linux-x64` | `FX-EVENT-001..010` | 100% semantic projections rebuild; no semantic frame is dropped at standard load |
| `WP-13` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-13 linux-x64` | `FX-NET-001..016`, `FX-SECRET-001..008` | Zero redirect/rebind/private-IP/ambient-secret bypasses |
| `WP-14` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-14 linux-x64` | `FX-EXT-ABUSE-001..016`, `FX-PLUGIN-HASH-001` | Every malicious extension is denied/contained; changed plugin content invalidates trust |
| `WP-15` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-15 linux-x64` | `FX-MCP-001..014`, `FX-MCP-OAUTH-001`, `FX-MIG-CONFIG-001` | Layering, stdio/HTTP, OAuth/named-secret auth, resources, timeout, cancellation, and N/N−1 pass 100% |
| `WP-16` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-16 provider-contract` | `FX-PROVIDER-001..018`, `FX-MODEL-LABEL-001` | Certified IDs pass contracts; all other models remain usable but visibly `unverified` and evidence-ineligible |
| `WP-17` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-17 linux-x64` | `FX-WORKER-001..012`, `FX-MIG-DAEMON-001` | Root/worker capability manifests match; unauthorized transitions are zero |
| `WP-18` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-18 linux-x64-load` | `FX-SUP-001..014`, `FX-BUDGET-001..006` | 16-worker and 30/60/90 heartbeat limits hold; queue service/backpressure and 2s/5s cleanup pass; budget has zero unreserved overshoot |
| `WP-19` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-19 linux-x64` | `FX-REWIND-001..010` | Conversation/code hashes restore exactly; parent and fork remain independent |
| `WP-20` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-20 linux-x64-git` | `FX-LAND-001..016` | Ref-only, clean, dirty, and concurrent target cases lose no commit or worktree state |
| `WP-21` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-21 lsp-matrix` | `FX-LSP-TS/PY/GO-001..004` | Four certified operations pass for all three pinned servers |
| `WP-22` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-22 image-matrix` | `FX-IMG-001..012`, `FX-MIG-BLOB-001` | Valid images traverse all surfaces/providers; malformed/oversized/tampered blobs fail |
| `WP-23` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-23 linux-x64` | `FX-MEM-001..010`, `FX-MIG-MEM-001` | Curated/archive state survives crash and obeys canonical scope |
| `WP-24` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-24 linux-x64-team` | `FX-TEAM-UX-001..012` | Watch/status/TUI/ACP converge after restart; usage reconciles |
| `WP-25` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-25 platform-matrix` | `FX-PLAT-001..005`, `FX-WSL-ID-001` | Package/isolation/PTY/cancel/cleanup pass on all five pinned targets |
| `WP-26` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-26 surface-matrix` | `FX-HDL-001..010`, `FX-ACP-001..010` | Headless and Zed pass the same mandatory journeys as TUI |
| `WP-27` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-27 crypto-matrix` | `FX-RET-001..010`, `FX-MIG-CRYPTO-001` | Encrypted 90-day default, alternate policies, export/delete, ephemeral no-key fallback, and tamper failures pass |
| `WP-28` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-28 release-matrix` | `FX-MATRIX-001..045`, `FX-NONINFERIOR-001`, `FX-EFFICIENCY-001` | Deterministic cells pass 100%; −5-point paired confidence, 1.25× latency, and 1.15× cost gates pass |
| `WP-29` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-29 security-review` | `FX-SEC-REPORT-001` | Signed report exists; every finding has severity, reproduction, owner, and disposition |
| `WP-30` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-30 security-retest` | `FX-SEC-RETEST-001` | Zero open critical/high findings; every remediation has an independent retest |
| `WP-31` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-31 soak-8h` | `FX-SOAK-001`, `FX-UX-001..008` | Post-remediation SHA: eight hours, zero semantic loss/orphans; latency/resume thresholds pass |
| `WP-32` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-32 migration-claims` | `FX-MIG-ALL-001..010`, `FX-CLAIMS-001`, `FX-PRIVACY-001` | Migrations/claims pass; no local-only telemetry path transmits without explicit consent evidence |
| `WP-33` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-33 release` | `FX-RC-001`, `FX-ROLLBACK-001` | Two clean RCs, signed artifacts, rollback rehearsal, seven-day soak |

### Unit and property tests

- All policy precedence, grant expiry, and use-limit combinations.
- At least 10,000 generated path/symlink cases per filesystem family.
- Session journal, migration, checkpoint, task, lease, generation, and landing state machines.
- Provider content conversion and capability negotiation.
- TUI reducer and key-sequence behavior.
- Secret redaction in audit, errors, transcripts, and child output.

### Integration tests

- Fault injection before/after mutating dispatch and journal commit.
- Malicious repository containing hooks, MCP, plugins, symlinks, redirects, and exfiltration attempts.
- Shared provider contract suite.
- TypeScript/Python/Go LSP fixtures.
- Shared writer/reader races and isolated landing races.
- Approval expiry/replay and broker disconnect.
- Process-tree cancellation and orphan cleanup.

### Required end-to-end journeys

1. Open an untrusted repository without executing project code.
2. Inspect, edit, approve, test, review diff, and continue the conversation.
3. Deny network/secret access, grant one domain/secret, and verify scope.
4. Crash, resume, checkpoint, fork, and rewind.
5. Run one shared writer with overlapping readers and force stale revalidation.
6. Run two isolated writers and serialize landing.
7. Complete the same task through headless and Zed ACP.
8. Attach an image and use LSP across all three languages.
9. Use a remote OAuth MCP server and a named-secret bearer-token server without exposing credentials.
10. Modify a trusted plugin and verify hash invalidation blocks activation.
11. Run with no secure storage key and verify an explicit ephemeral session with no plaintext files.
12. Select an uncertified model and verify visible `unverified` labeling and evidence exclusion.

### Platform matrix

Five targets × three providers × three languages = 45 deterministic release smoke cells. These cells use recorded/provider-contract fixtures; they do not imply 45 live API calls.

- Full live-provider suites: Linux x64 and macOS arm64.
- Package, TUI, isolation, shell, cancellation, and cleanup: every target.
- Zed integration: macOS arm64 and Linux x64; ACP golden protocol tests elsewhere.
- Windows cell: Windows 11 host with the pinned Linux distribution under WSL2/container; native Windows fallback is rejected.
- The R1 manifest pins exact OS builds, runtimes, LSP servers, provider model IDs, and certification dates.

### Observability gates

- Zero dropped semantic events during the eight-hour soak.
- Every side effect has policy, attempt, generation, and terminal records.
- Cancellation reaches descendants within two seconds; no process remains after five seconds.
- TUI key-to-paint p95 below 50 ms under standard event load.
- 10 MB session resume p95 below two seconds on reference Linux x64.
- Usage/cost totals reconcile with provider records within documented rounding.
- Audit output contains zero raw granted secrets.

### Security gate

- Independent review has no unresolved critical/high findings.
- Medium findings have accepted mitigation and retest dates.
- Abuse corpus covers trust, path/TOCTOU, injection, containment, SSRF, secrets, approval replay, extensions, session tampering, and daemon impersonation.

### Evidence policy

- 100% of mandatory capability IDs have named evidence.
- At least 90% are fully automated.
- Manual UX/security evidence records reviewer, build, platform, date, and result.
- Deterministic and safety conformance passes 100%.
- Live-provider comparisons follow the preregistered paired bootstrap and efficiency gates; transient provider failures remain separate infrastructure outcomes.
- Inconclusive statistical results cannot support parity claims.

## Migration and compatibility

1. Version session, event, content, attachment, config, approval, daemon, headless, plugin-trust, certification, and telemetry-consent protocols.
2. Each staged schema reads N and N−1; it writes only N. Older state opens as a read-only archive or returns an explicit incompatibility error.
3. Maintain an explicit mapping from canonical session/event IDs to opaque provider IDs.
4. Dual-read legacy SDK session IDs, native snapshots, team checkpoints, hook config, MCP config, and plugin manifests.
5. Treat journal, attachment, memory, checkpoint, and workspace metadata as one migration unit with a commit marker.
6. Freeze session/attachment encryption envelopes, the encrypted 90-day default, and ephemeral no-key behavior in `WP-00`; later key-policy work must not rewrite the journal schema.
7. Legacy sessions with discarded tool/media blocks import as lossy read-only history and cannot claim exact rewind.
8. Write only the new session/event/content format after R2.
9. Back up before migration; make migration idempotent, resumable, and rollback-capable.
10. Import provider session IDs opaquely; do not promise cross-provider replay.
11. Map legacy permission modes into policy ceilings; ambiguous rules become `ask` or `deny`.
12. Mandatory process containment remains active even under legacy `danger-full-access`.
13. Change autonomous network default to denied; diagnostics may suggest but never create grants.
14. Change headless implicit prompting to default deny; the authenticated API is explicit opt-in.
15. Preserve legacy CLI aliases for one staged release with warnings.
16. Disable in-process plugins at parity beta while preserving migration diagnostics.
17. Reject incompatible active daemons before state mutation and before any migration commit.
18. Normalize WSL path mappings without changing canonical trust identity.
19. Import legacy plugin records as disabled until source/content hashes are recorded and trusted.
20. Legacy model IDs import as `unverified` until the exact identifier passes certification.
21. Telemetry consent defaults to absent/disabled during migration; migration never infers opt-in.

Schema ownership is release-gated:

| Schema | Owning packages |
|---|---|
| Event/content/effect envelope | `WP-00`, `WP-07`, `WP-12` |
| Trust and grants | `WP-02`, `WP-09`, `WP-13` |
| Session/checkpoint | `WP-07`, `WP-19` |
| Workspace/task/landing | `WP-06`, `WP-11`, `WP-20` |
| Extension/MCP config | `WP-14`, `WP-15` |
| Plugin trust/hash records | `WP-14`, `WP-32` |
| Provider certification manifest | `WP-01`, `WP-16`, `WP-28` |
| Telemetry consent | `WP-01`, `WP-12`, `WP-32` |
| Worker/daemon protocol | `WP-17`, `WP-24` |
| Attachment/blob | `WP-22`, `WP-27` |
| Memory/archive | `WP-23`, `WP-27` |
| Headless/ACP protocol | `WP-26` |

Each owning package must add executable cases for:

- N and N−1 read compatibility;
- N-only writes;
- N-2 read-only archive or explicit error;
- interruption at every migration commit-marker phase;
- idempotent resume after interruption;
- backup restoration;
- permission non-broadening;
- incompatible-daemon rejection before mutation;
- stable canonical trust identity across WSL path mappings.

`WP-32` reruns the aggregate migration corpus; it does not defer schema safety until the end.

## Existing design documents to extend

This roadmap owns capability scope, sequencing, and evidence. Existing design docs remain authoritative for their subsystems.

| Document | Addendum |
|---|---|
| [28-v0.5-daemon-plan.md](./28-v0.5-daemon-plan.md) | Preserve daemon `events.jsonl` as a `LaneEvent` projection; add approvals, heartbeat/backpressure, hierarchical abort, durable state, and usage emission |
| [29-v0.7-git-cascade-plan.md](./29-v0.7-git-cascade-plan.md) | Harden the existing landing queue with generations, captured target SHA, validation evidence, and post-rebase revalidation |
| [37-hardened-engine-design.md](./37-hardened-engine-design.md) | Restrict retry replay for unsafe operations; add operation ledger, ambiguity, and cancellation |
| [40-memory-system-design.md](./40-memory-system-design.md) | Correct the “implemented” status; wire durable curated storage, encrypted 90-day default retention, secure-key providers, ephemeral no-key behavior, export/deletion, and project identity |
| [41-tui-redesign.md](./41-tui-redesign.md) | Preserve reducer/store boundaries; add single-owner input, canonical-event projections, queued prompts, session-scoped approvals, provisional/revalidating output states, and PTY criteria |
| [44-macro-agent-parity-implementation-plan.md](./44-macro-agent-parity-implementation-plan.md) | Extend local Track A landing correctness; existing Track B remains experimental and receives no parity certification/productization |
| [45-adaptive-orchestration-design.md](./45-adaptive-orchestration-design.md) | Freeze topology additions and remove unsupported quality claims |
| [46-sessionlog-trajectory-ingest.md](./46-sessionlog-trajectory-ingest.md) | Define canonical-journal-to-`LaneEvent` projection; distinguish session checkpoints from trajectory/Git checkpoints |
| [48-compaction-design.md](./48-compaction-design.md) | Preserve engine-owned compaction; record durable boundaries, adapter state, branches, replay limits, and budgets |
| [49-tui-parity-plan.md](./49-tui-parity-plan.md) | Move image input into the certified bundle; add user-shell trust class, patch/conflict recovery, and parity journeys |
| [51-eval-execution-plan.md](./51-eval-execution-plan.md) | Remains the heterogeneous-cost study; keep the mixed-corpus, capability-specific paired non-inferiority harness separate |
| [53-token-efficiency-plan.md](./53-token-efficiency-plan.md) | Preserve cache-token/topology-call categories; add capability filtering, aggregate budgets, attachment costs, and the 1.15× model-cost guardrail |

Claims also require reconciliation in `README.md`, `docs/USAGE.md`, and `docs/README.md`.

Each work package updates its subsystem’s design-of-record in the same change. This roadmap coordinates scope and gates; it does not silently supersede those contracts.

## Traceability to the product review

### P0

| Review finding | Work packages | Capabilities |
|---|---|---|
| P0.1 conversation continuity | `WP-07`, `WP-08`, `WP-26` | `DDP-CONV-01`, `DDP-SES-01` |
| P0.2 project trust | `WP-02`, `WP-14` | `DDP-SAFE-01`, `DDP-EXT-01` |
| P0.3 confinement | `WP-03` | `DDP-SAFE-02` |
| P0.4 shell containment | `WP-04`, `WP-25` | `DDP-SAFE-03`, `DDP-PLAT-01` |
| P0.5 approvals | `WP-09`, `WP-26` | `DDP-SAFE-05`, `DDP-HDL-01` |
| P0.6 TUI input | `WP-10` | `DDP-UX-01` |
| P0.7 task/landing state | `WP-06`, `WP-11`, `WP-20` | `DDP-SWM-01/02/03` |
| P0.8 retry side effects | `WP-05` | `DDP-REL-01` |

### P1

| Review gap | Work packages |
|---|---|
| Swarm view and usage wiring | `WP-12`, `WP-18`, `WP-24` |
| Durable memory | `WP-23`, `WP-27` |
| Hooks and extension execution | `WP-02`, `WP-14`, `WP-15` |
| Cross-platform sandbox | `WP-04`, `WP-25` |
| LSP, recovery, images | `WP-19`, `WP-21`, `WP-22` |
| Provider metadata/resume | `WP-07`, `WP-08`, `WP-16` |
| Distribution | `WP-25`, `WP-28` |
| SSRF | `WP-13`, `WP-29` |
| Supervision/resources | `WP-17`, `WP-18`, `WP-29` |
| Worker parity | `WP-09`, `WP-14`, `WP-17` |
| Budgets/errors | `WP-12`, `WP-16`, `WP-18` |
| Task authorization | `WP-06`, `WP-17` |
| Notebook safety | `WP-03`, `WP-04`; disable by default pending atomic implementation |
| Worktree mode | `WP-11`, `WP-20` |
| Documentation drift | `WP-01`, `WP-32` |

## Pre-mortem

### Failure 1: alternate composition roots bypass the new safety core

Early signal: direct `spawn`, `fetch`, or path resolution appears outside brokers.

Mitigation:

- static architecture checks;
- malicious-repository suite across root, worker, daemon, TUI, headless, and ACP;
- shared runtime composition factories.

Release response: any bypass blocks the gate.

### Failure 2: session unification repeats effects or loses provider state

Early signal: unexplained duplicate effects, adapter-specific resume failures, or journal gaps.

Mitigation:

- append-only journal;
- stable operation ledger;
- fault injection around every acknowledgment boundary;
- same-provider resume guarantee for parity beta.

Release response: stop feature work after any unexplained duplicate mutation.

### Failure 3: platform work arrives too late

Early signal: macOS x64, Linux arm64, or WSL2 runner missing at the start of week 10.

Mitigation: provision all runners during R1 and run empty package/isolation smoke tests continuously.

Release response: missing runner at R2 triggers schedule rebaseline.

### Failure 4: concurrent agents corrupt shared or target state

Early signal: ignored generation mismatches, partial landing, stale target update, or unrecoverable conflict.

Mitigation: lease assertions, digest CAS, serialized landing, and conflict-preserving failure.

Release response: any unrecoverable corruption blocks team alpha.

### Failure 5: scope exceeds staffing

Early signal: third engineer absent at week 10, cross-package quality allocation below 36 person-weeks, or contingency below twelve.

Mitigation: strict deferral order and no topology experiments.

Release response: publish a revised date rather than a weakened parity claim.

## ADR

### Decision

Adopt a thin effect-transaction foundation, validate it through one vertical walking skeleton, then expand through six gated releases. Use OpenCode selectively for configuration/provider/permission/MCP UX while retaining stricter OpenSwarm security and certification contracts. The stable seams are the session coordinator, operation policy, process/workspace authorities, typed content, canonical journal, and versioned projections.

### Drivers

- Eight current P0 blockers.
- Full daily-driver outcome parity with a selected best-of-breed bundle.
- Explicit encrypted-storage, grant-lifetime, extension-provenance, telemetry, model-certification, and statistical parity policies.
- Fixed support matrix and 50-week parity-beta target after rejecting the infeasible 39-week/three-engineer combination.

### Alternatives considered

1. **Control-plane-only parity:** lower cost and consistent with the audit recommendation, but rejected by the chosen product goal.
2. **Full foundation-first rewrite:** strongest theoretical uniformity, but risks months of abstraction work before real provider/surface behavior validates the design.
3. **Surface-first parity:** faster visible progress, but duplicates state/policy logic and defers critical risk.
4. **Independent per-engine/frontend fixes:** smaller initial diffs, but preserves the current composition drift.

### Why chosen

The walking skeleton tests the minimum canonical contracts against a complete effect before broad rollout. This preserves one safety/transaction model without committing the entire program to unvalidated universal abstractions.

### Consequences

- Visible feature velocity is lower in the first quarter.
- Pre-1.0 session/config/protocol migrations are required.
- In-process plugins and permissive defaults break; changed plugin hashes require renewed trust.
- No-config storage retains encrypted history for 90 days; missing secure keys force an explicit ephemeral session.
- Uncertified models remain usable but visibly `unverified` and excluded from claims.
- Shared readers may observe changing state, so output remains provisional until automatic revalidation succeeds.
- Statistical non-inferiority and efficiency evidence adds live-provider cost and may return an inconclusive result rather than a parity claim.
- OpenCode alignment covers behavior/configuration conventions, not plugin API compatibility or weaker trust assumptions.
- Three core engineers are required for the 50-week baseline; 39 weeks requires four plus a separate dependency schedule, and two engineers require approximately 75 weeks with equivalent reserve.

### Follow-ups

- Complete and review `WP-00` before expanding the foundation.
- Freeze exact certified model IDs, the mixed corpus, preregistered comparator mapping, and `DDP-*` manifest in R1.
- Validate the OpenCode-inspired configuration/MCP UX against OpenSwarm’s trust and secret boundaries.
- Select and test OS/headless secure-key providers; verify the ephemeral fallback before durable rollout.
- Book external security review by week 12.
- Provision every platform runner during R1.
- Reassess scope/date at R2 and R4 without weakening mandatory gates.
