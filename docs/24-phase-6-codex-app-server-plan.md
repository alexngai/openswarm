# Phase 6 — Codex App Server FrameworkProvider (v0.3)

Companion to [docs/21-roadmap-v0.2-to-v0.4.md](21-roadmap-v0.2-to-v0.4.md). This is the v0.3 release plan + design lock for ChatGPT Plus / Pro subscription support, **redesigned 2026-04-30** after research surfaced that the official OpenAI integration surface is the **Codex App Server (JSON-RPC over stdio)**, not the HTTP SSE endpoint at `chatgpt.com/backend-api/codex/responses`.

**Authoring date:** 2026-04-30.
**Status:** scoped; pre-implementation.
**Supersedes:** [docs/14-m4b-plan.md § Phase 5](14-m4b-plan.md) (the SSE-targeted custom Vercel AI SDK provider plan) + [docs/06-open-questions.md Q20](06-open-questions.md) (the deferred SSE spike).

---

## TL;DR

Pivot from "custom HTTP+SSE provider hitting a private browser endpoint" to **"FrameworkProvider that delegates to the locally-installed `codex` CLI via the documented JSON-RPC App Server protocol."** Same end goal (ChatGPT Plus/Pro subscription quota for swarm-harness users), better integration surface, lower risk, no spike needed.

This is also a categorization change: Codex was misclassified as a `TransportProvider` (raw model access). It is in fact a `FrameworkProvider` (agent-loop owner) — the same pattern as Anthropic's Agent SDK for Claude Max subscription auth.

---

## Why Path A (App Server) over Path B (SSE)

Research findings (full report at session log 2026-04-30):

| Dimension | Path B — HTTP SSE | Path A — App Server JSON-RPC |
|---|---|---|
| Endpoint | `chatgpt.com/backend-api/codex/responses` (private browser channel) | Local `codex` binary subprocess |
| Documentation | None — reverse-engineered | Official at [developers.openai.com/codex/app-server](https://developers.openai.com/codex/app-server) |
| Stability | Browser channel can change without notice | Documented, versioned, App Server has a public changelog |
| Auth | We own OAuth + reverse-engineered client_id `app_EMoamEEZ73f0CkXaXp7hrann` | User runs `codex login`; we inherit via the binary |
| Architecture fit | New HTTP+SSE stack | Reuses our existing subprocess + JSON-RPC IPC layer |
| Risk class | Policy-tolerated, ungoverned client_id, ungoverned endpoint | Officially supported integration surface |
| Implementation cost | 1.5d post-spike + ongoing maintenance to chase undocumented changes | 2.5d total + stable upgrade path |

The App Server pivot makes Phase 6 strictly safer and aligns with how Anthropic's Agent SDK is integrated: the user authenticates via the official tool, swarm-harness delegates the agent loop to the framework.

---

## Audit — what's already in tree

Inventory of Phase 4 + Phase 6-adjacent code that survives the pivot:

| Asset | State | Disposition |
|---|---|---|
| `src/auth/openai-oauth.ts` (420 lines) — full PKCE + browser callback + token persist + refresh | shipped (M4b Phase 4) | **Deprecated.** App Server path delegates auth to `codex login`; we don't store OAuth tokens. Keep for backward-compat read-side until v0.4 cleanup; new mode never invokes it. |
| `src/auth/openai-oauth.test.ts` | shipped | Stays green; covers the deprecated module's correctness. |
| `swarm-harness login --provider codex-chatgpt` | shipped | **Redirected.** New behavior: prints "use `codex login` instead — swarm-harness delegates to the official tool" with a link. Doesn't invoke OAuth flow. |
| `swarm-harness logout --provider codex-chatgpt` | shipped | **Redirected.** Same redirect message. |
| `src/tools/framework-filter.ts` — strips SwarmHost tools in framework modes | shipped | Stays as-is. App Server mode is a framework mode and benefits from the same filter. |
| `src/cli/argv.ts` `--framework codex-chatgpt` flag | shipped | Stays. Flag name is keyboard-stable; the underlying transport changes from "custom HTTP" to "App Server JSON-RPC". |
| `src/cli/main.ts:388` "blocked" stub | shipped | **Removed.** Replaced with CodexFrameworkProvider construction. |
| `src/providers/codex-chatgpt.ts` | not started | **Skipped.** Replaced by the App Server provider below. |
| `test/fixtures/codex/responses-sse.txt` | not captured | **Not needed.** SSE spike is moot under the App Server design. |
| `test/fixtures/codex/required-headers.json` | not captured | **Not needed.** Same reason. |

Net code-deletion vs the old plan: ~200 lines we never wrote. Net new code: ~400 lines (provider + tests). Net change in shipped surface: equivalent end-user UX, smaller maintained codebase.

---

## Design lock — Phase 6 (2026-04-30)

Numbers are Phase-6-local (distinct from Q1–Q18, P2.Q1–10, P3.Q1–6, P4.Q1–8, P5.Q1–12, v0.2.Q1–8).

### P6.Q1 — Integration target

**Decision: Codex App Server (JSON-RPC over stdio), spawning the locally-installed `codex` binary.**

The HTTP SSE endpoint at `chatgpt.com/backend-api/codex/responses` is a private browser-to-backend channel; building against it is policy-tolerated but ungoverned and unstable. The App Server is officially documented and versioned. Integration cost is the same; risk is meaningfully lower.

### P6.Q2 — Transport mechanism

**Decision: stdio.**

App Server supports stdio + WebSocket + Unix socket per the [Codex App Server changelog](https://developers.openai.com/codex/changelog) (April 2026). stdio wins because:
- No port conflicts (relevant for swarm runs spawning many agents)
- No socket file cleanup
- Matches our existing `src/swarm/ipc/` framing for worker subprocesses
- Cross-platform (Unix sockets are POSIX-only)

### P6.Q3 — Provider categorization: TransportProvider vs FrameworkProvider

**Decision: `FrameworkProvider`. Codex App Server hosts agent threads (with built-in tools, permission prompts, sandboxing); it doesn't expose raw model APIs.**

This corrects the M4b Phase 5 spec, which claimed Codex was a `TransportProvider`. App Server hosts the agent loop. swarm-harness in `--framework codex-chatgpt` mode acts as a thin shell that delegates the turn to Codex and translates events back. Same pattern as the Anthropic Agent SDK FrameworkProvider for Claude Max.

Consequence: in this mode, swarm-harness does NOT run its own tool dispatcher, permission engine, bash validation, or session loop. Codex owns all of that. swarm-harness owns the CLI surface, the lane-event translation, the orchestrator (when in swarm mode), and the user-facing UX.

### P6.Q4 — Auth delegation

**Decision: delegate entirely to `codex login`. swarm-harness owns zero auth code for this provider.**

Mirrors the Anthropic Agent SDK pattern (we never see the Claude Max OAuth token; the SDK manages it). Same here: the user runs `codex login` once via the official tool; the App Server inherits credentials from `~/.codex/auth.json` (or wherever Codex persists them).

`src/auth/openai-oauth.ts` is no longer invoked by Phase 6. It stays in the tree for one release cycle so the deprecation is visible (commit message + roadmap doc + login subcommand redirect message), then can be deleted in v0.4 cleanup.

### P6.Q5 — Codex binary discovery

**Decision: `which codex` (PATH lookup) with a clear error if absent.**

Doctor check (`swarm-harness doctor`) gains a new "codex CLI" entry that:
- ✅ if `codex --version` succeeds and returns a version number
- ⚠️ if absent — message: "Install via `npm install -g @openai/codex` to enable `--framework codex-chatgpt` mode."
- ❌ never — absence isn't a failure for non-codex modes

No bundling. Users who want this mode install Codex separately. Same UX bar as `claude auth login` (we don't bundle Claude Code either).

### P6.Q6 — Tool surface in `codex-chatgpt` mode

**Decision: swarm-harness's tools are entirely hidden. The agent sees only Codex's built-in tool surface.**

In FrameworkProvider mode, the framework owns the tool dispatcher. Codex has its own tool surface (`read_file`, `apply_patch`, `run_command`, etc.) which the agent sees and uses. Our `bashValidationGate`, `PermissionEngine`, `bashTool`, etc. are not invoked.

The existing `framework-filter.ts` strips swarm-routed tools in any framework mode — that part stays. We additionally enforce: in `codex-chatgpt` mode, the *entire* tool list passed to the agent is empty (Codex provides its own). Constrained-swarm-features tradeoff is identical to the existing Claude Agent SDK FrameworkProvider mode.

### P6.Q7 — Process lifecycle: long-lived vs spawn-per-turn

**Decision: long-lived. Spawn `codex` once at engine init; reuse across turns; teardown on engine close.**

App Server is designed to host multiple agent threads in a single process. Spawn-per-turn would be wasteful (subprocess startup time + reauth overhead + lost cache). The App Server's resume / pagination features (April 2026 changelog) assume long-lived sessions.

Failure modes:
- App Server crashes mid-turn → translate to NormalizedEvent error, mark engine as dead, require restart for next turn.
- App Server hangs → existing engine-level abort cancels the JSON-RPC request; engine is restartable.

### P6.Q8 — Lane event translation

**Decision: translate Codex's agent-thread events into our `NormalizedEvent` discriminated union (the existing `text_delta`, `tool_use_start`, `tool_use_input`, `tool_use_end`, `tool_result`, `message_stop` shapes from src/core/types.ts). Codex-specific event types we can't map fall through as `info` events with payload preserved verbatim.**

Don't introduce a parallel "codex-specific" event vocabulary. The whole point of NormalizedEvent is that downstream consumers (UI, headless JSONL, swarm orchestrator) don't care which engine produced the events.

Field mapping is locked by Stage 3.0 spike against the App Server's actual JSON-RPC notification shapes.

### P6.Q9 — Backward-compat for the deprecated OAuth path

**Decision: removed in v0.3 (originally planned for v0.4). `swarm-harness login --provider codex-chatgpt` redirects to `codex login` instead of running the OAuth flow.**

Original plan kept `src/auth/openai-oauth.ts` in the tree for one release cycle so the deprecation was observable as code (jsdoc `@deprecated` tag) and behavior (login redirect message). After v0.3 ship-readiness review, the file + its 393-line test suite were removed in the same release — the redirect message in `login`/`logout` and the negative tests in those files are the only deprecation signal callers need; keeping 818 lines of dead OAuth code as "reference material" wasn't pulling its weight.

---

## Stage breakdown

### Stage 3.0 — Codex App Server JSON-RPC spike (~0.25d)

Local development setup + protocol verification. No swarm-harness code changes.

- `npm install -g @openai/codex` (or use existing install)
- `codex login` (one-time interactive)
- `codex serve --stdio` (or whatever the App Server invocation is per current docs) — verify it starts and accepts JSON-RPC.
- Send the documented "list capabilities" or "ping" JSON-RPC method; capture the response.
- Send a "create thread + run one turn" sequence; capture the streaming events.
- Save the captures to `test/fixtures/codex-app-server/` (handshake.json, one-turn-events.jsonl, capabilities.json).
- Update this doc's Stage 3A spec with the locked method names + event shapes.

**Acceptance:** the three fixture files exist; this doc's Stage 3A inline spec uses real method names from the captures, not placeholders.

### Stage 3A — `CodexAppServerProvider` skeleton (~0.5d)

`src/providers/codex-app-server.ts` (new):
- Spawn `codex` binary as a child process (reuse `subprocess-spawner.ts` patterns where applicable).
- JSON-RPC 2.0 framing over stdio. Reuse `src/swarm/ipc/framing.ts` if compatible; else minimal re-implement.
- Initialize sequence: send capabilities request; verify response shape; cache capabilities for the engine.
- Lifecycle: `start()`, `dispose()`, abort signal wiring.
- No agent-turn logic yet — just connect / capabilities / disconnect.

`src/providers/codex-app-server.test.ts`: mock subprocess, assert handshake + lifecycle. Mocks load from Stage 3.0 fixtures.

### Stage 3B — Agent thread + event translation (~0.75d)

Extend the provider with:
- `runTurn(prompt, signal): AsyncIterable<NormalizedEvent>` method.
- Send "create thread" + "send message to thread" via JSON-RPC.
- Listen for streaming JSON-RPC notifications; translate each to a `NormalizedEvent` per P6.Q8 mapping.
- Handle the "thread completed" terminal notification → emit `message_stop`.
- Error paths: App Server returns a JSON-RPC error → emit `NormalizedEvent` of type `error` with structured `failureClass`.

Engine wiring: `CodexFrameworkEngine implements AgentEngine` in `src/engine/codex-framework.ts`. Holds the long-lived provider; each `run(config)` creates a new thread; emits NormalizedEvents from the provider's `runTurn`.

Tests:
- Replay captured events from Stage 3.0 fixture; verify translated NormalizedEvent stream matches expected shape.
- Tool-call accumulation (Codex partial-arg events → single `tool_use_start` + `tool_use_input` + `tool_use_end` triple).
- Error-event translation.
- Abort signal propagates and cancels the in-flight JSON-RPC call.

### Stage 3C — CLI + routing wiring (~0.25d)

- `src/providers/routing.ts`: route `--framework codex-chatgpt` to the new `CodexFrameworkEngine`. Models passed via `--model` are forwarded to Codex (Codex picks; we don't validate).
- `src/cli/main.ts`: remove the "blocked" stub at line 388. Wire the engine factory.
- `src/cli/login.ts`: redirect `--provider codex-chatgpt` to print the new "use `codex login` instead" message.
- `src/cli/logout.ts`: same redirect message; no-op on our side.
- `src/cli/doctor.ts`: add the codex-CLI presence check per P6.Q5.

### Stage 3D — Tests + docs (~0.5d)

- 6+ new tests covering the live integration paths (mocked subprocess; fixtures from Stage 3.0).
- Update `docs/15-parity-gaps.md` row P4: ⚠️ → ✅ with a citation pointing at this doc.
- Update `README.md` "Models & aliases" section: document the `--framework codex-chatgpt` mode + the `codex login` prerequisite.
- Update `docs/16-parity-plan.md` § Phase 6 with an "Implementation note" pointing at this doc (mirror the Phase 3/4/5 cross-reference style).
- Update `docs/06-open-questions.md` Q20: REVISITED — App Server pivot makes the SSE spike moot.
- Update `docs/14-m4b-plan.md` § Phase 5: SUPERSEDED by this doc; preserve the historical record.
- Update `docs/21-roadmap-v0.2-to-v0.4.md` v0.3 section: replace the current "wait for SSE spike" plan with the App Server flow.
- Mark `src/auth/openai-oauth.ts` as `@deprecated` in jsdoc with a v0.4 removal target.

### Stage 3E — Live smoke + close-out (~0.25d)

- Operator (you) runs the live smoke pass:
  - `swarm-harness doctor` reports codex-CLI presence + version.
  - `swarm-harness --framework codex-chatgpt --model gpt-5 "say hi"` returns a real response via subscription quota.
  - `swarm-harness --framework codex-chatgpt --model gpt-5 "list files in the current directory"` exercises a tool call (Codex's `read_file` or equivalent).
  - Verify ChatGPT subscription quota was actually consumed (check ChatGPT dashboard if accessible).
- Bump `package.json` to `0.3.0`.
- Tag `v0.3`.

---

## Acceptance criteria (Phase 6 as a whole)

1. ✅ `swarm-harness --framework codex-chatgpt --model gpt-5 "say hi"` returns a real ChatGPT response via the user's subscription quota.
2. ✅ `swarm-harness doctor` reports codex CLI presence + version (or a clear "install codex" message if absent).
3. ✅ `swarm-harness login --provider codex-chatgpt` redirects to `codex login` with a clear message; does not invoke our deprecated OAuth flow.
4. ✅ Tool surface is empty in `codex-chatgpt` mode (Codex provides its own tools).
5. ✅ Lane events from a Codex turn appear in the `--headless` JSONL stream as standard `NormalizedEvent` shapes (text_delta, tool_use_*, message_stop).
6. ✅ App Server crash mid-turn surfaces as a structured error event; engine is restartable.
7. ✅ Token usage from Codex's response → ChatGPT subscription quota is reflected in our `engine.getCumulativeUsage()` (best-effort; depends on what the App Server emits).
8. ✅ Doc 15 row P4 marked ✅.

---

## Estimate

**~2.5 days.** Distribution:

| Stage | Estimate | Note |
|---|---|---|
| 3.0 spike | 0.25d | Local capture; you (or me with `codex` installed) |
| 3A skeleton | 0.5d | JSON-RPC + lifecycle |
| 3B turn execution | 0.75d | Event translation; biggest chunk |
| 3C CLI wiring | 0.25d | Removes the stub; wires the engine |
| 3D tests + docs | 0.5d | Mostly mocked tests + doc updates |
| 3E live smoke + tag | 0.25d | Driven by you; quick once code is green |

This is **comparable to the original M4b Phase 5 estimate (~1.25d post-spike)** but with a meaningfully more solid foundation. The 1d delta is the FrameworkProvider engine layer, which we save back when we delete the OAuth code in v0.4.

---

## Risks

- **Codex App Server protocol churn.** April 2026 changelog showed active development. Mitigation: pin a tested codex version in the doctor check; document the supported version range; revisit on each codex minor bump. Same risk model as Anthropic SDK churn for our existing FrameworkProvider.
- **`codex` binary install friction.** Users who want the feature need to `npm install -g @openai/codex` first. Mitigation: doctor check + install instructions in the redirect message.
- **JSON-RPC framing edge cases.** Notifications interleaved with responses; backpressure on stdout; large payloads. Mitigation: reuse `src/swarm/ipc/framing.ts` patterns we've already debugged for worker subprocess IPC.
- **Codex's own quota / rate limits.** If the user exceeds ChatGPT subscription quota, Codex returns an error; we surface it. Same UX bar as any provider rate-limit error.
- **Engine-level abort propagation to App Server.** Need to verify the App Server respects `cancel` / `interrupt` JSON-RPC methods. If not, abort becomes "kill the subprocess" which loses session state. Mitigation: Stage 3.0 spike captures the cancel protocol.

---

## Out of scope for v0.3

- **Custom Vercel AI SDK provider hitting `chatgpt.com/backend-api/codex/responses`.** Replaced by App Server entirely. SSE fixtures are not captured.
- **Direct OAuth flow ownership.** Deprecated; user delegates to `codex login`.
- **Multi-account support.** One `codex` install = one auth = one subscription quota. Multi-account is post-v0.3.
- **Codex App Server extension surface.** The App Server has hooks for "external agents" per the April 2026 changelog. We don't expose this; we just consume.
- **`src/auth/openai-oauth.ts` deletion.** Marked deprecated in v0.3; physical removal in v0.4.

---

## What this supersedes

| Doc | Section | Action |
|---|---|---|
| `docs/14-m4b-plan.md` | § Phase 5 (Codex ChatGPT custom TransportProvider) | Marked SUPERSEDED 2026-04-30; points here |
| `docs/06-open-questions.md` | Q20 (Codex SSE spike) | Marked RESOLVED 2026-04-30 — pivot makes it moot |
| `docs/16-parity-plan.md` | § Phase 6 — OpenAI OAuth | Implementation-note block points here |
| `docs/21-roadmap-v0.2-to-v0.4.md` | § v0.3 Phase 6 stage breakdown | Rewritten to match Stages 3.0–3E |

Stage 3D explicitly handles all of these doc updates as part of the implementation work.

---

## Definition of done

1. All five stages (3.0 + 3A–3E) merged on `mvp`.
2. Test posture: vitest 1453+ pass / 0 fail; bun 49+ pass / 0 fail; tsc clean.
3. Acceptance criteria 1–8 met (live smoke).
4. Doc 15 row P4 marked ✅.
5. README documents `--framework codex-chatgpt` + the `codex login` prerequisite.
6. `package.json` bumped to `0.3.0`.
7. `v0.3` tag pushed.
8. CHANGELOG entry.

---

## Sign-off slot

Updated as v0.3 ships:

- **v0.3 — released:** _(pending)_
