# Contributing to OpenSwarm

Thanks for your interest in contributing!

## Build & test

```bash
bun install                                        # install dependencies
npm run build                                      # type-check + bundle
npm test                                           # vitest suite
bun test src/ui/repl-solid/                        # OpenTUI/Solid UI tests (bun test, not vitest)
npx tsc -p eval/tsconfig.json --noEmit             # type-check eval/ tree
npx tsc -p experimental/tsconfig.json --noEmit     # type-check experimental/ tree
```

## Package management (dual lockfiles)

Both lockfiles are tracked deliberately:

- **`package-lock.json` is canonical** — CI installs with `npm ci`, and all dependency changes should go through `npm install <pkg>`.
- **`bun.lock` feeds the compiled-binary build** (`npm run build:compile`), which resolves dependencies with Bun.

After any dependency change, resync the Bun lockfile with `bun install --lockfile-only` and commit both files. CI enforces this with a `bun install --frozen-lockfile --dry-run` check.

## Pull requests

- Keep PRs focused — one logical change per PR.
- Include tests for new behavior and make sure `npm run build` and `npm test` pass locally.
- Follow the existing code style; TypeScript strict mode is enforced by the build.
- Reference related issues in the PR description.

## Design docs

Architecture and design documents live in `docs/` — see [`docs/README.md`](docs/README.md) for the index. If your change touches architecture, protocols, or orchestration semantics, skim the relevant doc first.

## Reporting issues

File bugs and feature requests at [github.com/alexngai/openswarm/issues](https://github.com/alexngai/openswarm/issues). For security issues, see [SECURITY.md](SECURITY.md).
