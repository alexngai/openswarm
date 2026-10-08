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
openswarm landings <run> [--json] [--pricing <file>]   the landing queue, highest risk first; see below
openswarm metrics <run> [--json] [--pricing <file>]    the run's RunMetrics; see below
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

### Landings and metrics

`openswarm landings <run>` is the landing queue ([docs/05](05-control-plane-redesign.md) §6.4, B4): one block per task that landed (through the train, or the sequential queue without it), that the train ejected, or that the queue left conflicted (its branch kept), highest risk first, then oldest. Each block is the evidence a reviewer needs, from the journals alone: why it is high risk, the intent header, the diff against the tip it landed on, the verified level with the gate's evidence and the train's batch verification (levels, counts and command names; never a check's output or a hidden suite's content), its cost in tokens by role, the questions raised about it and who answered, its repairs and resolvers, and any tamper sign. High risk is a human waiver, a partly enforced L3, a tamper sign, a repair or resolver, a merge nothing verified (a train whose target already failed, merged anyway through the queue at the owner's answer), a conflict, or nothing passing at L2 or above; medium is L2; low is a fully enforced L3. It is read-only for now (no reprioritize, retain or take over). The Swarm tab shows the same blocks under Landings; `swarm/landings` serves them to any principal that may read the run.

`openswarm metrics <run>` prints the run's RunMetrics (B5) as a table: landed tasks and their verified levels; tokens (by principal, model and runtime) and dollars; wall clock; the coordination ratio, coordination tokens (reviews, repairs, resolvers, lead and judge runs) over task-work tokens, with the split; steers, answers, restarts, questions by trigger, median time-to-answer; landing rate, clean-merge rate, bisects, conflicts, latency; tasks lost or duplicated against the seeded set; tamper incidents and advisories; cost per landing. A row the journals cannot support reads `— <why>` (`null` with the reason under `unsupported` in `--json`), never 0. The same numbers are on a finished run's result (`TeamResult.metrics`), behind `swarm/metrics`, in the Swarm tab's Result section, and in an eval's JSONL as one `run_metrics` line per settled run.

Dollars need prices; there are none built in. Pass `--pricing <file>`, JSON of $ per million tokens by model id (cached tokens bill as input unless given their own rate):

```
{ "gpt-5.5": { "input": 5, "output": 30, "cacheRead": 0.5 } }
```

A served profile prices `swarm/metrics` and the tab from the `openswarm-swarm` row's `pricing` config, the same shape. A model the table lacks leaves dollars `null`, naming it. A runtime that reports its own dollars (a Claude Code member's `total_cost_usd`) is taken at its word and not priced; dollars then say their `source` (`pricing`, `runtime` or `mixed`), split by runtime, and count the runs that neither reported nor could be priced (`unreported`), the total then a lower bound. Usage is journaled per member run (`swarm/usage`) since docs/05 B5, with the model the member's own messages name, so earlier runs report tokens, and their landings, as unrecorded rather than zero. A messaging team's peers keep one session across tasks and journal none yet, so its tokens, dollars, cost per landing and each bundle's cost are unsupported even where the train's repairs journaled some. Only plain `.jsonl` session logs are read; a member composition writing `compression: zstd` would count nothing.

### Mirroring a run into opentasks

`openswarm tasks sync <run> [--watch] [--socket <path>]` projects a run's board into an [opentasks](https://www.npmjs.com/package/opentasks) graph so other tools see it ([docs/05](05-control-plane-redesign.md) B0): a `context` node for the run, a `task` node per board task (`implements` the run, `blocks` edges from its blockers, status and assignee mirrored), and per gate round an `attempt` with a `verifies` edge carrying the verdict (a human waiver is a `verifies` edge from `human:<by>`). It is one-way: the run journal stays authoritative, and nothing reads task state back from the graph. `--watch` re-syncs each second the journal grows, until the run settles, or stops (exit 1) when the run's writer has died, as `attach` would report it. Which node mirrors what is kept in `<home>/runs/<run>/opentasks.json`, rewritten atomically after every write, so a re-sync writes only what changed. A lost or corrupt map is rebuilt from the graph: the run's nodes (by `metadata.openswarm.key`) and edges are adopted, not duplicated, and each sync line reports created and adopted counts. A map whose run node this graph does not hold stops the sync before it writes anything; delete the map to project the run into that graph afresh. One syncer per run holds `<home>/runs/<run>/opentasks.lock`; a second is refused, and a lock whose process is gone is taken over.

It needs `opentasks` installed next to openswarm (`npm install opentasks@0.2.0`; an optional peer, so nobody else pays for it) and a running daemon, which it never starts itself. Keep the graph outside your repository, because opentasks rewrites its `graph.jsonl` continuously:

```
export OPENTASKS_PROJECT_DIR=~/.openswarm/opentasks
npx opentasks daemon start
openswarm tasks sync run-1a2b3c4d --watch
```

The socket is `--socket`, else `OPENTASKS_SOCKET`, else the opentasks client's own discovery (a `.git/opentasks/daemon.sock` in the current repository wins over `OPENTASKS_PROJECT_DIR`); every sync line names it, and a socket inside the current git repository draws a warning. Discovery that finds nothing leaves no `~/.opentasks` behind. With no daemon reachable it exits 1 and says how to start one; a write that fails is reported (exit 1) and retried by the next sync.

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

To run a team, type **`/swarm [--wait] [--workers <n>] <task>`** in the composer. A
coordinator decomposes the task into numbered subtasks, `n` workers (default 3)
run them concurrently, and the coordinator synthesizes. By default the command
returns at once with the run id (`Started run-…`); follow the run in the Swarm
tab or with `openswarm attach <run>`, both of which show the synthesis once it
finishes. When it settles, the outcome is also handed to the session as context
for its next turn, without waking the lead. `--wait` blocks instead and returns
the plan and the synthesis inline, for surfaces that show only the command's
text. Members inherit the session's model route, so nothing extra is
configured.

The command is registered by the `openswarm-swarm/command` bundle row, so it
appears on any dsh surface that renders the command registry — the browser UI
today, a TUI profile when one ships.

While the team runs, it holds a row in the surface's **background-jobs list**
(the session-header control): label, status, and a ticking elapsed clock, with
a shape summary once it settles. Killing that row cancels the team. (A live
Azure run under the old always-blocking form held its request open 72s without
trouble.)

Run as the very first action in a brand-new session, the command's reply (the
started run, or under `--wait` the result) is also posted into the
conversation as a follow-up turn, which makes the Swarm tab appear. A session
stays "blank" until something opens a turn, and command records deliberately never do (the same
reason `/plan` and `/goal` leave a fresh session untouched) — so without that
the surface would keep showing its landing screen and the result would never
render. It costs one lead model round, and only happens on a blank session.

**The Swarm tab** (the `openswarm-swarm-client` row, a dsh client plugin; `openswarm setup` adds it to an older home) sits beside Chat and Trajectory in a session's view tabs; dsh shows the tab bar only once a session has started. It follows one run, picked from a list of every run in `<home>/runs` (default: the newest started from this session, else the newest): status and topology with a Cancel button while it runs, the run's intent, a finished run's **Result** (the synthesis or final output), the task board (id, status, owner, subject; a task's own end state on hover), open questions with a button per option, the recap newest first, and a steer box (member and text → `immediate` or `enqueue`, or the refusal). **Start run** takes a `TeamSpec` as JSON and optional `worktrees` JSON (`{ "repoRoot": … }`, which makes steers land `immediate`); steering needs a messaging peer-team. It talks to the web carrier and updates by long-polling `swarm/events`, so direction (cancel, steer, answer) works only on runs this web process hosts: those started from the tab, by `/swarm`, or by the CLI below. `openswarm web` also serves the socket carrier on an ephemeral loopback port and writes `<home>/app-server.json`, so `openswarm start|steer|answer|kill` direct the same runs the tab shows. Run one of `openswarm web` and `openswarm serve` per home: both write that file, the last to start wins, and either one stopping removes it.

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

## Hidden tests: the L3 verifier

The completion gate ([docs/05](05-control-plane-redesign.md) B6, B1) accepts
work on the strongest verifier it is given: L1 a reviewer, L2 the task's checks,
L3 a hidden suite (L0 is no gate; L4, external CI on the train, is not built).
A hidden suite is one members cannot read: it lives in a store owned by a
separate, locked OS user with mode 0700, so the kernel refuses a member, which
runs as you, any read of it. A root-owned helper, run through sudo, is the only
way in, and it answers with counts.

### Setup

```
openswarm verifier setup [--node <path>] [--print]
```

It prints the commands, then runs them with `sudo` (your password, at sudo's
own prompt; nothing is stored). `--print` stops after printing. It creates:

- the user: `_openswarmverifier` on macOS (hidden, uid under 500, shell
  `/usr/bin/false`, home `/var/empty`), `openswarm-verifier` on Linux
  (`useradd --system`, no login, no home). Its primary group is yours, so it
  can read your repository's ignored environment through a 0750 home;
- the store, owned by it, 0700: `/Library/Application Support/openswarm-verifier`
  (macOS), `/var/lib/openswarm-verifier` (Linux);
- `/usr/local/libexec/openswarm-verifier/`: the helper, its config and its own
  copy of node, all root-owned;
- `/etc/sudoers.d/openswarm-verifier`, checked with `visudo -cf` before it is
  installed: `run`, `list` and `log` as the verifier without a password (the
  gate needs them unattended), `add-suite` and `remove-suite` with your
  password every time, so a member (you, without the password) cannot plant a
  suite whose command reads the store.

Setup refuses to run as root, into a directory that is not root-owned or that
its group or others can write (up to `/`), or with a node that loads libraries
from anywhere you can write. Homebrew's node does (`@rpath/libnode`,
`/opt/homebrew/...`), and the verifier runs a copy of it, so a member could
replace a library and run as the verifier: pass `--node` an official build
from nodejs.org, which loads only system libraries. The root script copies
node into a root-only staging directory first and checks the copy there (its
sha256 against the one checked before, then its libraries with `/usr/bin/otool`
or `/usr/bin/ldd`, system directories only) before installing it, so what is
installed is what was checked; every tool it runs is named by absolute path.

`openswarm verifier status` checks each piece, that the helper answers
without a password, and whether this host confines a run fully. `openswarm verifier uninstall [--print]` removes the sudoers
rules first, then the helper, the store with its suites, and the user.

### Adding a suite

A suite is a directory of test files with an `openswarm-suite.json` at its root:

```json
{ "command": "cd {work} && .venv/bin/python -m pytest -p no:cacheprovider --noconftest --junitxml=report.xml {suite}",
  "junit": "report.xml", "timeoutMs": 600000 }
```

`{work}` is a fresh copy of the round's snapshot and `{suite}` the run's copy of
the suite (both shell-quoted). With `junit` (a path under `{work}`) the counts
are its test cases; without it the suite counts as one test that passes on exit 0.

```
openswarm verifier add-suite <name> <dir>   # your password
openswarm verifier list                      # names and canary ids
openswarm verifier remove-suite <name>       # your password
```

A name is 1–64 of `[a-z0-9-]`. The helper refuses an absolute path, `..`, a
link, a device or a tar over 64 MiB; it appends a random canary comment to each
test file whose comment syntax it knows (`#`, `//`, `--`; not JSON) and stores
the files read-only. `list` needs no password, so it shows each canary's id (a
hash), never the canary.

### Gating at L3

```
openswarm run --gate --gate-level 3 --gate-suite <name> [--gate-check "<cmd>"] "<task>"
```

Or `OPENSWARM_GATE=1 OPENSWARM_GATE_LEVEL=3 OPENSWARM_GATE_SUITE=<name>`. A
suite alone implies L3. `--gate-level N` declares the minimum and is refused
before any spend when nothing configured reaches it (2 needs `--gate-check`, 3
needs `--gate-suite`), as is a suite the verifier does not hold. The weaker
source still runs, for feedback only: the checks if given, else the reviewer.
For a team, give a `peer-team` spec `gate: { suite, minLevel }`, or `suite` and
`minLevel` per task; its board refuses to complete a task on evidence below the
task's level (a human waiver has no level). Levels show in `openswarm board`,
the recap, the `gate_round` lines and `tasks sync`'s `verifies` edges.

Each round, the helper takes `git archive` of the round's snapshot on stdin
(`sudo -n -u <user> <helper> run <name> --env-root <repo>`), unpacks it into a
private 0700 directory, links your repository's ignored environment
(`node_modules`, `.venv`, `venv`, `dist`, `build`, `target`, `.tox`) in
read-only, runs only the stored command, deletes the directory, and prints
`{ passed, total, failed, durationMs, enforcement }` and nothing else. The
member is told `hidden acceptance suite: F of T failing`, plus the weaker
source's feedback. A snapshot the helper refuses (a malformed archive, a link
under a link) fails that round, and the member is told `hidden suite: snapshot
refused: <why>`. The command gets `HOME` and `TMPDIR` inside its directory and
a `PATH` of system directories and the helper's node, so use a venv or
`node_modules` from your repository, not your user-site packages.

`enforcement` is `full` on macOS (Seatbelt: no network, not even localhost;
writes only in the run's directory; the store hidden but for the run's copy of
its suite; no shared memory) and on Linux with bwrap (new network, IPC and pid
namespaces; the store under a tmpfs). Anywhere else it is `partial` (`unshare`
can still cut the network), and the run goes ahead with the evidence saying so.
Read `partial` as no confinement of what the suite's code writes: code under
test runs as the verifier, so it can copy the suite somewhere a member reads it,
or edit the helper's log. So L3 refuses to start on such a host, before any
spend. Install bwrap; or set `OPENSWARM_VERIFIER_ALLOW_PARTIAL=1` to run
anyway, when the evidence is recorded as `level: 3, enforcement: 'partial'`
and a board counts it as L2. A run that comes back `partial` without that
(bwrap gone mid-run) ends the gate, never counted as L3.

### Tamper incidents

Before a round is measured, the gate scans the member's tool calls and their
outputs in that round, the lines its diff adds, and the helper's log. An
**incident** needs corroboration: a suite's canary anywhere, a helper call
during the member's turn that the gate did not make (by the member's processes
or orphaned ones), a command of the member's own aimed by `sudo` at the
verifier user or helper, or one naming a verifier path that the kernel denied.
The round is then not measured, so the member learns nothing from it, and the
gate stops: the single path prints a `tamper` JSONL line (`severity:
"incident"`) and exits 1; a team journals `swarm/tamper` and asks a high-tier
`tamper` question, abandon the task and its dependents (the default) or
continue as a failed attempt. A bare mention of the store's or the helper's
path or the user's name is **advisory**: journaled (`severity: "advisory"`)
and the round measured as usual, since anyone can write a name. A repository
that documents the verifier (OpenSwarm's own) can therefore be gated, and text
a sibling plants in a file another member reads abandons nothing. Signals
record what matched (a path, the user's name, a canary's id, a log entry's
command and caller), never content.

### Limits

- **Root.** All of it rests on members not being root, since root reads any
  file: L3 refuses to start as root. In eval containers, where members run as
  root, the grader's held-out tests are the hidden suite instead.
- **Counts and timing leak a little.** The member learns pass and fail counts
  and can time the run. The code under test runs in the same process as the
  tests, so it can read them while it runs and signal through the result: a few
  bits a round. A member that calls the helper itself is a tamper incident.
- **The snapshot runs the runner too.** A command that lets the work tree
  configure it (a `conftest.py`, a runner config file) can be faked by the
  member's code; write it so the snapshot cannot (`--noconftest`, a config from
  `{suite}`). L3 hides tests; it does not make a runner unforgeable.
- **Other channels.** On Linux a pathname Unix socket a member makes
  world-writable is reachable from the run; on macOS, Mach services are not
  filtered. Both need code that read the suite while it ran.
- **The scan is detection; the kernel is the guarantee.** A worktree
  member's transcript is read from session logs by time, and in-process
  members share this process's ancestry, so with members in parallel a
  sibling's helper call can land on another's turn as an incident.

The exit criterion 2 probe needs the real setup:
`openswarm verifier add-suite probe packages/cli/tests/fixtures/verifier-probe`,
then `OPENSWARM_VERIFIER_E2E=1 npx vitest run packages/cli/tests/verifier.e2e.test.ts`.
The verifier is always the installed one, `/usr/bin/sudo -n -u <user>
<helper>`; no environment variable changes which command runs, since anything
that could set one (a member editing your shell profile) could swap in a helper
of its own that says whatever it likes. The keyless tests run a copy of the
helper as you against a temp store by injecting it in code
(`injectVerifierForTests`, or `RunTeamOptions.verifier` per run), in-process.

## The app-server (for UIs, CLIs, programs)

`openswarm serve` binds a newline-delimited JSON-RPC 2.0 endpoint: the socket carrier of the swarm protocol ([docs/05](05-control-plane-redesign.md) §5.3), in front of dsh's SDK session protocol. Connect with `@deepseek-ai/dsh-sdk-protocol`'s `JsonRpcLineTransport`.

- **Auth.** A connection starts unauthenticated, and every method but `swarm/auth { token } → { principal }` is refused until it binds one. At listen the server writes `$OPENSWARM_HOME/app-server.json` (default `~/.openswarm`): `{ url, token, pid }` with an owner token, mode 0600, removed on close. The owner mints more tokens with `swarm/token`; they are held in memory and die with the process.
- **Policy**, default-deny: owner, everything; viewer, state; driver, state, direction and low-tier answers; member (bound to one run and member name), its own run's state. A viewer or driver token minted with a `runId` is held to that run too. A refusal is a JSON-RPC error whose message starts with `FORBIDDEN`, `UNKNOWN_METHOD`, `INVALID_PARAMS` or `NOT_FOUND`.
- State:
  - `swarm/runs {} → { runs: [{ id, status, topology, parentSessionId, writer, startedAt, endedAt?, error?, result?, spec? }] }`, read from the run journals, so it survives a server restart.
  - `swarm/view { runId, since? } → { run, tasks, questions, recap }`.
  - `swarm/events { runId, afterSeq?, waitMs? } → { events }`: the run's journal events after `afterSeq` (default -1). For a run live in this server, a poll with nothing new waits up to `waitMs` (default 0, at most 30000) for the next event, so polling with the last `seq` follows a run.
  - `swarm/questions { runId? } → { questions: [{ runId, id, trigger, kind, tier, prompt, options, default, status, raisedAt, taskId? }] }`: the open questions of every run live in this server, or of one run (a bound principal's own). `taskId` names the task or train entry a question is about, where it is about one.
  - `swarm/landings { runId } → { landings: [{ …bundle, text }] }`: the run's landing queue ([docs/05](05-control-plane-redesign.md) B4), highest risk first, each evidence bundle with its `openswarm landings` block as `text` lines. Read-only.
  - `swarm/metrics { runId } → { metrics, rows }`: the run's RunMetrics (B5), and the `[row, value]` text pairs `openswarm metrics` prints; priced from the `openswarm-swarm` row's `pricing`.

  The event stream is additive since B4/B5: besides the run, board, mailbox, steer, question, gate and tamper events, a run's journal now carries `swarm/usage` (one per member run, as it settles: member, role, task key, runtime, provider, model, token counts), `swarm/restart` (a dead messaging member restarted on its task) and, without the train, `swarm/evidence` (a merged or conflicted task's bundle); the run record gains `landing` and `usageJournaled`. A member run's usage is journaled before what follows from it, so a task's `completed` snapshot comes after its member's usage, and a cancelled run's `failed` record after the aborted members' usage: a client following `swarm/events` should skip types it does not know, not stop at them. The train's own journal (`train.jsonl`) gains `train/evidence`.
- Direction:
  - `swarm/start { spec, provider?, model?, worktrees?, questionTimeoutMs? } → { runId }`; the connection that starts the run gets a `swarm.runFinished` notification carrying the `TeamResult` (or `error`). The lead's route fills a missing `provider` or `model` from the harness's default model (`ctx.agentDefaultModel`, the profile's `agent-default-model` row), which members inherit. The run's questions wait `questionTimeoutMs` (default 300000) for an answer.
  - `swarm/steer { runId, to, text } → { delivery }`: a member of a messaging peer-team; `immediate` (next step boundary) under `worktrees`, else `enqueue` (its next turn). Other topologies have no addressable members.
  - `swarm/cancel { runId } → { cancelled: true }`: aborts the run (a messaging peer-team's members finish their current turn), which records `failed`.
  - `swarm/attach { runId }`: take over a run whose process died (see below).
- Answer: `swarm/answer { runId, questionId, answer } → { answered: true }`, `answer` being one of the question's `options`. An owner answers any question; a driver only a `low`-tier one that is not a consent or approval.
- Admin: `swarm/token { role, runId?, member? } → { token }`.
- Delegated to dsh, owner only: `initialize`, `session/prompt`, streamed `session.event` / `session.status`.

**Questions** ([docs/05](05-control-plane-redesign.md) §6.1). The harness asks when a messaging member under `worktrees` stays silent through a nudge (`stall`: restart it, or wait another `memberIdleTimeoutMs`), a member dies with its restart budget spent (`restart-budget`: drop it, or restart once more), a board task runs out of attempts with a sibling left to retry it (`task-attempts`: abandon it, or retry once more), or every cascade tier fails (`verifier-failure`: stop, or retry the top tier once). Each question is a low-tier escalation in the run's journal (`swarm/question`, with recap lines) and takes the first answer, else its default once the timeout passes; while 3 are open, the next is `capped` at its default at once, and a run that ends defaults the rest.

A `spec` is a `TeamSpec` — e.g. `{ topology: 'fanout', members: [{name}], tasks: [{member, prompt}] }`. Any spec may carry an `intent` — `{ purpose, endState, constraints?, preferences? }`, the end state checkable — which is prepended as an `## Intent` header to every member prompt of the run; a peer-team task's own `intent` replaces it for that task. `openswarm board` and the Swarm tab show it. See the topology types in [`packages/swarm/src/types.ts`](../packages/swarm/src/types.ts). A worked client is [`packages/app-server/tests/app-server.e2e.test.ts`](../packages/app-server/tests/app-server.e2e.test.ts).

**The web carrier.** The `openswarm-web` profile also serves these `swarm/*` methods, minus `swarm/token`, on dsh's `/api` gateway (the `openswarm-app-server-web` row; `openswarm setup` adds it to an older home): `POST /api/swarm/<method>` with `{ type: 'client-request', rpcId, method: 'swarm/<method>', payload: { args: { …params } } }` answers `{ result: { ok: true, value } }`, or `ok: false` with an `error.message` led by the same code. Every caller is the owner, because dsh's web server authenticates nothing, so the carrier refuses to load unless that server binds 127.0.0.1, and the refusal fails the boot: `openswarm web --host 0.0.0.0` starts only with the row disabled. The gateway has no push, so there is no `swarm.runFinished`; follow a run by long-polling `swarm/events` with the last `seq`. An open question is also put to dsh's own question prompt (`ctx.userQuestions`), in the run's lead session; an answer there is recorded `by: 'userQuestions'`, and a reply naming none of the options is ignored.

## Driving a team in-process

`ctx.swarm.runTeam(spec, { parent, worktrees? })` is the programmatic entry point; it is `ctx.swarm.start(spec, options)` (a handle with the run `id`, its `board()`, and the `result` promise) plus waiting for the result. Each run journals to `$OPENSWARM_HOME/runs/<run id>/journal.jsonl` (default `~/.openswarm/runs`), which `ctx.swarm.runs()`, `view(runId)` and `attach(runId)` read from any process (outside a harness, `listRuns(runsDir)`, `viewRun(runsDir, runId)` and `attachRun(runsDir, runId)` do the same, with `defaultRunsDir()`); `attach` takes over a run whose process died, releasing its claims and marking it `interrupted`. `RunTeamOptions.worktrees` turns member runs into subprocess harnesses in per-task git worktrees and returns a merge outcome. At most `worktrees.maxConcurrent` (default 8) harnesses run at once; the rest queue, so a large fanout does not spawn one subprocess per task up front. `onProgress` receives human-readable progress lines; every topology emits. `questions: { timeoutMs?, maxOpen? }` (default 0 and 3) sets how long a question waits: at 0 every question takes its default at once, as an unattended run needs; the handle's `answer(questionId, answer, by)` answers one.

Worktree runs clean up after themselves in two ways: an abort or throw drops this run's checkouts without merging (branches survive, so committed work stays reachable), and each run first sweeps `.swarm/worktrees/` for teams that died before finalizing — the SIGKILL case try/finally cannot cover. Live teams are never touched, so concurrent runs are safe. Members set `agentOptions: { provider, model }` for heterogeneous rosters. See [`packages/swarm/tests/boot.ts`](../packages/swarm/tests/boot.ts) for a minimal composition.

**Member sandbox** ([docs/05](05-control-plane-redesign.md) §5.5, behind a flag). `OPENSWARM_MEMBER_SANDBOX=workspace-write`, or `worktrees.member.sandbox: 'workspace-write'` for one run, confines a worktree member's writes, from bash (and everything it spawns) and from the editor, to its worktree and temp (`/tmp`, `$TMPDIR`); unset, members run `danger-full-access`. Reads and network stay open, so it contains damage but hides nothing. The npm, pip and cargo caches (and `XDG_CACHE_HOME`) move to `$TMPDIR/openswarm-cache/<team>`. Failing by design: git writes in the worktree (`add`, `commit`, `checkout -b`; the object store and `.git/worktrees/<name>` are outside it, and the lead auto-commits), global installs (`pip install` outside a venv, `npm -g`), and anything else that writes the home directory. Where dsh has no backend (Seatbelt on macOS, bwrap or Landlock on Linux), a member's bash fails rather than running unconfined. A custom `member.configPath` composition must read the variable itself.
Under the sandbox a member also cannot open PTYs (`posix_openpt` is denied), so a repo suite that spawns PTY shells (this repo's own e2e tests) fails when a member runs it; the lead-side command gate still runs it.

**Claude Code members** ([docs/05](05-control-plane-redesign.md) R1). A member with `runtime: 'claude-code'` runs your installed `claude` CLI headless instead of a dsh harness, in the same place a dsh member works: its task worktree under `worktrees` (a scratch worktree for a keyless run), else, in place, the parent agent's cwd, which an in-process dsh member inherits too (`confidenceCwd` places checks, not members). A parent without a cwd is refused. A roster may mix runtimes:

```json
{ "topology": "peer-team",
  "members": [
    { "name": "dev" },
    { "name": "claude", "runtime": "claude-code", "agentOptions": { "model": "sonnet" } }
  ],
  "tasks": [ … ] }
```

- **The CLI**: `worktrees.member.claudeCommand`, else `OPENSWARM_CLAUDE_BIN`, else `claude` on PATH. A run with claude-code members runs `<claude> --version` once before any spend and stops there if it fails. Each run is `claude -p --output-format stream-json --verbose --no-session-persistence --permission-mode <mode>` (plus `--model` from `agentOptions.model` and `--setting-sources` from `claudeSettingSources`), the prompt on stdin: the member's persona, intent header and task, as a dsh member gets it.
- **Auth** is yours: the child inherits your environment minus what dsh's spawner scrubs (names containing `KEY`, `TOKEN`, `SECRET` or `PASSWORD`, and `DSH_*`) and the launcher's routes (`OPENSWARM_*`, `DEEPSEEK_*`, `OPENAI_*`, `AZURE_API_*`), keeping `ANTHROPIC_*` and `CLAUDE_*` (so `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` pass) and, when `CLAUDE_CODE_USE_BEDROCK` is set, `AWS_*`. Without those it uses your Claude login.
- **Permissions and sandbox**: Claude Code's own settings govern the member; OpenSwarm's member sandbox (`OPENSWARM_MEMBER_SANDBOX`) covers dsh members only. The permission mode is the member's `permissionMode`, else `worktrees.member.claudePermissionMode`, else `acceptEdits`: it edits files, and anything else that would ask (most Bash) is denied, as no one answers prompts in headless mode. `bypassPermissions` runs every tool unasked; opt into it only where you would run `claude --dangerously-skip-permissions` yourself. By default your full Claude Code settings apply, as in any `claude` run in that directory: your global hooks, MCP servers and `CLAUDE.md`, and the repo's own. `claudeSettingSources` on the member (else `worktrees.member.claudeSettingSources`) passes `--setting-sources`: `["project", "local"]` leaves out your user-level settings.
- **Basic only**: one-shot runs, cancellable: it reports `aborted`, or never starts when the run is already cancelled. A stop sends SIGTERM, then SIGKILL after 5s, to the CLI's process group and the descendants it has at that moment. Claude Code starts its Bash tool and hooks in sessions of their own, so a process one of them starts after the stop, or that detaches from it, can outlive the member until Claude's own shutdown reaps it. A CLI still running 10s after its result is stopped the same way (its result stands), and `claudeTimeoutMs` on the member (else `worktrees.member.claudeTimeoutMs`; default none) bounds a whole run, an error when it fires. Refused before any spend: a messaging peer-team (it needs members that keep one session and take messages mid-run), and an L3 run, a gated task's or the train's hidden suite (its tamper scan reads dsh session logs only, so it cannot read Claude Code transcripts). Every other topology, the completion gate at L1 and L2, and the train at L2 take it, and it repairs or resolves its own train entries as fresh runs in their worktrees.
- **Cost**: each run journals its usage and the CLI's own `total_cost_usd` as `swarm/usage` with runtime `claude-code`. `openswarm metrics` and `landings` take those dollars as reported and price only the rest from `--pricing`. A run that reported none and that the table cannot price (a cancelled or crashed claude-code run, a dsh run without prices) is counted, and the dollars read `at least $…` with that count (`dollars.unreported` in `--json`): a lower bound, never a reported total dropped to null. A claude-code-only run has dollars without a table.

### A team from the command line

```
openswarm run --model <m> --spec team.json "<task>"     # or OPENSWARM_TEAM_SPEC=team.json
```

`team.json` is a `peer-team` or `fanout` spec with its run's worktree options beside it:

```json
{ "topology": "peer-team",
  "members": [{ "name": "a" }, { "name": "b" }],
  "tasks": [{ "subject": "api", "prompt": "…" }, { "subject": "ui", "prompt": "…", "blockedBy": [0] }],
  "worktrees": { "train": { "checks": ["npm run build"], "batchSize": 4, "maxRepairs": 1 } } }
```

Members run as worktree members in the current repository; a dsh member takes the CLI's route (`--model`) unless it names its own, as plan-mode members do, and a spec of claude-code members alone needs none. dsh members run `danger-full-access` unless the member sandbox is on (`OPENSWARM_MEMBER_SANDBOX=workspace-write`, or `"worktrees": { "member": { "sandbox": "workspace-write" } }`; see the member sandbox above). The `<task>` goes ahead of every task's prompt. The run lands into a fresh target branch (through the train when `worktrees.train` is set, else the sequential queue). Then the branch checked out when the run started is fast-forwarded to that target, so the checkout holds the landed result, but only when that same branch is still checked out at the same commit (never a detached HEAD or another branch), the checkout is clean, and nothing the fast-forward writes is an ignored file there; otherwise it is refused and the refusal reported (stderr and `team_note`), the result left on the target branch. Output is the headless JSONL: a `team_note` line (run id, target branch, landed, ejected, withheld, what happened to the checkout, the run's metrics), the text summary, and `message_stop` with every member run's usage (tasks, reviews, repairs, resolvers, claude-code runs), cache writes as `cacheWriteInputTokens` and claude-code's own dollars as `claudeCodeCostUsd`. `--max-tokens` and `--max-turns` count them all, a claude-code run once it ends. A spec cannot be combined with `--team`, plan mode or `--gate`; gate a peer-team with its own `gate`.

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
