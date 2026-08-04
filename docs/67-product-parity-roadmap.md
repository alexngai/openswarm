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

- 105 core person-weeks of feature/work-package delivery;
- 36 person-weeks explicitly allocated to integration, tests, migration, documentation, remediation, and release quality;
- 10 person-weeks of true contingency;
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

This contract is also encoded as data in `src/parity/capabilities.ts`, and `bun scripts/check-parity-manifest.ts` fails when the two disagree on any ID, outcome, or evidence statement. The tables below are therefore checked, not merely reviewed — which is how `DDP-SWM-05` came to exist: `WP-17` was three person-weeks of work that no capability had asked for, while the scope boundary separately promised a uniform runtime contract with no ID to hold it.

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
| `DDP-SWM-05` | One authoritative runtime contract across root agents, workers, and daemons | Root and worker capability manifests match; unauthorized cross-process task transitions are zero; daemon transport identity is authenticated |
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
| R1 | 1–9 | `00` 4 ✔; `00a` 4 ✔; `01` 1 ✔; `02` 2 ✔; `03` 1 ✔; `04` 2; `05` 2; `06` 2 | 7/4/7 | 2/5/2 | 27 | 27 | 0 |
| R2 | 10–17 | `07` 3; `08` 3; `09` 1; `10` 2; `11` 3; `12` 2; `27a` 2 | 3/8/5 | 3/0/2 | 21 | 24 | 3 |
| R3 | 18–27 | `13`–`18` 3 each | 6/6/6 | 3/3/3 | 27 | 30 | 3 |
| R4 | 28–35 | `19` 3; `20` 3; `21` 4; `22` 3; `23` 3; `24` 3 | 5/7/7 | 3/1/1 | 24 | 24 | 0 |
| R5 | 36–43 | `25` 6; `26` 4; `27` 2; `28` 4; `29` 2 | 6/6/6 | 2/2/2 | 24 | 24 | 0 |
| R6 | 44–50 | `30` 6; `31` 4; `32` 3; `33` 3 | 5/6/5 | 1/0/1 | 18 | 21 | 3 |
| **Total** | **50** |  | **32/37/36** | **14/11/11** | **141** | **150** | **9** |

✔ marks delivered work. Inserting `WP-00a` added 4 person-weeks and the `WP-03`/`WP-09` re-scopes returned 2, so committed work rises from 138 to 140 and true contingency falls from twelve to ten. That crosses the rebaseline trigger below, and it does so on the first inserted package — which is the signal the pre-mortem asked for, not a surprise to absorb quietly.

`WP-27a` lands at w16–17, after `WP-08` at w13–15, which is the order the two packages actually require: `WP-08` builds the resume plumbing against opt-in storage, and the default flips to durable only once encryption exists. Splitting `WP-27a` forward is the second insertion, and it costs one net person-week: two in R2 for encryption and key providers, against one returned by the `WP-27` remainder that keeps retention, purge, and export. Committed work rises from 140 to 141 and contingency from ten to nine. The forward move is not optional — `DDP-CONV-01` is an R2 exit criterion and cannot pass on ephemeral-by-default history — but it does put owner B at eight package weeks in an eight-week release, so B's R2 quality week moves to R5, where the `WP-27` remainder freed the room. Release-wide quality is unchanged at 36. R5 now has zero slack in every owner, and B has none in R2.

`WP-00a` is A+C work, and both owners were already loaded to exactly nine person-weeks across R1's nine weeks, so the insertion put each at ten. R1's total still fits in 27 because owner B had two weeks spare, so R1's cross-package quality allocation is rebalanced from 3/3/3 to 2/5/2 and the release-wide quality split becomes 14/11/11, unchanged at 36 in total. This works only because quality work is reassignable; the package work is not. R1 now has zero slack in every owner, so any further insertion has to move a package out.

The forward exposure is smaller than these rows suggest, since both packages carrying the increase are already delivered. The rows are kept at plan values rather than measured ones deliberately: the work was done by an agent in hours, and recording that as a person-week figure would corrupt a model built for human capacity planning.

Cross-owner feature splits:

- `WP-00` B2/C2; `WP-00a` A2/C2; `WP-11` A2/C1.
- `WP-14` A2/C1; `WP-15` B2/C1; `WP-18` A1/B1/C1.
- `WP-19` B2/C1; `WP-20` A2/C1; `WP-21` A2/B2; `WP-22` B2/C1; `WP-23` A1/B1/C1.
- `WP-25` A3/B1/C2; `WP-26` B2/C2; `WP-27` A1/B1; `WP-28` A1/B1/C2; `WP-29` A1/B1+External.
- `WP-30` A3/B3; `WP-31` B1/C3; `WP-32` A1/B1/C1; `WP-33` A1/B1/C1.

Dependency- and owner-constrained schedule:

| Release | Feature schedule | Cross-package quality schedule | Slack |
|---|---|---|---|
| R1 | `WP-00` B/C w1–2 ✔; `00a` A/C w3–4 ✔; `01` C w5 ✔; `02` A w5–6 ✔; `03` A w7 ✔; `04` A w8–9; `05` B w4–5; `06` C w6–7 | A w1–2; B w3,w6–9; C w8–9 | none |
| R2 | `WP-07` B w10–12; `08` B w13–15; `09` A w10; `11` C w10 + A w12–13; `12` C w14–15; `10` C w16–17; `27a` B w16–17 | A w14–16; C w11–12 | A w11,w17; C w13 |
| R3 | `WP-13` A w18–20; `16` B w18–20; `14` C w21 + A w21–22; `15` C w23 + B w23–24; `17` C w24–26; `18` A/B/C w27 | A w23–25; B w21–22,w25; C w18–20 | A/B w26; C w22 |
| R4 | `WP-19` B w28–29 + C w28; `20` A w28–29 + C w29; `21` A/B w30–31; `22` C w30 + B w32–33; `23` C w31 + A w32 + B w34; `24` C w32–34 | A w33–35; B/C w35 | none |
| R5 | `WP-25` A w36–38 + B w36 + C w36–37; `26` B w37–38 + C w38–39; `27` A w39 + B w39; `28` A/B w41 + C w41–42; `29` external w41–43 + A/B w43 | A w40,w42; B w40,w42; C w40,w43 | none |
| R6 | `WP-30` A/B w44–46; `31` C w44–46 + B w47; `32` A/B/C w48; `33` A/B/C 0.5 pw each in w49 and w50 with the seven-day soak spanning both weeks | A/C w47 | 0.5 A/B/C in w49–50 |

The four-engineer 39-week and two-engineer 75-week figures are capacity-only bounds, not approved dependency schedules. Either staffing variant requires its own resource-constrained schedule before commitment.

The estimates are hypotheses. `WP-00` produces a bottom-up re-estimate; see the next section for its findings. Rebaseline when committed work exceeds 105 person-weeks, quality allocation falls below 36, an owner exceeds phase capacity, or the third engineer is unavailable by R2.

Two of these have already fired once, on `WP-00a`: committed work rose past the original 102 and owner A exceeded R1 capacity. The thresholds above are the post-`WP-00a` baseline, not the original one.

### `WP-00` re-estimate

The walking skeleton is built and its gate passes: `compose.parity.yml`, `scripts/verify-parity-wp.sh`, the frozen contracts, a durable journal, canonical path authority, discriminated policy, the effect transaction with write compare-and-swap, the seven-point fault matrix, and the storage/encryption contracts. The architecture review of the transaction ordering remains outstanding, and is the one part of the gate a test cannot discharge.

Four findings change the estimates.

**The journal was an unlisted prerequisite.** `WP-00` specifies "durably append `AttemptPrepared`" as though an append primitive existed. None did. All four existing lane-event writers use `createWriteStream` with no flush discipline, and `session-recorder` opens with `flags: "w"`, truncating per session. Telemetry survives that; an attempt journal does not, because "did this effect already run?" must be answerable after a hard kill. A store with explicit commit semantics was therefore part of `WP-00` rather than of `WP-07`. Consolidating the four existing writers onto it is real work that no package currently owns.

**The estimate priced design, and the cost is adoption.** The contracts and skeleton are greenfield with zero integration, and landed well inside 4 person-weeks. That is not evidence the program is cheaper than budgeted. Nothing in `src/tools/` or `src/engine/` uses the new contracts yet: the skeleton runs beside `ToolDispatcher` and `canUseTool`, not inside them. The expensive work is migrating the six tier-0 tools that carry duplicated `path.resolve` + `isUnderCwd` logic and routing the permission gate through the discriminated `PolicyEngine` — none of which `WP-00` claimed, and all of which later packages assume is already done.

**There are two tool-execution chokepoints, not one.** `WP-03`, `WP-04`, and `WP-09` are written as though authorization and execution funnel through `ToolDispatcher`. The Claude Agent SDK path does not: its MCP handler calls `toolImpl.execute` directly, bypassing the dispatcher's hooks and dispatch-time validation. Any package that enforces policy at the dispatcher enforces it for one engine family and not the other. Each of those three packages needs a second wiring path, or an earlier package has to collapse the two.

**The audit-derived P0 list is incomplete.** Surveying the path helpers for `WP-00` surfaced a containment bug that no audit finding named: `isUnderCwd` resolves symlinks only when the leaf is a symlink, so a path through a symlinked parent directory escapes the workspace, and only `write_file` realpaths its parent. The kernel authority closes this; every tier-0 tool still carries it. Expect comparable findings during adoption, and treat the remediation allocation as a floor rather than an estimate.

Recommended adjustments, all now applied:

- **Applied.** Add an adoption package between `WP-00` and `WP-03` that moves the production path onto the frozen contracts. Estimate 4 person-weeks, A+C. Delivered as `WP-00a` below. Event-writer consolidation was originally folded in here and has instead moved to `WP-07`, where the snapshot and import work it interacts with already lives.
- **Applied.** Re-scope `WP-07` to exclude journal construction, which is done, and to include migrating the existing writers.
- **Applied, differently than proposed.** Rather than adding a second SDK wiring path to `WP-03`, `WP-04`, and `WP-09`, `WP-00a` enforced at `canUseTool`, which every engine already honours. The two chokepoints were never collapsed and no longer need to be.

The predicted neutral R1 budget did not hold. `WP-00a` added 4 person-weeks; `WP-07` did not shrink, because the writer migration replaced the journal work rather than being additive to a smaller package; and the offset came instead from `WP-03` and `WP-09`, both of which `WP-00a` partly delivered. Net is +2 committed and −2 contingency. The ordering risk was called correctly: `WP-00a` did sit on the critical path of every enforcement package after it.

### `WP-00a` Production adoption of the frozen contracts — 4 person-weeks, A+C

The package the re-estimate recommends. Gate: `./scripts/verify-parity-wp.sh WP-00a <cell>`, `A1`–`A14` passing on both `linux-x64` and `macos-arm64`. Fixtures `FX-ESCAPE-001` (containment corpus, including the symlinked-parent case), `FX-GATE-001` (every engine gates tool calls), and `FX-AUDIT-001..019` (the audit journal is durable with no storage configuration, holds no message text, survives `SIGKILL`, pairs a pre-decision fact with a terminal one for every side effect on both dispatch paths, and reconciles what a real crash leaves dangling when the session next starts), and `FX-WORKER-001..006` (a swarm worker reaches the same verdict as the CLI, emits the validation events the orchestrator reads, and records what it authorized). Delivered in well under the 4 person-weeks estimated, for a reason worth carrying forward: the estimate assumed the chokepoints had to be collapsed, and they did not.

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

**One remainder was not deliberate, and surveying it corrected three things this document had wrong.** The claim was that the *effect path* had never been adopted: `EffectRuntime` — the frozen contract's write transaction, with its compare-and-swap against an expected `FileIdentity`, its durable prepare/resolve records, and its generation bump — had no production caller, tools wrote through `atomicWriteInWorkspace` instead, and `WP-11` had made it worse by building a second answer at the tool path. The remedy written down here was that the tool path should acquire its lease and then commit through the effect transaction, so containment, authorization, exclusion, and compare-and-swap would be decided in one place.

The diagnosis was right about the symptom and wrong about the cause, in a way worth recording because the wrong remedy would have regressed containment.

*The tool path already had a compare-and-swap.* `atomicWriteInWorkspace` takes an `expectedHash` and checks it immediately before the rename — a better position than the kernel's, which checks before staging as well as before rename but stages in a directory an attacker may redirect. `edit_file`, `multi_edit`, and `notebook_edit` all pass one. `write_file` is the single exception, and it is the tool that never reads its target, which is why `WP-11` had to give it a read-state staleness check instead. So there were not one mechanism and one absence; there were two implementations of the same idea, and the tool path's was the stronger.

*The kernel's writer was the weaker of the two.* `EffectRuntime.performWrite` stages beside the target and renames by name. `atomicWriteInWorkspace` stages at the workspace root, because every component of the target's directory is a name that can be redirected between the check and the create, and anchors the rename to a directory descriptor through `/proc/self/fd` where the platform allows it. Routing tool writes into the kernel's writer, as written down above, would have surrendered `WP-03`'s containment guarantee to obtain a compare-and-swap the tool path already had.

*Containment and authorization were never the gap.* `path-containment.ts` already canonicalizes through `WorkspaceAuthority` and builds complete `OperationRequest`s, including the `expected` `FileIdentity`, and `gate.ts` already authorizes each one through a real `PolicyEngine`. Both steps 1 and 2 of the durability order run in production on every call that names its resources. Calling into the effect transaction from the write path would have authorized a second time — the double prompt the gate documents avoiding.

What was actually missing was steps 3 and 5: nothing recorded the decision. `EffectRuntime` was the only writer of `AttemptPrepared` and `AttemptResolved`, and `new EffectRuntime` appeared only in its own test, so "every effect records its principal, decision, attempt, and terminal result" was a property of a class nothing constructed. `DDP-OBS-01` rested on it, and `WP-12` was scheduled to project canonical committed facts that production never produced.

So the adoption is a record, not a rewrite, and each half is written where it is knowable. The gate holds the request, the decision, and the generation, and returns immediately before execution; it records `AttemptPrepared` there and returns the attempt ids. `TurnLedger` brackets the execution and is the only component that knows whether the tool got to say what happened; it writes the terminal record. The distinction the ledger already drew for retries is the one the journal needs — a returned error is a proven failure, a thrown one is `outcome_unknown` — and its own docstring had anticipated the connection, commenting `all()` as "for projecting into a journal". The two interfaces are one-way: `AttemptRecorder` can only prepare and `AttemptResolver` can only resolve, so neither side can write the other's half, and resolution is awaited before the tool's result is returned so an acknowledgement is never ahead of the record of it.

The generation recorded is the shared one from the lease, not `WorkspaceAuthority`'s in-process counter, for the reason `WP-11` established: an expectation is only comparable across the agents that could invalidate it.

**The storage policy governs history, not the audit trail.** This is an amendment to the locked decisions, forced by the same work. Attempt records were sharing one `journal.jsonl` with engine snapshots and so inherited history's storage gate, which meant the answer to "did this effect already run?" existed only for users who had opted into keeping plaintext conversation logs — the inverse of what either policy wants, since that question is asked exactly when the process died. The two record classes differ in content, which is what makes separating them a distinction rather than a convenience: an attempt record carries canonical and relative paths, a tool name, a policy decision, content hashes, sizes, mtimes, and a generation, and never file content or message text. The audit journal is therefore durable unconditionally, with no configuration to resolve and deliberately no ephemeral variant to degrade to, while history keeps the encrypted-or-ephemeral rule and `WP-27a`. Tool output is not recorded at all: it is the one field that can carry arbitrary file content, and the journal's unconditional durability is defensible precisely because it holds decisions instead. Redaction discipline for whatever a projection quotes stays with `WP-12`. The split is held by three type-level assertions that the audit and history event sets partition `KernelEventType` exactly — total, closed, and disjoint — so adding an event type without deciding which journal owns it is a compile error rather than a silent default, which matters because `WP-12` adds projection events next.

**Recording a fact in one place created a wrong one somewhere else.** Only one of the two dispatch paths goes through the ledger. Eager dispatch does; the batch path does not, and the batch path is the default, because `eagerToolDispatch` defaults to false. So the moment the gate began recording, the default path started writing a prepare with no resolve for every tool call the product made — and that is not a missing record but a wrong one, since a prepare with no resolve is precisely the signature recovery reads as a process that died before its effect finished. The audit trail would have reported a crash per tool call, and recovery, once it has a caller, would have set about reconciling effects that had completed normally.

Nothing caught it, which is the more useful part. The correlation fixtures drive the ledger directly and so cannot see a path that has no ledger, and every engine test asserts the results a turn returns rather than the records it leaves. The fix resolves the batch path's attempts against its own results, and the mapping from a tool result to a terminal outcome is now one exported function with two callers rather than a copy each, because a second copy is how one path starts calling a returned error `outcome_unknown`. `FX-AUDIT-012..014` assert that the two paths *agree*, rather than checking either alone, since a fixture per path would still pass while they diverged; the negative control is that reverting the fix reddens the two batch fixtures and leaves the eager one green.

**Recovery now has a caller, which is what makes the records load-bearing.** The reconciliation logic existed on `EffectRuntime` and nothing invoked it, so a restart found the dangling attempt and did nothing — the record was as good as absent. It moved to `attempt-recovery.ts` and `EffectRuntime.recover()` delegates, because attempt records now live in their own journal and the restart path has to reconcile that one; one implementation with two callers, for the same reason the outcome mapping is shared.

Two constraints are worth stating because they bound what this buys. Reconciliation is scoped to the session the caller owns, and a workspace-wide sweep would be wrong rather than merely broad: a concurrent agent's legitimately in-flight prepare is indistinguishable from a crashed one, so sweeping would declare `outcome_unknown` for effects about to resolve normally — the same error as the batch path's, in the opposite direction. The honest cost is that a crashed session nobody resumes keeps its dangling records forever. And nothing is ever replayed, whatever the workspace looks like, because "never ran" and "ran but was not recorded" are not distinguishable and replaying the second is the reading that does damage; recovery reports whether the workspace still matches what the attempt expected and leaves the decision to a person.

`FX-AUDIT-017` kills a process mid-attempt for real rather than hand-writing a prepare, since the failure worth guarding against is not that reconciliation mishandles a dangling record but that what a crash actually leaves behind is not the shape recovery looks for — and a fixture that builds its own input cannot fail that way. It also caught a live bug in the production caller: `WorkspaceAuthority` requires `init()`, and the missing call would have thrown only when there was something to reconcile, so it would have passed every test and first failed during a real recovery. Initialization moved inside the reconciler for that reason.

**The worker surface was not a coverage gap, it was a second gate.** Chasing the missing records into the swarm path found that `buildWorkerCanUseTool` was its own implementation of authorization: containment, then a grading of the *tool* by its declared permission, then escalation. Read alone it looks reasonable, which is the problem — two gates in one product means the weaker is the real posture and the stronger is what gets read during review. Three ways weaker, each now a differential fixture.

It never ran the bash-validation pipeline, whose only caller was the shared gate. So a command the product classifies as never-allowable was merely graded by mode, and with an operator who approves — or in danger-full-access, where nobody is asked at all — a worker would run `cat /etc/passwd`, which the CLI refuses in every mode. Swarm orchestration is this product's primary surface, so that was the posture that counted.

It emitted no lane events. `bash_validation_blocked` and `bash_validation_warned` exist in the swarm event schema so an orchestrator can see what its workers were stopped from doing, and `bash-gate.ts` is their only emitter, so the events the schema gained for the swarm were never produced by one. The gate's `emitLaneEvent` dependency is even documented as the thing swarm workers pass — by a gate the workers did not call.

And it graded tools rather than resources, which is why nothing there could record an attempt: `makePathContainment` runs the same deriver as the real gate and returns only whether a path escaped, so the complete `OperationRequest`s an audit record is built from were computed and thrown away.

The worker path now delegates to `makeCanUseTool` behind a bridge that forwards prompts to the orchestrator, which closes all three at once and leaves containment un-escalated as before, since the shared gate refuses an escaping path before anyone is asked. Both attempt halves were wired together deliberately: recording prepares without resolves would have made every worker tool call look like a crashed process, which is the bug the default dispatch path had one surface over.

What is still owed here, stated plainly. The ACP surface builds the shared gate correctly but passes no attempt sink, so it authorizes per resource and records nothing; that one is plumbing. `DDP-OBS-01` covers the CLI and the swarm, not yet ACP. The kernel's weaker staging is still present rather than retired in favour of the contained write, and `write_file` remains the one tool without a rename-time compare-and-swap, holding a read-state staleness check instead. And the end-to-end evidence is a gate run rather than a live one: the fixtures drive the real engine, the real gate, and the real journal on both paths, but no live model run has yet been observed writing correlated records.

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

Depends on `WP-00`. Delivered. Run `bun scripts/check-parity-manifest.ts`, or the full gate through `./scripts/verify-parity-wp.sh WP-01 linux-x64`.

Delivered earlier, ahead of this package, to gate `WP-00`:

- The Compose parity image, artifact schema, and one-suite-at-a-time verbose runner, as `Dockerfile.parity`, `compose.parity.yml`, and `scripts/verify-parity-wp.sh`.

Delivered by this package, in `src/parity/`:

- Every `DDP-*` capability encoded with its accountable owner, release, supported cells, and evidence, in `capabilities.ts`, alongside the whole work-package schedule in `work-packages.ts`.
- Status is **not** encoded. It is derived from the parity artifacts on disk by `status.ts`, and an artifact that passed at another commit or from a dirty tree does not count. A hand-editable status field is the marketing surface this package exists to remove.
- Exact provider/model API identifiers in `certification.ts`, with every entry a **candidate** and `labelFor` returning `unverified` for all of them. Certification means passing the `WP-16` contract suite, which has not run; recording a certification date now would be the first false claim in the ledger.
- The mixed corpus, one comparator per workflow, five paired seeds, and the margins, in `eval-plan.ts`. The paired bootstrap, the non-inferiority decision, the guardrail ratios, and the power rule are **implemented** in `statistics.ts` rather than merely described, so the procedure is fixed before any result exists. Comparator versions and corpus snapshots are deliberately `null`: naming the repositories is the part that could be cherry-picked, and pinning a competitor's release now would pin a stale one.
- Claim-to-capability validation in `docs-sync.ts`, which fails when a document cites an ID the manifest does not define, when the manifest and the docs/67 tables disagree on any outcome or evidence statement, and when text inside a `parity:claims` block cites no ID.
- Evidence-existence validation in `fixture-coverage.ts` (`FX-MANIFEST-002`), added later and worth explaining, because it closes a hole the checks above cannot see. They prove the manifest agrees with *itself*: a package can name fixtures nobody ever wrote, or claim a gate the script does not have, and every structural check passes because each reference is well-formed. This one reads the tree and so is the only non-structural check in the gate.

  It exists to make `WorkPackage.owes` mean something. A passing gate covers the fixtures it runs, not the package's scope, and three packages reached `gateImplemented` with work still outstanding — recorded here in prose, invisible to `scripts/parity-ready.ts`, which is how `WP-12` came to sit at the head of the ready queue while nothing in production recorded the facts it projects. The obvious fix would have been a status field, and this package exists to refuse exactly that: a `remainder: "ACP sink pending"` string is an assertion nobody can falsify, and would rot the same way the paragraph did.

  So a remainder is stated as *fixtures*, and checked in both directions. A gated package's declared fixtures must all exist in the tree; an owed fixture must not. The second half is what makes it self-maintaining — the commit that writes the evidence is the commit that has to move the entry out of `owes`, or CI fails. `gateImplemented` is now checked against the branches of `verify-parity-wp.sh` rather than against a hand-maintained array in a test, which was itself a claim about a claim sitting in the file whose job was to prevent them. Range notation is expanded on both sides, because that is how the tree cites a corpus: `WP-03` proves twenty path shapes in one generated test whose header names `FX-PATH-001..020`, and demanding twenty literals would fail a package whose evidence is real.

  Two consumers follow from it. `parity-ready.ts` treats a package as satisfying a dependency only when it is gated *and* owes nothing, so `WP-12` now correctly reports as blocked; and `status.ts` gained an `owed` evidence state, so a capability cannot read `verified` off a package that admits it is unfinished. `owed` never masks a `fail`, since an unfinished package is the milder problem.

Not delivered, and reassigned:

- Deterministic malicious-repository and fault-injection fixtures. `FX-CRASH-001` and `FX-EFFECT-001` exist from `WP-00`; the malicious-clone corpus belongs with `WP-02`, which is the package that has to defeat it, and building it here would have meant building it twice.
- Local-only telemetry artifacts and redacted opt-in evidence. `DDP-PRIV-01` is gated by `FX-PRIVACY-001` in `WP-32`; this package records the capability and its owner, not the mechanism.

Gate:

- CI fails when a mandatory ID has no evidence owner. Enforced more broadly than stated, because evidence that names a work package that does not exist, a cell that package never runs, a fixture it never exercises, or work scheduled after the release being proven is indistinguishable from no evidence at all.
- Public capability claims without an ID fail documentation validation.

What encoding the contract found: three release exit gates claimed capabilities whose own stated beta evidence arrives later (`DDP-SAFE-03`, `DDP-SWM-04`, `DDP-PRIV-01`), and `WP-17` was three person-weeks of work that no capability required, against a scope promise that had no ID. All four are corrected above and in the capability contract. Four review passes over the prose found none of them.

#### `WP-02` Repository trust and configuration provenance — 2 person-weeks, A

Depends on `WP-01`. Delivered.

- Canonical repository identity, symlink-resolved, so one workspace is one decision.
- Trust record bound to root and executable configuration hashes, at `~/.openswarm/trust.json`.
- Trust invalidation on relevant configuration change.
- Disable Claude SDK project `settingSources` before trust.
- Include workspace skills, instructions, hooks, MCP, plugins, and LSP configuration in provenance/trust. LSP has no reader yet; `WP-21` adds one to an existing gate rather than a new one.
- Preserve user-level trust independently from workspace trust.
- No hook, MCP, plugin, or LSP activation before trust.

Gate: `./scripts/verify-parity-wp.sh WP-02 <cell>`, `T1`–`T6` passing, over `FX-TRUST-001..006`.

**There was no prior art to copy, which is itself the finding.** The design decision was to follow OpenCode, and OpenCode has no workspace trust: the report is [sst/opencode#6361](https://github.com/sst/opencode/issues/6361), which describes this exact vulnerability and was closed by a stale bot after ninety days rather than by a fix, over an objection that it was an open security report. The follow-up request was closed by its own author. What OpenCode does ship is `OPENCODE_DISABLE_PROJECT_CONFIG`, an all-or-nothing switch. The dialog below is the one proposed in that thread and never built.

Claude Code is the only agent shipping a trust gate, and it has published two CVEs against it. Both are ordering, not policy. `CVE-2025-59536` executed project code before the dialog was accepted. `CVE-2026-33068` read the repository's `.claude/settings.json` first, so a repo setting `defaultMode: bypassPermissions` put the session in a permissive mode and the permissive mode caused the dialog to be skipped — the repository argued its way out of the check meant to vet it. Both fixes moved the gate earlier and changed nothing else. `FX-TRUST-003` and `FX-TRUST-004` are regressions against that second one.

That evidence reframed the package. The bullets above read as checks to add; the cost is in *where the decision happens*. MCP servers were spawned inside `buildAgentRuntime`, so a malicious `.openswarm/mcp.json` got its subprocess before any prompt existed to refuse it. An OpenCode contributor hit the identical wall in that thread — "config and plugins loaded before any gui, how do we get around that?" — which is good evidence the shape is inherent to the architecture rather than to either codebase.

Two properties keep the CVEs out. The gate reads only the user-level trust store and the *hashes* of workspace files, never their settings, so no repository-supplied value lies on the path to the decision. And its result is inert data — a `TrustDecision`, not a mode — that `buildAgentRuntime` takes as a required argument, so a runtime cannot be assembled without one. The gate cannot be skipped by forgetting it; it has to be passed something.

An untrusted workspace is degraded, not dead: repository configuration is dropped while the user's own is kept, because a hostile clone should not also cost someone the hooks they configured themselves. Nothing is prompted for when a workspace contains nothing executable, which is what keeps the dialog rare enough to be read. Two deviations from Claude Code are deliberate. Their trust verification is disabled entirely under `-p`, leaving piped and CI invocations unprotected; here a non-interactive run loads no repository configuration and says so, matching the headless deny-by-default position taken above, with `OPENSWARM_TRUST_WORKSPACE` as the opt-in. And the prompt lists what would be activated, including the permission mode a repository asks for, since a dialog naming no specifics is one people dismiss.

The gate's own threshold is proven by running the built CLI in a hostile repository and looking for evidence, not by asking each loader whether it behaved: every fixture payload writes a marker file, and `T2` asserts the directory stays empty. Each refusal is paired with a positive control that grants trust and watches the same payload fire, so a corpus that stopped exercising the attack cannot report success. Wiring the gate also surfaced two live in-repository activations that the survey's file-by-file reading had not connected: this repository's own plugin fixtures load through `OPENSWARM_PLUGINS_DIR` pointing inside the workspace, and its integration suite authors a hook config and expects it honoured. Both now state their trust explicitly.

Residual, carried rather than claimed closed: on the `claude-sdk` engine the SDK reads project settings itself, so the only available lever is whether `settingSources` is passed at all — OpenSwarm cannot filter that file, only decline it wholesale.

#### `WP-03` Canonical path authorization — 1 person-week, A

Depends on `WP-01`. Re-scoped after `WP-00a`, which delivered the design half.

Delivered by `WP-00a`:

- Central path authorization for every file-bearing tool, decided in `canUseTool` and re-checked at write time by one shared helper.
- Parent-symlink, nearest-existing-ancestor, and external-path handling, via `WorkspaceAuthority.canonicalize`.
- Permission decisions carry canonical path arguments, as `OperationRequest.path`.

Delivered by `WP-03`. Gate: `./scripts/verify-parity-wp.sh WP-03 <cell>`, `P1`–`P6` passing, over `FX-PATH-001..020` and a generated corpus.

Both remaining items were live vulnerabilities rather than gaps in coverage, which is the fourth pass in a row to surface a finding no audit named.

**A broken link pointing outside was treated as a new file inside.** `realpath` answers `ENOENT` for a dangling link exactly as it does for a name that was never there, and `canonicalize` believed it — so `link → /outside/absent` was judged at the link's own in-workspace location, and a write through it created the file outside with chosen content. Both containment layers shared the reasoning, so both passed it. An `ENOENT` is now only believed once `lstat` agrees nothing is there; a link is followed to its target by hand and the target is judged. Related: a symlink cycle raised `ELOOP`, which the ancestor walk could not interpret and rethrew, crashing the tool instead of denying the path. An unprovable path is now a denied path.

**The swap race was open, and measurably so.** Against a thread doing nothing but replacing a directory with an outward symlink, 400 writes put finished, attacker-controlled files outside the workspace. Checking twice narrowed the window; it did not close it, because both checks resolve by name and a name can mean something else by the next syscall. Three changes close it. Staged files are created at the workspace root rather than beside the target, so nothing is ever created outside — a temp file that escapes cannot be cleaned up afterwards, since by the time the escape is noticed the name points back inside and the unlink misses. The rename is anchored to a directory descriptor through `/proc/self/fd`, which the kernel resolves straight to the open file description; where the platform offers that, failing to pin refuses rather than falling back, because a directory that cannot be opened is usually one being swapped. Where it does not — macOS, Windows — the sequence falls back to names and the residual is real, detected rather than prevented. Repair there was first claimed as "detected and undone"; that claim was wrong, and `WP-04` measured how. On macOS, most runs of 400 writes left one or two *finished* files outside, carrying their full chosen content at their chosen names, while the tool correctly reported every one of them as refused. Undoing by name loses the same race that caused the escape: once the redirect reverts, the escaped file has no name this process can compute, so the unlink misses and the file is orphaned where nothing will find it. The repair now falls back to the descriptor, which follows the inode through the rename — removal is attempted first and usually succeeds, and emptying the file is what remains when no name reaches it. Measured after the change, 2,000 writes stranded six files outside and all six were zero bytes. So the honest guarantee off Linux is narrower than "undone" and stronger than "nothing": no content chosen here persists outside the workspace, while an empty file may, at a path an attacker chose, and a pre-existing file at that path is destroyed by the rename regardless. Removing the escape needs `openat2(RESOLVE_BENEATH)` or kernel-level containment, so it is carried as a dependency on `WP-25` rather than claimed here.

Two contract fixes came with them. `write_file` threw rather than returned when a racing swap broke its `mkdir`, handing callers an exception where a refusal belongs; and its read-before-overwrite check used `lstat`, so a dangling link demanded a prior read that `read_file` could never supply, since it follows the link and finds nothing.

`notebook_edit` now stages and renames like every other write tool, guards on a content hash, and requires a prior read. A plain `writeFile` truncates before it writes, so an interrupted edit left JSON that no longer parsed — a whole notebook lost for one cell. This clears the risk register's "disable by default" position.

Four writers had four atomic-write implementations; they now share one, which is where the containment and race handling live.

#### `WP-04` Process broker and fail-closed shell baseline — 2 person-weeks, A

Depends on `WP-02` and `WP-03`.

- Route Bash, persistent shell, hooks, MCP, and plugins through the broker.
- Add process-group cancellation, bounded output, and effective-isolation diagnostics.
- Remove the synchronous `require` fail-open path.
- Close the unknown-resource gap `WP-00a` left open. A tool that cannot name what it touches — `bash`, `shell_exec`, `shell_write`, and every plugin and MCP tool — is still authorized by tool name alone, because central containment has no opinion on a resource it cannot name. The broker is where those operations acquire nameable resources, so this is where "unknown" stops meaning "unrestricted".
- For plugin and MCP tools specifically, the nameable resource is the **server or plugin identity**, not the paths the call happens to touch. Such a tool keeps declaring `ToolAccesses.all()` and is authorized as one `network.request` against that identity, so consent is granted once per server rather than once per call. Per-call authorization was considered and rejected: a remote tool cannot predict its own paths, so a per-call prompt asks the user to approve something neither side can describe, and the resulting prompt volume trains people to approve without reading. Making `accesses` mandatory on `ToolImpl`, with the missing-declaration default inverted from `none()` to `all()`, belongs here too — the current optional field means a new tool is parallel-safe and unrestricted by omission.
- Replace `CodexFrameworkEngine`'s `danger-full-access` and `approvalPolicy: "never"` defaults. `WP-00a` gated OpenSwarm's own tools on that path, but Codex's built-in tooling is unrestricted and OpenSwarm never sees it, so a Codex-backed worker currently has full filesystem access regardless of permission mode.

Delivered. Gate: `./scripts/verify-parity-wp.sh WP-04 <cell>`, `C1`–`C8` passing, over `FX-PROC-001..012`. No untrusted child can launch outside the broker; unavailable required isolation runs nothing.

Three of the listed items were live vulnerabilities rather than gaps in coverage, and all three were reachable in a default install.

**Codex ran unconfined at every permission mode.** `CodexFrameworkEngine` never passed a sandbox setting to the provider, and `CodexAppServerProvider` stored the option without sending it on `thread/start`, so Codex's own file and shell tools defaulted to `danger-full-access` no matter what the session's mode said. Read-only meant read-only for OpenSwarm's tools and nothing at all for Codex's. The session's `PermissionMode` now maps to a Codex `SandboxMode`, defaulting to `read-only`, and both layers are covered by tests that assert the value reaches the wire rather than that it was stored.

**The synchronous spawn path failed open.** `spawnSandboxedSync` could not await sandbox detection, so it read a cache and treated "not detected yet" as "no isolation available" — spawning unconfined even under a `require` policy, and only on the first call, which is why it never showed up in a warm process. There is now no synchronous variant at all: the one caller, `ShellSessionManager.create`, became async.

**Cancellation orphaned grandchildren.** Foreground `bash` was not detached, so it shared OpenSwarm's process group and `child.kill()` reached only the immediate child; a timeout left the actual work running. Background commands were `unref`'d with no handle at all, so nothing could reap them and nothing knew they existed. Every brokered child now leads its own process group and is signalled as a tree.

Beyond the listed scope, four things were found while doing it.

**Isolation was unreachable and unreported.** `setBashSandboxPolicy` existed but was never called in production, so the policy was effectively hard-coded to `prefer` and `require` could not be requested at all — the fail-closed baseline this package is named for had no way to be switched on. There is now a `--sandbox require|prefer|off` flag with an `OPENSWARM_SANDBOX` fallback, inherited by workers, and `openswarm doctor` reports the isolation actually in force. That report is deliberately blunt on macOS and Windows, where the answer is that shells, hooks, MCP servers, and plugins run unconfined. That was already true; it was simply never said.

**There were two schedulers, not one.** The hardened-native engine's eager-dispatch path computed resource accesses with its own copy of the dispatcher's logic, so a tool could serialize under one engine and run concurrently under the other. Both now call one helper.

**Output was bounded at close, which is the wrong end.** Truncating at 30,000 characters bounds what the model sees, not what a command can make the harness hold: `stdout` accumulated in an unbounded array, so a command that outran its own exit exhausted memory before the truncation meant to protect against it ever ran. Persistent shell sessions were worse — draining advanced a cursor but left the bytes in place, so a session's buffers never shrank for its entire lifetime, under ordinary use. Both now bound on the read path, retaining far more than any caller can observe so nothing visible changed.

**Brokers leaked exit listeners.** Each broker installed its own `process.once("exit")` reaper, so replacing the process-wide broker left the old listener installed for good. One shared listener now reaps them all.

The estimate held at 2 person-weeks, but the shape was wrong in an instructive way: the three listed items were the smaller half. The larger half was making the package's own gate meaningful — "unavailable required isolation runs nothing" could not be tested at all until `require` became reachable, which nothing in the original scope called for.

`FX-PROC-001..012` is deliberately not built on the broker's own bookkeeping. It intercepts `node:child_process` and compares what the process launched against what the broker launched, because the failure this package guards against is a *new* caller spawning directly — which every test written against the broker would pass. The corpus includes a case that bypasses the broker on purpose, so an interceptor that quietly stopped observing cannot be mistaken for a clean run.

#### `WP-05` Retry operation ledger and cancellation barrier — 2 person-weeks, B

Depends on `WP-01`.

- Classify side effects and idempotency.
- Assign stable logical operation IDs.
- Disable eager execution for unsafe tools.
- Record `outcome_unknown` when completion cannot be proven.

Delivered. Gate: `./scripts/verify-parity-wp.sh WP-05 <cell>`, `R1`–`R5` passing, over `FX-RETRY-001..010`. Fault injection around dispatch never duplicates a mutating call.

**The duplicate was live, and eager dispatch is what made it reachable.** Eager dispatch starts a tool the moment the provider announces the call, before the stream announcing it has finished. When that stream failed, the engine retried it, the retried stream announced the same calls, and they ran again. A test already covered the adjacent half of this — resetting the in-flight map so a failed attempt's *results* are not drained — which reads as though the case were handled; forgetting a promise does not unmake what it did. Measured before the change, one racing retry turned one announced write into two dispatches.

Two mechanisms now hold independently, which is deliberate: each has its own fixtures, and disabling either leaves the other detecting the duplicate.

Nothing that can leave a trace is speculated on at all. A call's idempotency is read from the resource accesses it already declares for the scheduler, rather than from a second annotation that could disagree with the first, and only `idempotent` calls start during streaming. Everything else waits for the stream to succeed and runs on a deferred path, so a turn abandoned before it finishes leaves the workspace untouched. This costs the overlap between streaming and mutating tool execution, which is the trade the package name implies.

The ledger accounts for whatever did start. Identity has to be computed rather than taken from the provider, because a retry is a fresh sampling request whose `tool_use` ids are its own; what corresponds across attempts is position, so the id is a digest over the turn, the tool, the canonical arguments, and how many times that exact call has already appeared in the turn. That last term is load-bearing: `echo x >> log` twice in one turn is two appends, and identifying operations by argument equality alone would silently drop the second one on every turn.

Three findings beyond the listed scope.

**A returned failure and a thrown one are not the same fact.** A tool that reports failure has said what happened; a dispatcher that throws has not, and the effect may well have landed. The ledger records the first as proven and the second as `outcome_unknown`, and only the proven one can answer a re-announced call. Collapsing them is how a half-applied write comes back as a confident "that failed".

**Cancellation was reported before it happened.** Aborting returned out of the generator with tool calls still running, so the effects continued and landed after the turn everyone believed was over, with nothing recording that they might. There is now a barrier that waits for outstanding work to report. It is bounded, because a tool that ignores its abort signal must not hold cancellation open forever, and anything still running when the grace period ends is recorded as unknown — which is the accurate description, since it may yet succeed and no one will find out.

**The refusal has to produce a result.** A suppressed duplicate that returns nothing leaves the model with a `tool_use` it never got an answer to, which reads from the transcript as though the call were never made — so the model asks again. Every replay decision, including the refusal, yields a result, and the refusal's text says what to do instead rather than only that something was denied.

The batch path deliberately has no ledger. It runs only once a stream has succeeded, so a retry can never have executed any of it; eager dispatch is what makes replay possible, and that is where the ledger sits. The kernel's journal (`WP-00`) records the same distinctions durably for crashes across process restarts; this is the same vocabulary applied in-memory at the one place a retry actually happens, and the two share terms rather than storage.

Nothing consumes the recorded uncertainty yet — surfacing and reconciling it is `WP-12`. It is kept rather than discarded in the meantime, because "we do not know whether this happened" is a fact about the workspace that outlives the turn that produced it.

#### `WP-06` Atomic task transitions and safe target CAS — 2 person-weeks, C

Depends on `WP-01`.

- Transactional claim and terminal result persistence.
- Parent-side identity and transition authorization.
- Capture target SHA before landing-worktree creation.

Delivered. Gate: `./scripts/verify-parity-wp.sh WP-06 <cell>`, `C1`–`C5` passing, over `FX-CLAIM-002` and `FX-CAS-001`. 10,000 claim attempts produce one owner; a moved target loses no commit.

**Two of the three items were live holes, and the landing one destroyed work.** Landing read the target branch twice: once to decide what to check the merge worktree out at, and once to pick the compare-and-swap expectation. Those are different commits whenever the target advances in between, and the combination is worse than either read being wrong alone — the merge is built on the old tip, the CAS expects the new one, so the CAS *succeeds* and moves the branch to a commit that does not contain what landed in that window. Every commit in the window is dropped, on a merge that reported success, with nothing for the caller to observe. Measured with a real `post-checkout` hook advancing the branch at the exact instant the landing worktree is created, the rival commit was not an ancestor of the branch afterwards. One read, used for both purposes, turns that into the `stale` the drain already knows how to retry.

**Transitions were unauthenticated.** The orchestrator knows which worker a request arrived from — the transport is per-child and the handler is handed that identity — and `task.create` already used it to derive the caller's scope rather than believing a scope in the request. The transition handlers did not, taking the task id, the claiming agent, and the target scope from the request body. So a worker could finish, fail, or reassign any task whose id it could name; claim work in another team's scope; or claim *as another agent*, after which every honest ownership check downstream agreed with the forgery. Ownership now comes from the transport. The relation accepted is the owner or an ancestor of the owner, identical to what `task_stop` already enforced, so the two cannot drift into disagreeing about who is in charge of a task. Reassignment by the worker running a task is refused outright: handing work to another agent is the parent's decision, taken through spawn.

Two findings beyond the listed scope, both in the same place — what "terminal" means.

**A terminal result was not final.** `update` and `stop` rewrote status unconditionally, so a cancellation arriving after a task completed turned a finished task into a cancelled one and discarded its result — which `stop`'s own doc comment said it would refuse to do. The first terminal outcome now wins and a later report is a visible no-op rather than an exception the caller has to expect, because a second report is either a duplicate or a disagreement and overwriting makes the answer depend on arrival order. Trailing output is still accepted after a terminal transition: a late chunk of a stream is ordinary and says nothing about the outcome.

**The registry never learned that tasks finished.** Terminal outcomes reached the lane events and `results.jsonl`, and the registry was left saying `running` — so `task.get` and the task board disagreed about whether a finished task had finished, and a parent deciding whether to retry consulted the stale one. The outcome now lands in the registry through one write that carries the status and its payload together, using the same four-way mapping `results.jsonl` uses so the two cannot describe the same run differently. Status and payload are one write because separately they disagree: a task marked succeeded before its output arrives is briefly a success with nothing to show, indistinguishable from one that produced nothing. A worker that exits silently is resolved from its exit code as a fallback, which is a no-op once a real outcome landed rather than a second opinion overwriting it.

The claim itself was already safe and is now honestly stated. It is a synchronous `Map` mutation with no `await` inside, so nothing can interleave — but "correct as long as nobody adds an await" is a property that stops being true quietly, and the loop read as though it were merely checking fields. The claim is now a compare-and-swap against the record the loop actually saw, so the 10,000-claimant fixture includes the case that separates the two: every claimant reads before any of them writes, which is the shape of every store that is not an in-process map. A read-modify-write loses there; the CAS refuses the stale 9,999.

Persistence remains out of scope here. The registry is still in-memory, so a claim does not survive the orchestrator dying — the durable journal is `WP-07`, and this package is the transition semantics that journal will record.

R1 exit:

- `DDP-SAFE-01`, `DDP-SAFE-02`, `DDP-REL-01`, and `DDP-SWM-01` pass on Linux x64.
- The effect-transaction walking skeleton and revised loading model are approved.
- No direct untrusted spawn path remains.
- No topology feature work starts.

### R2 — Stateful core alpha, weeks 10–17

Limited developer alpha.

#### `WP-07` Session schema, journal, snapshots, and importer — 3 person-weeks, B

Depends on `WP-00` and `WP-05`. Re-scoped per the `WP-00` re-estimate: journal construction moves out, writer migration moves in.

- ~~Versioned journal~~ — built in `WP-00` as `FileEventStore`, with gap-free sequencing, `fsync` on append, and torn-trailing-line recovery.
- Migrate the existing writers onto one durable appender. Seven, not four: `session-recorder`, both `events.jsonl` spines, `dead-letter`, two `results.jsonl` paths, and the lane trace.
- Checksummed atomic snapshots, and resume state moved onto them.
- Import legacy Claude IDs, native snapshots, and team checkpoints where possible.
- Mark imports read-only/lossy when typed tool, reasoning, or attachment history cannot be reconstructed.
- Backup before migration and archive unsupported state.

Delivered. Gate: `./scripts/verify-parity-wp.sh WP-07 <cell>`, `J0`–`J6` passing, over `FX-JOURNAL-001..012` and `FX-MIG-SESSION-001`.

**The transcript was truncated on purpose, once per session, and nobody noticed because the loss was invisible.** `session-recorder` opened with `flags: "w"`. That is the correct flag for a file whose only reader is a human tailing the current run, and the wrong one for the record `WP-08` will resume from and `WP-12` will audit: the second `startSessionRecorder` call against a session erased the first turn's transcript entirely. Nothing errored, the file existed, and it was plausible — it just described a shorter session than the one that happened. The fixture that catches it records a turn, closes, records a second turn, and asks for the first one back.

**A second recorder on one session lost events wholesale rather than interleaving them.** Two `createWriteStream` handles on a path each keep their own offset, so the second writer's first line lands *on top of* the first writer's output rather than after it. The concurrent-recorder fixture lost roughly half of what it wrote. `O_APPEND` fixes the offset, but not atomicity on its own — a line larger than the pipe-atomic size can still tear — so the appender buffers whole lines and hands the kernel one batch per commit, which also gives it somewhere natural to `fsync`.

**An atomic rename was being read as a durability guarantee it does not provide.** The team checkpoint wrote a temp file and renamed it, which is genuinely atomic against a concurrent reader: nobody sees a half-replaced file. It says nothing about whether the *bytes* reached disk before the rename entry did, and nothing at all about integrity — a checkpoint corrupted by anything other than an interrupted write reads back as ordinary resume state, and a team resumes from a state it was never in. Snapshots now carry a checksum over the canonical document, are `fsync`'d before the rename and again on the directory after it, and a failed check reports `corrupt` rather than `absent`. For a checkpoint specifically, `corrupt` is then treated as absent, which is the safe direction for this artefact: the team redoes work rather than skipping work it never did.

Pre-`WP-07` checkpoints are still accepted, unverified, because refusing them would silently re-run every unit a mid-upgrade team had already finished — the narrow case of what the importer does generally.

**The survey's account of the other writers was wrong, and measuring them changed what the work was.** It said they acknowledged from a userspace buffer. Probed, they do not: the flag is `O_APPEND`, so concurrent appenders never collide, and the write callback is post-syscall, so an acknowledged line is in the page cache and survives `SIGKILL` — verified against both the old writer and the new one. Two real gaps remained. An unacknowledged write is only in the stream's queue, and killed there the probe file did not exist at all; since none of these callers await, that tail is however much the last burst produced. And the page cache is not the disk. The seven writers now share one `Writable` with an `fsync` per batch, which keeps every file's format and every consumer's contract — the point of making it a `Writable` rather than a new interface is that a migration of this size cannot then quietly change a file's shape. It matters most for `dead-letter.jsonl`, which is read as evidence: `--allow-dead-letter` turns on whether a run dropped work, so a line lost with the process turned a lossy run into a clean one. A fixture asserting the old writers lost acknowledged data would have passed for the wrong reason, so `FX-JOURNAL-009` pins the acknowledgement boundary instead, and what `fsync` actually buys — surviving the machine rather than the process — is deliberately not asserted, because nothing in a test suite can drop the page cache.

**Two writers each wrote the file's one metadata header.** Both `events.jsonl` spines decided whether to stamp the wire header by stat-ing for size zero and then appending, which two daemons starting together both pass. Creation is the only exclusive fact available, so the header is now written by whoever creates the file.

**`state.json` could not be made atomic while it was also the results log.** The daemon appended task results to the same path its startup snapshot occupied, an acknowledged placeholder from v0.5 — the orchestrator needed a `Writable` and that path was to hand. One file cannot be both a replaceable snapshot and an append-only log: replacing it by rename unlinks the inode the results stream still holds, so the results go to a file nothing lists. Results moved to `results.jsonl` and the snapshot is now checksummed. Nothing read the old file's contents, so the split cost no consumer anything.

**The importer's job turned out to be disclosure rather than conversion.** `KernelEventType` has no member carrying message content — the frozen contract records session identity, turn boundaries, attempts, and opaque engine state — so history travels as `EngineStateRecorded.data`, verbatim and uninterpreted. That is lossless for resume and it is not a queryable transcript, and the difference has to be stated rather than discovered. A native snapshot's `ProviderMessage` content maps onto `ContentPart` member for member, so it arrives unchanged and resumes; a Claude SDK session is only an id, its transcript owned by the SDK and recoverable as prose but not as the typed exchange, so it resumes read-only and says which four things it cannot reconstruct. An empty snapshot is not called resumable. A team checkpoint is archived under its own name rather than converted into an empty session, because unit outcomes are real work and this journal has no shape for them. The verdict is written into the journal as the `SessionCreated` payload, not just returned: whoever resumes a session months later is not the person who ran the migration and cannot see what it printed. Sources are copied before anything is converted, and a backup that fails takes the import with it — nothing is journalled, so the migration can simply be run again. A file matching no known shape is refused rather than imported as an empty session, and a checksummed snapshot that fails verification is refused too, since importing is exactly the wrong moment to accept a document that outlives the file it came from.

Two things this package does not do. `FileEventStore` still has no production caller — the CLI does not yet write or resume from a journal, which is `WP-08` — so the importer is a library and a fixture rather than a subcommand; a command producing journals nothing reads would be a worse answer than an honest gap. And the `.openswarm/sessions/<hash>` layout described in `docs/01`, `docs/06`, and `docs/07` remains unbuilt; the importer treats today's four on-disk shapes as the sources that exist, not that spec.

#### `WP-08` Automatic multi-turn and crash resume — 3 person-weeks, B

Depends on `WP-07`.

- Connect TUI, ACP, headless, SDK, native, and hardened-native to the session kernel.
- Persist engine/provider resume state after every acknowledged turn.

Partially delivered. Gate: `./scripts/verify-parity-wp.sh WP-08 <cell>`, `R1`–`R5` passing, over `FX-RESUME-001..011`. Ten turns, each through a new engine and a new store, keep the first turn's content.

What is not yet true, stated plainly because `DDP-CONV-01`'s beta evidence reads "ten turns retain prior text and tool results without `/resume`". Continuity across separate CLI invocations still requires an explicit `--resume`, so it is recovery rather than the automatic continuity that phrase describes; in-process multi-turn in the REPL is unchanged and predates this work. Only the CLI's `prompt` path passes a sink — ACP and the TUI still resolve sessions through the SDK store. And durable storage is opt-in, so a crash loses the session unless the user asked for history to be kept. The capability cannot certify until those three close, the last of them behind encryption.

**`--resume` was advertised in `--help` and structurally impossible for the default engine.** Resuming an Azure session returned "hardened-native engine cannot resume snapshots produced by another engine", which is the correct answer to the wrong question. Three independent causes, each sufficient: `SessionStore.buildSnapshot` hardcoded `engineId: "claude-agent-sdk"` and delegated lookup to the SDK's own store, so a native session could never be found; the native engines' `persistSnapshot` fired only when `sessionDir` was set and no production caller ever set it, so nothing had written a snapshot to find; and the engine interface's docstring claimed "our SessionStore stores the snapshot alongside our own JSONL log so `--resume` works against whichever engine produced the session", which described a design nobody had built. The engines were refusing a label this layer invented, not a real mismatch — which is why `FX-RESUME-002`, pinning the engine id across a round trip, is the fixture to read first if this breaks again.

**The turn boundaries were already right; only the destination was wrong.** `persistSnapshot` was called at exactly the points the package asks for — every acknowledged turn, plus the `max_turns` stop — so the change is a `SnapshotSink` the surface supplies rather than a directory the engine writes into. The CLI's sink appends `EngineStateRecorded` to the kernel journal, which is `SessionSnapshot` under the frozen contract's own name, and which the `WP-07` importer already writes: an imported session now resumes through the same reader with no import-specific path, so that verdict's "resumable" finally means something a user can act on. A sink that rejects aborts the turn, matching what the file write already did — a turn whose state was not recorded is not recoverable, and reporting it as an ordinary success is how a resume loses the tail of a conversation.

**Durability is opt-in, and that is the locked storage decision rather than caution.** A session journal is conversation history, and `WP-00` froze the rule that history is encrypted with 90-day retention, ephemeral with a warning when no key provider exists, and never plaintext — `ResolvedStorage` has no plaintext variant precisely so there is nothing to silently degrade to. `crypto-envelope.ts` has one caller, `storage-policy.ts` itself, and `FileEventStore` does not encrypt, so the locked decision was a policy module with nothing enforcing it. That is also why `WP-07` could leave the journal without a production caller. Selecting OS/headless key providers is an unassigned follow-up whose wording is "verify the ephemeral fallback **before durable rollout**", and this package *is* the durable rollout, so the default resolves through `resolveSessionStorage` to ephemeral and says so. `OPENSWARM_SESSION_STORE=unencrypted-durable` is the documented deviation; it is spelled out rather than being a boolean because enabling unencrypted history should be a sentence about the tradeoff, and a fixture asserts that `1`, `true`, `yes`, and `durable` are not accepted as consent. Another asserts that this module refuses to run once a real key provider exists, so wiring one up fails loudly instead of quietly writing plaintext on a machine that could have protected it.

**The bug that got through the type checker is the argument for `L6`.** The first sink handed over `{ engineId, data: snap }` where `snap` was already a `SessionSnapshot`, nesting the payload one level too deep. It compiled, every unit test passed, and it failed only on a real second turn with `Cannot read properties of undefined (reading 'slice')`. The round-trip fixture added for it — record through the sink, then resume an engine from what was recorded — fails against that version, and `L6` in the live cell covers the same seam across two processes.

#### `WP-09` Approval broker and headless default deny — 1 person-week, A

Depends on `WP-02` and `WP-04`. Re-scoped after `WP-00a`, which delivered the schema and the grant model.

Delivered by `WP-00a`:

- Shared approval request/decision schema, as `ApprovalRequest` and `ApprovalResponse`.
- Exact-resource/operation grants with explicit one-shot and session alternatives, backed by the existing TUI, headless, and ACP surfaces. Note the default differs from what this package originally assumed: a plain approval is one-shot and only an explicit "always" creates a session grant, which preserves the established UX rather than widening consent by default.

Delivered. Gate: `./scripts/verify-parity-wp.sh WP-09 <cell>`, `A1`–`A5` passing, over `FX-APPROVAL-001..012`. Absent, invalid, expired, replayed, disconnected, and late approvals all deny.

**An approval gate is judged on its failure modes, and five of the six were fail-open or hang.** "The user said yes" was the only path with a defined outcome. An unanswered prompt waited forever, which is an outage that looks like a hang and leaves the operation pending rather than refused. A response that did not say what it decided, or answered a question that was never asked, or replayed an earlier decision, was indistinguishable from a valid approval — there was no request identity to check it against. And on the ACP surface, anything that was not literally `reject` or `cancelled` fell through to allow, so a client on a newer protocol revision, a typo in an option id, or a hostile response approved the operation silently.

Every ask now carries an identity and a deadline, and a response has to echo the identity to count. That one mechanism covers invalid, replayed, and expired, because all three are the same question — is this an answer to what we asked, and is it still open? The refusals are kept distinct in the decision source (`approval:invalid`, `approval:replayed`, `approval:expired`, `approval:timeout`, `approval:unavailable`) because they call for different responses: a timeout is operational, a replay is a security event, and reporting both as "denied" means neither gets looked at. Approval on the ACP surface is now named explicitly and everything else is a refusal.

One finding beyond the listed scope, and it was worse than the holes it came from.

**Failing closed forever is its own outage.** The bridge is strictly serial by design, so abandoning an ask left its slot occupied — and every later request was then refused with a reason about the earlier one, no prompt shown, no way back short of a restart. One unanswered prompt took the rest of the session with it. Giving up on an ask now cancels it, which releases the bridge and detaches the headless reader; without the detach, a listener left on stdin would consume the line meant for the next question.

Grants can now end, four ways: they expire, they run out of uses, they are revoked, or the workspace identity they were given about changes. The last is checked rather than subscribed to, deliberately — a revocation event has to be delivered to be honoured, and the failure mode of a missed event is a grant outliving the trust it rested on, silently and in the direction of permitting more. Re-reading the identity cannot be missed. Expiry is available but not the default: a grant that expires mid-task becomes a prompt the operator did not expect, so bounding consent in time is opt-in while revocation and trust-binding are always on.

**A later live run found a third case, and it is the reason this package now argues for a live cell.** Every fixture here hands the reader a fresh stream and asks once, which is the single shape where borrowing stdin per question behaves like owning it. A real headless run asks twice. Denying the first approval and approving the second emitted both questions and produced one result: the reader kept the first line of the `"n\ny\n"` an orchestrator writes in one go and discarded the rest, so the second question had nothing to answer it, and it then attached to a stdin that had already ended — which does not re-emit `end` to a listener arriving afterwards. The read never settled, and because stdin was closed nothing was left holding the event loop, so the process did not hang; it exited 0 with a tool call still outstanding, which whoever is driving it reads as success. The buffer and the ended flag now live with the stream, and a read after end answers immediately. The three fixtures added for it fail against the previous reader, two by timing out. What this says about the gate is that `FX-APPROVAL-001..012` tested the decision logic thoroughly and the transport not at all, and no amount of the former would have reached this. The live cell argued for here now exists as the `live` target (§Platform matrix), and `L3` is this case: reverting this fix turns it red against both certified providers while the other four probes stay green.

Decisions that involved an approver are reported to an audit sink, including the refusals the human never saw. Those are the ones that most need a record, because nothing else in the system mentions them. A standing rule emits nothing — it is not a decision anybody made about this operation, and logging it as one would bury the approvals in noise.

Two pieces remain and are not claimed. The trust digest is computed once at startup, so trust-binding tags grants correctly and any later re-verification invalidates them for free, but the re-verification itself does not exist yet. And the authenticated headless broker is still a stdin reader: it fails closed when nobody answers, which is what the threshold requires, but it is not an authenticated endpoint. Consuming the audit stream is `WP-12`.

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

Partially delivered. Gate: `./scripts/verify-parity-wp.sh WP-11 <cell>`, `W0`–`W7` passing, over `FX-RW-001..012`. A stale write is refused, sixteen real processes produce one writer at a time, queued writers are served in arrival order, and the next writer starts within five seconds while 32 readers hammer the workspace.

What is not yet true, and it is the reader-facing half: output is not streamed as provisional, nothing revalidates a dependency automatically, and there are no stale-result events. Read sets are recomputed at write, because that is where the generation advances, but not at task completion, checkpoint, commit, or landing, and the parent still commits terminal task state without waiting for a revalidation that does not exist. So `DDP-SWM-02` cannot certify: its beta evidence reads "overlapping reader output is provisional, generation-stamped, automatically revalidated, and terminal only when verified", and only the stamping is real. What has landed is the half that decides whether a conflict is *detectable at all* — a reader whose output is provisional is only useful if something can tell that its inputs moved.

The remainder is distributed rather than carried here as one lump, because most of it cannot be built where it was written down. Stale-result events move to `WP-12`, where a stale read joins the other committed facts instead of getting a second event path. Revalidation at checkpoint moves to `WP-19` and at commit and landing to `WP-20`, for the plain reason that neither checkpoints nor landing exist until those packages land — recomputing a read set at a checkpoint was never buildable in R2. What stays here is roughly one person-week: streaming reader output as provisional, revalidating affected dependencies automatically, and holding terminal task state until the new read set passes. That plus `WP-12` is what `DDP-SWM-02` now rests on, and both are in R2, so the outcome still certifies in the release that claims it.

**Read-before-edit was enforced against the wrong question.** `read-state` recorded which paths had been read, as a path and a recency counter, with no hash, size, or mtime. That answers "has the agent read this?" and cannot answer "is this still what the agent read?", and the two look like one question until several agents share a directory. So `hasFileBeenRead` returned true for a file another agent had since rewritten, and `write_file` — which never reads its target, and so has nothing in its request referring to the old content — overwrote that work and returned `The file … has been updated successfully.` The lost update left no trace anywhere: not in the result, not in the log, not on disk. `FX-RW-002` is deliberately written as the reader's complaint rather than the lease's, because the damage was never that two writers ran; it was that the loser was never told.

`FX-RW-002` is also flaky, which is worth recording as a defect rather than noise. It failed once inside a full `baseline linux-x64` run and passes every time in isolation, including three consecutive runs in the same container — so it is load-sensitive, and the `linux-x64` cell runs under x86 emulation on an arm64 host, which is where that sensitivity comes from. A staleness assertion that only holds when the machine is not busy is not one to certify a concurrency guarantee against, and it needs hardening under this package before its capability can be read as proven.

**The parity error for this already existed, with nothing to compare against.** `STALE_FILE_ERROR` — Claude Code's "File has been modified since read, either by the user or by a linter" — was in the tree and wired into `edit_file` and `multi_edit`, which made it look handled. It was guarding those tools' own read-modify-write window: they hash the content *they* just read and refuse if it moves before the rename. That is a genuine TOCTTOU check and it is not this. Anchoring on `old_string` against a freshly-read file made a stale edit look clean whenever the anchor survived somebody else's rewrite, and the edit then landed in a file the agent had never seen — `FX-RW-004`. Both tools now compare against the hash the *agent* saw, so the same recoverable message covers both halves of the rewrite case, and the model already knows what to do with it. Identical bytes under a new mtime are not a conflict (`FX-RW-005`), or every formatter run would refuse the next write.

**The generation counter was in-process, which is the one scope where it cannot mean anything.** `WorkspaceAuthority.generation` starts at one per process and is advanced by `EffectRuntime` after a mutation commits. In shared mode every agent is its own process, so each would start its own count at one and no two would agree on what generation a `ReadSet` was formed against — and the only thing a stamp is for is comparison across agents. The shared counter now lives beside the lease and advances under it, which is what makes the read-modify-write safe without further coordination. `EffectRuntime`'s own compare-and-swap write is still without a production caller, so the kernel path and the tool path continue to answer this differently; that is `WP-00a`'s unfinished remainder, not this package's.

**Two liveness bugs, both found by fixtures rather than reasoning, and both the same shape.** A holder keeps its ticket for the whole hold, so evicting an expired holder's *record* left the dead writer still at the head of the queue with every waiter politely waiting its turn behind a process that no longer existed — recovery from a `SIGKILL`ed holder never happened at all. Worse, a writer that took a ticket and died *before* claiming the lease left nothing that could expire: no record, just a ticket at the head of a queue that would never advance. Absence of a holder is not sufficient evidence of death, since the head may be milliseconds from creating its record, so the rule is that the head has failed to claim its turn for longer than a whole lease would have lasted. Removing a presumed-dead ticket then strands its owner if it was merely slow, so a writer that finds its own ticket gone takes a fresh one. Disabling that rule turns `FX-RW-011b` from 341ms into a 15-second timeout.

**A lease that is not renewed while work happens is worse than no lease.** Wiring the lease into the tool path made this immediate: any call slower than the TTL — anything that shells out — would have its lease declared abandoned and handed to the next writer while it was still writing, so the mechanism guaranteeing one writer would quietly permit two. `withWriteLease` therefore heartbeats at a third of the TTL, because asking every caller to run its own is asking for that bug. Renewal cannot outlast the bounded hold, and that case is reported rather than hidden: the body runs to completion, since there is no safe way to abandon a partial write, but the caller is told the work stopped being exclusive.

**Readers never take the lease, and `FX-RW-012` is what protects that.** A shared workspace is read-mostly, and putting reads behind a single writer would trade a correctness problem for a throughput one. The gate's 32 continuously active readers are there to notice if readers ever start queueing. Adoption is one site — the swarm worker's tool dispatch, where a call is judged by the accesses it declares — and the lease is keyed on the worker's own `cwd`, so worktree isolation falls out for free: a member given a worktree gets an uncontended lease of its own, and only members that genuinely share a directory serialize. A tool that cannot describe its accesses is treated as writing, matching what the access model already does with malformed accesses, since a needless lease costs throughput and a missing one costs the guarantee.

#### `WP-12` Audit and event projections — 2 person-weeks, C

Depends on `WP-00`, `WP-00a`, `WP-05`, `WP-06`, `WP-07`, `WP-09`, and `WP-11`.

The dependency on `WP-00a` was missing and is the reason this package could not have started as scheduled. Its first bullet is to project canonical committed facts, and until the `WP-00a` remainder landed there were none: `AttemptPrepared` and `AttemptResolved` had one writer, `EffectRuntime`, which nothing in production constructed. The estimate here assumes the facts exist and covers projecting them, so it was two person-weeks for the second half of a job whose first half was scheduled elsewhere and unfinished. Those records now exist, produced by the gate and the ledger; what this package adds is the projection layer over them, and the event types it introduces are the first test of the audit/history partition.

- Project canonical committed facts to `LaneEvent`, TUI, headless, ACP, usage, audit, and sessionlog.
- Keep token deltas ephemeral and persist semantic boundaries.
- Persist policy, operation, read-set, result, usage, and redaction records.
- Project stale-result events, moved here from `WP-11`: a stale read is a committed fact about the workspace, so it belongs with the projections rather than in a second event path of its own.

Gate: every test side effect has correlated pre-decision and terminal facts; every durable semantic projection rebuilds from the journal. Live token/input deltas are tested for ordering and bounded loss behavior, not byte-identical replay.

#### `WP-27a` Session encryption at rest and key providers — 2 person-weeks, B

Depends on `WP-07`. Split forward out of `WP-27`; the number records where the scope came from and the release records when it is needed.

- Authenticated encryption for the session journal and snapshots.
- OS and headless key-provider abstraction, with provider selection and absence both explicit.
- Explicit ephemeral-session fallback with a warning when no secure key is available; no plaintext fallback.
- Retire the `unencrypted-durable` opt-in `WP-08` introduced, and make durable history the default.

Gate: a journal written with a key provider present is unreadable without it; no-config key absence selects the warned ephemeral mode; a configuration that requires durable encryption fails closed on a missing key; the plaintext opt-in no longer exists.

**Why this is in R2 rather than R5.** `WP-08` established that history cannot be durable by default until it can be encrypted, because `WP-00` froze the rule that history is encrypted with 90-day retention, ephemeral with a warning when no key provider exists, and never plaintext — `ResolvedStorage` has no plaintext variant precisely so there is nothing to silently degrade to. `DDP-CONV-01` is an R2 exit criterion whose evidence reads "ten turns retain prior text and tool results without `/resume`", and that cannot be true of sessions the product declines to keep. Leaving encryption in R5 therefore made an R2 exit criterion depend on R5 work, which the manifest's `evidence-reaches-release` check exists to catch and which prose review had missed. The alternative considered was re-scoping `DDP-CONV-01` to in-process continuity, and it was rejected because the mandatory outcome would then no longer describe what a user experiences across invocations.

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

- `DDP-SAFE-04`, `DDP-EXT-01`, `DDP-SWM-05`, initial `DDP-PROV-01`, initial `DDP-OBS-01`, initial `DDP-SAFE-03`, and initial `DDP-SWM-04` pass.
- Existing topologies may enter hardening but none may be added.

`DDP-SAFE-03` and `DDP-SWM-04` are explicitly partial here, corrected after `WP-01` encoded the contract: `DDP-SAFE-03` requires LSP to run through the broker and LSP does not exist until `WP-21` in R4, and `DDP-SWM-04` requires survival of an eight-hour soak that `WP-31` does not run until R6. Both previously read as full passes at R3, which no gate could have delivered.

### R4 — Recovery and intelligence preview, weeks 28–35

#### `WP-19` Checkpoint, rewind, and fork — 3 person-weeks, B+C

Depends on `WP-07`, `WP-08`, and `WP-11`.

- Conversation-only and code+conversation checkpoints.
- Fork preserves parent history and creates independent workspace/session lineage.
- Recompute affected read sets at checkpoint, moved here from `WP-11` for the obvious reason that there is nothing to revalidate at a checkpoint until checkpoints exist.

Gate: restore matches selected hashes and never mutates the original branch/session.

#### `WP-20` Harden isolated writer landing — 3 person-weeks, A+C

Depends on `WP-06`, `WP-11`, and `WP-12`.

- Extend the existing `LandingStrategy` and queue; do not create a parallel subsystem.
- Add `enqueued`, `validating`, `landed`, `stale-retry`, `conflict-retained`, and `failed` states.
- Serialize captured-SHA landing for parallel worktree writers.
- Bind evidence to source SHA, target SHA, merge SHA, and `ReadSet`.
- Revalidate after rebase/merge and preserve conflicts.
- Recompute affected read sets at commit and landing, moved here from `WP-11` alongside the rebase/merge revalidation this package already owns.

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

- `DDP-SES-02`, `DDP-LSP-01`, `DDP-MEDIA-01`, `DDP-SWM-03`, `DDP-UX-02`, `DDP-UX-03`, `DDP-SAFE-03` in full, and durable `DDP-MEM-01` pass.

### R5 — Matrix release candidate, weeks 36–43

#### `WP-25` Platform containment, packaging, and CI — 6 person-weeks, A+B+C

Depends on `WP-03`, `WP-04`, `WP-13`, and `WP-14`.

- macOS Seatbelt. This carries `WP-03`'s one open residual: the swap race between a containment check and the rename that follows it is closed on Linux by anchoring to a directory descriptor through `/proc/self/fd`, and macOS and Windows have no equivalent, so they detect an escape and refuse the write without being able to prevent it. Repair there is best effort by construction — an escaped file often has no name left to unlink, so what is guaranteed is that no chosen content persists outside, not that nothing does; `WP-03` above records the measurements. Seatbelt is where prevention becomes available off Linux, and the empty-file residual and the destruction of whatever the rename landed on both go away with it.

  **Two corrections, now that a macOS cell exists to check against.** The first is that this is the largest live gap on the platform the product ships on, not a matrix chore. `SandboxMode` is `bwrap | landlock | none` and both real modes are Linux-only, so a Mac reports `{ mode: "none", satisfiesPolicy: true }` and every shell, hook, MCP server and plugin runs unconfined. That is reported honestly — `doctor` names it, `--sandbox require` refuses to start rather than pretending, and `WP-04`'s `C5` passes on macOS precisely because it asserts honest reporting rather than isolation — but honest reporting of an absent control is still an absent control. Scheduling it at R5 prices the shipping platform like a secondary one.

  The second is that it is implementation rather than research. `sandbox-exec` is present on macOS 26 and denies writes under a profile, and Codex confines its macOS runs the same way, so there is a reference design. The same is true of the anchoring residual: macOS has `O_DIRECTORY` and `renameat`, Node simply does not expose them, and this tree already compiles an embedded C helper on first use for Landlock. Neither limitation is the platform's — both are ours, and both are cheaper to close than "no equivalent" suggests.
- Linux x64/arm64 packaging and isolation.
- WSL2/container bootstrap, path mapping, signal handling, and cleanup.
- Explicit native Windows rejection.
- **Path canonicalization on macOS was not the same job as isolation, and has moved out of this package.** This package was scoped as containment and packaging, on the assumption that what differs off Linux is the *enforcement* primitive. A macOS trust-store defect found while working on `WP-00a` said otherwise: `src/trust/store.ts` keyed grants with `path.resolve` while `src/trust/provenance.ts` canonicalized with `fs.realpath`, and because macOS reaches every temporary directory through a symlink, a grant written under one spelling was invisible to a lookup under the other.

  It is now fixed and proven in `WP-02` as `FX-TRUST-007`. `canonicalRoot` in `src/kernel/workspace-authority.ts` is the single definition both sides use, and the five new fixtures reach the workspace through a deliberate alias rather than relying on the macOS accident, so they fail on any platform if the two ever drift apart again. The invariant was already written down in `provenance.ts` — "reaching the same repo through a link should not be a second trust decision" — and the store was the half that did not honour it.

  What is worth keeping is the scope correction, which the fix does not settle: what was unproven off Linux is every assumption about how paths resolve, not only whether an escape can be prevented. Six of the twelve gated packages now carry a `macos-arm64` cell for exactly this reason (§Per-work-package verification contract), and all six pass — but that is six, not twelve, and the remaining assumptions are still Linux assumptions. The estimate here was made against isolation and packaging; it needs re-doing before R5 planning, downward for the path audit that has partly happened and upward for the Seatbelt work below, which is larger than "packaging" implies.

The Compose `parity` service is the controller, not a claim that Linux containers can validate host-native controls. It dispatches a content-addressed, allowlisted job to authenticated host runners and collects signed artifacts:

That dispatch is this package's work and does not exist yet, so the macOS commands below are written as they run *today*: the same script, invoked directly on the host, because Compose has no macOS runtime to put a cell in. The rows previously wrapped every cell in `docker compose run`, which read as though a container could produce a macOS artifact. `check_cell_platform` in the script now compares the cell against `uname` and refuses a mismatch, so neither spelling can be filed under the wrong platform — the honesty is enforced rather than documented.

| Cell | Executor | Exact controller command |
|---|---|---|
| `linux-x64` | Compose service on a native x64 Linux host | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-25 linux-x64` |
| `linux-arm64` | Compose service on a native arm64 Linux host | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-25 linux-arm64` |
| `macos-arm64` | Signed arm64 macOS host runner; Seatbelt/PTY tests execute natively | `./scripts/verify-parity-wp.sh WP-25 macos-arm64`, on the host |
| `macos-x64` | Signed x64 macOS host runner; Seatbelt/PTY tests execute natively | `./scripts/verify-parity-wp.sh WP-25 macos-x64`, on the host |
| `windows11-wsl2-x64` | Signed Windows host runner controlling the pinned WSL2 distribution/container | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-25 windows11-wsl2-x64` |

Host runners accept only the committed verification manifest and scripts, use an ephemeral job token, sign result metadata, and upload to `artifacts/parity/WP-25/<cell>.json`. An unavailable/mismatched runner fails the cell; it never skips it.

Gate: all five signed target artifacts pass package, sandbox, shell, PTY, cancellation, and cleanup tests.

The capability manifest must pin exact OS/distribution builds, Node/Bun versions, LSP server versions, provider model IDs, and certification dates. The Windows cell is “Windows 11 host + pinned Linux distribution under WSL2/container,” not native Windows execution.

#### `WP-26` Headless and Zed ACP completion — 4 person-weeks, B+C

Depends on `WP-08`, `WP-09`, `WP-19`, and `WP-22`.

- Versioned JSONL and deterministic exit behavior.
- Session, approval, attachment, cancellation, diff, reconnect, and error parity.

Gate: headless and Zed pass the same daily-driver journeys as TUI.

#### `WP-27` Retention, purge, and export — 2 person-weeks, A+B

Depends on `WP-07`, `WP-19`, `WP-22`, `WP-23`, and `WP-27a`.

Re-scoped: encryption and key providers moved forward to `WP-27a` in R2, because an R2 exit criterion turned out to depend on them. What stays here is everything that operates *on* an encrypted store, which is why it stays in R5 behind checkpoint, attachments, and memory.

- Configurable retention and storage modes.
- Automatic 90-day purge as the no-config default.
- Export, deletion, and cryptographic tamper detection.

Gate: configured policies survive restart; tampering always fails closed.

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

- `DDP-CORE-01`, `DDP-HDL-01`, `DDP-ACP-01`, `DDP-PLAT-01`, and `DDP-MEM-01`, `DDP-PROV-01`, and `DDP-OBS-01` in full pass.
- All mandatory capabilities are feature complete. Three remain unproven rather than incomplete, because the gates that prove them are release-quality runs rather than feature work: `DDP-SWM-04` awaits the `WP-31` soak, and `DDP-PRIV-01` and `DDP-EVAL-01` await the `WP-32` claims and privacy audit. Feature-complete and proven are different states and R5 only claims the first.
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

R6 exit:

- `DDP-SWM-04`, `DDP-PRIV-01`, and `DDP-EVAL-01` pass in full, closing the last three capabilities.
- Every capability in `src/parity/capabilities.ts` reports `verified` against the release SHA, with no stale or dirty-tree artifacts counted as evidence.

R6 result: a parity beta, explicitly not compatibility-stable 1.0.

## Critical paths

Security:

`WP-00 → WP-00a → WP-01 → WP-02/WP-03 → WP-04 → WP-09 → WP-13 → WP-14 → WP-25 → WP-29 → WP-30 → WP-32 → WP-33`

Twelve have passing gates: `WP-00`, `WP-00a`, `WP-01`, `WP-02`, `WP-03`, `WP-04`, `WP-05`, `WP-06`, `WP-07`, `WP-08`, `WP-09`, and `WP-11`. Nine are complete. The difference is the three that carry remainders, which the manifest now records as owed fixtures rather than prose (`WP-01` above explains the mechanism), so `bun scripts/parity-ready.ts` no longer counts them as satisfying a dependency — `WP-12` reports as blocked, which it always was. `WP-08`: resume now works for every engine through the journal, which gives `FileEventStore` its first production caller and makes the importer's verdict actionable, but the ACP and TUI surfaces are still on the old path and durable storage stays opt-in until encryption exists. `WP-11`: a stale read is detected and a stale write refused, and one writer at a time is enforced across processes with a shared generation, but reader output is not yet provisional and nothing revalidates it, so `DDP-SWM-02` cannot certify. Every R1 package has a passing gate, and `WP-00a`'s remainder is now paid on the CLI: the attempt records `DDP-OBS-01` and `WP-12` both depend on are written in production by the gate and the ledger rather than by the unadopted `EffectRuntime`, the audit journal is split from history so they survive a crash whatever the user chose about conversation logs, and reconciliation runs before the first turn so a dangling record is read rather than merely written. The swarm path was then found to be running a second, weaker gate rather than merely missing a sink, and now delegates to the shared one; what remains is the ACP surface, which authorizes correctly and records nothing. The other R1 exit conditions are review items rather than implementation: the walking skeleton and revised loading model need approving, and the `DDP-*` outcomes need certifying on Linux x64. `bun scripts/parity-ready.ts` derives the queue from the manifest rather than from this paragraph.

**Encryption at rest is the blocking dependency, and it was owned all along — three releases too late.** `WP-08` found that the locked storage decision — encrypted history, ephemeral when no key exists, never plaintext — is encoded in `storage-policy.ts` with nothing calling it. This was first written up here as belonging to no package, and that was wrong: `WP-27` scoped "authenticated encryption and OS/headless key-provider abstraction" from the start. The defect was sequencing, not ownership, and it is the more dangerous of the two, because a missing owner is visible while a mis-sequenced one looks handled. `WP-27` sits in R5 behind checkpoint, attachments, and memory, while `DDP-CONV-01` has to pass at R2 exit — so an R2 criterion depended on R5 work. The encryption and key-provider half is now `WP-27a` in R2; until it lands, session history is kept only when a user opts into plaintext, so crash resume is not on by default and the R2 conversation-durability outcomes cannot certify.

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

Three engineers over 50 weeks provide 150 gross person-weeks. The loading model allocates 105 to feature packages, 36 to explicit cross-package quality work, and 9 to true contingency. It allocated 102/36/12 before `WP-00a` and 104/36/10 before `WP-27a` was split forward.

Four engineers have enough capacity for the original 39-week target but require a separate dependency schedule. Two engineers require approximately 69 weeks for committed work or 75 weeks with equivalent contingency.

`WP-00` and R1 replace planning estimates with measured loading. Rebaseline beyond 50 weeks when:

- committed package work exceeds 105 core person-weeks;
- cross-package quality work exceeds 36 person-weeks;
- any owner exceeds phase capacity;
- true reserve drops below ten person-weeks;
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

Six packages run a second cell, `macos-arm64`, on the host rather than through Compose: the kernel and gate (`WP-00`, `WP-00a`), trust (`WP-02`), path containment (`WP-03`), the process broker (`WP-04`), and approvals (`WP-09`). All six pass there. macOS is the platform the product ships on, so a program whose evidence came entirely from a Linux container held no evidence about any machine a user runs — and adding the cell was not a formality. It found two defects immediately, neither visible to a green Linux gate:

- `FX-TRUST-007`, above: a trust grant recorded under one spelling of a directory and unfindable under the other.
- A test-hermeticity defect that had been misread as a macOS bug. `sessionlog` is configured through ambient `SESSIONLOG_*` variables, and an exported `SESSIONLOG_REPO_REMOTE` redirects all session storage into a clone of that remote under `~/.sessionlog/repos/`. The swarm checkpointer fixtures therefore wrote their state into the developer's own session-history checkout and then failed looking for it in the fixture — while the container, which forwards no such variable, stayed green. It looked like a platform difference and was an environment difference; the Linux-only matrix is what allowed the two to be confused for as long as they were. `test/vitest-setup.ts` now strips the whole prefix suite-wide, next to the `OPENSWARM_HISTORY_PATH` guard that exists for the same reason one dependency over.

The second one is the more useful finding, because the class is general: a suite that only ever runs in a container cannot tell a platform assumption from an ambient-environment assumption, and will read the second as the first every time.

A third was the same class again, and is now fixed. The `baseline` cell on `macos-arm64` was red on `test/integration/open-weight-repair.e2e.test.ts`, "dispatches the call and continues the run", which made four model round trips on macOS where it made two on Linux and expected two. The extra pair were `compaction` calls. The fake provider advertised a 32k window, and the fixture's `glob` for `*.json` returns its 1000-line cap — so the size of the fixture in bytes was the length of the absolute path to the checkout, a thousand times over. 70,687 bytes at `/workspace`; 92,685 at `/Users/<someone>/GitHub/openswarm`; the difference is 22 characters of path times 1001 lines, and it crosses the window. The repair path under test worked correctly on both platforms, and the run returned the right answer after compacting.

  So a Linux developer with a deep checkout fails it too, and the third finding in a row that presented as "macOS is different" was again an environment dependence that a Linux-only matrix could not distinguish from one. The window is now large enough that the fixture's size cannot reach it; no test here asserts anything about compaction, and narrowing the glob would only trade a dependency on path length for one on how many files the developer's tree contains.

With that, 4788 of 4810 tests pass on macOS and 22 skip. The `macos-arm64` baseline is green.

**And the reason none of the three was caught earlier is worse than a missing cell.** `.github/workflows/ci.yml` already runs the whole suite on `macos-latest` — it always has. That job had been failing at `npm ci` for a month: `@vscode/ripgrep`'s postinstall downloads a platform binary from a GitHub release, shares the runner's anonymous rate limit when no token is present, and answers `403`. So the macOS job never reached a single test, and `main` has been red on it continuously since early July while the Linux job went green beside it.

That reframes this whole section. The gap was not only that the parity matrix declared one cell; it was that the second cell existed, was red for an environmental reason nobody had to look at, and stayed red long enough for three real defects to accumulate behind it. Every one of them was something CI had already been asked to catch and could not. Passing `GITHUB_TOKEN` to the install step is the fix, and it is a one-line change that has been available the entire time.

The lesson for the program is about what a cell is *for*. A declared cell that nobody runs and a declared cell that fails before it tests anything are the same artifact: an assertion of coverage with no evidence under it. `check_cell_platform` stops a cell from lying about *where* it ran; it could not stop one from lying about whether it ran at all.

That is now enforced. `status.ts` has a fourth qualifier beside `stale`, `dirty`, and `owed`: a gate that passes on a platform cell whose repository baseline does not pass is `unbaselined`, and a capability resting on it is `unproven`. A work-package gate runs its own fixtures and nothing else, so on a cell where the suite as a whole is broken it can report green over a platform that does not work — which is precisely what would have happened had any of these gates been declared on `macos-arm64` a month ago. A missing baseline counts the same as a failing one, the baseline is held to the same commit and clean-tree rules as the gate it licenses, and a genuine gate failure still reports as `failing` because that is the thing to act on. Scope cells like `crypto-matrix` are exempt: they name a body of work rather than a machine, so there is no baseline to measure them against.

| WP | Exact verification command | Primary fixtures | Threshold |
|---|---|---|---|
| `WP-00` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-00 linux-x64`; plus `./scripts/verify-parity-wp.sh WP-00 macos-arm64` on the host | `FX-EFFECT-001`, `FX-CRASH-001`, `FX-STORAGE-DEFAULT-001` | Durability invariant passes; encrypted 90-day default and secure-key-missing ephemeral behavior are explicit |
| `WP-01` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-01 linux-x64` | `FX-MANIFEST-001`, `FX-CLAIM-001`, `FX-EVAL-PLAN-001` | Every ID has evidence ownership; corpus, comparator, model IDs, statistics, and guardrails are preregistered |
| `WP-02` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-02 linux-x64`; plus `./scripts/verify-parity-wp.sh WP-02 macos-arm64` on the host | `FX-TRUST-001..007` | Zero pre-trust process, network, secret, or project-setting activation |
| `WP-03` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-03 linux-x64`; plus `./scripts/verify-parity-wp.sh WP-03 macos-arm64` on the host | `FX-PATH-001..020`, generated corpus | Zero escapes across at least 10,000 path/symlink/race cases |
| `WP-04` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-04 linux-x64`; plus `./scripts/verify-parity-wp.sh WP-04 macos-arm64` on the host | `FX-PROC-001..012` | Zero direct untrusted spawns; all unavailable `require` paths execute nothing |
| `WP-05` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-05 linux-x64` | `FX-RETRY-001..010` | Zero duplicate mutating dispatches; unresolved attempts remain `outcome_unknown` |
| `WP-06` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-06 linux-x64` | `FX-CLAIM-002`, `FX-CAS-001` | One owner across 10,000 claims; no moved target commit is lost |
| `WP-07` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-07 linux-x64` | `FX-JOURNAL-001..012`, `FX-MIG-SESSION-001` | Every torn-write boundary retains the last committed event; N/N−1 rules pass |
| `WP-08` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-08 linux-x64` | `FX-RESUME-001..011` | Ten-turn and restart continuity pass on all engine adapters |
| `WP-09` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-09 linux-x64`; plus `./scripts/verify-parity-wp.sh WP-09 macos-arm64` on the host | `FX-APPROVAL-001..012` | Default grants are session/resource/operation scoped; missing, expired, replayed, disconnected, and late decisions deny 100% |
| `WP-10` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-10 linux-x64-pty` | `FX-TUI-KEYS-001..014` | Zero dropped input; all key/history/paste/approval cases pass |
| `WP-11` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-11 linux-x64` | `FX-RW-001..012` | Stale output remains provisional, revalidates automatically, and cannot become terminal; queued writer starts within five seconds |
| `WP-12` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-12 linux-x64` | `FX-EVENT-001..010` | 100% semantic projections rebuild; no semantic frame is dropped at standard load |
| `WP-27a` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-27a crypto-matrix` | `FX-CRYPT-001..010` | A journal written with a key provider is unreadable without it; key absence selects the warned ephemeral mode; required-encryption configurations fail closed |
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
| `WP-25` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-25 linux-x64` | `FX-PLAT-001..005`, `FX-WSL-ID-001` | Package/isolation/PTY/cancel/cleanup pass on all five pinned targets; the other four cells are invoked as in the `WP-25` table above |
| `WP-26` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-26 surface-matrix` | `FX-HDL-001..010`, `FX-ACP-001..010` | Headless and Zed pass the same mandatory journeys as TUI |
| `WP-27` | `docker compose -f compose.parity.yml run --rm parity ./scripts/verify-parity-wp.sh WP-27 crypto-matrix` | `FX-RET-001..010`, `FX-MIG-CRYPTO-001` | 90-day purge default, alternate policies, export/delete, and tamper failures pass |
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

- Full live-provider suites: Linux x64 and macOS arm64. Implemented as the `live` target — see below.
- Package, TUI, isolation, shell, cancellation, and cleanup: every target.
- Zed integration: macOS arm64 and Linux x64; ACP golden protocol tests elsewhere.
- Windows cell: Windows 11 host with the pinned Linux distribution under WSL2/container; native Windows fallback is rejected.
- The R1 manifest pins exact OS builds, runtimes, LSP servers, provider model IDs, and certification dates.

#### The live cell

```
OPENSWARM_PARITY_LIVE=1 OPENSWARM_LIVE_MODELS=azureoai/gpt-5.5,awsbedrock/amazon.nova-pro-v1:0 \
  docker compose -f compose.parity.yml run --rm -T parity \
  ./scripts/verify-parity-wp.sh live linux-x64
```

`FX-LIVE-001..006` in `scripts/live-probe.sh`, run once per model named. Not a work-package gate: it certifies no capability. It checks that the seams between the model, the process, and the filesystem still line up, which is the class of defect an in-process fixture cannot reach — a turn completes (`L1`), a tool call reaches a real file through canonicalization (`L2`), every approval question asked gets an answer (`L3`), two live workers land two results and two files (`L4`), what the writers left behind parses and ends on a line boundary (`L5`), and a second process resumes a session the first one recorded (`L6`). It exists because of the WP-09 finding below, and `L3` is that finding: reverting the fix turns `L3` red and leaves the others green. `L6` earned its place the same way, catching a `WP-08` payload-nesting bug that compiled and passed every unit test.

Certified on both cells against `azureoai/gpt-5.5` and `awsbedrock/amazon.nova-pro-v1:0`.

Three things about it are deliberate, and each was learned by getting it wrong first:

**Two independent locks, because a live cell's failure mode is a bill and a leaked credential rather than a red check.** The target has to be named — no matrix over the work packages reaches it, since those are all `WP-*` — *and* `OPENSWARM_PARITY_LIVE=1` has to be set, so a copied command line or a job that enumerates `--list` still spends nothing. Compose defaults both off and passes credentials with bare `- VAR` entries, which forward a variable only when it exists: `VAR: "${VAR:-}"` would define it as empty, and empty is not absent to the code reading it, since the Azure transport resolves `AZURE_API_BASE ?? AZURE_OPENAI_ENDPOINT` and an empty first operand satisfies `??` and suppresses the fallback.

**A missing credential reports `skipped` and exits 4, never `pass`.** A live cell that cannot reach a provider has certified nothing, and a matrix that reads that as green has no live coverage and no way to find out. The probe distinguishes an unconfigured provider from a defect and stops after one request rather than five, so the report says "no credential" once instead of describing a broken build five times.

**The probes assert on what this codebase is responsible for, not on what the model does, and every one is bounded.** This is the rule the cell keeps re-learning. `L6` first asserted that a resumed session recalled a fact from its first turn, and failed against a model that was handed the entire first turn and still answered "Condor" — a fact about the model, not about resume, and the same model answered correctly on the next run. It now asserts that the journal accumulated a second turn over a longer message list under an unchanged engine id, and that the resumed request cost more input tokens than the fresh one, which together prove the history was delivered and hold whatever the model says; the recall itself is printed as a note rather than gated. `L3` learned the same lesson earlier: it demanded exactly two approval questions and failed against a weak model that looped to fifty-two — a transport failure reported where there was only a model with poor discipline. The invariant is that every question asked gets answered, which is what the bug actually violated (it asked twice and answered once) and which holds whatever the model does. That looping run also spent 1.1M input tokens before anything stopped it, so the probes now pass `--max-turns 12 --max-wall-clock 4m`. `L4` checks the two files separately from the two `succeeded` statuses, because a task reports success when its loop ended, which is not the same as the work having happened.

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
| Notebook safety | Closed. Containment fixed in `WP-00a`; atomic writes, a content-hash guard, and a read-before-edit contract landed in `WP-03` |
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
- ~~Select and test OS/headless secure-key providers; verify the ephemeral fallback before durable rollout.~~ Owned by `WP-27a` since the R2 sequencing defect was found; no longer a loose follow-up.
- Book external security review by week 12.
- Provision every platform runner during R1.
- Reassess scope/date at R2 and R4 without weakening mandatory gates.
