# Tool tiers

Tiers exist so the MVP ships fast and later tools slot in without re-architecting. A higher tier never depends on a lower tier's internals — only on the published interfaces.

## Tier 0 — Atomic agent MVP

The minimum viable coding agent. An atomic unit must have exactly these to be useful.

| Tool | Purpose |
|---|---|
| `bash` | Shell exec with timeout, background, and permission gate |
| `read_file` | Read file with offset/limit, binary detection |
| `write_file` | Create or overwrite a file |
| `edit_file` | Exact-string replacement with mandatory uniqueness check |
| `multi_edit` | Atomic batch of edits (all-or-nothing) in one tool call |
| `glob` | File pattern matching |
| `grep` | Content search (bundled `@vscode/ripgrep` binary) |
| `todo_write` | Persistent todo list for multi-step tasks |
| `shell_exec` | Persistent shell sessions surviving across tool calls |
| `shell_write` | Send text input / signals to running shell sessions |
| `shell_list` | List, inspect, reattach, or close shell sessions |
| `request_permissions` | Request elevated permissions mid-session — *registered on the single-agent REPL + headless paths (Phase 4.1e); the handler prompts the user and, on approval, raises the live permission mode up to the CLI ceiling. Not yet advertised on ACP bridges or swarm workers (follow-up).* |
| `memory_manage` | Manage curated memory entries (add/replace/remove) that persist across sessions |
| `memory_search` | Search past session archives and memories |

## Tier 1 — Productivity

| Tool | Purpose |
|---|---|
| `web_fetch` | GET a URL, return markdown |
| `web_search` | Query the web (pluggable backends, batch queries, domain filtering) |
| `notebook_edit` | Jupyter notebook cell operations | **shipped M3b** |
| `structured_output` | Force JSON-shaped final answer |
| `skill` | Invoke a loaded skill |
| `view_image` | Read image files (PNG/JPEG/GIF/WebP/SVG/BMP/ICO), return base64 |
| `tool_search` | Dynamic tool discovery by keyword matching |

## Tier 2 — Swarm primitives

What makes openswarm a *swarm*. Dispatched via `SwarmHost`. Works in both standalone and worker modes — the surface does not change.

| Tool | Purpose |
|---|---|
| `agent` | Spawn a sub-agent on a subtask |
| `task_create` | Register a task in the shared task registry |
| `task_get` | Read task state |
| `task_list` | List tasks by filter |
| `task_update` | Update status, owner, or output |
| `task_stop` | Cancel a running task | **shipped M3a** |
| `task_output` | Append to a task's output stream | **shipped M3a** |
| `send_message` | Message another agent by id | **shipped M3a** |
| `check_inbox` | Read messages for this agent | **shipped M3a** |
| `ask_user_question` | Structured question back to the human, routed via `SwarmHost` | **shipped M3b** |

## Tier 3 — Team / schedule

| Tool | Purpose |
|---|---|
| `team_create` | Declare a named team with members and roles |
| `team_delete` | Dissolve a team |
| `cron_create` | Schedule a recurring agent run |
| `cron_list` | List scheduled crons |
| `cron_delete` | Remove a cron |
| `remote_trigger` | Invoke a remote agent |

## Tier 4 — Developer surface

| Tool | Purpose |
|---|---|
| `mcp__list_resources` | List MCP server resources |
| `mcp__read_resource` | Read an MCP resource |
| `mcp__auth` | MCP authentication flow |
| `lsp_diagnostics` | Language-server diagnostics |
| `lsp_hover` | Symbol hover |
| `lsp_definition` | Go to definition |
| `lsp_references` | Find references |
| `lsp_symbols` | Document and workspace symbols |

## Tier 5 — Advanced runtime

| Tool | Purpose |
|---|---|
| `enter_plan_mode` / `exit_plan_mode` | Gated planning mode |
| `sandbox` | Sandboxed shell exec |
| `hooks` | Lifecycle hook management |
| `pdf_extract` | PDF → text |
| `sleep` | Deliberate wait |
| `repl` | Persistent stateful REPL (python/node) |

## NativeEngine compatibility

Tier 2 tools work identically under NativeEngine — SwarmHost is engine-agnostic. The `dispatchBatch` fan-out in NativeEngine calls the same `ToolDispatcher.dispatchBatch` path that `ClaudeAgentSdkEngine` uses, so `send_message`, `check_inbox`, `task_*`, and `ask_user_question` all route through SwarmHost regardless of which engine drives the turn loop. Swapping from `--framework claude-agent-sdk` to `--framework native` requires no tool-layer changes.

## Tier ordering ≠ release ordering

Release milestones live in [`07-implementation-plan.md`](./07-implementation-plan.md). Summary: M0 = Tier 0 only; M1 = Tier 2 subset (`agent`, `task_create/update/get/list`); M2 = Tier 1 + plugin/skill/MCP; M3 = Tier 2 remainder + teams + git coord; M4 = provider breadth; M5+ = Tier 3–5.

## Claude Code schema alignment

Tier-0 tool schemas, output formats, and error strings are aligned with Claude Code
(and, where compatible, MiMoCode/ZCode and Codex) so models trained on those
harnesses work on openswarm without fine-tuning. See
[`39-codex-parity-gap-analysis.md`](./39-codex-parity-gap-analysis.md) for the
full harness comparison that motivated this. The decisions:

| Tool | Canonical schema | Legacy alias (still accepted) |
|---|---|---|
| `read_file` | `file_path`, `offset` (1-based line), `limit` | `path` |
| `write_file` | `file_path`, `content` | `path` |
| `edit_file` | `file_path`, `old_string`, `new_string`, `replace_all` | `path` |
| `multi_edit` | `file_path`, `edits[]` | `path` |
| `bash` | `command`, `timeout`, `description`, `workdir`, `run_in_background` | `background` |
| `grep` | `pattern`, `path`, `glob`, `type`, `-i`, `-n`, `-A`, `-B`, `-C`, `output_mode`, `head_limit`, `multiline` | `case_insensitive` (= `-i`) |
| `glob` | `pattern`, `path` | `cwd` |
| `apply_patch` | `patch` | `input` (Codex JSON variant) |
| `todo_write` | `todos[]` with optional `id` (auto-filled from index) | required `id` |

Aliases are normalized via `z.preprocess` before validation; the advertised JSON
schema only shows the canonical names. Behavioral contracts that ship with the
alignment (verified against the Claude Code **v2.1.198** bundle — exact strings
extracted from the shipped binary):

- **`read_file`** returns `cat -n`-formatted output (6-wide right-aligned line
  number + tab), truncates lines >2000 chars, defaults to 2000 lines. Empty
  files return `<system-reminder>Warning: the file exists but the contents are
  empty.</system-reminder>`; an offset past EOF returns `<system-reminder>Warning:
  the file exists but is shorter than the provided offset (N). The file has M
  lines.</system-reminder>`. When the *default* cap truncates a read, the content
  is prefixed with Claude Code's `<system-reminder>[Truncated: PARTIAL view — …
  Do NOT answer from this page alone …]</system-reminder>` banner; explicit
  `limit` windows get a plain `(Showing lines X-Y of Z. Use offset=N to
  continue.)` suffix. Missing files error with exactly `File does not exist.`
- **Read-before-edit** (`src/tools/tier0/read-state.ts`): `edit_file`,
  `multi_edit`, and `write_file`-on-existing-file fail with Claude Code's
  recoverable error `File has not been read yet. Read it first before writing to
  it.` unless the file was read (or written) earlier in the session. Successful
  edits/writes record read state, so no re-read is needed after modifying. A
  TOCTTOU-detected concurrent modification fails with Claude Code's stale-file
  error: `File has been modified since read, either by the user or by a linter.
  Read it again before attempting to write it.`
- **`edit_file` strings** match Claude Code verbatim: errors `String to replace
  not found in file.`, `Found N matches of the string to replace, but
  replace_all is false. …`, and `No changes to make: old_string and new_string
  are exactly the same.`; success is `The file X has been updated successfully.
  (file state is current in your context — no need to Read it back)` (or `… has
  been updated. All occurrences were successfully replaced. …` for
  `replace_all`). `write_file` uses `File created successfully at: X` /
  `The file X has been updated successfully.` with the same suffix.
- **`bash`** collects stdout and stderr **separately** (Claude Code does not
  interleave): the success result is stdout (leading blank lines stripped,
  trailing trimmed) followed by stderr, joined by a newline. stdout is
  head-truncated at **30,000 chars** (`BASH_MAX_OUTPUT_LENGTH` default) with a
  `... [N lines truncated] ...` marker. Non-zero exits return an error whose
  message is `Exit code N` **first**, then stderr, then stdout, middle-truncated
  at 10,000 chars with `... [N characters truncated] ...`. Timeouts read
  `Command timed out after 2m 0s` (humanized). Aborts append
  `<error>Command was aborted before completion</error>`. Background commands
  stream to a temp file and return `Command running in background with ID: <pid>.
  Output is being written to: <file>. …`. Default timeout 120 s (max 600 s);
  `workdir` replaces `cd X && …`.
- **`grep`** content mode emits plain ripgrep formatting (`path:line:text`
  matches, `path-line-text` context lines, `--max-columns 500`), with Claude
  Code's `[Showing results with pagination = limit: N]` note at `head_limit`.
  files mode returns `Found N files` + paths; count mode returns raw
  `path:count` lines + `Found N total occurrences across M files.` Empty
  results: `No matches found` / `No files found`.
- **`glob`** returns `No files found` when empty and appends `(Results are
  truncated. Consider using a more specific path or pattern.)` at the cap.
- **`todo_write`** returns Claude Code's exact acknowledgement: `Todos have been
  modified successfully. Ensure that you continue to use the todo list to track
  your progress. Please proceed with the current tasks if applicable`.

### Post-compaction instruction re-injection (follow-up F1 in doc 48 — done)

Claude Code re-reads CLAUDE.md / memory files after every compaction and
re-injects them as attachments. OpenSwarm now matches this:

- **CLAUDE.md / AGENTS.md** are loaded at startup (`src/engine/project-instructions.ts`,
  CWD→root ancestor walk) into the system prompt, and re-injected after
  compaction as a `<system-reminder>` attachment via the `recontextualize()`
  hook (`makeProjectInstructionsRecontextualizer`) threaded into
  `compactSessionRemote`.
- **Curated memory** is not re-injected: `enrichTurnInputs` folds it into the
  system prompt, which is resent every request and untouched by compaction, so
  it already survives the boundary.

The post-compact rebuild (`src/engine/compact-rebuild.ts`) still handles
recently read files and the todo snapshot. See
[48-compaction-design.md](./48-compaction-design.md) "F1 — how it landed".

## Divergences from the reference implementation

Research surfaced behaviors we explicitly **change** when porting:

| Tool | Reference-implementation behavior | Our behavior | Why |
|---|---|---|---|
| `edit_file` | Silent first-match when `replace_all=false` | Reject ambiguous matches | Alignment with Claude Code proper; prevents subtle bugs |
| `grep` | `walkdir` + `regex`, no gitignore | Real ripgrep binary | Name should match behavior; gitignore respected |
| `bash_validation` | 6 submodules exist but not wired | Wire all validation we port | Dead code attracts bit-rot |
| `write_file` | Canonical boundary helpers exist but unused | Boundary check enforced on every call | Workspace safety is non-negotiable |
| `MCP` (generic dispatcher) | Single tool with `{server, tool, args}` | First-class tools via deferred registration (M5) | Model can plan against named tools |

## Tools NOT in our catalog

The reference implementation has these; we deliberately skip:

- `SendUserMessage` / `Brief` — host-level send-to-user, unclear delivery semantics in the reference implementation
- `Config` — settings get/set better handled via `/config` slash command
- `PowerShell` — Windows twin of bash; if we support Windows, use `bash` with WSL detection
- `ToolSearch` — the reference implementation's deferred-schema discovery mechanism; our tier model handles this architecturally
- `WorkerCreate/Get/Observe/ResolveTrust/AwaitReady/SendPrompt/Restart/Terminate/ObserveCompletion` — 9-tool family for driving external Claude Code via screen-scraping. We have the SDK; our `agent` + lane events cover this ground.
- `RunTaskPacket` — collapses into `task_create` with a richer input variant
- `TestingPermission` — test-only stub

## Tool-spec convention

Every tool declares:

- `name` — stable identifier (snake_case, matches what the model sees)
- `description` — model-facing description
- `inputSchema` — JSON Schema for the input
- `requiredPermission` — `"none" | "read" | "write" | "exec" | "network"`
- `tier` — 0..5, used for gating and telemetry
- `execute(input, ctx)` — implementation, receives a `ToolContext` with cwd, `SwarmHost`, permission engine, and logger
