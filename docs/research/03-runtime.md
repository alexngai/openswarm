# 03 — Runtime core (conversation, session, permissions, hooks, config, prompt, compact, usage)

Research extract from `references/claw-code/rust/crates/runtime/src/`. Scope: the conversation-and-session core. Skips MCP, LSP, plugins, bash, file_ops, remote, worker, task, team, cron.

## 1. Summary

claw-code's runtime is a synchronous, trait-driven agent loop. `ConversationRuntime<C, T>` is parameterized on an `ApiClient` (provider-facing streaming contract) and a `ToolExecutor` (tool dispatcher). The loop itself is provider-agnostic: it consumes a flat list of `AssistantEvent`s, materializes them into `ConversationMessage` blocks, walks tool uses, runs pre/post hooks, consults a `PermissionPolicy` (optionally with an interactive `PermissionPrompter`), and writes everything back to a persisted `Session` (JSONL).

Key architectural signals for swarm-coder:

- The runtime is **stateful and single-lane per Session** — there is no built-in concurrency inside `run_turn`. Parallelism is an outer-layer concern.
- Session persistence is per-worktree (`.claw/sessions/<fingerprint>/`), explicitly motivated by ROADMAP item 41 ("phantom completions" — parallel `serve` instances writing to the wrong cwd). This is load-bearing for swarm usage.
- Sessions append to JSONL incrementally, which is friendly to external tailing/resume.
- Permission model composes three orthogonal controls: mode-level (ReadOnly/WorkspaceWrite/DangerFullAccess/Prompt/Allow), per-tool required mode, and allow/deny/ask string rules with a `tool(subject:*)` grammar. Hook outputs can inject per-call overrides.
- Hooks are shell commands run with JSON on stdin. Exit 0 = allow (parse optional JSON for updated input / permission override / messages), exit 2 = deny, other non-zero = fail. PreToolUse, PostToolUse, PostToolUseFailure.
- Compaction is mechanical, not LLM-driven: it synthesizes a structured `<summary>` block from message counts, tool names, user requests, and heuristic "pending work"/"key files" extraction. Auto-triggers when cumulative input tokens cross a threshold (default 100k, env-overridable).
- System prompt is assembled from static scaffolding + a `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` marker + environment + project context (cwd, date, platform, git) + `CLAUDE.md` instruction files (ancestor-walk, deduped) + rendered merged runtime config.

## 2. Conversation loop

### ConversationRuntime shape
`crates/runtime/src/conversation.rs`.

```
ConversationRuntime<C: ApiClient, T: ToolExecutor> {
  session: Session,
  api_client: C,
  tool_executor: T,
  permission_policy: PermissionPolicy,
  system_prompt: Vec<String>,          // pre-rendered, passed to every request
  max_iterations: usize,
  usage_tracker: UsageTracker,
  hook_runner: HookRunner,
  auto_compaction_input_tokens_threshold: u32,
  hook_abort_signal: HookAbortSignal,
  hook_progress_reporter: Option<Box<dyn HookProgressReporter>>,
  session_tracer: Option<SessionTracer>,
}
```

Constructors: `new`, `new_with_features(&RuntimeFeatureConfig)`. Builder methods: `with_max_iterations`, `with_auto_compaction_input_tokens_threshold`, `with_hook_abort_signal`, `with_hook_progress_reporter`, `with_session_tracer`.

### ApiClient contract (provider seam)

```rust
pub trait ApiClient {
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError>;
}

pub struct ApiRequest {
    pub system_prompt: Vec<String>,
    pub messages: Vec<ConversationMessage>,
}

pub enum AssistantEvent {
    TextDelta(String),
    ToolUse { id: String, name: String, input: String },  // input is raw JSON as a String
    Usage(TokenUsage),
    PromptCache(PromptCacheEvent),
    MessageStop,
}
```

Notes: the Rust trait returns `Vec<AssistantEvent>` rather than an async stream. In TypeScript, the equivalent would be `AsyncIterable<StreamEvent>`, matching swarm-coder's `docs/03-interfaces.md`. `ToolUse.input` is carried as a JSON string, not a parsed value.

### Turn algorithm (`run_turn`)

1. **Health probe**: if `session.compaction.is_some()`, run a non-destructive `glob_search` with a never-matching pattern through the tool executor. If it errors, abort the turn with a "Session health probe failed after compaction" error. This protects against resuming into a broken tool transport after a compaction boundary.
2. Trace `turn_started`, push `user_input` as a user message, persist.
3. Loop, bounded by `max_iterations`:
   - Build `ApiRequest { system_prompt, messages }`, call `api_client.stream(...)`.
   - `build_assistant_message` folds events into a `ConversationMessage`: contiguous `TextDelta`s become a `ContentBlock::Text`, `ToolUse` becomes a `ContentBlock::ToolUse`, `Usage` is captured, `PromptCache` events accumulate, `MessageStop` is required (else error "assistant stream ended without a message stop event"). Empty block list also errors.
   - Record usage on the tracker, append the assistant message to the session (persists).
   - If there are no tool uses, break.
   - For each tool use in order:
     - Run pre-tool-use hook. Results: `Allow`, `Deny`, `Failed`, `Cancelled`. `Cancelled`/`Failed`/`Deny` short-circuit to a denied tool result (no execution).
     - Hook outputs can supply `permission_override: Allow|Deny|Ask`, `permission_reason`, `updated_input` (swap the tool JSON), and arbitrary messages (merged into the tool result as "Hook feedback").
     - Call `PermissionPolicy::authorize_with_context(tool_name, effective_input, context, prompter)`.
     - If allowed, invoke `tool_executor.execute`. Capture `(output, is_error)`.
     - Run post-tool-use hook (normal path) or post-tool-use-failure hook (on tool error). Deny/fail/cancel from post hooks marks the result as `is_error`.
     - Append tool result to session.
4. After loop: `maybe_auto_compact` — if cumulative input tokens ≥ threshold, compact with `max_estimated_tokens = 0` so `should_compact` fires; replace session.
5. Return `TurnSummary { assistant_messages, tool_results, prompt_cache_events, iterations, usage, auto_compaction }`.

### Tool execution

```rust
pub trait ToolExecutor {
    fn execute(&mut self, tool_name: &str, input: &str) -> Result<String, ToolError>;
}
```

Simple map-lookup dispatch. Tool inputs are opaque JSON strings; tool outputs are opaque strings. No typing. A helper `StaticToolExecutor` is provided for tests. All tool dispatch (bash, file_ops, MCP bridge, task primitives, etc.) is layered over this single trait.

### Message/block model

`crates/runtime/src/session.rs`.

```rust
pub enum MessageRole { System, User, Assistant, Tool }

pub enum ContentBlock {
    Text { text: String },
    ToolUse   { id: String, name: String, input: String },
    ToolResult { tool_use_id: String, tool_name: String, output: String, is_error: bool },
}

pub struct ConversationMessage {
    pub role: MessageRole,
    pub blocks: Vec<ContentBlock>,
    pub usage: Option<TokenUsage>,   // attached to the assistant turn
}
```

Convenience constructors: `user_text`, `assistant`, `assistant_with_usage`, `tool_result`. Tool results carry `tool_name` redundantly alongside `tool_use_id` — useful for reconstructing after compaction.

## 3. Session format & resume

### In-memory shape

```rust
pub struct Session {
  pub version: u32,                               // SESSION_VERSION = 1
  pub session_id: String,                         // "session-<ms>-<counter>"
  pub created_at_ms: u64,
  pub updated_at_ms: u64,
  pub messages: Vec<ConversationMessage>,
  pub compaction: Option<SessionCompaction>,      // { count, removed_message_count, summary }
  pub fork: Option<SessionFork>,                  // { parent_session_id, branch_name }
  pub workspace_root: Option<PathBuf>,            // binds session to its worktree
  pub prompt_history: Vec<SessionPromptEntry>,    // { timestamp_ms, text } — historical user prompts
  pub last_health_check_ms: Option<u64>,          // ROADMAP #38
  pub model: Option<String>,                      // persisted so resumed sessions remember the model
  persistence: Option<SessionPersistence>,        // carries append path
}
```

### JSONL file format

One record per line, each a JSON object with a `type` discriminator. First line is `session_meta`. Subsequent lines interleave `compaction`, `prompt_history`, and `message` records in append order.

Record schemas:
- `{"type":"session_meta","version":1,"session_id":"…","created_at_ms":…,"updated_at_ms":…,"fork":{…}?,"workspace_root":"…"?,"model":"…"?}`
- `{"type":"compaction","count":…,"removed_message_count":…,"summary":"…"}`
- `{"type":"prompt_history","timestamp_ms":…,"text":"…"}`
- `{"type":"message","message":{"role":"user|assistant|tool|system","blocks":[…],"usage":{…}?}}`

Unknown types error the load. Legacy single-object JSON files (top-level object containing `messages`) are still accepted for read.

### Persistence behavior

- `push_message` / `push_user_text` / `push_prompt_entry` append to the in-memory vector and, if `persistence_path` is set, append one JSONL line to the file. On empty/missing file, bootstraps by writing the full snapshot. Pop-on-error semantics for atomicity.
- `save_to_path` writes the full snapshot atomically (`.tmp-<ms>-<counter>` rename), rotates files larger than 256 KiB to `*.rot-<ms>.jsonl`, and caps rotated logs at 3.
- `fork(branch_name)` clones messages, compaction, workspace_root, prompt_history; mints a fresh `session_id`; blanks `persistence`. Blank branch names normalize to `None`.

### SessionStore (per-worktree isolation)

`crates/runtime/src/session_control.rs`. Two constructors:
- `SessionStore::from_cwd(cwd)` → `<cwd>/.claw/sessions/<workspace_fingerprint>/`
- `SessionStore::from_data_dir(data_dir, workspace_root)` → `<data_dir>/sessions/<fingerprint>/`

`workspace_fingerprint` is FNV-1a 64-bit → 16-char hex of `cwd.to_string_lossy()`. Deterministic; different cwds yield different fingerprints.

File extensions: primary `.jsonl`, legacy `.json`. Reference aliases for resume: `latest`, `last`, `recent` (case-insensitive) resolve to the newest session by `updated_at_ms` (then by file mtime, then id).

### Workspace validation

On load, `SessionStore` enforces that either:
- the session has no `workspace_root` but lives under the current workspace, OR
- its `workspace_root` canonicalizes equal to the store's workspace root.

Mismatches produce `SessionControlError::WorkspaceMismatch { expected, actual }`. This is the explicit defense against the "phantom completions" pattern — a serve instance writing to one worktree but reporting success in another.

### Fork

`SessionStore::fork_session` creates a new session that clones messages + compaction, inherits the workspace root, carries `fork.parent_session_id` and `fork.branch_name`, lands in the same namespace (same fingerprint), and is persisted via a freshly allocated path.

## 4. Permission model

### Modes (ordered, `PartialOrd`)

```
ReadOnly  <  WorkspaceWrite  <  DangerFullAccess  <  Prompt  <  Allow
```

(`Prompt` and `Allow` sort above DangerFullAccess purely by the derive; `Allow` is the trump-card "permit everything", `Prompt` signals "let the enforcer defer to an interactive prompt flow".)

### `PermissionPolicy`

Composed of:
- `active_mode: PermissionMode`
- `tool_requirements: BTreeMap<String, PermissionMode>` — per-tool *required* mode; default fallback is `DangerFullAccess` (i.e., unknown tools are treated as dangerous unless declared).
- `allow_rules`, `deny_rules`, `ask_rules: Vec<PermissionRule>` — parsed from raw strings.

### Rule grammar

`tool(subject)` or `tool(subject:*)` or bare `tool`. Parser is unescape-aware (handles `\(` / `\)` / `\\`). Matcher variants: `Any`, `Exact`, `Prefix` (trailing `:*`). Subject is extracted from the tool input JSON via a fixed key priority list:
```
command, path, file_path, filePath, notebook_path, notebookPath, url, pattern, code, message
```
If none match but input isn't blank, the raw input is used as the subject.

### Authorization algorithm (`authorize_with_context`)

Evaluated in this order:

1. **Deny rule hit** → deny.
2. **Hook override**:
   - `Deny` → deny (with hook reason).
   - `Ask` → prompt (or deny if no prompter).
   - `Allow` → still respects ask rules (prompts), else allow if an allow rule / Allow mode / mode≥required.
3. **Ask rule hit** → prompt.
4. **Allow rule hit**, or `active_mode == Allow`, or `active_mode >= required_mode` → allow.
5. If `active_mode == Prompt`, or `WorkspaceWrite → DangerFullAccess` escalation → prompt.
6. Else deny.

Prompter interface:
```rust
pub trait PermissionPrompter {
    fn decide(&mut self, request: &PermissionRequest) -> PermissionPromptDecision; // Allow | Deny { reason }
}
```

`PermissionRequest` carries `tool_name`, raw `input`, `current_mode`, `required_mode`, and an optional `reason` (set by hooks or ask rules).

### `PermissionEnforcer` (composed helper)

`crates/runtime/src/permission_enforcer.rs`. A stateless facade over `PermissionPolicy` used by tool-layer code (bash, file_ops) when they need non-prompt checks. Notable non-obvious behavior:

- When `active_mode == Prompt`, the enforcer returns `Allowed` — it defers to the caller's interactive flow rather than hard-denying.
- `check_file_write(path, workspace_root)` — ReadOnly denies unconditionally; WorkspaceWrite checks `is_within_workspace(path, workspace_root)` by string prefix after normalizing relative paths; Allow/Danger permit all; Prompt denies (deferred to prompt).
- `check_bash(command)` — ReadOnly applies `is_read_only_command` heuristic (extensive allowlist of read-only tool names: `cat head tail less more wc ls find grep rg awk sed echo printf which whoami pwd env date df du uptime uname file stat diff sort uniq tr cut paste tee xargs test readlink realpath basename dirname sha256sum md5sum b3sum xxd hexdump od strings tree jq yq python python3 node ruby cargo rustc git gh`). Blocked if command contains `-i `, `--in-place`, ` > `, or ` >> `. Note: `sed` and `awk` and `python` are in the allowlist; the mutation guard is the flag/redirection check, not the program.
- Prompt mode denies bash writes explicitly.

### `EnforcementResult`

`Allowed | Denied { tool, active_mode, required_mode, reason }`. This struct is `Serialize`/`Deserialize` — intended to round-trip through IPC.

## 5. Hooks

### Lifecycle events

```rust
pub enum HookEvent { PreToolUse, PostToolUse, PostToolUseFailure }
```

No session-level (SessionStart / SessionEnd / UserPromptSubmit) hooks in this slice. Only tool-level. Configured via `hooks` key in settings.

### Config shape

`RuntimeHookConfig { pre_tool_use: Vec<String>, post_tool_use: Vec<String>, post_tool_use_failure: Vec<String> }`. Each string is a shell command (runs under `sh -lc` on POSIX, `cmd /C` on Windows). Lists are ordered, run sequentially, abort-on-failure.

### Execution protocol

Every hook command:
1. Receives a JSON payload on stdin:
   ```json
   {
     "hook_event_name": "PreToolUse|PostToolUse|PostToolUseFailure",
     "tool_name": "...",
     "tool_input": <parsed JSON or {"raw": "..."}>,
     "tool_input_json": "<raw string>",
     "tool_output": "..." | null,
     "tool_error": "..." ,          // only for PostToolUseFailure
     "tool_result_is_error": bool
   }
   ```
2. Receives env vars: `HOOK_EVENT`, `HOOK_TOOL_NAME`, `HOOK_TOOL_INPUT`, `HOOK_TOOL_IS_ERROR`, `HOOK_TOOL_OUTPUT?`.
3. Exit-code semantics:
   - `0` → allow (may still set `decision: "block"` / `continue: false` in JSON stdout to deny).
   - `2` → deny with "denied tool" fallback message.
   - other non-zero → fail (short-circuits subsequent hooks in the list).
   - signal → fail.
4. Stdout parsing: empty → no-op. Attempted-JSON (starts with `{`/`[`) that fails parse → diagnostic `hook_invalid_json: phase=… tool=… command=… detail=… stdout_preview=… stderr_preview=…` (bounded to 160 chars, control chars escaped). Plain text → passed through as a message.

### JSON stdout schema (claude-code-compatible)

```json
{
  "systemMessage": "string",            // added to hook messages
  "reason": "string",                   // added to hook messages
  "continue": false,                    // -> deny
  "decision": "block",                  // -> deny
  "hookSpecificOutput": {
    "additionalContext": "string",      // added to messages
    "permissionDecision": "allow|deny|ask",
    "permissionDecisionReason": "string",
    "updatedInput": { ... }             // replaces the tool input JSON
  }
}
```

### HookRunResult

```rust
{ denied, failed, cancelled,
  messages: Vec<String>,
  permission_override: Option<PermissionOverride>,
  permission_reason: Option<String>,
  updated_input: Option<String> }
```

### Abort / progress

`HookAbortSignal` is a clonable Arc<AtomicBool>. Commands poll it every 20 ms and kill the child on trip. Reporter events: `Started | Completed | Cancelled { event, tool_name, command }`.

## 6. Config hierarchy

### Discovery order (lowest → highest precedence)

`ConfigLoader::discover` returns these in scan order; later entries override earlier on deep-merge:

1. `<HOME>/.claw.json` (user, legacy top-level)
2. `<config_home>/settings.json` (user) — `config_home` is `$CLAW_CONFIG_HOME`, else `$HOME/.claw`, else `.claw`
3. `<cwd>/.claw.json` (project, legacy top-level)
4. `<cwd>/.claw/settings.json` (project)
5. `<cwd>/.claw/settings.local.json` (local overrides)

`ConfigSource`: `User < Project < Local` (ordered enum).

### Load + validate pipeline (`ConfigLoader::load`)

For each entry:
1. Reject unsupported formats (TOML is explicitly rejected with a clear error).
2. `read_optional_json_object` — missing file is silent, invalid JSON errors.
3. `validate_config_file` → first error fails the load. Warnings (e.g., deprecated keys) print to stderr but do not block.
4. `validate_optional_hooks_config` — hook-specific sanity check.
5. `merge_mcp_servers` — scope-aware (Local > Project > User collision resolution).
6. `deep_merge_objects` — recursive merge into accumulator. Objects merge key-wise; scalars/arrays replace.

### Validated sections

`config_validate.rs` enforces a known-field schema for:
- Top-level keys: `$schema, model, hooks, permissions, permissionMode (deprecated), mcpServers, oauth, enabledPlugins (deprecated), plugins, sandbox, env, aliases, providerFallbacks, trustedRoots`.
- Nested fields for `hooks`, `permissions`, `plugins`, `sandbox`, `oauth`.
- Type labels: `a string`, `a boolean`, `an object`, `an array of strings`, `a number`.
- Unknown-key errors carry Levenshtein-suggested close matches (distance ≤ 3).
- Line numbers are computed from the raw source text by searching for the key needle and counting newlines.
- Deprecated keys produce warnings with replacement hints (`permissionMode` → `permissions.defaultMode`, `enabledPlugins` → `plugins.enabled`).

### Parsed feature config

`RuntimeFeatureConfig` aggregates decoded views:
- `hooks: RuntimeHookConfig`
- `plugins: RuntimePluginConfig` (enabled map, external dirs, install/registry/bundled roots, `maxOutputTokens`)
- `mcp: McpConfigCollection` (scope-tagged server configs)
- `oauth: Option<OAuthConfig>`
- `model: Option<String>`, `aliases: BTreeMap<String, String>`
- `permission_mode: Option<ResolvedPermissionMode>` (`ReadOnly|WorkspaceWrite|DangerFullAccess`)
- `permission_rules: RuntimePermissionRuleConfig { allow, deny, ask }`
- `sandbox: SandboxConfig`
- `provider_fallbacks: ProviderFallbackConfig { primary, fallbacks }`
- `trusted_roots: Vec<String>`

## 7. System prompt assembly

`crates/runtime/src/prompt.rs`. `SystemPromptBuilder` composes a `Vec<String>` of sections; `render()` joins with `\n\n`.

### Fixed sections (in order)

1. **Intro** — "You are an interactive agent that helps users with software engineering tasks" (or output-style variant). Embeds a hard rule: never generate URLs unless confident.
2. **Output style** (optional) — `# Output Style: <name>\n<prompt>`.
3. **`# System`** — bullet list covering tool permission modes, `<system-reminder>` tags, prompt injection flagging, hook feedback behavior, and auto-compaction awareness.
4. **`# Doing tasks`** — scoping discipline, no speculative abstractions, no unrequested files, diagnose before pivoting, security, faithful reporting.
5. **`# Executing actions with care`** — blast-radius framing.
6. **`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`** — literal marker string; downstream consumers can split here to separate static scaffold from dynamic context.

### Dynamic sections (appended after boundary)

7. **Environment context** — bullets: `Model family: <FRONTIER_MODEL_NAME>` (default `"Claude Opus 4.6"`), working directory, date, platform.
8. **Project context** — current date, cwd, instruction-file count, git status snapshot, recent commits (last 5), git diff snapshot, git context render.
9. **Claude instructions** — instruction file contents (see below).
10. **Runtime config** — lists loaded entries by source + pretty-printed merged JSON.
11. Caller-appended sections.

### Instruction file discovery

Walks cwd upward to filesystem root; at each ancestor checks:
```
<dir>/CLAUDE.md
<dir>/CLAUDE.local.md
<dir>/.claw/CLAUDE.md
<dir>/.claw/instructions.md
```
Order is root → cwd (so deepest scope appears last). Deduped by a stable hash over content (whitespace-collapsed, trimmed); duplicates in ancestors are dropped.

### Budget

- `MAX_INSTRUCTION_FILE_CHARS = 4000` per file.
- `MAX_TOTAL_INSTRUCTION_CHARS = 12000` across all files.
- Truncation marker: `\n\n[truncated]`.
- When budget is exhausted: `_Additional instruction content omitted after reaching the prompt budget._`.

### Git context

`GitContext::detect(cwd)` runs `git rev-parse --is-inside-work-tree` as the gate. Captures:
- Branch (`git rev-parse --abbrev-ref HEAD`; filters `"HEAD"` detached state).
- Up to 5 recent commits (`git --no-optional-locks log --oneline -n 5 --no-decorate`).
- Staged files (`git --no-optional-locks diff --cached --name-only`).

Status/diff come via separate functions in `prompt.rs` using `git status --short --branch` and `git diff` / `git diff --cached`. The `--no-optional-locks` flag matters for concurrent serve instances.

## 8. Compaction

### When it triggers

- **Manual**: `ConversationRuntime::compact(CompactionConfig)` returns a `CompactionResult` without mutating.
- **Auto**: after every `run_turn`, if `cumulative_usage().input_tokens ≥ auto_compaction_input_tokens_threshold`. Default 100_000, overridable via `CLAUDE_CODE_AUTO_COMPACT_INPUT_TOKENS` env var, or `with_auto_compaction_input_tokens_threshold`.
- Auto-compaction uses `CompactionConfig { max_estimated_tokens: 0, ..default() }` which forces `should_compact` true as long as there are more than `preserve_recent_messages` messages.

### `should_compact` rule

```
messages[prefix..].len() > preserve_recent_messages
  && sum(estimate_tokens(m) for m in messages[prefix..]) >= max_estimated_tokens
```
Where `prefix` skips an existing `<summary>` system message (so re-compaction ignores the already-compacted prefix). Estimation is `content_len / 4 + 1` per block — the usual rough token estimator.

### Algorithm

1. Detect an existing compacted summary at `messages[0]` (system role, text begins with the known preamble) → `existing_summary`, advance prefix.
2. `keep_from = len - preserve_recent_messages`, defaults preserve 4 recent messages.
3. **Boundary guard (load-bearing)**: if `messages[keep_from]` starts with a `ToolResult` and `messages[keep_from-1]` does *not* have a `ToolUse`, walk `keep_from` back. Without this, the OpenAI-compat path sends an orphaned tool role message (400 error). Explicitly tested.
4. `summarize_messages(removed)` produces a deterministic XML-tagged summary:
   ```
   <summary>
   Conversation summary:
   - Scope: N earlier messages compacted (user=a, assistant=b, tool=c).
   - Tools mentioned: …
   - Recent user requests: … (last 3)
   - Pending work: … (heuristic: scans for "todo"/"next"/"pending"/"follow up"/"remaining")
   - Key files referenced: … (scans for tokens with `/` and extensions rs/ts/tsx/js/json/md, first 8)
   - Current work: <last non-empty text>
   - Key timeline:
     - role: <truncated-160 block summary>
     …
   </summary>
   ```
5. If an existing summary exists, `merge_compact_summaries` produces a `Previously compacted context / Newly compacted context / Key timeline` structured merge.
6. New session = `[synthetic System message with continuation preamble] + preserved_tail`. The System message carries `COMPACT_CONTINUATION_PREAMBLE + formatted_summary [+ COMPACT_RECENT_MESSAGES_NOTE] [+ COMPACT_DIRECT_RESUME_INSTRUCTION]`.
7. Session gets `record_compaction(summary, removed_count)` — increments `compaction.count`.

### Post-compaction health check

At the top of the next `run_turn`, if `session.compaction.is_some()`, the runtime calls `tool_executor.execute("glob_search", {"pattern":"*.health-check-probe-"})`. A probe error aborts the turn with guidance to start a fresh session. An empty-message freshly-compacted session (no preserved tail) skips the probe.

### Summary compression (secondary budget)

`summary_compression.rs` provides a completely separate utility for compressing an existing summary string (not the session) to tighter character/line budgets (default 1200 chars / 24 lines / 160 chars per line). Priority ladder: core-detail lines (`Scope`, `Current work`, `Pending work`, …) → section headers → bullets → prose. Used downstream by consumers that need to squeeze a summary further; not invoked by the conversation loop itself.

## 9. Usage tracking

`crates/runtime/src/usage.rs`.

`TokenUsage { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }` — captured per assistant turn, stored on `ConversationMessage.usage` for assistant messages, and rolled up by `UsageTracker`.

`UsageTracker`:
- `latest_turn: TokenUsage`, `cumulative: TokenUsage`, `turns: u32`.
- `from_session(&Session)` reconstructs by replaying assistant messages with usage → this is how `ConversationRuntime::new` restores counters on resume.
- `record(usage)` — sums into cumulative, sets latest.

### Pricing / cost estimation

Hardcoded per-model-family pricing inferred from substring match on the model name (`haiku`, `opus`, `sonnet` — otherwise `None` → default sonnet-tier rates). Pricing is USD/million tokens for input, output, cache-creation, cache-read. `summary_lines_for_model` produces two human-readable lines including `estimated_cost` and cost breakdown.

Prompt-cache telemetry (not cost, diagnostic):
```rust
PromptCacheEvent {
  unexpected: bool,
  reason: String,
  previous_cache_read_input_tokens: u32,
  current_cache_read_input_tokens: u32,
  token_drop: u32,
}
```
Accumulated into `TurnSummary.prompt_cache_events`. Useful for alerting on cache invalidation regressions but not acted on automatically.

## 10. Requirements for swarm-coder

### [v0] — must-haves for single-agent TS port

- **Conversation loop shape**: single struct parameterized on `Provider` + `ToolDispatcher` + `PermissionPolicy`, with a `run_turn(userInput)` that returns a `TurnSummary`. Matches `docs/03-interfaces.md`'s `Provider` seam; claw's `AssistantEvent` maps ~1:1 to our `StreamEvent`.
- **Message model**: `{ role, blocks[], usage? }` with `text | tool_use | tool_result` blocks. Keep `tool_name` on tool_result to preserve our ability to reconstruct after compaction.
- **Tool dispatcher contract**: `execute(name, input: string) → Promise<string>` with a ToolError for failures. Keep tool I/O as opaque JSON strings at this seam, even though TS can do better — cross-provider compatibility depends on stringified inputs.
- **Session persistence**: JSONL with a `session_meta` header record, then interleaved `message` / `compaction` / `prompt_history` records. Append-on-push, snapshot on bootstrap/rotation.
- **Session IDs**: monotonic string generator; `Session.fork()` mints fresh IDs and records `fork.parent_session_id`.
- **Per-worktree isolation**: `SessionStore` that namespaces by a deterministic 16-char hex fingerprint of the workspace root. This is the claw response to "phantom completions" in parallel lanes — directly relevant to swarm-coder where multiple workers share a parent process.
- **Resume aliases**: `latest`/`last`/`recent` → newest session by `updated_at_ms`.
- **Permission model**: `PermissionMode` (ReadOnly/WorkspaceWrite/DangerFullAccess/Prompt/Allow) + per-tool required mode + allow/deny/ask rules with `tool(subject)` / `tool(subject:*)` grammar.
- **Subject extraction key list**: `command, path, file_path, filePath, notebook_path, notebookPath, url, pattern, code, message`. Keep this list exactly — rules written against claw will be copy-pasted.
- **PermissionPrompter** interface, optional at the call site. Rule evaluation order: deny → hook override → ask rule → allow rule/mode → prompt escalation → deny.
- **Workspace-boundary file write check** and **bash read-only heuristic**: both gate behavior on strict mode. The bash allowlist is a useful starting point (keep flag/redirection checks — mutation isn't in the binary name).
- **Config layering**: user → project → local. Deep-merge objects, replace scalars/arrays. Validate against a known-key schema with suggestions on typos, explicit deprecations.
- **Hooks**: PreToolUse / PostToolUse / PostToolUseFailure as ordered shell command lists. JSON payload on stdin, exit 0/2/other semantics, stdout JSON schema with `permissionDecision`, `updatedInput`, `systemMessage`, `continue: false`.
- **System prompt assembly**: static scaffold → `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` marker → environment → project context → CLAUDE.md instruction files → merged config.
- **CLAUDE.md discovery**: ancestor walk, four filenames per level, dedupe by content hash, 4k-per-file / 12k-total char budgets.
- **Git context capture**: branch, 5 recent commits, staged files. Use `--no-optional-locks`.
- **Basic compaction**: token-based threshold trigger, summary synthesis with role counts + tool names + recent user requests + heuristic pending work + key files + timeline. Tool-use/tool-result boundary guard is non-negotiable.
- **Post-compaction health probe**: cheap no-op tool call to confirm the transport is alive before the next turn.
- **UsageTracker**: per-turn latest + cumulative totals. Reconstruct from a loaded session's assistant-message `usage` fields on resume.

### [v1] — should-haves

- **PermissionEnforcer facade** for file_ops / bash that `Denied` with serializable payload — we'll need this shape over the stdio wire when the swarm orchestrator needs to display denials.
- **Hook abort signal** (AbortController-backed) + **progress reporter** for UIs that surface long-running hooks.
- **HookSpecificOutput** schema (`additionalContext`, `updatedInput`, `permissionDecision`, `permissionDecisionReason`) for full claude-code hook compatibility. Enables reusing existing hook libraries.
- **Model pricing table** and **per-model cost estimation**. Swarm orchestration benefits from per-agent cost rollups.
- **Prompt cache event tracking** — not acted on, just surfaced to the event stream so orchestrators can alert.
- **Rotation of large session logs** (256 KiB threshold, keep last 3). Worth having once sessions grow past a few MB.
- **Session workspace mismatch** detection on load — error rather than silently writing to the wrong root.
- **Scope-aware MCP server merge** (deferred — not in this slice, but the sibling agent should align on the User/Project/Local precedence).
- **Summary compression budget tool** (`summary_compression.rs`) for squeezing summaries down when they're piped into subagent contexts.

### [later] — nice-to-haves

- **Trace events** (`turn_started`, `assistant_iteration_completed`, `tool_execution_started/finished`, `turn_completed`, `turn_failed`) — useful for observability, but our UI event stream already covers most of this.
- **Prompt history append log** (`prompt_history` JSONL records) — useful for a `/history` command; deferrable.
- **`auto_compaction_input_tokens_threshold` env override** (`CLAUDE_CODE_AUTO_COMPACT_INPUT_TOKENS`).
- **Merge of previously-compacted context with new summary** — the "Previously compacted / Newly compacted" dual-section layout. Only matters after multiple compactions.
- **FNV-1a fingerprint** specifically — any stable 16-char hex will do for us; we can use SHA-256-truncated if it's simpler in TS.

### [skip] — out of scope or overengineered

- **`model` field persisted on Session**. Can be inferred from last assistant `usage.model` or caller-side.
- **`last_health_check_ms`**. The health-probe behavior doesn't need to be persisted; recompute per-turn.
- **Atomic-write temp-file naming** with ms+counter. Standard "write .tmp then rename" is sufficient.
- **Deprecated key warnings with line numbers via needle search**. Start with a simpler schema validator; line numbers are polish.
- **`$schema` advertising**. Add when we publish a schema URL, not before.
- **`PolicyEngine`/`policy_engine.rs`**. That whole module is lane/CI/branch-reconciliation orchestration — green-level gates, MergeToDev, StaleBranch, etc. Completely unrelated to the agent loop and belongs in a higher-level orchestrator (or not at all). **Skip**.

## 11. Open questions

- **Session tracer vs. event stream**: claw pipes runtime traces through a `SessionTracer` trait backed by a telemetry sink. swarm-coder already has an event stream as the primary observability surface — is a separate tracer abstraction warranted, or can we fold trace-worthy events into the existing stream?
- **Model persistence on Session**: claw persists `model` so a resumed session knows which model it started with. For swarm, do we want the atomic agent to be pinned to a model across resume, or always let the orchestrator rebind? Affects whether this moves from [skip] to [v1].
- **Provider capabilities**: claw has no `ProviderCapabilities` concept — the loop assumes streaming + tool use + prompt cache events. Our `Provider` interface has `capabilities`, which the loop should actually check. This is a swarm-coder improvement over claw, not a port — flag it as a net-new thing to design.
- **Tool input types**: claw carries tool inputs as raw JSON strings end-to-end. TypeScript can validate against schemas at the dispatcher boundary. Should the ToolExecutor seam accept `unknown` / parsed JSON with per-tool schemas, or stay stringly typed to match claw's wire model? Recommend parsed-with-validation inside, string at the boundary.
- **Ask rule vs hook-Allow precedence**: claw explicitly tests that hook `Allow` *still respects* ask rules (prompt is required). This is subtle — confirm the swarm-coder behavior spec matches before copying blindly.
- **Bash read-only heuristic scope**: claw's allowlist includes `python`, `node`, `ruby`, `cargo`, `rustc`, `git`, `gh` — several of which can absolutely mutate state. The flag/redirection check catches `-i`/`--in-place`/`>`/`>>` but misses plenty (e.g., `git push`, `cargo publish`, `python -c 'open(...).write(...)'`). Decide whether to tighten the list or rely on explicit allow rules in practice.
- **Workspace fingerprint collisions**: 64-bit FNV-1a gives ~1-in-2^32 collision prob by birthday bound at ~4B workspaces. Fine for single-user, worth a 128-bit hash if we ever share session stores across machines.
- **Compaction is mechanical, not LLM-driven**: claw produces a deterministic summary via string pattern matching (pending-work detection by keyword scan, key-file extraction by extension). An LLM-summarization step would be much higher quality — is deferring to the model a v1 target, or do we keep mechanical compaction as a deterministic baseline with LLM compaction as a plugin?
- **Hook failure propagation**: a hook exiting 1 (not 2) fails the *turn's current tool call* but does NOT abort the loop — the tool simply returns as an error and the model sees it. Is this the right default for swarm workers, where a silent hook failure could loop indefinitely?
- **Session health probe tool name is hardcoded to `glob_search`**. swarm-coder's tool naming in `tools/tier0/` may differ; either standardize on `glob_search` or make the probe tool configurable.
- **Load-bearing for multi-agent swarm**: The "phantom completions" pattern (ROADMAP #41) is the biggest design lesson here — multiple serve instances writing to shared session storage while reporting success against different worktrees. swarm-coder's orchestrator-spawns-workers model has the same failure mode. The SessionStore + workspace_root validation is the answer. **Treat this as non-negotiable for v0.**

## 12. File references

All absolute paths under `/Users/alexngai/GitHub/swarm-coder/`:

- `references/claw-code/rust/crates/runtime/src/lib.rs` — module index, public re-exports
- `references/claw-code/rust/crates/runtime/src/conversation.rs` — `ConversationRuntime`, `ApiClient`, `ToolExecutor`, `AssistantEvent`, `TurnSummary`, `run_turn`
- `references/claw-code/rust/crates/runtime/src/session.rs` — `Session`, `ConversationMessage`, `ContentBlock`, `MessageRole`, JSONL format, atomic write + rotation
- `references/claw-code/rust/crates/runtime/src/session_control.rs` — `SessionStore`, `workspace_fingerprint`, per-worktree namespacing, `latest`/`last`/`recent` aliases, workspace mismatch detection
- `references/claw-code/rust/crates/runtime/src/permissions.rs` — `PermissionMode`, `PermissionPolicy`, rule parser, `authorize_with_context` precedence logic, subject-extraction key list
- `references/claw-code/rust/crates/runtime/src/permission_enforcer.rs` — `PermissionEnforcer`, `check_file_write`, `check_bash`, `is_read_only_command` heuristic, `EnforcementResult` (Serialize)
- `references/claw-code/rust/crates/runtime/src/policy_engine.rs` — **out of scope for runtime core**; lane/merge orchestration; flagged [skip]
- `references/claw-code/rust/crates/runtime/src/hooks.rs` — `HookRunner`, `HookEvent`, shell invocation, JSON stdin payload, stdout schema parsing, `PermissionOverride` emission, abort signal, progress reporter
- `references/claw-code/rust/crates/runtime/src/config.rs` — `ConfigLoader`, `RuntimeConfig`, discovery order, deep-merge, `RuntimeFeatureConfig` shape
- `references/claw-code/rust/crates/runtime/src/config_validate.rs` — known-field schema, type checking, line-number resolution, Levenshtein suggestions, deprecation warnings, TOML rejection
- `references/claw-code/rust/crates/runtime/src/prompt.rs` — `SystemPromptBuilder`, `ProjectContext`, CLAUDE.md discovery, instruction budget, static scaffold sections, `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`
- `references/claw-code/rust/crates/runtime/src/git_context.rs` — `GitContext::detect`, branch + 5 recent commits + staged files
- `references/claw-code/rust/crates/runtime/src/compact.rs` — `compact_session`, `should_compact`, `estimate_session_tokens`, synthetic summary generation, tool-use/tool-result boundary guard, re-compaction merge
- `references/claw-code/rust/crates/runtime/src/summary_compression.rs` — secondary summary compressor; line-priority ladder; line/char budgets
- `references/claw-code/rust/crates/runtime/src/usage.rs` — `TokenUsage`, `UsageTracker`, model pricing, `PromptCacheEvent` (re-exported from conversation), cost estimation
- `references/claw-code/rust/crates/runtime/src/json.rs` — custom JSON value type (not read in detail; utility layer)
