# 03 — Usage & runbook

How to run and drive the dsh-based OpenSwarm. Architecture is [docs/01](01-dsh-foundation.md); this is the operator's guide.

## Setup

```bash
npm install && npm run build
```

`npm run build` compiles the plugin packages to `dist/` (esbuild; bare imports external). The launcher refuses to run until this is done.

## The launcher

`bin/openswarm.mjs` (installed as the `openswarm` bin) wraps `dsh --profile openswarm[-dev]`: it initializes profiles on first use, auto-detects the provider, and maps flags to the `OPENSWARM_*` env the bundle reads.

```
openswarm "<task>"          run one task headless
openswarm run "<task>"      same
openswarm web [flags]       open DeepSeek's browser UI on a swarm context
openswarm serve [--port N]  start the app-server (default :4620)
openswarm setup             (re)initialize profiles
openswarm config            print resolved provider / model / home
openswarm ps | board | questions | attach | start | steer | answer | kill
                            control verbs (see below)
```

Options: `--model <id>`, `--provider <azure|openai|bedrock>`, `--home <dir>`, `--port <n>`.
`web` forwards its remaining flags verbatim to the dsh web app (`--host`,
`--no-open`, `--trusted-host`, …).

Profile home defaults to `$OPENSWARM_HOME` or `~/.openswarm`; the launcher passes it to dsh as both `DSH_HOME` and `OPENSWARM_HOME`, so run journals (`<home>/runs`) and the app-server's credential file (`<home>/app-server.json`) land where the control verbs read them. Profiles are re-initialized by `setup` (or delete the home and re-run).

## Control verbs

The CLI side of steering ([docs/05](05-control-plane-redesign.md) §6.1), in `packages/cli` (`runControl`). The state verbs read run journals under `<home>/runs` directly, so they need no server and see a run whose process died:

```
openswarm ps [--json]                      runs: id, status, topology, age, writer pid
openswarm board <run> [--json]             tasks (id, status, owner, subject), open question count
openswarm questions [--run <id>] [--json]  open questions of running runs (or of one run)
openswarm attach <run> [--no-follow]       board and recap; see below
```

`attach` on a settled run prints its board and recap and exits. On a running one whose writer (same host) is dead, it takes the run over — releases the dead writer's claims and records the run `interrupted` — and prints the board, the released claims and the recap. On one whose writer is alive, it prints the recap and then follows it, polling the journal each second, until the run settles (or Ctrl-C; `--no-follow` stops after the recap). A `ps` row whose writer died reads `pid N (dead)`.

The direction verbs call a running `openswarm serve` over its socket as the owner, with the token it wrote to `<home>/app-server.json`; without a live server they exit 1 with `no app-server running`:

```
openswarm start <"task" | spec.json> [--workers N] [--provider P] [--model M] [--question-timeout MS]
openswarm steer <run> --to <member> "text"   → immediate | enqueue
openswarm answer <run> <question> <choice>
openswarm kill <run>
```

`start` prints the run id. A task becomes the coordinator team `/swarm` builds (default 3 workers); a single word (no spaces) ending in `.json` is read as a `TeamSpec` file. `--provider`/`--model` name the lead's route (a route of the serving profile, e.g. `openai`, `azure`, `bedrock`); omitted, the lead takes the server's default model — the one `openswarm serve` was launched with. The run's questions wait `--question-timeout` ms (default 300000) for `answer`. A refusal from the server is printed as it arrives, led by its code (`NOT_FOUND: …`), with exit 1; usage errors exit 2. `pause`, `resume` and `join` are not implemented yet.

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
- **`openswarm-dev`** — HMR hot, app-server bound, and **no** headless runner (the app-server's socket keeps the process alive to serve). Used by `openswarm serve`. Edit a package's source, run `npm run build`, and the *running* server picks up the new `dist` without restarting — see [Hot reload](#hot-reload-editing-a-running-harness).
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
today, a TUI profile when one ships.

While the team runs, it holds a row in the surface's **background-jobs list**
(the session-header control): label, status, and a ticking elapsed clock, with
a shape summary once it settles. Killing that row cancels the team. The command
itself awaits the run and returns the synthesis inline — dsh's job rows are
read-only and carry no output, so returning early would put the result where no
human surface can read it. A live Azure run held its request open 72s without
trouble.

Run as the very first action in a brand-new session, the result is also posted
into the conversation as a follow-up turn. A session stays "blank" until
something opens a turn, and command records deliberately never do (the same
reason `/plan` and `/goal` leave a fresh session untouched) — so without that
the surface would keep showing its landing screen and the result would never
render. It costs one lead model round, and only happens on a blank session.

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

### What an authored plugin can reach

`swarm_author_plugin` hands the module exactly one capability — `defineTool`.
That is a capability-passing convention, **not a sandbox**. A `data:` URL module
cannot resolve bare specifiers, but it *can* import `node:` builtins, and both
`node:fs` and `node:child_process` are reachable from authored source today.

So read the two scopes below as blast radius for **mounting** — who can change
the shared harness — not as a limit on what mounted code may do. Actual
confinement comes from the approval gate plus whatever sandbox/permission layer
your profile composes; a bare hand-built context composes none.

### Surviving a restart

By default nothing outlives its process: Cordis unwinds every mount on dispose,
which is what makes live mounting safe. Set `persistDir` on the row to keep
**approved `lead`-scope** plugins across restarts:

```yaml
- id: openswarm-plugin-authoring
  name: 'openswarm-plugin-authoring'
  config:
    persistDir: ~/.openswarm/plugins
```

Each approved mount writes `<name>.mjs` plus an `approved.json` manifest holding
the SHA-256 of exactly what the human approved. On boot, a plugin is restored
only when its bytes still match that record; anything edited since approval, or
dropped into the directory without ever passing the gate, is skipped.

That check is a security boundary, not bookkeeping — member harnesses carry
ordinary file-write tools, so without it a model could write a `.mjs` into the
directory and reach shared scope on the next boot having never faced the gate.

`self` scope is never persisted: it belongs to an agent that will not exist
after a restart. To revoke a persisted plugin, delete its file (or its manifest
entry). Off by default deliberately — persistence turns a one-time grant into a
standing one, which is the operator's call, not ours.

Related, from dsh itself: the shipped **`cordis` agent preset** ("创造模式") mounts
`tool-cordis`, which inspects and edits the live composition, plus skills for
authoring Cordis plugins and presets. Pick it from the agent-preset selector in
the web UI when you want the agent to reason about the running tree.

## Hot reload: editing a running harness

On `openswarm-dev`, a rebuilt `dist` replaces live code in the running process —
no restart:

```bash
openswarm serve --port 4620      # leave it running
# …edit packages/app-server/src/index.ts…
npm run build                    # the running server picks it up
```

The one thing that makes this work is `base` in the dev overlay:

```yaml
- id: hmr
  disabled: false
  config:
    base: !!js process.env.OPENSWARM_HMR_BASE ?? process.cwd()
    root: ['packages']
```

`root` resolves against `base`, and **`base` defaults to the profile directory,
not your working directory** — so the intuitive `root: ['.']` watches
`~/.openswarm/profiles/openswarm-dev/`, whose contents are config files and a
`node_modules` of symlinks that the default `ignored` excludes. The watcher then
never sees your repo, and the failure is *silent*: no reload, no restart, no
error, with the row still reporting `disabled: false`. If hot reload seems dead,
check `base` before anything else. Override it with `OPENSWARM_HMR_BASE` when
running from outside the repo.

This needs no Node flags. `cordis-plugin-hmr` wants Node's internal module
loader, and while `--expose-internals` is one way to expose it,
`cordis-plugin-loader` falls back to `node-addon-require-builtin` — so the
launcher passes no flag, and the unstable-`internal/*` surface stays closed.

Not available on the **web** profile: `dsh-web-app` disables the `hmr` row
upstream, noting its reload lifecycle is untested. Hot reload is an app-server
capability today.

## Gating a run on build + test (self-modification)

A `cascade` with a `confidence` gate is the shape for letting a team edit real
source: tiers attempt the task cheapest-first, and a tier is accepted only when
every verification command exits 0.

```ts
await ctx.swarm.runTeam(
  {
    topology: 'cascade',
    tiers: [{ name: 'cheap' }, { name: 'strong' }],
    task: 'fix the failing test in packages/swarm',
    confidence: { commands: ['npm ci', 'npm run presubmit'], tau: 1 },
  },
  { parent: lead.agent, worktrees: { repoRoot: '/path/to/repo' } },
)
```

Under `worktrees`, every tier shares one worktree (they continue each other's
work) and **the gate runs in that worktree** — not the repo root — so it grades
the tier's actual edits.

### Pin what the gate grades with

That worktree is a full checkout, tests included, so `npm run presubmit` reads
the suite **from the tree it is grading**. "Make the gate pass" then has two
solutions — fix the code, or weaken the test — and the second is cheaper. Pass
`confidencePinPaths` to take the verification assets out of the graded party's
hands:

```ts
{ confidencePinPaths: ['packages/swarm/tests', 'packages/git/tests'], worktrees: { repoRoot: '…' } }
```

**Use literal directories, not globs.** Git matches pathspec wildcards against
WHOLE paths, so `packages/*/tests` matches *nothing* — it does not match
`packages/swarm/tests/foo.test.ts`. A glob like that pins nothing while looking
configured; `restoreFromBase` now throws on a pathspec that matches neither the
base commit nor the worktree, rather than treating it as a no-op.

Those pathspecs are restored from the base commit before **every** gate run, and
files the member added under them are removed, so the pinned paths are exactly
their base state. A tier that spent its turn editing tests gets a
`gate: discarded member edits…` progress line rather than a silent revert.

Edits to pinned paths are **discarded and never merged** — pinning declares that
tests are not this run's to change. A task that is *supposed* to add tests must
leave them unpinned and accept that the gate is then partly self-authored. A rejected tier's feedback threads into the next one.
Accepted work merges to the integration branch; your checkout is never touched.

Two environment traps, both specific to gating on a repo's own build, and both
of which score a *correct* edit as 0:

1. **A worktree is gitignore-clean**, so it has no `node_modules` and
   `npm run presubmit` alone dies with `ERR_MODULE_NOT_FOUND`. Symlinking the
   root `node_modules` in does not fix it either — workspace self-links resolve
   back to the original checkout and `tsc` then sees two identities of the same
   package. Bootstrap hermetically instead; that is why `npm ci` leads the list.
2. **The gate inherits your environment.** The runner shells out with a `cwd`
   but no `env`, so any flag that changes what your test suite does is still
   set. Gating this repo from a live run with `OPENSWARM_LIVE=1` made the gate's
   `npm test` re-run the live suite inside the worktree — including the
   self-modification test driving the run, which failed its own clean-checkout
   guard because the worktree is legitimately dirty. Scrub such flags in the
   command itself (`OPENSWARM_LIVE=0 npm run presubmit`).

When a gate does reject, note that you get a bare `confidence 0`: the runner
discards command output, and the next tier is told only that "the verification
commands did not pass". Reproduce the commands by hand in the task worktree to
find out why.

This is the path rung 5 runs on — a live cascade using exactly the config above
edited this repository's own source, passed this repository's own presubmit
inside the worktree, and merged. See `packages/swarm/tests/self-modify-live.test.ts`.

## The app-server (for UIs, CLIs, programs)

`openswarm serve` binds a newline-delimited JSON-RPC 2.0 endpoint: the socket carrier of the swarm protocol ([docs/05](05-control-plane-redesign.md) §5.3), in front of dsh's SDK session protocol. Connect with `@deepseek-ai/dsh-sdk-protocol`'s `JsonRpcLineTransport`.

- **Auth.** A connection starts unauthenticated, and every method but `swarm/auth { token } → { principal }` is refused until it binds one. At listen the server writes `$OPENSWARM_HOME/app-server.json` (default `~/.openswarm`): `{ url, token, pid }` with an owner token, mode 0600, removed on close. The owner mints more tokens with `swarm/token`; they are held in memory and die with the process.
- **Policy**, default-deny: owner, everything; viewer, state; driver, state, direction and low-tier answers; member (bound to one run and member name), its own run's state. A viewer or driver token minted with a `runId` is held to that run too. A refusal is a JSON-RPC error whose message starts with `FORBIDDEN`, `UNKNOWN_METHOD`, `INVALID_PARAMS` or `NOT_FOUND`.
- State:
  - `swarm/runs {} → { runs: [{ id, status, topology, parentSessionId, writer, startedAt, endedAt?, error?, result?, spec? }] }`, read from the run journals, so it survives a server restart.
  - `swarm/view { runId, since? } → { run, tasks, questions, recap }`.
  - `swarm/events { runId, afterSeq?, waitMs? } → { events }`: the run's journal events after `afterSeq` (default -1). For a run live in this server, a poll with nothing new waits up to `waitMs` (default 0, at most 30000) for the next event, so polling with the last `seq` follows a run.
  - `swarm/questions { runId? } → { questions: [{ runId, id, trigger, kind, tier, prompt, options, default, status, raisedAt }] }`: the open questions of every run live in this server, or of one run (a bound principal's own).
- Direction:
  - `swarm/start { spec, provider?, model?, worktrees?, questionTimeoutMs? } → { runId }`; the connection that starts the run gets a `swarm.runFinished` notification carrying the `TeamResult` (or `error`). The lead's route fills a missing `provider` or `model` from the harness's default model (`ctx.agentDefaultModel`, the profile's `agent-default-model` row), which members inherit. The run's questions wait `questionTimeoutMs` (default 300000) for an answer.
  - `swarm/steer { runId, to, text } → { delivery }`: a member of a messaging peer-team; `immediate` (next step boundary) under `worktrees`, else `enqueue` (its next turn). Other topologies have no addressable members.
  - `swarm/cancel { runId } → { cancelled: true }`: aborts the run (a messaging peer-team's members finish their current turn), which records `failed`.
  - `swarm/attach { runId }`: take over a run whose process died (see below).
- Answer: `swarm/answer { runId, questionId, answer } → { answered: true }`, `answer` being one of the question's `options`. An owner answers any question; a driver only a `low`-tier one that is not a consent or approval.
- Admin: `swarm/token { role, runId?, member? } → { token }`.
- Delegated to dsh, owner only: `initialize`, `session/prompt`, streamed `session.event` / `session.status`.

**Questions** ([docs/05](05-control-plane-redesign.md) §6.1). The harness asks when a messaging member under `worktrees` stays silent through a nudge (`stall`: restart it, or wait another `memberIdleTimeoutMs`), a member dies with its restart budget spent (`restart-budget`: drop it, or restart once more), a board task runs out of attempts with a sibling left to retry it (`task-attempts`: abandon it, or retry once more), or every cascade tier fails (`verifier-failure`: stop, or retry the top tier once). Each question is a low-tier escalation in the run's journal (`swarm/question`, with recap lines) and takes the first answer, else its default once the timeout passes; while 3 are open, the next is `capped` at its default at once, and a run that ends defaults the rest.

A `spec` is a `TeamSpec` — e.g. `{ topology: 'fanout', members: [{name}], tasks: [{member, prompt}] }`. See the topology types in [`packages/swarm/src/types.ts`](../packages/swarm/src/types.ts). A worked client is [`packages/app-server/tests/app-server.e2e.test.ts`](../packages/app-server/tests/app-server.e2e.test.ts).

**The web carrier.** The `openswarm-web` profile also serves these `swarm/*` methods, minus `swarm/token`, on dsh's `/api` gateway (the `openswarm-app-server-web` row; `openswarm setup` adds it to an older home): `POST /api/swarm/<method>` with `{ type: 'client-request', rpcId, method: 'swarm/<method>', payload: { args: { …params } } }` answers `{ result: { ok: true, value } }`, or `ok: false` with an `error.message` led by the same code. Every caller is the owner, because dsh's web server authenticates nothing, so the carrier refuses to load unless that server binds 127.0.0.1, and the refusal fails the boot: `openswarm web --host 0.0.0.0` starts only with the row disabled. The gateway has no push, so there is no `swarm.runFinished`; follow a run by long-polling `swarm/events` with the last `seq`. An open question is also put to dsh's own question prompt (`ctx.userQuestions`), in the run's lead session; an answer there is recorded `by: 'userQuestions'`, and a reply naming none of the options is ignored.

## Driving a team in-process

`ctx.swarm.runTeam(spec, { parent, worktrees? })` is the programmatic entry point; it is `ctx.swarm.start(spec, options)` (a handle with the run `id`, its `board()`, and the `result` promise) plus waiting for the result. Each run journals to `$OPENSWARM_HOME/runs/<run id>/journal.jsonl` (default `~/.openswarm/runs`), which `ctx.swarm.runs()`, `view(runId)` and `attach(runId)` read from any process (outside a harness, `listRuns(runsDir)`, `viewRun(runsDir, runId)` and `attachRun(runsDir, runId)` do the same, with `defaultRunsDir()`); `attach` takes over a run whose process died, releasing its claims and marking it `interrupted`. `RunTeamOptions.worktrees` turns member runs into subprocess harnesses in per-task git worktrees and returns a merge outcome. At most `worktrees.maxConcurrent` (default 8) harnesses run at once; the rest queue, so a large fanout does not spawn one subprocess per task up front. `onProgress` receives human-readable progress lines; every topology emits. `questions: { timeoutMs?, maxOpen? }` (default 0 and 3) sets how long a question waits: at 0 every question takes its default at once, as an unattended run needs; the handle's `answer(questionId, answer, by)` answers one.

Worktree runs clean up after themselves in two ways: an abort or throw drops this run's checkouts without merging (branches survive, so committed work stays reachable), and each run first sweeps `.swarm/worktrees/` for teams that died before finalizing — the SIGKILL case try/finally cannot cover. Live teams are never touched, so concurrent runs are safe. Members set `agentOptions: { provider, model }` for heterogeneous rosters. See [`packages/swarm/tests/boot.ts`](../packages/swarm/tests/boot.ts) for a minimal composition.

**Member sandbox** ([docs/05](05-control-plane-redesign.md) §5.5, behind a flag). `OPENSWARM_MEMBER_SANDBOX=workspace-write`, or `worktrees.member.sandbox: 'workspace-write'` for one run, confines a worktree member's writes, from bash (and everything it spawns) and from the editor, to its worktree and temp (`/tmp`, `$TMPDIR`); unset, members run `danger-full-access`. Reads and network stay open, so it contains damage but hides nothing. The npm, pip and cargo caches (and `XDG_CACHE_HOME`) move to `$TMPDIR/openswarm-cache/<team>`. Failing by design: git writes in the worktree (`add`, `commit`, `checkout -b`; the object store and `.git/worktrees/<name>` are outside it, and the lead auto-commits), global installs (`pip install` outside a venv, `npm -g`), and anything else that writes the home directory. Where dsh has no backend (Seatbelt on macOS, bwrap or Landlock on Linux), a member's bash fails rather than running unconfined. A custom `member.configPath` composition must read the variable itself.
Under the sandbox a member also cannot open PTYs (`posix_openpt` is denied), so a repo suite that spawns PTY shells (this repo's own e2e tests) fails when a member runs it; the lead-side command gate still runs it.

## Testing

```bash
npm test                          # full keyless suite (scripted mock LLM)
npm run typecheck                 # tsc across all packages
OPENSWARM_LIVE=1 npm test         # + env-gated live tests (needs AZURE_/AWS creds)
OPENSWARM_MEMBER_SANDBOX=workspace-write npm test   # members sandboxed
OPENSWARM_HMR_E2E=1 npx vitest run packages/bundle/tests/hmr-reload.e2e.test.ts
```

The HMR e2e is gated separately because it is invasive rather than merely
keyless-or-not: it edits a package's source in your working tree and runs
`npm run build` twice. It refuses to start on a dirty checkout and restores in a
`finally`; if a hard kill interrupts it, `git checkout packages/` clears the
marker.

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
