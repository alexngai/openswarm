# 02 — Tools, Bash Validation, Sandbox (claw-code Rust → openswarm)

Research extract from `references/claw-code/rust/crates/tools/src/lib.rs` and the `runtime/` crate. Focus is pure-execution tools: `bash`, file ops, search, `web_fetch`/`web_search`, `todo_write`, `notebook_edit`, `structured_output`, `repl`, `sleep`, `ask_user_question`, plus the bash validation / sandbox infrastructure that wraps them. MCP, LSP, plugin, skill, task/team/cron/worker surfaces are deliberately out of scope.

## 1. Summary

claw-code exposes a single flat `mvp_tool_specs()` table (~47 ToolSpecs) each carrying `{name, description, input_schema, required_permission}` and a central `execute_tool` dispatch in `tools/src/lib.rs`. There is no tiering; gating is a single 4-level `PermissionMode` enum (`ReadOnly`, `WorkspaceWrite`, `DangerFullAccess`, plus `Allow`/`Prompt` for legacy paths). Pure-execution tools split clearly by permission:

- Read-level: `read_file`, `glob_search`, `grep_search`, `WebFetch`, `WebSearch`, `StructuredOutput`, `Sleep`, `AskUserQuestion`, `SendUserMessage`/`Brief`
- Workspace-write: `write_file`, `edit_file`, `TodoWrite`, `NotebookEdit`, `Config`, `EnterPlanMode`/`ExitPlanMode`
- Danger-full-access: `bash`, `REPL`, `PowerShell`

`bash` gets a dynamic permission classifier (`classify_bash_permission`) that drops commands starting with a known read-only binary and targeting workspace-local paths down to `WorkspaceWrite`. The bash-validation crate implements six upstream submodules (read-only, destructive warning, mode, sed, path, semantics) plus a `validate_command` pipeline, but — critical finding — these validators are *never wired into* `execute_bash` or `run_bash`; they exist as importable library code and are only exercised by unit tests. The only actual pre-flight gating in `run_bash` is the `workspace_test_branch_preflight` that blocks `cargo test --workspace` when the branch is stale vs `main`.

File ops enforce 10 MiB read/write caps, NUL-byte binary detection on read, and canonical-path workspace boundary + symlink-escape helpers (also gated behind `*_in_workspace` wrappers that the main `execute_tool` path does NOT call).

Sandbox (runtime/src/sandbox.rs) is Linux-only and probes `unshare --user --map-root-user true` at startup (memoized in a `OnceLock`); on success it wraps bash via `unshare --user --map-root-user --mount --ipc --pid --uts --fork [--net]` with `HOME` and `TMPDIR` rewritten to `$cwd/.sandbox-home` / `$cwd/.sandbox-tmp`. macOS/Windows fall back to plain `sh -lc` with no isolation beyond `HOME`/`TMPDIR` redirection. Container detection inspects `/.dockerenv`, `/run/.containerenv`, env keys (`container`, `docker`, `podman`, `KUBERNETES_SERVICE_HOST`), and `/proc/1/cgroup` markers.

Notable gaps / surprises: the bash validation pipeline is dead code in practice, there is no `multi_edit` tool, `pdf_extract` is a runtime module but **not** exposed as an MVP tool, `AskUserQuestion` blocks on stdin (not surfaced via UI), bash stdout/stderr are each truncated to 16 KiB with an inline marker, and `web_fetch` force-upgrades http → https for non-localhost hosts.

## 2. Tool catalog

### 2.1 `bash`

- File: `runtime/src/bash.rs`, dispatched via `tools/src/lib.rs` `run_bash`.
- `required_permission` declared: `DangerFullAccess`, but `classify_bash_permission` may downgrade to `WorkspaceWrite` at runtime.
- Input (`BashCommandInput`):
  - `command: string` (required)
  - `timeout: integer ms` (optional; no declared default — unbounded if omitted)
  - `description: string` (optional, model hint)
  - `run_in_background: bool` (optional)
  - `dangerouslyDisableSandbox: bool`
  - `namespaceRestrictions: bool`
  - `isolateNetwork: bool`
  - `filesystemMode: "off" | "workspace-only" | "allow-list"`
  - `allowedMounts: string[]`
- Output (`BashCommandOutput`): `stdout`, `stderr`, `rawOutputPath?`, `interrupted`, `isImage?`, `backgroundTaskId?`, `backgroundedByUser?`, `assistantAutoBackgrounded?`, `dangerouslyDisableSandbox?`, `returnCodeInterpretation? ("timeout" | "exit_code:N" | "preflight_blocked:branch_divergence")`, `noOutputExpected?`, `structuredContent?` (lane events), `persistedOutputPath?`, `persistedOutputSize?`, `sandboxStatus?`
- Edge cases:
  - Background mode returns immediately with a PID as `backgroundTaskId`; stdout/stderr/stdin are all null-piped.
  - Synchronous timeout returns `interrupted=true`, `returnCodeInterpretation="timeout"`, empty stdout.
  - Stdout/stderr truncated to `MAX_OUTPUT_BYTES = 16_384` with `"\n\n[output truncated — exceeded 16384 bytes]"` appended; truncation respects UTF-8 char boundaries.
  - On Linux with namespaces available, runs inside `unshare` (see §4).
  - `detect_and_emit_ship_prepared`: naive string match on `git push` + `main|master` emits a `ship.prepared` lane event to stderr (no parsing; false positives likely).
  - `workspace_test_branch_preflight` intercepts `cargo test --workspace`, `cargo test --all`, `cargo nextest run --workspace|--all` and blocks execution if the current branch is stale/diverged vs `main` (or `origin/main`), returning a fabricated `BashCommandOutput` with `return_code_interpretation="preflight_blocked:branch_divergence"` and a `BranchStaleAgainstMain` lane event.
  - Permission classifier: first token must be in a small read-only set (`cat head tail less more ls ll dir find test [ [[ grep rg awk sed file stat readlink wc sort uniq cut tr pwd echo printf`) AND `has_dangerous_paths` must be false (any `/…` or `~/…` not inside CWD, or `../..` traversal) to downgrade to `WorkspaceWrite`.
  - Shell is `sh -lc <command>` (login shell); on Linux sandbox path it's `unshare … sh -lc <command>`.

### 2.2 `read_file`

- File: `runtime/src/file_ops.rs::read_file`
- Permission: `ReadOnly`
- Input: `{ path: string, offset?: integer≥0, limit?: integer≥1 }`
- Output envelope `ReadFileOutput`: `type: "text"`, `file: { filePath, content, numLines, startLine (1-indexed), totalLines }`
- Edge cases:
  - `MAX_READ_SIZE = 10 * 1024 * 1024` (10 MiB); larger files return `InvalidData`.
  - Binary detection: reads first 8 KiB, fails with `InvalidData: "file appears to be binary"` if any NUL byte is present.
  - Paths normalized via `fs::canonicalize` (so symlinks are resolved, nonexistent paths fail).
  - `offset`/`limit` are **line-based**, not byte. `offset` clamps at `lines.len()`; selected window joined with `\n`.
  - No workspace boundary check in the dispatch path. The module defines `read_file_in_workspace` + `validate_workspace_boundary` + `is_symlink_escape` helpers, but `run_read_file` calls the unguarded `read_file`.

### 2.3 `write_file`

- File: `runtime/src/file_ops.rs::write_file`
- Permission: `WorkspaceWrite`
- Input: `{ path: string, content: string }`
- Output (`WriteFileOutput`): `type: "create" | "update"`, `filePath`, `content`, `structuredPatch: StructuredPatchHunk[]`, `originalFile?`, `gitDiff?`
- Edge cases:
  - `MAX_WRITE_SIZE = 10 * 1024 * 1024` (10 MiB).
  - `normalize_path_allow_missing` — canonicalizes parent if target file does not yet exist.
  - Auto-creates parent directories (`fs::create_dir_all`).
  - Patch generator is naive (all old lines as `-`, all new lines as `+`; not a real diff).
  - No workspace boundary check in dispatch path (wrapper `write_file_in_workspace` exists but is unused).

### 2.4 `edit_file`

- File: `runtime/src/file_ops.rs::edit_file`
- Permission: `WorkspaceWrite`
- Input: `{ path: string, old_string: string, new_string: string, replace_all?: bool }` (default `replace_all=false`, first occurrence only).
- Output (`EditFileOutput`): `filePath`, `oldString`, `newString`, `originalFile`, `structuredPatch`, `userModified: false`, `replaceAll`, `gitDiff?`
- Edge cases:
  - Rejects if `old_string == new_string` (`InvalidInput`).
  - Rejects if `old_string` not present (`NotFound`).
  - No uniqueness check when `replace_all=false`; silently replaces first match even if ambiguous (Claude Code's reference harness tracks this differently).
  - Workspace-bounded variant exists but is not dispatched.

### 2.5 `glob_search`

- File: `runtime/src/file_ops.rs::glob_search`
- Permission: `ReadOnly`
- Input: `{ pattern: string, path?: string }`
- Output: `{ durationMs, numFiles, filenames: string[], truncated: bool }`
- Edge cases:
  - Brace expansion implemented in-process (`expand_braces`) — one level only, nested braces recursed; unmatched `{` treated as literal.
  - Results sorted by mtime descending.
  - Hard cap 100 files (`truncated=true` when exceeded).
  - Uses `glob` crate; no gitignore awareness.

### 2.6 `grep_search`

- File: `runtime/src/file_ops.rs::grep_search`
- Permission: `ReadOnly`
- Input (`GrepSearchInput`): `pattern` (required), `path?`, `glob?`, `output_mode?` (`files_with_matches` default, `content`, `count`), `-B/-A/-C/context?`, `-n?` (line numbers, default true), `-i?` (case insensitive), `type?` (extension match), `head_limit?` (default 250), `offset?`, `multiline?`
- Output: `mode?`, `numFiles`, `filenames[]`, `content?`, `numLines?`, `numMatches?`, `appliedLimit?`, `appliedOffset?`
- Edge cases:
  - Uses `walkdir::WalkDir` to collect all files recursively — no gitignore, no binary-skip, no concurrency. NOT ripgrep-backed despite the tool-tier doc suggesting so.
  - Regex via `regex::RegexBuilder`; `multiline` flips `dot_matches_new_line`.
  - Context lines unpacked inline; limits applied after collection.
  - `head_limit=0` means unlimited; otherwise truncate and report `appliedLimit`.

### 2.7 `WebFetch`

- File: `tools/src/lib.rs::execute_web_fetch`
- Permission: `ReadOnly`
- Input: `{ url: uri, prompt: string }`
- Output (`WebFetchOutput`): `{ bytes, code, codeText, result, durationMs, url }`
- Edge cases:
  - Auto-upgrades `http://` → `https://` for any host that isn't `localhost`/`127.0.0.1`/`::1`.
  - `reqwest::blocking::Client` with 20 s timeout, max 10 redirects, UA `clawd-rust-tools/0.1`.
  - HTML → text is a hand-rolled tag stripper + limited entity decoder (`&amp; &lt; &gt; &quot; &#39; &nbsp;` only).
  - Prompt drives one of three heuristic paths: "title" → `<title>` extraction, "summary"/"summarize" → 900-char preview, else `Prompt: … Content preview: <900 chars>`.
  - No caching, no auth, no header passthrough.

### 2.8 `WebSearch`

- File: `tools/src/lib.rs::execute_web_search`
- Permission: `ReadOnly`
- Input: `{ query: string (min 2), allowed_domains?: string[], blocked_domains?: string[] }`
- Output (`WebSearchOutput`): `{ query, results: [Commentary(summary), SearchResult{tool_use_id, content: SearchHit[]}], durationSeconds }`
- Edge cases:
  - Backend: `CLAWD_WEB_SEARCH_BASE_URL` env override; default is `https://html.duckduckgo.com/html/?q=…`. HTML-scraped.
  - `decode_duckduckgo_redirect` unwraps `/l/?uddg=<real-url>` redirects.
  - `host_matches_list` normalizes domain filters and supports subdomain match (`example.com` matches `foo.example.com`).
  - Dedupes by URL; caps at 8 hits.
  - Fragile: depends on DDG HTML structure.

### 2.9 `TodoWrite`

- File: `tools/src/lib.rs::execute_todo_write`
- Permission: `WorkspaceWrite`
- Input: `{ todos: [{ content, activeForm, status: "pending"|"in_progress"|"completed" }] }`
- Output: `{ old_todos, new_todos, verification_nudge_needed? }`
- Edge cases:
  - Persisted to a per-session JSON file (`todo_store_path`).
  - When all todos are `completed`, file is written as empty array (reset).
  - If ≥3 todos all completed with no "verif" in any content, emits `verification_nudge_needed=true`.
  - Rejects empty list or empty content strings.
  - Multiple `in_progress` items allowed (parallel workflows).

### 2.10 `NotebookEdit`

- File: `tools/src/lib.rs::execute_notebook_edit`
- Permission: `WorkspaceWrite`
- Input: `{ notebook_path, cell_id?, new_source?, cell_type?: "code"|"markdown", edit_mode?: "replace"|"insert"|"delete" }` (default `replace`)
- Output (`NotebookEditOutput`): `{ new_source, cell_id?, cell_type?, language, edit_mode, error?, notebook_path, original_file, updated_file }`
- Edge cases:
  - Requires `.ipynb` extension.
  - Reads language from `metadata.kernelspec.language` (default `"python"`).
  - Insert: if `cell_id` omitted, appends to end; if provided, inserts *after* that cell.
  - Replace/delete require a resolvable cell index.
  - New cells get synthetic `id = "cell-<len>"` via `make_cell_id`.
  - Always rewrites file with `serde_json::to_string_pretty` (may reformat adjacent cells).

### 2.11 `StructuredOutput`

- Permission: `ReadOnly`
- Input: free-form JSON object (any keys).
- Output: `{ data: "Structured output provided successfully", structured_output: <echoed payload> }`
- Edge cases: rejects empty object. Purely a sink — doesn't validate against a schema.

### 2.12 `REPL`

- File: `tools/src/lib.rs::execute_repl`
- Permission: `DangerFullAccess`
- Input: `{ code: string, language: string, timeout_ms?: integer≥1 }`
- Output: `{ language, stdout, stderr, exit_code, duration_ms }`
- Edge cases:
  - Languages: `python`/`py` → `python3` or `python` + `-c`; `javascript`/`js`/`node` → `node -e`; `sh`/`shell`/`bash` → `bash`/`sh` + `-lc`.
  - Runtime resolved via `detect_first_command` walking `PATH`.
  - Timeout loop polls `try_wait` every 10 ms, kills on expiry.
  - Not persistent — every call spawns a fresh subprocess; "REPL" name is misleading.
  - Stdin null-piped.

### 2.13 `Sleep`

- Permission: `ReadOnly`
- Input: `{ duration_ms: integer≥0 }`
- Output: `{ duration_ms, message: "Slept for {n}ms" }`
- Edge cases: cap `MAX_SLEEP_DURATION_MS = 300_000` (5 min); exceeding returns error. Uses blocking `std::thread::sleep`.

### 2.14 `AskUserQuestion`

- Permission: `ReadOnly`
- Input: `{ question: string, options?: string[] }`
- Output: `{ question, answer, status: "answered" }`
- Edge cases:
  - Writes prompt to stdout, reads a line from stdin. If `options` given, parses numeric index (1-based) into the corresponding option string; otherwise returns the raw line.
  - Blocking and terminal-bound — not suitable for programmatic or server-driven hosts without a host-provided adapter.

### 2.15 `SendUserMessage` / `Brief`

- Permission: `ReadOnly`
- Input: `{ message: string, attachments?: string[], status: "normal"|"proactive" }`
- Output: `{ message, attachments?, sent_at }`
- Edge cases: canonicalizes attachment paths, detects image extensions (`png jpg jpeg gif webp bmp svg`). No transport — output is returned to the caller who must surface it.

### 2.16 `ToolSearch`

- Permission: `ReadOnly`
- Input: `{ query: string, max_results?: integer≥1 }`
- Output: matches from `deferred_tool_specs()` (tools hidden behind on-demand schema loading).
- Note: openswarm's tier model implicitly handles deferred tool discovery via its tool registry; direct port may not be needed.

### 2.17 (Excluded from this slice, listed for completeness)

`Skill`, `Agent`, `TaskCreate`/`RunTaskPacket`/`TaskGet`/`TaskList`/`TaskStop`/`TaskUpdate`/`TaskOutput`, `Worker*` (8 tools), `TeamCreate`/`TeamDelete`, `CronCreate`/`CronDelete`/`CronList`, `LSP`, `ListMcpResources`/`ReadMcpResource`/`McpAuth`/`MCP`, `RemoteTrigger`, `PowerShell`, `Config`, `EnterPlanMode`/`ExitPlanMode`, `TestingPermission`.

## 3. Bash validation matrix

Source: `runtime/src/bash_validation.rs` (1004 LOC). The upstream Claude Code `BashTool` validation pipeline is **fully implemented as a library** but **not wired into `execute_bash`** in the current claw-code build. The only pre-flight gating actually invoked by `run_bash` is `workspace_test_branch_preflight`.

| Submodule | Function | Implemented? | Wired into `run_bash`? | Gates on |
|---|---|---|---|---|
| `readOnlyValidation` | `validate_read_only(command, mode)` | Yes | No | `PermissionMode::ReadOnly` only; blocks `WRITE_COMMANDS` (18 entries: cp, mv, rm, mkdir, rmdir, touch, chmod, chown, chgrp, ln, install, tee, truncate, shred, mkfifo, mknod, dd), `STATE_MODIFYING_COMMANDS` (34 entries: apt, yum, brew, pip, npm, cargo, docker, systemctl, kill, crontab, …), shell write redirections (`>`, `>>`, `>&`), `sudo <inner>` recursion, git non-whitelisted subcommands |
| `destructiveCommandWarning` | `check_destructive(command)` | Yes | No | `Warn` on: `rm -rf /`, `rm -rf ~`, `rm -rf *`, `rm -rf .`, `mkfs`, `dd if=`, `> /dev/sd`, `chmod -R 777`, `chmod -R 000`, fork bomb literal `:(){ :|:& };:`; always-destructive commands `shred`, `wipefs`; any generic `rm -r -f` |
| `modeValidation` | `validate_mode(command, mode)` | Yes | No | Dispatches to `validate_read_only` in RO mode; warns in `WorkspaceWrite` when write commands target `/etc /usr /var /boot /sys /proc /dev /sbin /lib /opt`. `DangerFullAccess`/`Allow`/`Prompt` unconditionally allow. |
| `sedValidation` | `validate_sed(command, mode)` | Yes | No | In `ReadOnly`, blocks `sed -i`. Otherwise allow. |
| `pathValidation` | `validate_paths(command, workspace)` | Yes | No | Warns on `../` that doesn't resolve within workspace string, and on any `~/` or `$HOME` reference. |
| `commandSemantics` | `classify_command(command)` | Yes | No | Returns `CommandIntent: ReadOnly/Write/Destructive/Network/ProcessManagement/PackageManagement/SystemAdmin/Unknown`. Classifier tables: `SEMANTIC_READ_ONLY_COMMANDS` (~60), `NETWORK_COMMANDS` (~19), `PROCESS_COMMANDS` (~14), `PACKAGE_COMMANDS` (~19), `SYSTEM_ADMIN_COMMANDS` (~27). Special cases: `sed -i` → Write; `rm` → Destructive; bare `git` dispatches to `GIT_READ_ONLY_SUBCOMMANDS` list. |
| pipeline | `validate_command(command, mode, workspace)` | Yes | No | Runs mode → sed → destructive → path in that order; first non-`Allow` wins. |

Helpers: `extract_first_command` strips leading `KEY=val` env assignments and handles quoted values; `extract_sudo_inner` skips sudo flags to find the real command.

**Implication for openswarm:** We can lift these lists and algorithms verbatim into TypeScript, and we should actually wire them into the bash-execution critical path (unlike claw-code). `classify_command` plus a `validate_command` pre-flight is enough to drive the downgrade logic that `classify_bash_permission` is attempting more crudely in the `run_bash` path.

A separate, narrower classifier lives at `tools/src/lib.rs::classify_bash_permission` (lines 1844-1874) and *is* wired into dispatch — it is a duplicate, stricter-but-shallower reimplementation. If both are ported, decide which owns runtime dispatch vs diagnostics.

## 4. Sandbox model

Source: `runtime/src/sandbox.rs` (385 LOC).

Core types:

- `FilesystemIsolationMode`: `Off` | `WorkspaceOnly` (default) | `AllowList`
- `SandboxConfig`: all fields `Option` so can come from config file; `allowed_mounts: Vec<String>`
- `SandboxRequest`: resolved config + per-invocation overrides from `BashCommandInput`
- `SandboxStatus`: the final effective state, including support/active breakdown and `fallback_reason`
- `ContainerEnvironment`: `{ in_container, markers[] }`
- `LinuxSandboxCommand`: `{ program: "unshare", args, env }`

Probing & detection:

- `unshare_user_namespace_works()` (memoized `OnceLock`): runs `unshare --user --map-root-user true` at first use; success means user namespaces are usable (CI envs like GH Actions often fail here silently). Caches verdict for process lifetime.
- `detect_container_environment()` looks at:
  - File markers: `/.dockerenv`, `/run/.containerenv`
  - Env vars: `container`, `docker`, `podman`, `KUBERNETES_SERVICE_HOST` (case-insensitive, non-empty)
  - `/proc/1/cgroup` substrings: `docker`, `containerd`, `kubepods`, `podman`, `libpod`
  - Markers sorted, deduped.
- `namespace_supported = cfg!(target_os = "linux") && unshare_user_namespace_works()`; `network_supported = namespace_supported`.
- `filesystem_active = request.enabled && mode != Off`.
- Fallback reasons collected when namespace/network requested but unavailable, or when `AllowList` mode has no mounts.

Wrapping:

- `build_linux_sandbox_command` returns `None` on non-Linux or when `status.enabled==false` or when neither namespace nor network isolation is active — bash then falls through to plain `sh -lc`.
- When active, the launcher is `unshare --user --map-root-user --mount --ipc --pid --uts --fork [--net] sh -lc "<command>"`.
- Env injected: `HOME=<cwd>/.sandbox-home`, `TMPDIR=<cwd>/.sandbox-tmp`, `CLAWD_SANDBOX_FILESYSTEM_MODE=<mode>`, `CLAWD_SANDBOX_ALLOWED_MOUNTS=<colon-joined>`, plus pass-through `PATH`.
- `prepare_sandbox_dirs(cwd)` creates `.sandbox-home` and `.sandbox-tmp` lazily on each invocation.
- `normalize_mounts` absolutizes relative mount paths against cwd.

Non-Linux behavior:

- On macOS/Windows, `build_linux_sandbox_command` returns `None` → bash runs as raw `sh -lc`; the only "sandboxing" is `HOME`/`TMPDIR` redirection when `filesystem_active`. This is effectively no isolation.

Per-call overrides (in `BashCommandInput`):

- `dangerouslyDisableSandbox: bool`
- `namespaceRestrictions: bool`
- `isolateNetwork: bool`
- `filesystemMode: FilesystemIsolationMode`
- `allowedMounts: string[]`

All fold into `SandboxConfig::resolve_request` which merges per-call overrides on top of config file defaults.

## 5. Requirements for openswarm

Tags: [v0] ship in Tier 0 MVP · [v1] Tier 1-2 · [later] Tier 3-5 · [skip] not worth porting.

### Tools (mapped to tier catalog)

- **[v0] Tier 0 `bash`** — Port `BashCommandInput/Output`, 16 KiB stdout/stderr truncation with UTF-8-safe cut, timeout returning `{interrupted, returnCodeInterpretation:"timeout"}`, background mode returning `backgroundTaskId`. Wire validation pipeline into the execute path (see sandbox/bash section below).
- **[v0] Tier 0 `read_file`** — `MAX_READ_SIZE=10MiB`, NUL-byte-in-first-8KiB binary detection, line-based `offset`/`limit`, canonicalized absolute path, return `{type:"text", file:{filePath, content, numLines, startLine, totalLines}}`. **Additionally wire `validate_workspace_boundary`/`is_symlink_escape`** (the claw-code helpers that are defined but not called).
- **[v0] Tier 0 `write_file`** — `MAX_WRITE_SIZE=10MiB`, auto-create parents, return `type:"create"|"update"` plus original content. Wire the same workspace boundary check. Drop the naive "all `-` all `+`" patch — either use a real diff library or omit `structuredPatch` in v0.
- **[v0] Tier 0 `edit_file`** — Exact-string replace (first occurrence or all), reject equal strings, reject missing substring. **Add uniqueness check** when `replace_all=false` (claw-code silently replaces first match; Claude Code proper errors). Return `originalFile` for undo/telemetry.
- **[v0] Tier 0 `glob`** — Brace expansion, mtime-desc sort, 100-file cap, `truncated` flag. Skip gitignore for v0 but note it as a productivity enhancement.
- **[v0] Tier 0 `grep`** — For v0 we should prefer shelling out to `rg` if available (matches doc claim "ripgrep-backed") and fall back to an in-process walkdir+regex matching claw-code's behavior. Port the output-mode triad (`files_with_matches` default, `content`, `count`), `head_limit=250` default, `-A/-B/-C/context`, `multiline`, `type`, `glob`.
- **[v0] Tier 0 `todo_write`** — Persist JSON per-session, reset-on-all-completed semantics, `verification_nudge_needed` heuristic. (This is already Tier 0 in the catalog.)
- **[v1] Tier 1 `web_fetch`** — Port http→https auto-upgrade, 20 s timeout, 10 redirects. Replace the hand-rolled HTML stripper with a proven library (e.g., `cheerio` + `turndown` for markdown). Keep the prompt-driven summarization hook.
- **[v1] Tier 1 `web_search`** — Respect `CLAWD_WEB_SEARCH_BASE_URL` equivalent env override; don't ship with DDG HTML scraping as the default — use an actual search API. Port `allowed_domains`/`blocked_domains` subdomain-aware filtering and 8-hit cap.
- **[v1] Tier 1 `notebook_edit`** — Port edit modes (`replace` default, `insert`, `delete`), cell id resolution, language detection, synthetic id generation. Low-risk port.
- **[v1] Tier 1 `structured_output`** — Thin echo-sink; trivial to port, reject empty payload.
- **[later] Tier 3 `ask_user_question`** — Port the schema but host-pluggable: do NOT block on stdin by default. Let the host (CLI vs server vs IDE) supply the answer via a callback/transport. Claw-code's stdin blocking makes it unusable in non-TTY contexts.
- **[later] Tier 5 `sleep`** — Trivial; port with 5-min cap. Note: it's marked Tier 5 in our catalog, which may be too conservative — `sleep` is occasionally useful in Tier 0 polling loops.
- **[later] Tier 5 `repl`** — Only worth porting if we add true persistent session semantics (e.g., keep an IPython kernel / node REPL alive across calls). Claw-code's version is just "spawn+wait", which is indistinguishable from `bash` + `python3 -c`.
- **[later] Tier 5 `pdf_extract`** — Claw-code has this as a module but NOT as a tool. The implementation is a pragmatic flate2 + BT/ET-operator extractor; fine for simple PDFs but not encrypted/image-only. Consider keeping it behind a pdf-library dependency (e.g., `pdf-parse`) rather than reimplementing from scratch.
- **[skip] `PowerShell`** — Windows-specific twin of bash; out of scope for v0. If needed later, collapse into `bash` via a runtime selector.
- **[skip] `SendUserMessage`/`Brief`** — Host-level concern, not a tool.
- **[skip] `Config`, `EnterPlanMode`/`ExitPlanMode`** — Host/CLI surface, out of scope.
- **[skip] `ToolSearch`** — Our tiered catalog handles deferred tool discovery architecturally.

### Bash validation

- **[v0]** Port `classify_command` semantic tables (`SEMANTIC_READ_ONLY_COMMANDS`, `WRITE_COMMANDS`, `STATE_MODIFYING_COMMANDS`, `NETWORK_COMMANDS`, `PROCESS_COMMANDS`, `PACKAGE_COMMANDS`, `SYSTEM_ADMIN_COMMANDS`, `DESTRUCTIVE_PATTERNS`, `ALWAYS_DESTRUCTIVE_COMMANDS`, `GIT_READ_ONLY_SUBCOMMANDS`) as TypeScript const arrays.
- **[v0]** Port `extract_first_command` (env-var stripping, quoted values) — necessary for any other classifier to be correct.
- **[v0]** Port `validate_command` pipeline: mode → sed → destructive → path. **Actually wire it into the bash executor** (fixing the dead-code gap in claw-code).
- **[v0]** Port `validate_read_only` with `WRITE_COMMANDS + STATE_MODIFYING_COMMANDS + WRITE_REDIRECTIONS + sudo-inner + git-subcommand` rules.
- **[v0]** Port `check_destructive` warning pipeline and surface its `Warn` as a permission-gated prompt (not auto-block).
- **[v1]** Port `validate_mode` WorkspaceWrite system-path heuristic.
- **[v1]** Port `validate_sed` (`sed -i` blocked under ReadOnly).
- **[v1]** Port `validate_paths` (`../`, `~/`, `$HOME` warnings).
- **[v1]** Port `classify_bash_permission` downgrade rule so read-only commands over workspace paths don't require full-access gate.

### Sandbox

- **[v0]** Port detection: `detect_container_environment` (file markers + env vars + `/proc/1/cgroup`). Useful signal regardless of sandboxing policy.
- **[v0]** Port 16 KiB stdout/stderr truncation with UTF-8-safe boundaries.
- **[v1]** Port `unshare_user_namespace_works` probing + memoization. On Linux with probe success, wrap bash in `unshare --user --map-root-user --mount --ipc --pid --uts --fork [--net] sh -lc …` and inject `HOME`/`TMPDIR` pointing at `$cwd/.sandbox-home` / `$cwd/.sandbox-tmp`.
- **[v1]** Port `SandboxConfig` / `SandboxRequest` / `SandboxStatus` shape, including `fallback_reason`.
- **[v1]** Port `FilesystemIsolationMode` three-way enum and allow-list normalization.
- **[v1]** Port per-call overrides (`dangerouslyDisableSandbox`, `namespaceRestrictions`, `isolateNetwork`, `filesystemMode`, `allowedMounts`).
- **[later]** macOS `sandbox-exec` profile (claw-code doesn't do this; worth investigating). Windows sandboxing is likely out of scope indefinitely.
- **[skip]** `build_linux_sandbox_command` as-is for TS — we'll need to invoke `unshare` via `child_process.spawn` and assemble args; the shape of the launcher spec is the portable piece.

### File ops

- **[v0]** `MAX_READ_SIZE`/`MAX_WRITE_SIZE = 10 * 1024 * 1024`.
- **[v0]** Binary detection = "NUL byte in first 8 KiB".
- **[v0]** `validate_workspace_boundary(resolved, workspace_root)` check (canonical path `startsWith` workspace root after resolving symlinks). Wire into read/write/edit — don't leave unused.
- **[v0]** `is_symlink_escape(path, workspace_root)` — `symlink_metadata` + canonicalize comparison. Call on read/write.
- **[v0]** Brace expansion helper for glob patterns (`expand_braces`).
- **[v1]** Replace line-based `offset`/`limit` with a streaming impl so reads don't buffer 10 MiB when the user only wants 10 lines.

### Other observations worth carrying over

- **[v0]** Lane-event-style structured output on preflight blocks (e.g. branch divergence) is a good pattern for openswarm telemetry — keep the idea, drop the specific `workspace_test_branch_preflight` heuristic unless the v0 scope includes test/CI awareness.
- **[v0]** Ship-prepared detection on `git push … main|master` is a string-match hack; if we want CI/ship telemetry, do it through a hook rather than a tool intercept.

## 6. Open questions

1. **Grep backend**: claw-code's `grep_search` uses `walkdir` + `regex`, not ripgrep, despite "(ripgrep-backed)" in our doc. For openswarm v0, do we shell out to `rg` when available, ship `ripgrep-node`, or accept a pure-JS impl?
2. **Workspace boundary enforcement scope**: claw-code defines but doesn't wire `*_in_workspace` helpers. Do we enforce the boundary at the tool layer (every read/write/edit), at the permission-engine layer, or both?
3. **AskUserQuestion transport**: stdin is wrong for a server-mode host. What interface should the tool present (promise resolved by host, EventEmitter, WebSocket message)?
4. **REPL semantics**: persistent kernel vs spawn-per-call? The former is meaningfully different from `bash` + `python3 -c`; the latter is redundant.
5. **Bash validation vs permission engine**: the rules here overlap heavily with the permission/policy surface already covered by another research slice. Where does `classify_command` live — inside the bash tool, or in the permission engine?
6. **Sandbox on macOS/Windows**: ship Linux-only in v0 and document the absence, or invest in `sandbox-exec` / Windows equivalents?
7. **PDF extraction**: port claw-code's hand-rolled extractor, or depend on a library? The claw-code implementation is pragmatic but silently returns `""` for encrypted/image-only PDFs — we should at least surface that state.
8. **Truncation marker**: claw-code injects `"\n\n[output truncated — exceeded 16384 bytes]"` into stdout/stderr content. Should we instead expose truncation as an out-of-band boolean + size field so the model doesn't have to parse the marker?
9. **`multi_edit`**: claw-code has no such tool — each `edit_file` is a single replacement. Claude Code proper supports batched edits. Is this a Tier 0 gap for openswarm?

## 7. File references

- `references/claw-code/rust/crates/tools/src/lib.rs` — tool registry, `mvp_tool_specs()` (lines 385-1172), `execute_tool` dispatch (lines 1189-1291), all `run_*`/`execute_*` implementations, `classify_bash_permission` (lines 1844-1906), `workspace_test_branch_preflight` (lines 1916-2060), `execute_web_fetch`/`execute_web_search` (2747-3128), `execute_todo_write` (3130-3173), `execute_notebook_edit` (5055-5175), `execute_sleep` (5225-5237), `execute_structured_output` (5475-5485), `execute_repl` (5487-5565)
- `references/claw-code/rust/crates/tools/src/pdf_extract.rs` — flate2 + BT/ET operator extractor; module only, not an MVP tool
- `references/claw-code/rust/crates/tools/src/lane_completion.rs` — lane-completion detector (out of scope for this slice)
- `references/claw-code/rust/crates/runtime/src/bash.rs` — `BashCommandInput`/`Output`, `execute_bash`, `prepare_command`, `prepare_tokio_command`, 16 KiB truncation
- `references/claw-code/rust/crates/runtime/src/bash_validation.rs` — full validation pipeline (read-only, destructive, mode, sed, path, semantics) — library code, not wired into `execute_bash`
- `references/claw-code/rust/crates/runtime/src/file_ops.rs` — `read_file`, `write_file`, `edit_file`, `glob_search`, `grep_search`, `MAX_READ_SIZE`, `MAX_WRITE_SIZE`, `is_binary_file`, `validate_workspace_boundary`, `is_symlink_escape`, `expand_braces`
- `references/claw-code/rust/crates/runtime/src/sandbox.rs` — `SandboxConfig/Request/Status`, `FilesystemIsolationMode`, `detect_container_environment`, `resolve_sandbox_status_for_request`, `build_linux_sandbox_command`, `unshare_user_namespace_works`
- `docs/04-tool-tiers.md` — target tier taxonomy this research feeds
