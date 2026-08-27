# Architecture

## Runtime shape

```
                ┌──────────────────────────────┐
                │  swarm orchestrator          │
                │  (optional, Tier 2+)         │
                └──────┬───────────┬───────────┘
                       │ spawn     │ messages
                       ▼           ▼
                ┌──────────────────────────────┐
                │  atomic agent (openswarm)  │
                │  ┌────────────────────────┐  │
                │  │ cli / ui               │  │  ink | headless JSONL
                │  ├────────────────────────┤  │
                │  │ conversation loop      │  │  SDK-backed
                │  ├────────────────────────┤  │
                │  │ tool dispatcher        │  │
                │  ├────────────────────────┤  │
                │  │ permission engine      │  │
                │  ├────────────────────────┤  │
                │  │ provider (anthropic)   │  │  interface — swappable
                │  └────────────────────────┘  │
                │  memory coordinator          │  pluggable providers
                │  plugins · skills · mcp      │
                │  state (SQLite) · session    │
                └──────────────────────────────┘
```

## Source layout

Single npm package, internal modules. Split into sub-packages only if an external consumer needs a module on its own.

```
src/
  core/
    types.ts         # shared primitives (PermissionMode, NormalizedEvent, ToolSpec, ...)
  engine/            # PRIMARY abstraction — AgentEngine
    index.ts         # AgentEngine, RunConfig, SessionSnapshot
    claude-agent-sdk.ts  # M0 — default engine, wraps @anthropic-ai/claude-agent-sdk
    native.ts        # M4 — composes Provider + our loop + Compactor + MCP
    hardened-native.ts  # Production-hardened NativeEngine variant (retry, eager dispatch, mid-turn compaction)
    retry-policy.ts     # RetryPolicy + error classification for hardened engine
    hardened-native-snapshot.ts  # Snapshot with retry stats for hardened engine
  providers/         # inner layer — used ONLY by NativeEngine/HardenedNativeEngine (M4+)
    index.ts         # Provider stub; finalized in M4
    anthropic.ts     # M4 — wraps @ai-sdk/anthropic
    openai.ts        # M4
    google.ts        # M4
    xai.ts           # M4
    openai-compat.ts # M4 — Ollama / LM Studio / OpenRouter
    codex-chatgpt.ts # M4 — custom provider for ChatGPT Plus/Pro
  auth/
    index.ts         # AuthSource, InteractiveAuth
    anthropic-api-key.ts   # M0
    anthropic-oauth.ts     # M0 — Claude Max subscription
    openai-api-key.ts      # M4
    openai-oauth.ts        # M4 — Codex App Server flow
    google-api-key.ts      # M4
    xai-api-key.ts         # M4
  permissions/       # our permission engine, bound to AgentEngine.canUseTool
  memory/            # 4-layer memory system
    types.ts         # shared memory types (MemoryProvider, MemoryFragment, TurnContext, ...)
    curated.ts       # L1 — bounded curated memory (project/user scopes)
    skills.ts        # L2 — procedural memory as Markdown files with YAML frontmatter
    archive.ts       # L3 — session archive with FTS5 search
    coordinator.ts   # L4 — MemoryCoordinator (provider fan-out, deduplication)
    lifecycle.ts     # engine lifecycle hooks (onSessionStart → onSessionEnd)
    providers/
      file-provider.ts    # built-in provider wrapping L1 curated memory
      minimem-provider.ts # optional hybrid vector + BM25 search (graceful degradation)
  state/             # SQLite-backed state database (sessions, memory, audit log)
  session/           # per-worktree JSONL + engine SessionSnapshot
  tools/
    tier0/           # bash, file_ops, search, todo
    tier1/           # web, notebook, structured_output, skill
    tier2/           # swarm primitives (spawn, task, message, inbox)
    tier3/           # team, cron, remote_trigger, ask_user
    tier4/           # mcp client, lsp
    tier5/           # plan_mode, sandbox, hooks, pdf, sleep, repl
  session/           # persistence, resume, jsonl log
  plugins/
    index.ts         # PluginSource interface
    claude-code.ts   # v0 impl
  skills/
    index.ts         # SkillSource interface
    claude-code.ts   # v0 impl
  mcp/               # stdio bridge (Tier 4)
  ui/
    ink/             # rich TUI
    headless/        # JSONL event stream
  swarm/             # orchestrator — spawns atomic agents
  cli/               # argv parsing, doctor, one-shot, REPL entry
  config/            # hierarchy + validation
```

## Layering rules

- `core` depends on `providers`, `tools`, `session`, `permissions`. Never on `ui`, `cli`, or `swarm`.
- `providers` depend on nothing in this tree.
- `tools` depend on `core` types only (tool spec, permission result).
- `swarm` depends on `core` to spawn atomic units. The reverse is forbidden — an atomic agent must stay swarm-agnostic.
- `cli` and `ui` are the only modules allowed to touch process argv, stdio, or the filesystem outside of explicit I/O tools.
- No circular imports. Enforce with a lint rule.

## Process topologies

Atomic agent has two runtime modes — same code, different entry:

| Mode | Entry | Consumer |
|---|---|---|
| Interactive | `openswarm` (ink UI) | Human user |
| Headless | `openswarm --headless --task-file=…` (JSONL on stdout) | Swarm orchestrator, CI, scripts |

The swarm orchestrator spawns atomic agents as subprocess workers by default. In-process mode is an optimization deferred until startup cost becomes a problem.

## Wire conventions

- Subprocess workers communicate with the orchestrator via JSONL over stdio.
- Event shapes live in `src/core/events.ts` and are stable across versions.
- Every event carries `ts`, `agentId`, `type`, `payload`.
- Workers receive their task via `--task-file` (a JSON file), not via argv. Argv is reserved for flags.
- Workers inherit env: `OPENSWARM_AGENT_ID`, `OPENSWARM_PARENT_PID`, `ANTHROPIC_API_KEY`.
