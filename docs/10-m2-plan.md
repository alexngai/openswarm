# M2 UI Depth + Productivity Tools — Implementation Plan

**Status:** draft (rev 2)
**Owner:** alex
**Created:** 2026-04-20
**Prereq:** M1 complete (tag `m1-complete` at `f7cc642`)
**Refines:** §"Milestone M2 — UI depth and productivity tools" in `docs/07-implementation-plan.md`

## Scope

M1 shipped the swarm. M2 makes the atomic agent feel like a real CLI — ink REPL with streaming markdown, slash commands, Tier 1 productivity tools, plugin/skill discovery that reads existing `~/.claude/` installations, MCP stdio client, lifecycle hooks, and a compaction observer. When M2 lands, `swarm-harness prompt` inside a terminal should feel competitive with Claude Code.

**In scope:**
- ink TUI rewrite: state-machine-driven REPL, streaming markdown renderer, tab-completion dropdown, emacs keybindings (Ctrl+A/E/K/U/W), spinner, slash-prefix detection
- 13 slash commands: `/help`, `/exit`, `/clear`, `/status`, `/cost`, `/model`, `/permissions`, `/resume`, `/doctor`, `/tasks`, `/approve`, `/deny`, `/stop`, plus `/compact`
- Tier 1 tools: `web_fetch`, `web_search` (via SDK built-in), `structured_output`, `skill`
- Compaction observer (+ post-compaction `glob` health probe)
- Hooks runtime (shell-command protocol per claude-code contract)
- `PluginSource.claude-code` — read-only discovery, dual exec model (subprocess OR in-process MCP) per manifest
- `SkillSource.claude-code` — tiered path walk; skills exposed via `skill` tool
- MCP stdio client with **first-class tool registration at startup** (per Q12 decision)
- `scripts/smoke-repl.sh` — ink REPL smoke + slash command spot-checks (live + offline split)

**Out of scope (explicit):**
- `notebook_edit` → M3
- Plugin install / enable / disable / update / uninstall → M4
- Prompt caching → M3
- Parallel tool execution → M3
- LSP, mid-session MCP tool registration → M5
- Custom mechanical compactor → M4 (bundled with NativeEngine)
- Windows emacs keybindings (POSIX-first; Windows best-effort)

## Decision context

Five decisions locked via user interview:

1. **Full M2 scope in one milestone** (not M2a/M2b split).
2. **REPL: full rewrite with state machine.** States: `idle`, `streaming`, `awaiting-permission`, `compact`, `shutdown`. Slash-command input mode as first-class. Separate transcript + input + status bar.
3. **Plugin exec: both modes per manifest.** Shell-command plugins spawn subprocess with claw env contract (`CLAWD_PLUGIN_ID`, `CLAWD_TOOL_INPUT`); Node-exports plugins wrap into in-process MCP server.
4. **Compaction: observer + `/compact` slash command.** SDK compacts internally; we emit `compaction` lane event on boundary messages, run post-compaction `glob` probe, and expose `/compact` as a user-facing way to hint the engine to compact sooner (via a structured instruction turn).
5. **web_search: SDK built-in.** Enable Anthropic's first-party web_search via SDK tool allowlist. Zero new code; works out of the box with Claude Max. Multi-provider web_search is a M4 NativeEngine concern.

**Resolving the MCP contradiction:** `docs/07-implementation-plan.md` M2 line says "dispatch via generic `mcp` tool; first-class deferred to M5." `docs/06-open-questions.md` Q12 (resolved 2026-04-20) says "first-class at startup in M2; dynamic in M5." **Q12 wins** (later decision, explicit user call). M2 ships first-class MCP tools: each discovered MCP tool registers as `mcp__<server>__<tool>` in the dispatcher at startup. Generic dispatcher never materializes — doc 07's M2 wording becomes stale.

## Acceptance criteria

Each is executable with a one-line test harness or manual smoke step.

1. `swarm-harness prompt "..."` on a TTY enters interactive ink REPL; turn completes; prompt returns to idle; user can type next turn. State transitions visible in a status bar.
2. Tab-completion dropdown appears when the line starts with `/` and the cursor is at end; cycling through candidates works via ↑/↓ (and Tab).
3. Emacs keybindings in the input line: Ctrl+A (BOL), Ctrl+E (EOL), Ctrl+K (kill to EOL), Ctrl+U (kill to BOL), Ctrl+W (kill prev word).
4. Streaming markdown renders correctly when assistant text contains fenced code blocks, lists, bold/italic, links.
5. Spinner appears during `streaming` state; disappears at `message_stop`.
6. All 14 slash commands dispatch (13 from plan + `/compact`); each either completes inline or emits a visible side effect; none crash the REPL.
7. `/compact` sends a structured hint message; `SDKCompactBoundaryMessage` observed; `compaction` lane event emitted with `trigger` and `compact_metadata` fields; `glob_search` health probe runs and confirms tool transport alive.
8. `web_fetch` tool: given a URL, returns plain-text or Markdown content, capped at a sensible size.
9. `web_search`: works live against Anthropic's SDK-bundled tool; returns ranked results.
10. `structured_output`: model produces a parseable JSON object matching a Zod-compatible schema supplied by the caller.
11. `skill` tool: invoking by name returns the skill's body text (model reads and follows instructions).
12. `PluginSource.claude-code.discover()` returns manifest list sourced from `~/.claude/plugins/`; `load(id)` returns a `LoadedPlugin` whose `executeTool()` works for both shell and node-exports plugin types on a fixture each.
13. `SkillSource.claude-code.discover()` walks `CODEX_HOME` → `CLAUDE_CONFIG_DIR` → cwd-ancestor `.claude` / `.codex` / `.claw` / `.omc` paths, de-duplicating by skill id; returns union.
14. MCP stdio client connects to a local mock MCP server on startup; each of the server's tools is registered in our dispatcher as `mcp__<server>__<tool>` and callable by the model.
15. Hooks: with `.swarm-harness/hooks.json` declaring a `PreToolUse` command, running a tool invokes the command, honors exit codes (0 allow, 2 deny, other fail), merges `updatedInput` / `systemMessage` / `permissionDecision` from stdout JSON.
16. `npx tsc --noEmit` passes strict mode.
17. `npm test` runs ≥ 60 new M2 tests (in addition to M1's 340), all passing.
18. Real-subprocess integration tests cover: REPL lifecycle (happy path), slash-command dispatch, plugin-subprocess execution, MCP tool registration, hook exit-code branches.
19. `scripts/smoke-repl.sh --offline` runs REPL against ScriptedTestEngine and verifies slash commands work.
20. `scripts/smoke-repl.sh` (live) exercises all 14 slash commands + at least one Tier 1 tool + one hook invocation against Claude Max; all pass.
21. Hook `PreToolUse` fires for a Tier 2 `agent` tool invocation (verified via hook fixture that logs all events; `agent` invocation appears in the log).
22. Tool name collision (Tier 1 + plugin registering the same bare name) resolves to Tier 1; `degraded_registration` lane event is emitted identifying the skipped plugin entry.
23. `/cost` shows cumulative token counts (input, output, cache_read, cache_write, est_cost_usd); counts survive across turns within the same session; reset to zero on `/clear`.
24. Config path hierarchy resolves `.swarm-harness/hooks.json` before `~/.claude/settings.json`; `config_resolved` lane event captures the winning path at startup.

## Implementation phases

### Phase 0 — Interface refinements (~0.5 day)

0.1. `src/plugins/index.ts` — extend `PluginManifest` with `readonly execMode: "shell" | "in-process"` to drive the dual-exec dispatch. Optional `readonly entryModule?: string` for in-process variant (path to a Node module that exports `{ tools: ToolImpl[] }`).

0.2. `src/skills/index.ts` — extend `LoadedSkill.body` JSDoc to clarify it's raw Markdown body (post-frontmatter). No shape change.

0.3. `src/tools/types.ts` — no change expected; Tier 1 tools use the existing ToolImpl shape.

0.4. `src/hooks/index.ts` (new interface file) — define `HookEvent` union (`PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`), `HookConfig` shape (matcher + command), `HookResult` shape (allow/deny + optional payload). Pure interface; implementation lands in Phase 9.

0.5. `src/ui/repl/state.ts` (new) — REPL state machine types: `ReplState` enum, `ReplAction` union, reducer signature. Pure types; implementation in Phase 2.

### Config discovery

All config files (`.swarm-harness/hooks.json`, `.swarm-harness/mcp.json`, plugin directories, etc.) are resolved using a consistent hierarchy. First-match-wins:

1. `$SWARM_HARNESS_CONFIG_DIR/<file>` (env override)
2. `<cwd>/.swarm-harness/<file>`
3. `<cwd>/.claude/<file>` (fallback for existing Claude Code installs)
4. `$HOME/.claude/<file>`

The resolved path is logged at startup via a `config_resolved` lane event (includes which tier matched). This applies to hooks, MCP server configs, and plugin discovery roots.

### Phase 1 — Dependencies (~0.25 day)

1.1. `npm install @modelcontextprotocol/sdk` — for the MCP stdio client (Phase 8).

1.2. Evaluate terminal-ready tab-complete / input libraries: `ink-text-input` (existing stdlib-ish) plus custom dropdown component. Keep the list minimal — prefer building dropdown + emacs bindings ourselves to reduce deps.

1.3. No new dev deps.

### Phase 2 — ink REPL rewrite (state machine) (~3 days)

2.1. `src/ui/repl/state.ts` — finalize state machine. States + allowed transitions. Reducer takes `(state, action) → nextState`.

Explicit transition table:

```
idle          --(submit)----------------> streaming
streaming     --(message_stop)----------> idle
streaming     --(permission_request)----> awaiting-permission
awaiting-permission --(approve|deny)----> streaming
streaming     --(compact_boundary)------> compact
compact       --(compact_end)-----------> streaming
any           --(/exit or SIGINT)-------> shutdown
```

Slash command validity per state:
- `idle`: all commands valid.
- `streaming`: only `/stop`, `/approve`, `/deny`.
- `awaiting-permission`: only `/approve`, `/deny`, `/stop`.
- `compact`: no commands accepted (dispatcher rejects with a status-bar message).
- `shutdown`: terminal state; all commands ignored.

2.2. `src/ui/repl/input.tsx` — `<Input>` component:
- Renders a single prompt line, cursor-aware
- Emacs keybindings: Ctrl+A, Ctrl+E, Ctrl+K, Ctrl+U, Ctrl+W, plus Left/Right/Home/End
- Line-history navigation via ↑/↓ when line is empty or below history frontier
- Slash-completion dropdown (see 2.3) when the line starts with `/`
- Emits `submit(text)` on Enter

2.3. `src/ui/repl/dropdown.tsx` — tab-completion dropdown:
- Renders a short list of candidates below the input
- Filtered by current `/` prefix
- Selected candidate reverse-highlighted; Tab / Enter completes; Esc dismisses
- Candidates sourced from a static `SlashCommand[]` registry (populated in Phase 3)

2.4. `src/ui/repl/transcript.tsx` — transcript view:
- Scrollable (via ink's `useInput` + chunked render) log of past turns
- Each turn: user prompt line + streaming assistant text + collapsed tool_use lines
- Streaming markdown rendered via `ink-markdown` (same as M0)

2.5. `src/ui/repl/status.tsx` — bottom status bar:
- Current state (`idle` / `streaming` / `compact` / `awaiting-permission`)
- Permission mode
- Model name
- Session id (short)
- Cost accumulator (tokens + usage) if available

2.6. `src/ui/repl/spinner.tsx` — simple `⠋⠙⠸⠴⠦⠇` spinner that advances in `streaming` state.

2.7. `src/ui/repl/app.tsx` — root `<Repl>` component. Wires state machine + input + transcript + status + dropdown + spinner. Replaces `src/ui/ink/index.tsx`'s minimal shell. Old file deleted or marked deprecated (keep `src/ui/headless.ts` unchanged for non-TTY path).

2.8. Tests (`src/ui/repl/state.test.ts`) — pure reducer tests, ≥ 8 cases covering every allowed transition.

### Phase 2.5 — Engine surgery for M2 (~0.5 day)

Engine-level changes needed to unlock WebSearch, hook events, and config-driven tool lists. All edits are in `src/engine/claude-agent-sdk.ts`.

2.5.1. **Config-driven tool list** (line ~204): Change `tools: []` to a config-driven list. When `web_search` is allowlisted via `RunConfig.enabledBuiltinTools`, pass `tools: ['WebSearch']` to the SDK `query()` call (SDK capitalisation — verify exact string against `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` at implementation time). Default remains empty (no built-in tools) unless explicitly enabled.

2.5.2. **Enable hook events** (line ~216): Change `includeHookEvents: false` to `includeHookEvents: true` so hook-event messages propagate through the SDK stream and reach our translator.

2.5.3. **Hook-event translator branch**: Verify `translateSdkMessage` has a `hook_event` branch; if not, add one that emits a `hook_event` lane event.

2.5.4. **Permission gating for built-in tools**: Built-in tools (e.g., `WebSearch`) are gated at engine-config time via SDK's `allowedTools` / `disallowedTools` options, not via our `canUseTool` per-call path. Document this: Tier 1 `web_search` permission check happens when assembling `RunConfig`, not mid-turn. Update Phase 4.2 to reflect this.

2.5.5. Tests: one unit test asserting `tools: ['WebSearch']` appears in the SDK call when `RunConfig.enabledBuiltinTools` includes `web_search`; one asserting `includeHookEvents: true` is set unconditionally.

### Phase 3 — Slash command system (~1.5 days)

3.1. `src/cli/slash/index.ts` — slash command registry:

```ts
export interface SlashCommand {
  readonly name: string;          // e.g. "/help"
  readonly description: string;
  readonly handler: SlashHandler; // (ctx, args) => Promise<SlashResult>
}

export type SlashHandler = (
  ctx: SlashContext,
  args: string,
) => Promise<SlashResult>;

export interface SlashContext {
  readonly sessionId: string;
  readonly permissionMode: PermissionMode;
  readonly transcript: readonly TranscriptEntry[];
  readonly engineEvent: (event: EngineHint) => Promise<void>;
  // ... access to task registry (for /tasks), session store (for /resume), doctor, etc.
}

export type SlashResult =
  | { kind: "message"; text: string }
  | { kind: "state-change"; patch: Partial<ReplStatePatch> }
  | { kind: "exit"; code: number }
  | { kind: "engine-hint"; prompt: string }  // for /compact
  | { kind: "error"; message: string };
```

3.2. `src/cli/slash/commands/*.ts` — one file per command. Pattern: each exports a `SlashCommand`.
- `help.ts`: lists all registered commands with descriptions
- `exit.ts`: returns `{ kind: "exit", code: 0 }`
- `clear.ts`: emits `state-change` to clear transcript
- `status.ts`: formats and returns sessionId, mode, model, cost from ctx
- `cost.ts`: returns cumulative usage
- `model.ts`: with args → change model; no args → print current
- `permissions.ts`: with args → change permission mode; no args → print current
- `resume.ts`: `/resume <sessionId>` during `idle` state resets the engine's session pointer to `<sessionId>` via `RunConfig.resumeFrom`, emits a status-bar notice, and the next user turn runs against the resumed session. `/resume` with no arg lists the last 10 session ids from the per-worktree session log. Forbidden outside `idle` state (dispatcher rejects with a message).
- `doctor.ts`: inline health check (reuses `runDoctor()` logic)
- `tasks.ts`: calls `host.task.list()`, formats table
- `approve.ts`/`deny.ts`: respond to pending permission prompt (only valid in `awaiting-permission` state)
- `stop.ts`: sends abort signal mid-streaming
- `compact.ts`: returns `engine-hint` with prompt `"Please compact the conversation history now — summarize prior turns to conserve context."`

3.3. `src/cli/slash/dispatcher.ts` — parse `/name [args]`, look up in registry, call handler, return result. Unknown command → `{ kind: "error", message: "unknown slash command: /name" }`.

3.4. `src/ui/repl/app.tsx` wires the dispatcher — when input submits and starts with `/`, route to dispatcher first; otherwise treat as prompt.

3.5. Tests (`src/cli/slash/dispatcher.test.ts` + per-command) — ≥ 14 tests (one per command plus dispatcher basics).

### Phase 4 — Tier 1 tools (~2 days)

4.1. `src/tools/tier1/web_fetch.ts` — fetch a URL via `fetch`, run it through a Markdown converter (`turndown` or lightweight HTML → MD). Zod schema `{ url: string, maxBytes?: number (default 256 KiB) }`. Required permission `"network"`. Size-cap enforced.

4.2. `src/tools/tier1/web_search.ts` — **placeholder ToolImpl for registry symmetry**. Actual execution is handled by the SDK's built-in `WebSearch` tool, enabled via the engine config change in Phase 2.5 (`RunConfig.enabledBuiltinTools`). Permission gating happens at engine-config time (not per-call via `canUseTool` — see Phase 2.5.4). Our `ToolImpl` is declared so `buildTier1Tools()` returns a complete list for discovery/UI; its `execute` body is never reached for live search calls.

**Alternative considered:** omit `web_search` from Tier 1 entirely. Rejected: placeholder keeps the registry complete and makes the tool visible in `/help`.

4.3. `src/tools/tier1/structured_output.ts` — model-level tool that forces JSON output. Implementation: wraps caller-provided Zod schema, converts to JSON Schema, passes to model via `outputFormat: { type: "json_schema", schema }` on the SDK's `Options`. Zod schema `{ schema: ZodTypeAny — provided via context }`. Actually — structured_output is weird; the model doesn't "call" it. Ship as a ctx-option on the engine run. **Revise:** not a ToolImpl; expose as `RunConfig.structuredOutput?: { schema }` instead. Defer to Phase 4 implementation review.

4.4. `src/tools/tier1/skill.ts` — the skill invocation tool. Zod `{ id: string }`. Execute: `skillRegistry.load(id)` → return `{ status: "ok", output: skill.body }`. Model reads the body and applies the skill's instructions.

4.5. `src/tools/tier1/index.ts` — `buildTier1Tools(skillRegistry?: SkillRegistry): ToolImpl[]`.

4.6. Tests per tool + factory (≥ 12 tests total).

### Phase 5 — Compaction observer + /compact + cost tracking (~1 day)

5.1. `src/engine/claude-agent-sdk.ts` — modify `translateSdkMessage` or add a branch: when an `SDKCompactBoundaryMessage` arrives, emit a lane event `{ type: "compaction", payload: { trigger: "auto" | "manual", compact_metadata: {...} } }`. Field names match the SDK's `SDKCompactBoundaryMessage` shape — verify against `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` at implementation time. Also run a health probe: call `dispatcher.dispatch("glob", { pattern: "*" }, ctx)` and assert `status === "ok"` — if it fails, emit `worker_stuck`-equivalent error event.

5.2. `src/cli/slash/commands/compact.ts` (already in Phase 3) — returns `{ kind: "engine-hint", prompt }` that the REPL injects as the next user turn.

5.3. Cost tracking: `ClaudeAgentSdkEngine` accumulates token usage per run in an exposed `getCumulativeUsage(): Usage` getter returning `{ input_tokens, output_tokens, cache_read, cache_write, est_cost_usd }`. Resets on session clear. The `/cost` slash command calls this getter and formats the result into a status-bar message.

5.4. Tests: scripted SDK emission of compact boundary → lane event emitted with `trigger`/`compact_metadata` fields → glob probe invoked; `/cost` returns non-zero counts after a turn; `/clear` resets counts to zero.

### Phase 6 — Plugin discovery (~2 days)

6.1. `src/plugins/claude-code-source.ts` — `ClaudeCodeSource implements PluginSource`.
- `discover()`: scans `~/.claude/plugins/` for `<plugin>/plugin.json`. Parses each manifest. Returns `PluginManifest[]`.
- `load(id)`: reads the plugin's full entry, returns `LoadedPlugin` with correct `executeTool` wiring per `execMode`:
  - `"shell"`: spawn `plugin.command` with JSON-stdin, env `CLAWD_PLUGIN_ID`, `CLAWD_TOOL_NAME`, `CLAWD_TOOL_INPUT`, `CLAWD_CWD`. Capture stdout as tool output.
  - `"in-process"`: **TRUST BOUNDARY** — in-process plugins run with full host process privileges (same UID, same file-system access, same env). This is intentional for M2 but must be documented prominently in JSDoc. Requirements: (a) validate `entryModule` path stays within the plugin's own directory (no `..` traversal); (b) wrap `import()` in try/catch — on throw, emit a `degraded_plugin` lane event and skip the plugin (fail-soft, do not crash the host); (c) call the module's exported `buildTools()` function; invoke the matching tool's `execute` in-process. Full isolation (Worker threads or VM contexts) deferred to M4.

6.2. `src/plugins/registry.ts` — `PluginRegistry` tracks registered sources and exposes a flat dispatcher. Called by the runtime at startup.

6.3. `src/cli/main.ts` — `runPrompt` calls the plugin registry at startup to discover; loaded plugins' tools are registered into the `ToolDispatcher`. Plugin tools appear to the model alongside Tier 0/1/2.

6.4. Fixtures + tests under `test/fixtures/plugins/`:
- `shell-plugin/plugin.json` + `shell-plugin/run.sh` (echoes stdin) — tests the subprocess path
- `node-plugin/plugin.json` + `node-plugin/index.mjs` (exports `buildTools()`) — tests in-process path
- `src/plugins/claude-code-source.test.ts` covers both

### Phase 7 — Skill discovery + skill tool (~1.5 days)

7.1. `src/skills/claude-code-source.ts` — `ClaudeCodeSource implements SkillSource`.
- `discover()`: walks tiered paths in priority order:
  1. `$CODEX_HOME/skills`
  2. `$CLAUDE_CONFIG_DIR/skills`
  3. For each cwd ancestor: `<dir>/.claude/skills`, `<dir>/.codex/skills`, `<dir>/.claw/skills`, `<dir>/.omc/skills`
  7. `$HOME/.claude/skills` (etc. for other roots)
- Each discovered entry: `<root>/<skill-id>/SKILL.md`. Legacy flat: `<root>/<skill-id>.md`.
- Parse YAML frontmatter into `SkillManifest.frontmatter`; extract `description`, `triggers`.
- De-dup by skill id; first-wins per priority order.

7.2. `src/skills/registry.ts` — `SkillRegistry`: register sources, `discover()` unions, `load(id)` first-match-wins.

7.3. `src/cli/main.ts` — instantiate `SkillRegistry` at startup, pass to `buildTier1Tools(skillRegistry)` so `skill` tool dispatch resolves ids.

7.4. Fixtures + tests under `test/fixtures/skills/` covering single-skill, multi-source dedup, legacy-flat layout.

### Phase 8 — MCP stdio client + first-class tools (~2 days)

8.1. `src/mcp/client.ts` — `McpStdioClient` using `@modelcontextprotocol/sdk` package.
- `connect(config: McpServerConfig)`: spawn the MCP server subprocess per its stdio config, perform MCP handshake (`initialize`).
- `listTools()`: returns `McpToolDescriptor[]`.
- `listResources()`, `readResource(uri)`: for future use (plan says read-only M2 includes resources).
- `callTool(name, args)`: invokes a tool via JSON-RPC.
- `close()`: graceful shutdown.

8.2. `src/mcp/bridge.ts` — converts each `McpToolDescriptor` into a first-class `ToolImpl` in our dispatcher. Name: `mcp__<serverName>__<toolName>`. Input schema: translated from MCP's JSON Schema into our `ToolSpec.inputSchema`. Execute: calls `client.callTool(name, args)`, maps result to `ToolResult`.

8.3. `src/cli/main.ts` — at startup, read MCP server configs from `.swarm-harness/mcp.json` (or `~/.claude/mcp_servers.json` if the Claude Code format is already there). Parallel-connect each server with per-server 10s timeout. On fail-soft: log degraded-startup lane event, skip that server's tools, continue. On success: register all tools first-class.

MCP tool permission gating policy (M2 default):
- MCP tools flow through the existing `canUseTool` path (they are registered in our dispatcher with `mcp__<server>__<tool>` names).
- Permission mode `workspace-write`: all MCP tools allowed by default.
- Permission mode `read-only`: MCP tool calls allowed if the tool's declared name matches a read-only pattern (`list_*`, `get_*`, `read_*`, `search_*`); otherwise prompts for user approval.
- Richer per-tool policy (explicit allowlists, scoped permissions) deferred to M5.

8.4. Fixtures + tests:
- `test/fixtures/mcp-mock-server/` — a tiny MCP server in Node exposing 2 toy tools
- `src/mcp/bridge.test.ts` — spawn mock, discover, register, invoke
- Failure modes: server-crash, tool-call-error, malformed-response

### Tool name collision policy

Tools can be registered from multiple sources: Tier 0, Tier 1, Tier 2, MCP (`mcp__<server>__<tool>`), plugins (`plugin__<id>__<tool>`), and skills (via `skill` tool). Priority order for resolving bare-name collisions:

1. Tier 0 (built-in agent/task tools)
2. Tier 1 (web_fetch, web_search, structured_output, skill)
3. Tier 2 (agent orchestration tools)
4. MCP (prefixed `mcp__<server>__<tool>`)
5. Plugin (prefixed `plugin__<id>__<tool>`)
6. Skills (surfaced via the `skill` tool)

The `mcp__*` and `plugin__*` prefixes make true collisions rare. If an unprefixed name collision is detected at registration time, emit a `degraded_registration` lane event identifying the skipped duplicate and its source, then skip the lower-priority entry.

Unit test: construct two sources registering the same bare tool name; assert the higher-priority source wins and `degraded_registration` is emitted for the skipped lower-priority entry.

### Phase 9 — Hooks runtime (~3 days)

9.1. `src/hooks/types.ts` — finalize `HookEvent`, `HookConfig`, `HookResult` per Phase 0.4.

9.2. `src/hooks/config.ts` — load hook config from `.swarm-harness/hooks.json` (with fallback to `~/.claude/settings.json`'s `hooks` field so existing Claude Code hook configs light up free). Validate via Zod.

9.3. `src/hooks/runtime.ts` — `HookRuntime`:
- `invoke(event: HookEvent, payload: unknown): Promise<HookResult>`
- For each hook config entry matching the event, wrap the shell command in a **JS callback** that:
  1. `child_process.spawn`s the configured command with JSON-serialised payload on stdin.
  2. Reads stdout to completion; parses as JSON (optional — empty stdout is valid).
  3. Reads exit code: 0 → allow; 2 → deny; other → fail (throw).
  4. Returns `HookResult` with `{ decision, updatedInput?, systemMessage?, permissionDecision? }` merged from stdout JSON.
- The JS callback is an `async` function conforming to the shape the SDK's `hooks` field expects.
- **Tier 2 coverage:** our `ToolDispatcher` calls `HookRuntime.invoke("PreToolUse", ...)` before executing **any** tool — including Tier 2 `agent` and task tools — regardless of whether the tool goes through the SDK's built-in path. This ensures hooks fire uniformly across all tiers.

9.4. Wire hooks into the engine:
- `ClaudeAgentSdkEngine.run()` produces JS async callbacks (via `HookRuntime.buildSdkCallbacks()`) and passes them to `query()` options via `hooks: { PreToolUse: [{ matcher, hooks: [asyncCallback] }] }`.
- The SDK's `hooks` field accepts **JavaScript callback functions**, not shell-command config objects. Shell-command configs live in `.swarm-harness/hooks.json` (preserved for user authoring / Claude Code format compatibility); our runtime wraps them in JS callbacks before handing off to the SDK.
- Exit-code translation (0/2/other) happens inside our JS wrapper, not in the SDK.

9.5. `.swarm-harness/hooks.json` example:
```json
{
  "PreToolUse": [
    { "matcher": "bash", "command": "./hooks/log-bash.sh" }
  ]
}
```

9.6. Tests: fixture hooks (shell scripts) + runtime invocation + exit-code branching + stdout JSON merge.

### Phase 10 — Tests + smoke (~2 days)

10.1. Integration tests (`test/integration/repl.test.ts`): spawn the CLI with `--headless` and pipe a sequence of inputs + slash commands; assert JSONL events match expectations. Use same real-subprocess harness as M1 Phase 7.

10.2. `scripts/smoke-repl.sh` — mirrors `smoke.sh` / `smoke-swarm.sh` format:
- **Offline scenarios** (ScriptedTestEngine): REPL lifecycle, every slash command dispatches, hooks fixture invoked, plugin fixture loaded
- **Live scenarios**: start ink REPL via a PTY driver (or the headless path with realistic prompt sequence), exercise `/model sonnet` + `/status` + a real prompt, verify state transitions observable in output

10.3. Update `scripts/smoke.sh` to invoke all four smoke scripts (`smoke.sh`, `smoke-swarm.sh`, `smoke-repl.sh`) via a `--all` flag.

## File layout after M2

```
src/
  ui/
    repl/                   # NEW (replaces minimal ink/index.tsx as the TTY path)
      state.ts
      state.test.ts
      app.tsx
      input.tsx
      dropdown.tsx
      transcript.tsx
      status.tsx
      spinner.tsx
    headless.ts             # unchanged (non-TTY JSONL)
    ink/                    # DEPRECATED (delete or keep as stub referencing repl/)
  cli/
    slash/
      index.ts              # NEW — SlashCommand types + registry
      dispatcher.ts
      dispatcher.test.ts
      commands/
        help.ts
        exit.ts
        clear.ts
        status.ts
        cost.ts
        model.ts
        permissions.ts
        resume.ts
        doctor.ts
        tasks.ts
        approve.ts
        deny.ts
        stop.ts
        compact.ts
        *.test.ts
  tools/
    tier1/                  # NEW
      web_fetch.ts
      web_search.ts
      structured_output.ts  # (maybe relocated to engine config; see §4.3)
      skill.ts
      index.ts
      *.test.ts
  plugins/
    claude-code-source.ts   # NEW
    claude-code-source.test.ts
    registry.ts             # NEW
  skills/
    claude-code-source.ts   # NEW
    claude-code-source.test.ts
    registry.ts             # NEW
  mcp/
    client.ts               # NEW
    bridge.ts               # NEW
    bridge.test.ts
  hooks/
    index.ts                # types (added in Phase 0)
    config.ts               # NEW
    runtime.ts              # NEW
    runtime.test.ts
  engine/
    claude-agent-sdk.ts     # MODIFIED — compaction observer + hooks wiring
test/
  fixtures/
    plugins/
      shell-plugin/
      node-plugin/
    skills/
    mcp-mock-server/
    hooks/
  integration/
    repl.test.ts            # NEW
scripts/
  smoke-repl.sh             # NEW
```

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ink REPL rewrite is larger than 3d | Medium | High | Time-box: if state-machine spine isn't working by day 2, drop tab-completion dropdown from M2 scope (ship plain input instead). Dropdown slips to M2.1. |
| Slash commands race with streaming state | High | Medium | State machine's `streaming` state rejects most slash commands (except `/stop`, `/approve`, `/deny`). Dispatcher checks `ctx.state` first; non-safe commands return an error message instead of executing. |
| Plugin discovery hits permission-sensitive directories | Medium | Medium | `fs.readdir` with error-silent fallback; never throw on unreadable dirs; emit a `degraded_discovery` lane event. |
| MCP server hangs on startup | Medium | High | Per-server 10s connect timeout; fail-soft (skip server's tools, continue); log `degraded_startup` lane event. |
| Hook config leaks arbitrary shell command execution | **High** | **High** | Hook configs live ONLY in `.swarm-harness/hooks.json` or `~/.claude/settings.json` — user-controlled trust boundary. We don't download or auto-merge hook configs. Document explicitly: "hooks run with your shell permissions; only enable configs you trust." Future: signed hook manifests (M5). |
| Subprocess-plugin exec is slow (50–200ms startup per call) | Medium | Medium | Document the cost in `src/plugins/claude-code-source.ts` JSDoc. Users choose `execMode: "in-process"` in their own plugins to skip subprocess overhead. |
| SDK built-in `web_search` returns unpredictable shapes across minor SDK versions | Medium | Low | Pin SDK to `~0.2.116` (already pinned from M0). Integration test checks web_search smoke returns non-empty results live. |
| Compaction observer misses SDK event shape changes | Medium | Medium | Integration test: scripted SDK emits compact boundary message → assert lane event emitted. If SDK changes shape, test breaks and we update the translator. |
| Emacs keybindings conflict with ink's default input handling | Medium | Medium | Build on top of ink's `useInput` hook directly; bypass `ink-text-input` to avoid bindings conflict. Unit-test every binding. |
| Tier 1 `structured_output` doesn't fit the ToolImpl shape | High | Low | Relocate to `RunConfig.structuredOutput` — not a tool. Update plan to reflect (Phase 4.3 already flags this). |
| Skill discovery walks unbounded directory tree | Medium | Medium | Cap ancestor walk at 10 levels up (realistic for any monorepo); cap per-directory file scan at 500 entries; warn on cap hit. |
| Resume mid-REPL (via /resume) conflicts with live turn | Medium | Medium | `/resume` is only allowed in `idle` state; dispatcher rejects otherwise. Resume replaces the current session id and triggers a full transcript reload. |

## Verification steps

Run after each phase:

- **Phase 0:** `npx tsc --noEmit` clean
- **Phase 1:** `ls node_modules/@modelcontextprotocol/sdk` exists
- **Phase 2:** `npx vitest run src/ui/repl/` green (pure reducer tests); `npx swarm-harness prompt "hi"` in a real terminal shows the new REPL
- **Phase 3:** every slash command's test passes; manually entering `/help` in the REPL shows the full list
- **Phase 4:** Tier 1 tool tests green; `npx swarm-harness prompt "fetch https://example.com"` actually fetches live
- **Phase 5:** `/compact` emits an observable compaction event in the JSONL stream
- **Phase 6:** `npx swarm-harness doctor` + plugin fixture present → plugin tool appears in `/help`-style listing; invoking the model with "use shell-plugin's tool" actually calls it
- **Phase 7:** `SkillSource.claude-code.discover()` returns real skills from user's `~/.claude/skills`; `skill` tool loads them
- **Phase 8:** mock MCP server fixture exposes a tool; that tool shows up in `/help`-style output and is invokable
- **Phase 9:** hook fixture fires on a real tool call; exit code 2 denies the call visibly
- **Phase 10:** `npm test` ≥ 400 tests passing; `scripts/smoke-repl.sh` passes live + offline

**End-of-M2 gate:** all 24 acceptance criteria verified, tagged `m2-complete`.

## Estimated effort

| Phase | Effort |
|---|---|
| 0 Interface refinements | 0.5 d |
| 1 Dependencies | 0.25 d |
| 2 ink REPL rewrite | 3 d |
| 2.5 Engine surgery (WebSearch + hook events + tools config) | 0.5 d |
| 3 Slash command system (14 commands) | 1.5 d |
| 4 Tier 1 tools | 2 d |
| 5 Compaction observer + /compact + cost tracking | 1 d |
| 6 Plugin discovery (dual exec) | 2 d |
| 7 Skill discovery + skill tool | 1.5 d |
| 8 MCP stdio client + first-class tools | 2 d |
| 9 Hooks runtime (JS-callback wrapper) | 3 d |
| 10 Tests + smoke | 2 d |
| Buffer | 1 d |

**Total: ~20.25 engineer-days.** Biggest M2-specific phases are the REPL rewrite (Phase 2) and the plugin/MCP/hooks triad (Phases 6, 8, 9). If any slips, drop order: tab-completion dropdown → MCP resources (keep tools only) → plugin in-process mode (subprocess-only ships first).

## Open items to revisit during implementation

- **`structured_output` location** — whether it stays as a Tier 1 ToolImpl or relocates to `RunConfig.structuredOutput`. Decide during Phase 4.
- **MCP resources vs tools** — M2 plan says "list + read resources." If time is tight, defer resources to M5 and ship tools-only.
- **Claude Code settings format compatibility** — we read `~/.claude/settings.json` for hooks. Does the format diverge between Claude Code versions? Snapshot a known version at M2 ship time and document.
- **Plugin manifest format** — claude-code plugins' `plugin.json` may have fields we don't support. Validate via Zod and warn on unknown fields; don't hard-fail.
- **Spinner interaction with streaming** — ink re-renders on every `text_delta`. Ensure the spinner doesn't double-animate or flicker. Use `useInterval` with `unref`.

## Cross-references

- Prereq scope: `docs/07-implementation-plan.md` §M2
- UI model: `docs/02-architecture.md` (ui/ink/ vs ui/headless/)
- Interface contracts: `src/plugins/index.ts`, `src/skills/index.ts`, `src/hooks/index.ts` (new)
- Prior milestones: `docs/08-m0-plan.md` (atomic agent), `docs/09-m1-plan.md` (swarm)
- Research: `docs/research/03-runtime.md` (compaction, hooks), `docs/research/04-integrations.md` (plugins, skills, MCP), `docs/research/06-cli.md` (REPL, slash commands, ink/rustyline gaps)

## Revision history

- **rev 1 (2026-04-20):** initial draft. Five scope/architecture decisions locked via user interview: full M2 scope, state-machine REPL rewrite, dual-mode plugin exec, observer-compaction + `/compact`, SDK built-in `web_search`. MCP contradiction between doc 07 and Q12 resolved in favor of Q12 (first-class MCP tools at startup).
- **rev 2 (2026-04-20):** applied critic REVISE feedback. 3 critical fixes: (C1) Phase 9 hook runtime rewritten as JS-callback wrapper around user's shell-command configs (SDK's `hooks` field takes JS callbacks, not shell configs); (C2) new Phase 2.5 engine surgery — change `tools: []` to config-driven list with `'WebSearch'` allowlisting + enable `includeHookEvents: true`; (C3) subsumed into C2 engine surgery. 9 major fixes: plugin in-process sandbox trust boundary, REPL transition graph, MCP permission gating policy, tool name collision policy, `/resume` mechanics, hooks cover Tier 2, compaction field-name fix (`trigger`/`compact_metadata`), config discovery hierarchy, cost tracking surface. Total effort bumped from 17.75d → 20.25d.
