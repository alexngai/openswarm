# Agent Instructions

OpenSwarm is a TypeScript multi-agent coding CLI: one orchestrator coordinating N specialized agents over shared task lists, worktrees, and memory.

## Build & test

```bash
bun install                                        # install dependencies
npm run build                                      # type-check + compile (tsc)
npm test                                           # vitest suite
bun test src/ui/repl-solid/                        # OpenTUI/Solid UI tests (bun test, not vitest)
npx tsc -p eval/tsconfig.json --noEmit             # type-check eval/ tree
npx tsc -p experimental/tsconfig.json --noEmit     # type-check experimental/ tree
bun scripts/check-parity-manifest.ts               # product-parity capability manifest gate
```

## Conventions

- **Dual lockfiles are deliberate.** `package-lock.json` is canonical (CI installs with `npm ci`; add dependencies via `npm install <pkg>`). `bun.lock` feeds the compiled-binary build. After any dependency change, resync with `bun install --lockfile-only` and commit both files — CI fails on a stale `bun.lock`.
- UI component tests under `src/ui/repl-solid/` run with `bun test`, not vitest.
- `eval/` and `experimental/` are separate TypeScript trees with their own tsconfigs; type-check them explicitly when touching them.
- The product-parity capability contract in [`docs/67-product-parity-roadmap.md`](docs/67-product-parity-roadmap.md) is encoded as data in `src/parity/`. Editing a `DDP-*` outcome, its evidence, or the roadmap tables in one place without the other fails CI — change both, or run `bun scripts/check-parity-manifest.ts` to see what diverged.

## Docs

Design docs live in `docs/` — see [`docs/README.md`](docs/README.md) for the full index.
