# M0 Runtime Core — Implementation Plan

**Status:** draft
**Owner:** alex
**Created:** 2026-04-20
**Supersedes:** §M0 of `docs/07-implementation-plan.md` (plan refines the breakdown based on Agent SDK research findings)

## Scope

Build the runtime foundation for a single atomic swarm-harness agent backed by `@anthropic-ai/claude-agent-sdk`. At exit, `swarm-harness prompt "..."` completes a real tool-using conversation end-to-end in both API-key and Claude-subscription paths.

**In scope:**
- `AgentEngine` interface + `ClaudeAgentSdkEngine` implementation (wraps Agent SDK, normalizes events, binds our permission + dispatcher)
- Tool infrastructure: `ToolImpl` shape (Zod schemas + execute), dispatcher registry, 8 Tier 0 tools
- `PermissionEngine` (mode-only — three modes, no rule grammar)
- `SessionStore` (thin wrapper over SDK's default path with resume-latest helper)
- `AuthSource` read-only stub (reports env/keychain status; no credential management)
- CLI: `prompt` (bare-positional shorthand), `doctor`, `init`, flags `--model`, `--resume`, `--permission-mode`, `--output-format`, `--headless`
- Minimal ink UI + headless JSONL emitter
- Unit tests + mock-Agent-SDK integration tests

**Out of scope (explicit):**
- `swarm-harness login` subcommand — document-only; user runs `claude auth login` or `claude setup-token` themselves
- OAuth / credential management (SDK handles; Anthropic TOS restricts third-party offering)
- Our own compactor (SDK owns compaction)
- MCP client (M0 uses SDK's; ours is M5)
- Hooks runtime (M2)
- Full permission rule grammar — `tool(subject:*)` patterns (M2)
- Swarm primitives — `agent`, `task_*`, `send_message`, lane-event fan-out (M1)
- Vercel AI SDK / `NativeEngine` / `Provider` impls (M4)
- Plugin and skill loaders (M2)
- ink polish (spinner coexistence, tab-completion dropdown, emacs bindings) — M0 ships minimal; M2 adds depth

## Decision context

Planning informed by three research passes. Key facts from the Agent SDK spike (results in conversation, key points below):

1. **SDK is a subprocess orchestrator.** `query()` spawns the bundled Claude Code CLI binary. All auth, session, compaction, MCP, and streaming happen inside that subprocess. We cannot bypass the CLI in M0.
2. **Custom tools must go through MCP.** No Anthropic-native JSON tool schemas. We register an in-process MCP server via `createSdkMcpServer()` with Zod-shape tools. The MCP handler is the execution path.
3. **`canUseTool` is allow/deny only.** Fires before the MCP handler when `permissionMode: 'default'`. Allowlists short-circuit it — we must NOT use `allowedTools` if we want gate control.
4. **OAuth is not programmatic.** No `login()` export. `claude auth login` runs the flow; credentials persist to macOS Keychain (`Claude Code-credentials` service) or `~/.claude/.credentials.json`. SDK inherits from `process.env` / keychain automatically.
5. **Anthropic TOS:** _"Anthropic does not allow third-party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."_ → swarm-harness owns **zero auth code**. Users run `claude auth login` themselves; we inherit credentials.
6. **Per-worktree session isolation is free.** SDK default path: `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`. Q3's "non-negotiable" already satisfied.
7. **Compaction is free.** SDK emits `SDKCompactBoundaryMessage`; we just observe.

## Acceptance criteria

Each is executable with a one-line test harness (manual or scripted).

1. `ANTHROPIC_API_KEY=sk-ant-... npx swarm-harness prompt "say hi"` returns a text response and prints it to the TTY; exits 0.
2. `ANTHROPIC_API_KEY=sk-ant-... npx swarm-harness prompt "read the file package.json and count its keys"` invokes `read_file` through our dispatcher (observed in JSONL when `--headless`) and returns the model's answer.
3. `npx swarm-harness --permission-mode read-only prompt "write a test.txt file"` → permission denial surfaced as a tool_result error; model adapts or gives up; exit 0. No file created.
4. `npx swarm-harness --headless prompt "say hi"` emits a parseable JSONL stream to stdout; every line is a valid JSON object matching `NormalizedEvent` | `LaneEvent`; stream terminates with a `message_stop` event.
5. `npx swarm-harness --resume latest prompt "and one more thing"` resumes the most recent session in the current worktree and continues the conversation.
6. `npx swarm-harness doctor` on a clean install with only `ANTHROPIC_API_KEY` set prints 4 checks (auth / config / install / workspace), all PASS, exits 0. With no auth configured, auth check fails with actionable message pointing at `claude auth login` or `ANTHROPIC_API_KEY`.
7. `npx swarm-harness doctor --output-format json` emits valid JSON with `{checks: [{name, status, message}, ...], overall: "pass"|"fail"}`.
8. `npx swarm-harness init` in an empty dir creates `.swarm-harness/`, adds entries to `.gitignore`, and creates a stack-detected `CLAUDE.md` if one doesn't exist; idempotent.
9. `npx tsc --noEmit` passes with strict mode.
10. `npm test` passes: ≥ 20 unit tests covering tools, dispatcher, permission engine, event translation; ≥ 5 integration tests against a mock Agent SDK covering the scenarios in criteria 1–5.
11. Bash tool: verify 16 KiB stdout truncation on UTF-8 boundaries, timeout handling, background PID return.
12. Edit tool: verify uniqueness check rejects ambiguous matches (claw divergence).
13. Grep tool: verify bundled `@vscode/ripgrep` binary is used and honors `.gitignore`.

## Implementation steps

Dependency-ordered. File paths are concrete; cross-references use `file.ts:symbol`.

### Phase 0 — Interface refinements (small; unblocks everything else)

The research surfaced three adjustments to the existing drafted interfaces (see §"Interface adjustments" below for exact diffs):

0.1. `src/core/types.ts` — add `ToolImpl` type (spec + execute function). Keep `ToolSpec` pure metadata.
0.2. `src/engine/index.ts` — shift `RunConfig.tools` from `readonly ToolSpec[]` to `readonly ToolImpl[]`. Keep `canUseTool` as the sole permission gate; remove the separate `executeTool` callback (execution happens via the ToolImpl's own `execute`, invoked from inside the engine's MCP handler).
0.3. `src/auth/index.ts` — narrow `AuthSource` for M0 to "report status" semantics; drop `InteractiveAuth` from M0 scope (not used — document it as post-M0 territory).

These are small edits; re-running `tsc --noEmit` after each confirms stability.

### Phase 1 — Dependencies (15 min)

1.1. `npm install @anthropic-ai/claude-agent-sdk zod @vscode/ripgrep ink@5 ink-markdown`
1.2. `npm install -D vitest @types/node@20`  *(test runner TBD — vitest is the lean; node:test is acceptable if we want zero-dep)*
1.3. Verify `@anthropic-ai/claude-agent-sdk` is version 0.2.116+ and its bundled CLI binary is present. Add a postinstall check script or surface via doctor.

### Phase 2 — Tool infrastructure (~2 days)

2.1. `src/tools/types.ts` — `ToolImpl` type, `ToolExecutionContext`, `ToolResult`. Move from `core/types.ts` if it keeps things tidy.
2.2. `src/tools/dispatcher.ts` — `ToolDispatcher` class. `register(impl)`, `list(): ToolSpec[]`, `dispatch(name, input, ctx): Promise<ToolResult>`. Input validation via Zod at dispatch boundary.
2.3. Tier 0 tools, one file each under `src/tools/tier0/`:
  - `bash.ts` — `child_process.spawn` with timeout, 16 KiB stdout/stderr truncation on UTF-8 boundaries, background PID return. Zod schema `{ command, timeout?, background? }`.
  - `read_file.ts` — `fs.promises.readFile`, 10 MiB cap, NUL-in-first-8-KiB binary detection, offset/limit.
  - `write_file.ts` — 10 MiB cap, workspace boundary check via canonical path.
  - `edit_file.ts` — exact-string replacement, **mandatory uniqueness check** (reject if `old_string` appears >1 time unless `replace_all: true`).
  - `multi_edit.ts` — atomic batch; validate all matches before applying any.
  - `glob.ts` — `fast-glob` or equivalent, gitignore-respecting.
  - `grep.ts` — invoke bundled `@vscode/ripgrep` binary via `child_process.spawn`.
  - `todo_write.ts` — in-memory + session-persisted list.
2.4. `src/tools/tier0/index.ts` — factory `buildTier0Tools(): ToolImpl[]`.
2.5. Unit tests per tool under `src/tools/tier0/*.test.ts`.

### Phase 3 — Permission engine (~0.5 day)

3.1. `src/permissions/index.ts` — `PermissionEngine` class. `check(toolName, mode, tool: ToolSpec): PermissionDecision`. Mapping:
  - `read-only` → allow tools with `requiredPermission ∈ {"none", "read"}`; deny others
  - `workspace-write` → allow `{"none", "read", "write"}`; deny `"exec"` and `"network"` (unless in allowlist)
  - `danger-full-access` → allow all
3.2. Per-tool required permissions (declared in each `ToolImpl.spec.requiredPermission`): bash=exec, read_file=read, write_file=write, edit_file=write, multi_edit=write, glob=read, grep=read, todo_write=none.
3.3. Unit tests: every mode × every tool produces the expected decision.

### Phase 4 — AgentEngine + ClaudeAgentSdkEngine (~3 days)

4.1. `src/engine/claude-agent-sdk.ts` — `ClaudeAgentSdkEngine` implements `AgentEngine`.
  - Constructor takes `(tools: ToolDispatcher, permissions: PermissionEngine)`.
  - `capabilities` returns `{ streaming: true, promptCache: true, parallelToolUse: true, mcp: true, compaction: true, resume: true, maxContextTokens: 200_000, maxOutputTokens: 64_000 }`.
  - `run(config)`:
    1. Build an in-process MCP server via `createSdkMcpServer({ name: "swarm-harness", tools: <our tools as SDK tool() defs> })`. Each tool's handler delegates to `config.executeTool` (set below), passing through the SDK's MCP Zod-validated input.
    2. Wrap `config.canUseTool` in the SDK's `CanUseTool` shape — map `{ allow: true }` → `{ behavior: 'allow' }`, `{ allow: false, reason }` → `{ behavior: 'deny', message: reason }`.
    3. Call `query({ prompt: config.prompt, options: { systemPrompt: config.systemPrompt ? config.systemPrompt : { type: 'preset', preset: 'claude_code' }, settingSources: ['project'], tools: [], mcpServers: { "swarm-harness": mcpServer }, canUseTool: wrappedGate, model: config.model, resume: config.resumeFrom?.data?.sessionId, maxTurns: config.maxTurns, includePartialMessages: true, includeHookEvents: false, abortController } })`.
    4. For each `SDKMessage`: translate to `NormalizedEvent`; yield. Terminal on `type === 'result'`.
4.2. `src/engine/event-translator.ts` — pure function `translateSdkMessage(msg: SDKMessage): NormalizedEvent | null`. Return `null` for messages we don't surface (setup/hook progress/misc). Covers:
  - `assistant` content blocks → `text_delta` (from partial messages) or batched text
  - `tool_use` start/end, `tool_result`
  - `result` → `message_stop` with usage
  - SDK `error` envelopes → `error`
4.3. Unit tests for event-translator with canned SDKMessage fixtures.
4.4. Integration test with a mock `@anthropic-ai/claude-agent-sdk` that produces scripted SDKMessage streams.

### Phase 5 — Session store (~0.5 day)

5.1. `src/session/store.ts` — thin `SessionStore` using SDK's session helpers.
  - `resolveLatest(): Promise<string | undefined>` — calls `listSessions({ dir: process.cwd() })`, returns most-recent sessionId.
  - `buildSnapshot(sessionId): SessionSnapshot` — returns `{ engineId: 'claude-agent-sdk', data: { sessionId } }`.
5.2. No persistence layer of our own for M0 — SDK does it. (M4 adds a full jsonl supplementing Agent SDK's when we build NativeEngine.)

### Phase 6 — Auth (M0 minimal) (~0.5 day)

6.1. `src/auth/status.ts` — `detectAuth()` returns:
```ts
type AuthStatus =
  | { state: 'env-api-key'; source: 'ANTHROPIC_API_KEY' }
  | { state: 'env-oauth-token'; source: 'CLAUDE_CODE_OAUTH_TOKEN' }
  | { state: 'keychain'; service: 'Claude Code-credentials' }   // macOS only
  | { state: 'file'; path: '~/.claude/.credentials.json' }      // Linux/Windows
  | { state: 'none' };
```
Implementation: check env first, then platform-specific credential store. Do NOT read/decrypt the actual credentials — we're just checking presence, not owning them.
6.2. Expose via `doctor` only.
6.3. `src/auth/index.ts` — keep interface unchanged (`AuthSource` with `headers()`, `isAuthenticated()`), but in M0 the sole implementation is a stub that reports status; `headers()` returns `{}` since the SDK reads env itself.

### Phase 7 — CLI (~2 days)

7.1. `src/cli/argv.ts` — hand-rolled parser (simpler than commander; ~150 LOC). Supports:
  - Bare positional → `prompt` shorthand
  - Subcommands: `prompt`, `doctor`, `init`, `help`, `version`
  - Flags: `--model`, `--resume`, `--permission-mode`, `--output-format`, `--headless`, `--version`, `--help`
7.2. `src/cli/prompt.ts` — orchestrates: detect TTY, build ToolDispatcher, build PermissionEngine, build ClaudeAgentSdkEngine, call engine.run, route events to UI layer.
7.3. `src/cli/doctor.ts` — 4 checks:
  - **auth:** `detectAuth()` reports a non-none state
  - **config:** (M0 stub) reports "no config" — full config hierarchy is M2
  - **install:** `@anthropic-ai/claude-agent-sdk` is importable, its bundled CLI binary is findable (per-platform resolution via the optional deps)
  - **workspace:** current cwd is writable
  Each check emits `{ name, status: 'pass'|'fail', message }`. Text mode prints with ✓/✗; JSON mode emits `{ checks: [...], overall }`. Exit 0 on all pass; 1 otherwise.
7.4. `src/cli/init.ts` — scaffold:
  - `.swarm-harness/` directory
  - `.gitignore` entries for `.swarm-harness/` and `node_modules/`
  - `CLAUDE.md` if missing — stack-detected: inspect `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod` and include a relevant starter note
  - Idempotent — safe to re-run
7.5. `src/cli/main.ts` — ties argv → subcommand dispatch → UI.
7.6. Update `package.json` `bin` entry from the existing stub to point at the compiled CLI.

### Phase 8 — UI (~1 day)

8.1. `src/ui/headless.ts` — JSONL event emitter. `emit(event: NormalizedEvent | LaneEvent): void` → `console.log(JSON.stringify(event))`. One event per line, stable schema.
8.2. `src/ui/ink/app.tsx` — minimal: show prompt, stream text via `ink-markdown`, show tool-use blocks as collapsed `[tool_use: <name>]` lines. No spinner, no tab-completion, no emacs bindings — M2.
8.3. TTY gating in `src/cli/main.ts` — if `!process.stdout.isTTY` or `--headless`, route to headless; else render ink.

### Phase 9 — Tests (continuous, final gate)

9.1. **Mock Agent SDK.** `test/mocks/agent-sdk.ts` — implements the subset of `query()` we use: accepts the same Options, returns an async iterable yielding scripted SDKMessages from fixtures. Used via vitest module mock (`vi.mock("@anthropic-ai/claude-agent-sdk", ...)`).
9.2. **Tool unit tests** — one file per tool, realistic fixtures (temp dirs, real file I/O). Already planned in phase 2.
9.3. **Dispatcher / permission engine unit tests** — 100% coverage of the mode × requiredPermission matrix.
9.4. **Event translator unit tests** — canned SDKMessages → expected NormalizedEvents.
9.5. **Integration tests:**
  - `e2e/prompt-text.test.ts` — mock SDK returns text; assert NormalizedEvent stream + exit 0
  - `e2e/prompt-tool-use.test.ts` — mock SDK calls `read_file` via MCP; assert dispatcher runs + real file read + result roundtrip
  - `e2e/permission-deny.test.ts` — permission-mode read-only + write_file → denial event + clean exit
  - `e2e/headless-jsonl.test.ts` — `--headless` path, assert stdout is valid JSONL
  - `e2e/resume.test.ts` — second invocation with `--resume latest` passes `resume: <uuid>` to SDK
9.6. `npm test` runs in CI-friendly time (< 30s).

## Interface adjustments (from interface drafts to M0 reality)

Small, mechanical. Apply before or at the start of Phase 2.

**`src/core/types.ts`** — no change. `ToolSpec` stays pure metadata (name/description/inputSchema/requiredPermission/tier).

**`src/tools/types.ts`** (new file) —
```ts
export interface ToolImpl {
  readonly spec: ToolSpec;
  execute(input: unknown, ctx: ToolExecutionContext): Promise<ToolResult>;
}
```

**`src/engine/index.ts`** — change `RunConfig.tools` from `readonly ToolSpec[]` to `readonly ToolImpl[]`. Remove `executeTool: ToolExecutor` from `RunConfig` (execution lives on `ToolImpl.execute`; engine calls it from inside its MCP handlers). Keep `canUseTool: PermissionGate`.

**`src/auth/index.ts`** — keep `AuthSource` shape. Mark `InteractiveAuth` as "post-M0" in the JSDoc comment. No API change.

**`src/providers/index.ts`** — no change. Provider is M4+ anyway.

**`src/core/types.ts`** — consider adding Zod as the canonical `inputSchema` type or keep JSON Schema + add conversion utilities. Recommend: keep `inputSchema` as JSON Schema (provider-neutral); have each `ToolImpl` carry its Zod schema separately as the SDK-boundary artifact. Tools export both; converters are ugly and lossy.

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Agent SDK subprocess startup cost makes `prompt` feel sluggish | High | Medium | Measure in P0 with `--debug`; if > 2s cold, adopt `startup()` warm-query pattern (SDK exports it) for interactive REPL; document for CI users |
| Zod ↔ JSON Schema duplication creates drift between our `ToolSpec.inputSchema` and MCP tool shape | Medium | Medium | Each tool declares schema **once in Zod**, exports `ToolSpec` via a `zodToJsonSchema(zodSchema)` helper at module load. Single source of truth. |
| SDK API drift (alpha surfaces marked `unstable_v2_*`) | Medium | High | Avoid all `unstable_*` APIs. Pin `@anthropic-ai/claude-agent-sdk` to `~0.2.116` in M0. Revisit on minor bumps only. |
| Anthropic TOS enforcement changes | Low | High | swarm-harness owns no auth code; README explicitly says "run `claude auth login` yourself." Revisit if TOS changes. |
| `canUseTool` gets short-circuited by allowlist / permissionMode | Medium | Medium | Code review checklist: never set `allowedTools` in `query()` call, always pass `permissionMode: 'default'`. Enforced by lint rule if feasible. |
| Claude Code CLI binary not on PATH / wrong version | Medium | Medium | `doctor` install check verifies bundled optional-dep binary at import time; fails with actionable message ("SDK expects bundled CLI 2.1.116; got ...") |
| Event-translator incorrectly drops a load-bearing SDKMessage type | Medium | High | Translator is pure; comprehensive fixture-based unit tests; keep `NormalizedEvent` permissive (discriminated union, easy to add variants) |
| Session resume across SDK version bumps fails | Low | Medium | M0 stays pinned; no session-format migration burden. |
| In-process MCP server leaks between runs (process-level resource) | Low | Medium | `ClaudeAgentSdkEngine.run()` constructs a fresh MCP server per call; `query.close()` on completion or abort. |

## Verification steps

Run after each phase completes:

- Phase 0: `npx tsc --noEmit` passes
- Phase 1: deps install cleanly; `ls node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` exists
- Phase 2: `npm test -- src/tools/` green; all 8 tools individually invokable via a small scripted test harness
- Phase 3: `npm test -- src/permissions/` green; matrix table passes
- Phase 4: mock-SDK integration test for a trivial "say hi" prompt passes
- Phase 5: `resolveLatest()` against a fresh `~/.claude/projects/` returns the last-written session
- Phase 6: `detectAuth()` returns the right state on a machine with ANTHROPIC_API_KEY set
- Phase 7: `npx swarm-harness doctor` runs, prints 4 checks. `npx swarm-harness init` in `/tmp/test` scaffolds correctly
- Phase 8: `npx swarm-harness --headless prompt "hi" | head -1` is valid JSON
- Phase 9: `npm test` green, all 13 acceptance criteria checked off

**End-to-end smoke test:** after all phases, run each of the 13 acceptance criteria manually against a live Anthropic API key. Script as `scripts/smoke.sh` to re-run on every green CI build.

## Dependencies on prior work

- Interface drafts already present: `src/{core,engine,auth,providers,swarm,plugins,skills}/*.ts` (typechecks clean)
- Design docs: `docs/00-vision.md` through `docs/07-implementation-plan.md` (all current as of 2026-04-20)
- Research notes: `docs/research/01-api.md` through `06-cli.md`

## Estimated effort

Phases 0–9 total ~10–12 engineer-days for one person working full-time, assuming no major SDK surprises. Splits:

| Phase | Effort |
|---|---|
| 0 Interface refinements | 0.25 d |
| 1 Dependencies | 0.25 d |
| 2 Tool infrastructure | 2 d |
| 3 Permission engine | 0.5 d |
| 4 Engine + translator | 3 d |
| 5 Session store | 0.5 d |
| 6 Auth status | 0.5 d |
| 7 CLI | 2 d |
| 8 UI | 1 d |
| 9 Tests | 1 d (ongoing throughout) |
| Buffer for SDK surprises | 1 d |

## Open items to revisit during implementation

These are micro-decisions better made with code in hand than planned up-front:

- Exact argv parser: hand-rolled (~150 LOC) vs `commander` — decide in Phase 7 based on flag complexity
- Exact test runner: `vitest` vs `node:test` — decide in Phase 1 based on mocking ergonomics
- Zod version: `^3` vs `^4` — match the SDK's peerDep (currently `^4`)
- Ink-markdown fallback if unmaintained: `marked-terminal` as alternate

## Next plan after M0

`docs/07-implementation-plan.md` M1 (minimum viable swarm): subprocess worker pool + task fanout + lane events. Starts after M0 exit criteria green. That plan gets its own `.omc/plans/m1-*.md` file.
