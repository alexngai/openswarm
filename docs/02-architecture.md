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
                │  atomic agent (swarm-coder)  │
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
                │  plugins · skills · mcp      │
                │  session                     │
                └──────────────────────────────┘
```

## Source layout

Single npm package, internal modules. Split into sub-packages only if an external consumer needs a module on its own.

```
src/
  core/              # conversation loop, tool dispatcher, permission engine
  providers/
    index.ts         # Provider tagged union (TransportProvider | FrameworkProvider)
    transport/
      anthropic.ts   # M0 — wraps @ai-sdk/anthropic
      openai.ts      # M2
      google.ts      # M4
      xai.ts         # M4
      openai-compat.ts # M2 — Ollama / LM Studio / OpenRouter
    framework/
      claude-agent-sdk.ts  # M3 — Claude Max subscription
      codex-chatgpt.ts     # M4 — ChatGPT Plus/Pro subscription
  auth/
    index.ts         # AuthSource interface
    anthropic-api-key.ts
    anthropic-oauth.ts     # M3 (framework-managed — delegates to Agent SDK)
    openai-api-key.ts
    openai-oauth.ts        # M4 — Codex App Server flow
    google-api-key.ts
    xai-api-key.ts
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
| Interactive | `swarm-coder` (ink UI) | Human user |
| Headless | `swarm-coder --headless --task-file=…` (JSONL on stdout) | Swarm orchestrator, CI, scripts |

The swarm orchestrator spawns atomic agents as subprocess workers by default. In-process mode is an optimization deferred until startup cost becomes a problem.

## Wire conventions

- Subprocess workers communicate with the orchestrator via JSONL over stdio.
- Event shapes live in `src/core/events.ts` and are stable across versions.
- Every event carries `ts`, `agentId`, `type`, `payload`.
- Workers receive their task via `--task-file` (a JSON file), not via argv. Argv is reserved for flags.
- Workers inherit env: `SWARM_CODER_AGENT_ID`, `SWARM_CODER_PARENT_PID`, `ANTHROPIC_API_KEY`.
