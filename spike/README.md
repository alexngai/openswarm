# Phase-0 spike — results

Probes from [docs/01 §Phase-0](../docs/01-dsh-foundation.md), run 2026-08-23
against the published npm distribution (`@deepseek-ai/dsh*@0.1.1-rc.2`,
Node 22). **All four passed; no dsh patches were needed.**

| # | Probe | Verdict | Evidence |
|---|---|---|---|
| 1 | Bundle mechanics | PASS | `dsh plugin --profile headless add file:packages/spike-bundle` → pnpm add + auto-join of the bundle layer; `--dump-config` shows our row under a `# == openswarm-spike-bundle` provenance header |
| 2 | **Worktree isolation (kill criterion)** | PASS | `probe2-worktrees.mjs`: two SDK-driven child harnesses, `cwd` = two git worktrees; each child's persistent-bash `pwd; cat MARKER` returned its own worktree path and marker through the real tool pipeline |
| 3 | SDK drive + method extension | PASS* | `probe3-rpc.mjs`: initialize handshake ok; unknown `swarm/ping` rejects as typed JSON-RPC `-32603`. *Red flag (minor): the server's method table is a closed `switch` — no registration seam. Not a fork: `HarnessSdkJsonRpcServer` is exported, so our app-server owns the transport and delegates non-swarm methods to it. Transports are caller-owned streams (TCP/WS possible). Upstream issue candidate: a method-registry seam. |
| 4 | Hot-load with rollback | PASS | Against a live `dsh web`: editing the profile's `cordis.patch.yml` replugged our marker plugin (`spike-v1` → `spike-v2-hot`, no restart); a broken patch (nonexistent package) left the last-good tree running, still HTTP 200 |

## Distribution findings (feed the pin policy)

- **npm dist-tags are stale.** Bare `npm install @deepseek-ai/dsh-<pkg>`
  resolves ancient `0.0.1-rc.1` builds that import pre-rename package names
  (`dsh-bash-env`, `dsh-environment`, …) which were never published — the
  peer-dep maze we hit first. **Always pin the aligned release version
  explicitly** (`@0.1.1-rc.2` era); at aligned versions plain npm resolves
  the whole tree cleanly, no `--legacy-peer-deps`.
- The client README's `await using` needs Node ≥ 24 (explicit resource
  management); on Node 22 call `close()` manually.
- Patch files insert new rows under a `- insert:` key; a bare `- id:` row
  targets an existing entry and fails loud if absent.

## Re-run

```sh
npm install                 # package.json pins the aligned versions
node probe2-worktrees.mjs   # worktree isolation
node probe3-rpc.mjs         # SDK drive + unknown-method rejection
```

Probes 1 and 4 are interactive (`DSH_HOME=$PWD/.dsh-home npx dsh ...`); the
transcript lives in the session, and `packages/spike-bundle/` is the
out-of-tree bundle they exercise.
