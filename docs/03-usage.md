# 03 — Usage & runbook

How to run and drive the dsh-based OpenSwarm. Architecture is [docs/01](01-dsh-foundation.md); this is the operator's guide.

## Setup

```bash
npm install && npm run build
```

`npm run build` compiles the plugin packages to `dist/` (esbuild; bare imports external). The launcher refuses to run until this is done.

## The launcher

`bin/openswarm` wraps `dsh --profile openswarm[-dev]`: it initializes profiles on first use, auto-detects the provider, and maps flags to the `OPENSWARM_*` env the bundle reads.

```
openswarm "<task>"          run one task headless
openswarm run "<task>"      same
openswarm web [flags]       open DeepSeek's browser UI on a swarm context
openswarm serve [--port N]  start the app-server (default :4620)
openswarm setup             (re)initialize profiles
openswarm config            print resolved provider / model / home
```

Options: `--model <id>`, `--provider <azure|openai|bedrock>`, `--home <dir>`, `--port <n>`.
`web` forwards its remaining flags verbatim to the dsh web app (`--host`,
`--no-open`, `--trusted-host`, …).

Profile home defaults to `$OPENSWARM_HOME` or `~/.openswarm`. Profiles are re-initialized by `setup` (or delete the home and re-run).

## Providers

Auto-detected in order — Azure, then OpenAI, then Bedrock — from these env vars:

| Provider | Env | Default model |
|---|---|---|
| `azure` | `AZURE_API_BASE` + `AZURE_API_KEY` | `gpt-5.5` |
| `openai` | `OPENAI_API_KEY` (opt. `OPENSWARM_LLM_BASE_URL` for LiteLLM/compatible) | `gpt-5.5` |
| `bedrock` | `AWS_BEARER_TOKEN_BEDROCK` (+ `AWS_REGION`) | `us.anthropic.claude-haiku-4-5-…` |

Force a choice with `--provider` / `--model` or `OPENSWARM_PROVIDER` / `OPENSWARM_MODEL`.

## Profiles

The launcher's `init-profile.mjs` writes three profiles into the home and heals a `node_modules` so the bundle's plugins resolve by bare name:

- **`openswarm`** — HMR cold, includes `dsh-headless` (one-shot task runner → drives a task, then exits). The default for `openswarm run` and for eval.
- **`openswarm-dev`** — HMR hot, app-server bound, and **no** headless runner (the app-server's socket keeps the process alive to serve). Used by `openswarm serve`.
- **`openswarm-web`** — dsh's own browser surface (`@deepseek-ai/dsh-web-app`) with the OpenSwarm layer over it; the bound webserver keeps it alive. Used by `openswarm web`.

Each stack ends with `openswarm-bundle`, so the OpenSwarm rows override whatever surface sits beneath them.

Inspect the composed tree at any time:

```bash
DSH_HOME=~/.openswarm dsh --profile openswarm --dump-config      # or openswarm-dev
```

You'll see `llm-deepseek` disabled, the OpenSwarm rows inserted under a `# == openswarm-bundle` provenance header, all over `@deepseek-ai/dsh-base`.

## The web UI

```bash
openswarm web                     # → http://127.0.0.1:3080, opens your browser
openswarm web --port 0 --no-open  # OS-assigned port, print the URL only
```

This is DeepSeek Harness's own browser UI composed over the OpenSwarm context —
sessions, the tool/trajectory views, settings and the command palette come from
dsh; the model adapters, `ctx.swarm`, and the `/swarm` command come from ours.
Pick a workspace in the composer, then chat as usual.

To run a team, type **`/swarm [--workers <n>] <task>`** in the composer. A
coordinator decomposes the task into numbered subtasks, `n` workers (default 3)
run them concurrently, and the coordinator synthesizes; the command returns the
plan and the synthesis. Members inherit the session's model route, so nothing
extra is configured.

The command is registered by the `openswarm-swarm/command` bundle row, so it
appears on any dsh surface that renders the command registry — the browser UI
today, a TUI profile when one ships. It awaits the whole run before returning
(a `CommandResult` is the only channel the registry offers); long teams block
the command for their duration. A live Azure run held the request open for 72s
without trouble, so the ceiling is streaming progress, not the transport.

**Send a chat message before your first `/swarm`.** Run as the very first
action in a brand-new session, the command executes and lands in the session
log but the UI stays on the landing screen and never renders the result. Once
the conversation has any message, results render inline.

## Live self-modification

`swarm_author_plugin` (F3) lets an agent write a Cordis plugin and hot-mount it
into a *running* harness. Cordis makes this reversible by construction: every
registration the plugin makes unwinds on dispose.

Two blast radii:

- **`self`** — mounts into the authoring agent's own scoped context. Always
  allowed; the worst case is a broken child, and disposing the agent unwinds it.
- **`lead`** — mounts into the shared root context, changing tools for the whole
  team. Gated. The default gate asks the human over dsh's approval seam
  (`ctx.approval`), which the api-gateway forwards to the connected UI as a
  permission prompt. The seam is fail-closed: no answerer composed, a session on
  the `never` approval policy, an ask outside an open turn, or a withdrawn
  question all deny. A headless run therefore never silently grants shared scope.

Pass `approveLeadMount` in the row's config to substitute your own policy.

Related, from dsh itself: the shipped **`cordis` agent preset** ("创造模式") mounts
`tool-cordis`, which inspects and edits the live composition, plus skills for
authoring Cordis plugins and presets. Pick it from the agent-preset selector in
the web UI when you want the agent to reason about the running tree.

## The app-server (for UIs/TUIs)

`openswarm serve` binds a newline-delimited JSON-RPC 2.0 endpoint (dsh's SDK session protocol + swarm methods). Connect with `@deepseek-ai/dsh-sdk-protocol`'s `JsonRpcLineTransport`:

- Delegated (dsh): `initialize`, `session/prompt`, streamed `session.event` / `session.status`.
- Swarm extension:
  - `swarm/runTeam { spec, provider, model, worktrees? } → { runId }`; completion arrives as a `swarm.runFinished` notification carrying the `TeamResult`.
  - `swarm/runs {} → { runs: [{ runId, status, leadSessionId }] }`.
  - `swarm/board { runId } → { tasks }`.

A `spec` is a `TeamSpec` — e.g. `{ topology: 'fanout', members: [{name}], tasks: [{member, prompt}] }`. See the topology types in [`packages/swarm/src/types.ts`](../packages/swarm/src/types.ts). A worked client is [`packages/app-server/tests/app-server.e2e.test.ts`](../packages/app-server/tests/app-server.e2e.test.ts).

## Driving a team in-process

`ctx.swarm.runTeam(spec, { parent, worktrees? })` is the programmatic entry point. `RunTeamOptions.worktrees` turns member runs into subprocess harnesses in per-task git worktrees and returns a merge outcome. Members set `agentOptions: { provider, model }` for heterogeneous rosters. See [`packages/swarm/tests/boot.ts`](../packages/swarm/tests/boot.ts) for a minimal composition.

## Testing

```bash
npm test                          # full keyless suite (scripted mock LLM)
npm run typecheck                 # tsc across all packages
OPENSWARM_LIVE=1 npm test         # + env-gated live tests (needs AZURE_/AWS creds)
```

Live tests skip themselves without `OPENSWARM_LIVE=1` and the relevant creds. The reusable message-boarding harness ([`board-harness.ts`](../packages/swarm/tests/support/board-harness.ts)) runs the same durable-mailbox scenarios in mock and live mode from one place.

## Eval

The discrimination-set rerun and SWE-bench harness live under `legacy/eval/` and drive the sandbox-deployable CLI bundle (`npm run bundle:cli` → `packages/cli/dist/openswarm.mjs`). Results and mechanics: [docs/02](02-discrimination-rerun.md).

## Publishing / installed use

`openswarm` publishes as one package that bundles the built plugin packages
(`packages/*/dist`) and depends on the dsh harness + framework. `npm pack`
(or `npm publish`) ships `bin/`, `scripts/`, and `packages/*` (dist + src +
patch YAMLs); `.npmignore` keeps `legacy/`, tests, and dist out of git but in
the tarball. Prep and verify a tarball locally:

```bash
npm run build
npm pack                                   # → openswarm-<ver>.tgz
mkdir /tmp/try && cd /tmp/try && npm init -y
npm install /path/to/openswarm-<ver>.tgz   # pulls the dsh tree from the registry
node_modules/.bin/openswarm config         # then a real run
```

The launcher and profile-init resolve everything through Node's module
resolution, so an installed package works from any cwd; inter-package imports
(e.g. `openswarm-swarm` → `openswarm-git`) resolve via sibling links the init
step creates under the package's own `node_modules`.

## Troubleshooting

- **"packages are not built"** → `npm run build`.
- **"no model provider configured"** → set one provider's env vars, or pass `--provider`/`--model`.
- **The `dsh` bin is missing** → `npm install` (pulls `@deepseek-ai/dsh`).
- **A team member can't reach the model** → confirm `openswarm config` shows the intended provider/model; the member harness inherits `OPENSWARM_LLM_*` from the launcher.
- **Reset everything** → delete the profile home (`~/.openswarm`) and re-run; profiles re-initialize.
