# Agent Instructions

OpenSwarm is built as out-of-tree plugins on DeepSeek Harness (`dsh`,
Cordis-based). [`docs/01-dsh-foundation.md`](docs/01-dsh-foundation.md) is the
governing design doc (decision, seams, focus features, phases);
[`docs/03-usage.md`](docs/03-usage.md) is the operator runbook.

## Build, run, test

```bash
npm install && npm run build          # build plugin packages to dist/
./bin/openswarm.mjs "explain this repo"  # run a task (auto-detects provider from env)
npm test                              # keyless suite (scripted mock LLM)
npm run typecheck                     # tsc across every package
OPENSWARM_LIVE=1 npm test             # + env-gated live tests (needs creds)
```

- Tests read package sources via a vitest alias (no build needed); `main`
  points at `dist/`, so a real `dsh` boot / publish needs `npm run build`.
- After editing a package that other packages import, rebuild before booting
  the launcher (tests don't need it).

## Packages

`packages/swarm` (`ctx.swarm`: topologies, log-backed board, mailbox),
`packages/git` (worktrees + merge queue), `packages/llm-openai`,
`packages/llm-anthropic`, `packages/app-server` (JSON-RPC), `packages/cli`
(eval cascade CLI), `packages/plugin-authoring` (F3), `packages/swarm-member`
(member-side messaging), `packages/bundle` (the dsh bundle + profiles).

## Conventions

- **`legacy/`** is the frozen v0.x implementation, kept for reference. Its own
  build/test instructions are in `legacy/CLAUDE.md` (`bun install` inside
  `legacy/` first). Do not extend it.
- A dsh source checkout for reading lives at `../deepseek-harness` (see its
  `docs/architecture.md` and cookbook). We consume dsh from npm at a pinned
  exact version — never patch the checkout as part of a change here.
- Docs are numbered and cited by number (`docs/01`); numbers are never
  reused. Legacy docs keep their old numbering under `legacy/docs/`.
- The deferred-work ledger and phase status live in docs/01.
