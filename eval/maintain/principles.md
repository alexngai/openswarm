# OpenSwarm maintenance principles

The principles `openswarm maintain` checks this repository against (docs/05
C7b, exit criterion 3). Scope: `packages/*/src`, `packages/*/tests`, `docs/`
and `eval/pilot/`. Never `legacy/`, `node_modules/` or `dist/`.

1. Every exported function, class, interface and type in `packages/*/src`
   has a doc comment saying what it is for, not how it works.
2. Nothing in `packages/*/src` is unused: no unused imports, locals,
   parameters, or non-exported functions and constants.
3. Every file path (`packages/...`, `eval/...`, `bin/...`) and every doc
   number (`docs/NN`) a doc or comment cites exists.
4. An error a person can hit says what to do next when there is an obvious
   fix (the flag to pass, the command to run, the file to create).
5. A `ponytail:` comment names its ceiling and the upgrade path.
6. Tests import package sources (`../src/...` or the package name through the
   vitest alias), never a `dist/` build.
