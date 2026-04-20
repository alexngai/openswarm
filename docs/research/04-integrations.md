# claw-code integrations research (for swarm-coder)

Research of how claw-code (Rust) wires external integrations — plugins, skills,
MCP, and LSP — into the runtime. Extracted to inform `PluginSource` /
`SkillSource` design in `docs/03-interfaces.md` and the Tier-4 developer tools
in `docs/04-tool-tiers.md`.

## 1. Summary

claw-code treats each integration as an independent subsystem with its own
lifecycle and registry — none of them share a transport abstraction.

- **Plugins** are on-disk packages discovered from a small set of roots (bundled,
  installed, external dirs). A plugin ships a `plugin.json` (or
  `.claude-plugin/plugin.json`) that declares hooks, init/shutdown scripts, and
  process-exec-style tools. Plugins have install / update / enable / disable /
  uninstall flows driven by a `PluginManager` that writes to
  `<config_home>/settings.json` (enabled flags) and
  `<config_home>/plugins/installed.json` (registry).
- **Skills** are resolved at invocation time from a tiered path list
  (`.omc/.agents/.claw/.codex/.claude/...` plus `$CLAW_CONFIG_HOME`, `$CODEX_HOME`,
  `$CLAUDE_CONFIG_DIR`, plus home-dir variants). A skill is a `SKILL.md`
  markdown file (optionally with YAML frontmatter `name:` / `description:`), and
  invoking the `skill` tool returns the prompt text plus metadata — not a
  remote call, just a content expansion.
- **MCP** has a full stdio client (`McpStdioProcess` / `McpServerManager`),
  LSP-framed JSON-RPC with `initialize` → `tools/list` → `tools/call` /
  `resources/list` / `resources/read`, per-server timeouts, retry-on-failure,
  server names normalized into `mcp__<server>__<tool>` qualified tool IDs.
  A separate `McpToolRegistry` bridge exposes that surface to generic tools
  (`ListMcpResources`, `ReadMcpResource`, `McpAuth`, `MCP`).
- **LSP** is a typed registry (`LspRegistry`) keyed by language; dispatch goes
  through a `dispatch(action, path, line, character, query)` method covering
  7 actions. Current code is mostly a stateful in-memory registry with the
  actual JSON-RPC call out "returning structured placeholder" — the plumbing
  for real LSP processes is not fully implemented, but the dispatch surface,
  language-detection-by-extension, and tool shape are.

Key takeaway for interfaces: claw-code chose separate, concrete subsystems
rather than a shared `Source` abstraction. swarm-coder's `PluginSource` /
`SkillSource` needs to preserve discovery-vs-load-vs-execute as distinct phases
and keep transport-specific details (MCP stdio framing, LSP language mapping)
inside source adapters.

## 2. Plugins

### Manifest format

File: `plugins/src/lib.rs`, struct `PluginManifest` / `RawPluginManifest`.

Two accepted on-disk locations (checked in order):

1. `<plugin_root>/plugin.json` (claw's own convention)
2. `<plugin_root>/.claude-plugin/plugin.json` (Claude-Code-compatible path)

Required top-level fields (JSON):

| Field | Type | Notes |
|---|---|---|
| `name` | string | Used to derive `plugin_id = "<marketplace>/<sanitized-name>"` |
| `version` | string | Surfaced in registry and update outcomes |
| `description` | string | |
| `permissions` | string[] | Subset of `["read","write","execute"]`; deduped, validated |
| `defaultEnabled` | bool | Default `false`. Controls built-in / bundled default state |
| `hooks` | object | Keys: `PreToolUse`, `PostToolUse`, `PostToolUseFailure` — each a string[] of script paths or literal commands |
| `lifecycle` | object | Keys: `Init`, `Shutdown` — string[] run at load/unload |
| `tools` | object[] | See below |
| `commands` | object[] | `{name, description, command}` — slash-command-style entries |

Tool entry fields (`PluginToolManifest`):

```
{
  "name":              "string",
  "description":       "string",
  "inputSchema":       { /* JSON schema object; must be `type: object` */ },
  "command":           "path or literal shell command",
  "args":              ["..."],
  "requiredPermission": "read-only" | "workspace-write" | "danger-full-access"
}
```

Explicitly rejected Claude-Code-specific fields (`detect_claude_code_manifest_contract_gaps`): `skills`, `mcpServers`, `agents`, directory-glob `commands` (strings), and any hook name outside the three supported lifecycle events. Rejection raises `PluginManifestValidationError::UnsupportedManifestContract`.

### On-disk layout

```
<install_root>/<sanitized_plugin_id>/
  plugin.json                       (or .claude-plugin/plugin.json)
  hooks/
    pre.sh
    post.sh
  ...
```

Config/state paths (relative to `config_home`, defaults to something like `~/.claw` or `$CLAW_CONFIG_HOME`):

- `<config_home>/settings.json` — `enabledPlugins: { "<plugin_id>": bool }`
- `<config_home>/plugins/installed.json` — `InstalledPluginRegistry`
- `<config_home>/plugins/installed/<plugin_id>/` — default install root (overridable)
- `crates/plugins/bundled/*/` — bundled plugins (compiled in; auto-synced to install root every time `plugin_registry_report` is called)
- External dirs (in `PluginManagerConfig.external_dirs`) — any path with plugin subdirectories

### Plugin kinds

```rust
enum PluginKind { Builtin, Bundled, External }
```

- **Builtin** — compiled into the binary (`builtin_plugins()` returns a hard-coded list).
- **Bundled** — shipped alongside the binary in `crates/plugins/bundled/`; auto-sync copies them into the install root, with drift detection (version / name / description / install_path diff triggers resync), and stale bundled records get cleaned up.
- **External** — user-installed via `install()` or auto-discovered from `external_dirs` scan paths.

### Lifecycle flows (all on `PluginManager`)

- **discover** — `plugin_registry_report()` runs bundled sync → loads builtins → scans install root (cross-references `installed.json`, culls stale records) → scans `external_dirs`. Returns `(registry, failures[])` so partial discovery can still succeed.
- **install** — `install(source)` parses `source` as `PluginInstallSource::LocalPath { path }` or `PluginInstallSource::GitUrl { url }`, materializes into a temp dir, loads + validates the manifest, copies into `install_root/<sanitized_plugin_id>/`, writes an `InstalledPluginRecord` with `installed_at_unix_ms` / `updated_at_unix_ms`, enables by default.
- **enable / disable** — writes to `settings.json` under `enabledPlugins[plugin_id]`.
- **uninstall** — removes the install dir, removes the registry record, removes the `enabledPlugins` entry. Refuses to uninstall `PluginKind::Bundled`.
- **update** — re-materializes the stored `install_source`, reloads the manifest, replaces the install dir, bumps `version` + `updated_at_unix_ms`.
- **initialize / shutdown** — `PluginRegistry::initialize()` runs validation + init scripts for each enabled plugin in order; shutdown runs in reverse order. `BuiltinPlugin` no-ops both.

### Tool registration into the runtime

File: `tools/src/lib.rs` — `GlobalToolRegistry::with_plugin_tools(...)`.

- Takes `Vec<PluginTool>` from `PluginRegistry::aggregated_tools()`.
- Rejects plugin tools that collide with `mvp_tool_specs()` built-in names.
- Rejects duplicate plugin tool names across plugins.
- `definitions()` produces a single flat list to the model: builtin tools then runtime tools then plugin tools.
- `permission_specs()` maps `requiredPermission` string to `PermissionMode` (`read-only` → `ReadOnly`, etc.).
- `execute(name, input)` dispatches to `PluginTool::execute(input)`, which:
  - Runs `Command::new(self.command)` with args, pipes, and env:
    - `CLAWD_PLUGIN_ID`, `CLAWD_PLUGIN_NAME`, `CLAWD_TOOL_NAME`, `CLAWD_TOOL_INPUT` (JSON string)
    - `CLAWD_PLUGIN_ROOT` and sets `current_dir` to plugin root
  - Writes the input JSON to child stdin.
  - Returns trimmed stdout on success; stderr or exit-status as `PluginError::CommandFailed` on failure.

So from the runtime's point of view, a plugin tool is a dynamically-loaded-at-startup entry that looks identical to a built-in tool to the model, but executes as a subprocess pipe.

## 3. Skills

### "Manifest"

Skills don't have a JSON manifest. They are `SKILL.md` markdown files with
optional YAML frontmatter parsed ad hoc:

```markdown
---
name: my-skill
description: Human-readable summary
---
(skill prompt body…)
```

`parse_skill_frontmatter_value` only reads the first `---` block, only pulls
`name` and `description` (single-line, quoted or unquoted). Frontmatter is
optional — if the skill dir matches the requested name case-insensitively,
that's enough.

### Discovery paths

File: `tools/src/lib.rs` — `skill_lookup_roots()`.

For each ancestor of CWD: check `.omc/{skills,commands}`, `.agents/{skills,commands}`, `.claw/{skills,commands}`, `.codex/{skills,commands}`, `.claude/{skills,commands}`.

Then (from env vars, added in this order):

- `$CLAW_CONFIG_HOME/{skills,commands}`
- `$CODEX_HOME/{skills,commands}`
- `$HOME/{.omc,.claw,.codex,.claude}/{skills,commands}`
- `$HOME/.agents/skills`
- `$HOME/.config/opencode/skills`
- `$HOME/.claude/skills/omc-learned`
- `$CLAUDE_CONFIG_DIR/skills`, `$CLAUDE_CONFIG_DIR/skills/omc-learned`, `$CLAUDE_CONFIG_DIR/commands`
- Two hard-coded deployment paths: `/home/bellman/.claw/skills`, `/home/bellman/.codex/skills` (deployment-specific cruft; should not port)

Two directory shapes are supported:

- **SkillsDir**: `<root>/<skill-name>/SKILL.md` or any subdir whose folder-name or frontmatter-name matches (case-insensitive).
- **LegacyCommandsDir**: same as SkillsDir plus flat `<root>/<name>.md` markdown files.

First match wins across the ordered list. There is no caching — every `skill` tool invocation re-walks the disk.

### Invocation

Tool: `skill` (dispatched through `run_skill` → `execute_skill`).

- Input: `{ skill: string, args?: any }`.
- Resolver: walks `skill_lookup_roots()` in order, returns the first match.
- Output: a `SkillOutput { skill, path, args, description, prompt }` — just the markdown body plus the resolved path and the first frontmatter description.
- The runtime does NOT execute the skill — it returns the prompt text to the model, which is expected to follow the prompt in its next turn.

Important: skills are pure content expansion, not live handlers. This is unlike plugin tools (subprocess pipes) or MCP tools (remote JSON-RPC).

## 4. MCP

### Transport

Supported `McpServerConfig` variants (`McpClientTransport`): `Stdio`, `Sse`, `Http`, `WebSocket`, `Sdk`, `ManagedProxy` (the Claude.ai proxy wrapper with a `mcp_url=…` query param). But `McpServerManager` **only implements stdio** — the others are captured as `UnsupportedMcpServer { reason }` and surface as failed servers in the discovery report.

Stdio process framing is LSP-style:

```
Content-Length: N\r\n
\r\n
<N bytes of JSON-RPC payload>
```

`McpStdioProcess::spawn` pipes stdin + stdout, inherits stderr, applies the configured env, reads/writes framed JSON-RPC messages.

### Bootstrap and identity

`McpClientBootstrap::from_scoped_config(server_name, config)` produces:

- `server_name` (raw)
- `normalized_name` — alphanumeric + `_`/`-`, collapsed underscores for `claude.ai ` prefix
- `tool_prefix = "mcp__<normalized>__"`
- `signature` — stable stringified identity used for dedupe
- `transport` (typed variant)

Tool qualified name: `mcp__<normalized_server>__<normalized_tool>`. This is the name the model sees.

### Handshake & discovery

Per-server, via `McpServerManager::ensure_server_ready`:

1. **Spawn** — `spawn_mcp_stdio_process` (stdio only; other transports error cleanly).
2. **initialize** — send `{ protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "runtime", version: CARGO_PKG_VERSION } }`. Timeout 10 s (200 ms in tests).
3. **tools/list** — paginated via `cursor`. Timeout 30 s (300 ms in tests). Results become `ManagedMcpTool { server_name, qualified_name, raw_name, tool }`.
4. Tools populate `McpServerManager.tool_index` keyed by qualified name → `ToolRoute { server_name, raw_name }`.

`discover_tools_best_effort()` keeps going on per-server failures and returns `McpToolDiscoveryReport { tools, failed_servers, unsupported_servers, degraded_startup }`. `degraded_startup` lists working + failed servers and diffs expected vs available tool names.

Lifecycle phases (`McpLifecyclePhase`, hardened module): `ConfigLoad` → `ServerRegistration` → `SpawnConnect` → `InitializeHandshake` → `ToolDiscovery` → `ResourceDiscovery` → `Ready` → `Invocation` → `ErrorSurfacing` → `Shutdown` → `Cleanup`. Used for structured error reporting (`McpErrorSurface { phase, server_name, message, context, recoverable, timestamp }`).

### Resource listing and reads

- `list_resources(server_name)` → `resources/list` (paginated via cursor).
- `read_resource(server_name, uri)` → `resources/read` with params `{ uri }`.

Both retry once on retryable errors, and reset (kill + respawn + re-initialize) the server on hard failures.

### Tool dispatch (runtime → MCP)

- `McpServerManager::call_tool(qualified_tool_name, arguments)` looks up `ToolRoute`, ensures server ready, sends `tools/call { name: raw_name, arguments }` with a per-server timeout. Resets the server process on certain errors.
- Each call uses a fresh `next_request_id` (monotonic `u64` → `JsonRpcId::Number`).

### Tool bridge

`McpToolRegistry` (in `mcp_tool_bridge.rs`) is a **separate, stateful mirror** used by tool handlers:

- Stores `McpServerState { server_name, status, tools, resources, server_info, error_message }` in a `HashMap` behind `Arc<Mutex>`.
- Holds a weak ref (`Arc<OnceLock<Arc<Mutex<McpServerManager>>>>`) to the real manager.
- Exposes `list_resources / read_resource / list_tools / call_tool / set_auth_status / disconnect`.
- `call_tool` delegates to the manager on a dedicated thread with its own current-thread tokio runtime, calls `discover_tools().await`, then `call_tool`, then `shutdown` — combining into a single cross-thread JSON response.
- Status lifecycle: `Disconnected | Connecting | Connected | AuthRequired | Error`. Callers refuse ops unless `Connected`.

### Agent-visible MCP tools

From `tools/src/lib.rs` (`run_*` handlers):

| Tool | Method on registry | Behavior |
|---|---|---|
| `ListMcpResources` | `list_resources(server)` | server default `"default"` |
| `ReadMcpResource` | `read_resource(server, uri)` | |
| `McpAuth` | `get_server(server)` | reports status/server_info/tool_count/resource_count — does **not** drive an OAuth flow, just reports state |
| `MCP` | `call_tool(server, tool, arguments)` | generic invocation entry point |

Individual MCP tools from `discover_tools` are NOT automatically surfaced as top-level tools to the model in this flow — the model calls the generic `MCP` tool with `{server, tool, arguments}`. (The `mcp__<server>__<tool>` qualified names exist internally for routing in the manager.)

### Auth

`McpClientAuth::None | OAuth(McpOAuthConfig { client_id, callback_port, auth_server_metadata_url, xaa })`. Header-based auth comes from `headers` and `headers_helper` on remote transports. For stdio (the only implemented transport), env vars carry any secrets. The "complete OAuth" UX is not implemented in this slice — only declared in config types.

## 5. LSP

### Actions

```rust
enum LspAction {
  Diagnostics, Hover, Definition, References, Completion, Symbols, Format,
}
```

String aliases accepted by `LspAction::from_str`:

- `diagnostics`
- `hover`
- `definition` | `goto_definition`
- `references` | `find_references`
- `completion` | `completions`
- `symbols` | `document_symbols`
- `format` | `formatting`

### Dispatch shape

Single entry point: `LspRegistry::dispatch(action, path, line, character, query)`.

- Diagnostics: returns cached diagnostics for `path` (or all if path omitted). Does not trigger a fresh LSP pull.
- All other actions: require `path`, look up a server via `find_server_for_path` (fixed extension → language map: `rs`→rust, `ts|tsx`→typescript, `js|jsx`→javascript, `py`→python, `go`→go, `java`→java, `c|h`→c, `cpp|hpp|cc`→cpp, `rb`→ruby, `lua`→lua). Fail if the server isn't `Connected`.
- Currently returns a **structured placeholder** response — the real JSON-RPC call into the LSP process is not implemented. The dispatch surface, registry, and tool schema are in place; the wire-level integration is the stub.

### Registry model

```rust
struct LspServerState {
  language: String,
  status: LspServerStatus,   // Connected | Disconnected | Starting | Error
  root_path: Option<String>,
  capabilities: Vec<String>,
  diagnostics: Vec<LspDiagnostic>,
}
```

Operations: `register`, `get`, `find_server_for_path`, `list_servers`, `add_diagnostics`, `get_diagnostics(path)`, `clear_diagnostics(language)`, `disconnect`, `len/is_empty`.

Diagnostics aren't scoped to a file by structure — the registry scans all servers and filters by `path` string match. Input types are normalized (`LspDiagnostic`, `LspLocation`, `LspHoverResult`, `LspCompletionItem`, `LspSymbol`).

Tool surface (`run_lsp`): a single generic `lsp` tool takes `{ action, path?, line?, character?, query? }` and delegates to `dispatch`. Tier-4 breaks this into `lsp_diagnostics`, `lsp_hover`, etc. — claw's plumbing is one dispatch; the split is a UX choice at the tool-spec layer.

## 6. Requirements for swarm-coder

### Plugins

- [v0] Support **one source** (Claude-Code layout): read `plugin.json` or `.claude-plugin/plugin.json`, support `name / version / description / permissions / defaultEnabled / hooks / tools / commands`.
- [v0] Discovery paths: bundled (builtin in-process), `<config_home>/plugins/installed/*`, and user-configurable external dirs.
- [v0] `PluginSource.discover() -> PluginManifest[]` and `load(id) -> LoadedPlugin` (where `LoadedPlugin` includes tool specs and init/shutdown hooks). Keep the source adapter responsible for manifest parsing so new layouts only need a new adapter.
- [v0] Plugin tool execution via subprocess with JSON stdin and a well-defined env contract (`SWARM_PLUGIN_ID`, `SWARM_PLUGIN_NAME`, `SWARM_TOOL_NAME`, `SWARM_TOOL_INPUT`, `SWARM_PLUGIN_ROOT`).
- [v0] Conflict check: plugin tool names must not collide with tier-0 tools and must be unique across sources.
- [v0] `enable / disable` persistence in `settings.json` (`enabledPlugins: { id: bool }`).
- [v1] `install` / `update` / `uninstall` flows with a registry file (`installed.json`) that tracks `(source, install_path, installed_at, updated_at, version)` per plugin.
- [v1] Bundled-plugin auto-sync with drift detection (version / description change → resync).
- [v1] Claude-Code-contract rejection for unsupported fields (`skills` / `mcpServers` / `agents` / directory-glob commands / non-standard hook names) — with clear error messages.
- [v1] Multiple `PluginSource` registry (ordered, first match wins on load, union on discover).
- [later] GitUrl `PluginInstallSource`; remote marketplaces.
- [skip] Bespoke `/home/bellman/...` deploy paths.

### Skills

- [v0] `SkillSource.discover()` walks a priority-ordered path list; `load(id)` returns the `SKILL.md` body + parsed `name` / `description` frontmatter.
- [v0] Path list from CWD ancestors: `.omc/skills`, `.agents/skills`, `.claw/skills`, `.claude/skills`, and legacy `/commands` siblings of each.
- [v0] Path list from env vars: `$CLAW_CONFIG_HOME`, `$CODEX_HOME`, `$CLAUDE_CONFIG_DIR`, `$HOME/.{omc,agents,claw,codex,claude}`.
- [v0] Support both shapes: `<root>/<skill>/SKILL.md` and legacy flat `<root>/<name>.md`.
- [v0] Case-insensitive match on folder name OR frontmatter `name:`.
- [v0] Skill invocation is pure content expansion — returns the prompt text to the model; the model decides what to do.
- [v0] First-match-wins across ordered sources.
- [v1] Multiple `SkillSource`s stacked with source-id disambiguation.
- [later] Discovery caching with inotify-style invalidation (claw re-walks every call).
- [skip] Hard-coded deploy paths (`/home/bellman/...`).

### MCP (Tier 4)

- [v0] Stdio transport only, `initialize` / `tools/list` / `tools/call` / `resources/list` / `resources/read`.
- [v0] LSP-style `Content-Length`-framed JSON-RPC, protocol version `"2025-03-26"`, client info `{ name: "swarm-coder", version }`.
- [v0] Per-server `tool_call_timeout_ms`; defaults around 10 s initialize / 30 s list / 60 s call.
- [v0] Qualified tool naming `mcp__<normalized>__<tool>` with identical normalization rules (alphanumeric + `_`/`-`, underscore collapse for `claude.ai ` prefix).
- [v0] `McpToolRegistry`-style mirror so tool handlers read status without racing the manager.
- [v0] Generic agent-facing tools: `mcp__list_resources`, `mcp__read_resource`, `mcp__auth`, plus a generic `mcp__call_tool` (or expose each MCP tool as a first-class tool — open question below).
- [v0] Degraded-startup reporting: partial success should not fail the whole agent; expose a `degraded_startup` report.
- [v1] SSE / HTTP remote transports.
- [v1] OAuth auth flow (config shape already defined in claw; flow not implemented).
- [v1] Managed-proxy / Claude.ai URL unwrap for dedupe.
- [later] WebSocket transport.
- [later] SDK-embedded MCP servers.

### LSP (Tier 4)

- [v0] Typed `LspRegistry` by language with status `Connected | Disconnected | Starting | Error`.
- [v0] Single internal `dispatch(action, path, line, character, query)` surface; split into per-action tools (`lsp_diagnostics`, `lsp_hover`, `lsp_definition`, `lsp_references`, `lsp_symbols`, `lsp_format`, `lsp_completion`) at the tool-spec layer.
- [v0] Extension→language mapping for file-path routing.
- [v0] Diagnostic cache on the registry (fast `lsp_diagnostics`).
- [v1] Real LSP JSON-RPC implementation (claw has only the dispatch shape wired up, not the wire calls).
- [v1] Workspace / project roots configuration, multi-root servers.
- [later] Code actions, rename, semantic tokens.

## 7. Open questions

1. **`PluginSource.load` return shape.** claw's `RegisteredPlugin` carries
   metadata, hooks, lifecycle commands, and tools all together. Should
   swarm-coder's `LoadedPlugin` also bundle hooks + lifecycle + tools, or split
   tools onto a separate `ToolSource` abstraction? Leaning: bundle into
   `LoadedPlugin` since they share the plugin-root context (env vars, cwd).

2. **Single `Source` trait vs separate `PluginSource` / `SkillSource`.** They
   have similar discover/load shapes but their loaded artifacts are very
   different (subprocess tool spec vs. prompt text). claw kept them fully
   separate. Proposal: keep two traits and resist the DRY temptation — the
   `SkillManifest` vs `PluginManifest` divergence will only grow.

3. **Should MCP tools become first-class tools (like in Claude Code, where they
   show up as `mcp__server__tool` in the model's tool list) or only be
   accessible through a generic `mcp__call_tool` (as claw does)?** First-class
   is better UX for the model but explodes the deferred-tool list. claw's
   design uses `ToolSearch` to keep that list tractable. Lean: first-class with
   deferred-registration (see `ToolSearch` in claw) — the `PluginSource` /
   `SkillSource` pattern suggests an `McpSource` may also belong in the
   hierarchy.

4. **Is `MCP` a third `Source` (`McpSource.discover()` returns servers, `load(id)`
   returns a `ConnectedMcpServer`)?** This would unify the seam. Counterpoint:
   MCP has live connection lifecycle (initialize / shutdown / reconnect) that
   `PluginSource.load()` does not model. Might need a `ConnectionSource`
   variant or an explicit `connect()` phase.

5. **Skills as a `Source` that returns prompt strings — is that the right
   abstraction?** It conflates discovery (file on disk) with execution (prompt
   injection). Cleaner alternative: `SkillSource` returns a `Skill` whose
   `invoke()` returns prompt text. That keeps invocation a seam and lets future
   `Skill` implementations do live expansion (env interpolation, subagent
   prelude) without changing the source contract.

6. **Plugin / skill ID collisions across sources.** claw errors on duplicate
   plugin tool names globally. For multi-source discovery, swarm-coder's
   "source-id disambiguation" (`03-interfaces.md`) needs a concrete collision
   policy: warn + last-wins, error + refuse-to-start, or exposed both with
   prefix. Lean: error on tool-name collisions (the model can't disambiguate
   two tools named the same), allow skill/plugin metadata ID collisions (just
   pick first-match-wins).

7. **`.claude.json` vs `settings.json`.** claw-code has two locations in
   different READMEs (`.claude.json` in outer, `.claw.json` in rust/CLAUDE.md).
   swarm-coder should pick one canonical name (suggest `.swarm.json` or just
   `settings.json` under a config home) and document it upfront.

8. **Bundled plugins — ship in npm package, or separate optional install?**
   claw ships `crates/plugins/bundled/` compiled in. For a TypeScript harness,
   bundling in the npm tarball is the equivalent. Open: how to version bundled
   plugins independently of the harness.

## 8. File references

claw-code sources (all under `references/claw-code/`):

- `rust/crates/runtime/src/mcp.rs` — name normalization, signature hashing, `mcp_tool_name` / `mcp_tool_prefix`, CCR-proxy URL unwrap.
- `rust/crates/runtime/src/mcp_client.rs` — `McpClientBootstrap`, typed transport enum, `McpClientAuth`.
- `rust/crates/runtime/src/mcp_stdio.rs` — the big one: `McpServerManager`, `McpStdioProcess`, JSON-RPC framing, `initialize` / `tools/list` / `tools/call` / `resources/list` / `resources/read`, retry + reset logic, `McpToolDiscoveryReport`.
- `rust/crates/runtime/src/mcp_server.rs` — minimal MCP **server** (claw exposing its own tools to external MCP clients). Same LSP framing, `serve` loop.
- `rust/crates/runtime/src/mcp_tool_bridge.rs` — `McpToolRegistry`, the stateful mirror for tool handlers. Includes a working test harness with a Python MCP server fixture.
- `rust/crates/runtime/src/mcp_lifecycle_hardened.rs` — `McpLifecyclePhase`, `McpErrorSurface`, `McpDegradedReport`, `McpLifecycleValidator`.
- `rust/crates/runtime/src/lsp_client.rs` — `LspRegistry`, `LspAction`, typed result structs, `dispatch(action, path, line, character, query)`.
- `rust/crates/runtime/src/plugin_lifecycle.rs` — `PluginLifecycle` trait, `PluginState`, `PluginHealthcheck`, `DegradedMode`, `ServerHealth` (wraps plugin + MCP server health for a unified view).
- `rust/crates/plugins/src/lib.rs` — entire plugin subsystem (~2000 lines): manifest types, `PluginManager` install/update/uninstall, bundled auto-sync, tool-execution subprocess glue, Claude-Code-contract rejection.
- `rust/crates/plugins/bundled/example-bundled/.claude-plugin/plugin.json` — concrete example manifest with hooks.
- `rust/crates/plugins/bundled/sample-hooks/.claude-plugin/plugin.json` — second example.
- `rust/crates/tools/src/lib.rs`:
  - Lines ~60–370 — `GlobalToolRegistry` with plugin / runtime / builtin tool merge, name-collision guards, `definitions()` flat list to the model.
  - Lines ~1656–1742 — `run_lsp`, `run_list_mcp_resources`, `run_read_mcp_resource`, `run_mcp_auth`, `run_mcp_tool`.
  - Lines ~3176–3471 — `execute_skill`, `skill_lookup_roots()`, `resolve_skill_path_in_skills_dir`, `resolve_skill_path_in_legacy_commands_dir`, frontmatter parser.
