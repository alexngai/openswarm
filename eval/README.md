# eval/ — experiment-running code

Experimental infrastructure for the adaptive-orchestration work in
[docs/45](../docs/45-adaptive-orchestration-design.md). Everything here is **research code**, not
shipped product: `eval/` is outside `tsconfig.build.json` and `package.json#files`, so it never
lands in the npm package. Experiments run under **node via global `tsx`** (`tsx eval/experiments/<file>.ts`) —
**not bun** (bun's gzip handling corrupts E2B's compressed output). See
[docs/47](../docs/47-h1-experimental-findings.md) for H1 findings + the full reproduction recipe.

## Why this exists

We're approaching orchestration **experimentally** — reproduce the failure findings of the
multi-agent literature on swarm-harness, then show structural fixes overcome them (docs/45):

| Hyp. | Claim | Status |
|---|---|---|
| **H1** | Homogeneous Claude team ≤ single long-lived agent, at higher cost (reproduce arXiv 2601.12307) — negative control | **done: parity, 2 families ([docs/47](../docs/47-h1-experimental-findings.md))** |
| **H2** | Heterogeneous roster (different base models per role) beats best single model + homogeneous team | — |
| **H3** | Structural fixes (isolation + access-lists + first-class verification) beat the **~+14%** tactical ceiling and shift the MAST histogram | — |
| **H4** | An orchestrator that *decides* whether to fan out is Pareto-better | — |

## Engine: `swarmkit-eval`

We don't build a bespoke harness — we depend on
[`swarmkit-eval`](https://github.com/alexngai/swarmkit/tree/main/src/eval), which already provides the
`(task × arm × model × seed)` matrix runner with **ground-truth grading**, sandboxed backends
(in-process / docker / e2b / modal / ec2), the SWE-bench / GAIA(HAL) / **MARBLE multi-agent**
benchmarks, LiteLLM-gateway model routing (for heterogeneity), a MAB driver (for the H4 learned-priors
layer), and paired-CI / pass^k / Pareto statistics.

swarm-harness is already a **registered harness** in swarmkit-eval
(`swarmHarness()` → `swarm-harness --single --headless --output-format json …`), wired as the
**single-agent baseline**. Team/heterogeneous arms use `execution: "marble"` (native multi-agent).

### Local dev-dependency (live-linked)

`swarmkit-eval` is a `devDependency`, symlinked to the sibling checkout so edits there are picked up
without reinstalling (per the multi-repo convention):

```sh
ln -sfn /Users/alexngai/GitHub/swarmkit/src/eval node_modules/swarmkit-eval
ls -la node_modules/swarmkit-eval   # → … -> /Users/alexngai/GitHub/swarmkit/src/eval
```

If you change the sibling's source, rebuild its `dist/` (`cd …/swarmkit/src/eval && npm run build`) —
the symlink resolves `main: dist/index.js`.

## Layout

```
eval/
  README.md                         this file
  tsconfig.json                     standalone (NodeNext, noEmit; run via bun)
  vitest.config.ts                  standalone test config (eval/**/*.test.ts)
  experiments/
    smoke.ts                        zero-token wiring check (✅ verified)
    h1-single-vs-team.ts            H1: single vs homogeneous-team arms on SWE-bench/E2B
  harness/
    local.ts                        run the working-tree CLI in evals (no publish)
    swarm-modes.ts                  single-vs-team as an extraTools arm axis
  mast/
    taxonomy.ts                     the 14 MAST failure modes (FC1/FC2/FC3)
    judge.ts                        LLM-as-judge trace tagger + histogram (✅ tested)
    judge.test.ts
  scripts/
    pack-local-harness.sh           build + npm pack the local CLI for sandbox evals
    prep-swe-subset.sh              prep a SWE-bench subset (needs `pip install swebench datasets`)
```

### E2B safety (shared account)

The H1 run is a good neighbor on the team E2B account: the backend kills only the sandbox it creates
(no `list()`+kill sweep), templates are **namespaced `sh-h1-<id>`** so we never overwrite the shared
`swe-<id>` templates, `skipCache` stays off, and cell concurrency is bounded.

## Run

```sh
# Zero-token wiring check — proves matrix → backend → adapter → grade → store → paired report.
bun eval/experiments/smoke.ts

# Tests (MAST judge) + typecheck.
npx vitest run -c eval/vitest.config.ts
bunx tsc -p eval/tsconfig.json

# H1 single-agent baseline on E2B (once instances are prepped):
RUN_H1=1 E2B_API_KEY=… SWE_INSTANCES_DIR=eval/.artifacts/swe-instances bun eval/experiments/h1-single-vs-team.ts
```

Run output + the content-addressed resume cache land under `.eval-runs/` (gitignored); re-runs resume
and only recompute cells whose prompt/scaffold/model/`configVersion` changed.

## Built / still to build (vs docs/45 phases)

- ✅ **MAST judge** ([mast/](mast/)) — tags each trace with the 14 modes → per-mode/per-category
  histogram (`aggregateMast` / `renderMastHistogram`). The LLM call is injected (testable). **Next:**
  wire a real LLM impl + validate against **MAST-Data** labels before trusting the histogram.
- ✅ **Local-CLI harness** ([harness/local.ts](harness/local.ts)) — `localSwarmHarness()` (bin-override,
  in-process) + `pack-local-harness.sh` for sandboxes.
- ✅ **E2B local-harness transport** — no publishing: swarmkit-eval's template builder gained a
  `copyFiles` option (E2B SDK `.copy()`); `HARNESS=local` stages the packed tarball into each template
  and `npm i -g`s it in-sandbox.
- ⏳ **Team/marble arms** — homogeneous vs heterogeneous roster via `execution: "marble"` (H1 Path B, H2).
- ⏳ **GAIA subset** via the HAL benchmark adapter (cross-domain breadth beyond coding).
