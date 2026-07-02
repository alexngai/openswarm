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

## Divergences from claw-code

Research (see `research/02-tools.md`) surfaced behaviors we explicitly **change** when porting:

| Tool | Claw behavior | Our behavior | Why |
|---|---|---|---|
| `edit_file` | Silent first-match when `replace_all=false` | Reject ambiguous matches | Alignment with Claude Code proper; prevents subtle bugs |
| `grep` | `walkdir` + `regex`, no gitignore | Real ripgrep binary | Name should match behavior; gitignore respected |
| `bash_validation` | 6 submodules exist but not wired | Wire all validation we port | Dead code attracts bit-rot |
| `write_file` | Canonical boundary helpers exist but unused | Boundary check enforced on every call | Workspace safety is non-negotiable |
| `MCP` (generic dispatcher) | Single tool with `{server, tool, args}` | First-class tools via deferred registration (M5) | Model can plan against named tools |

## Tools NOT in our catalog

Claw-code has these; we deliberately skip:

- `SendUserMessage` / `Brief` — host-level send-to-user, unclear delivery semantics in claw
- `Config` — settings get/set better handled via `/config` slash command
- `PowerShell` — Windows twin of bash; if we support Windows, use `bash` with WSL detection
- `ToolSearch` — claw's deferred-schema discovery mechanism; our tier model handles this architecturally
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
