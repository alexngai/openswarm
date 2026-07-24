# 55 — Live-eval handoff: TE-25 constraint retention

> **✅ RAN 2026-07-22 on `azureoai/gpt-5.5`** (Azure OpenAI direct transport,
> best-of-3). Result: **baseline / section / verbatim all 100% overall + 100%
> non-security, 45/45 runs clean.** Baseline saturated → verbatim pinning stays
> gated off, no code change; section stays default-on as (unmeasured) defense.
> Full table + decision + saturation caveat live in
> [`55-cross-harness-cache-efficiency.md` → Live result](./55-cross-harness-cache-efficiency.md#live-result-2026-07-22-te-25-constraint-retention).
> This runbook is kept for **re-running on a weaker summarizer** (the real
> discriminating test, since gpt-5.5 saturated). Note: with Azure creds in
> `~/.zshrc`, set `OPENSWARM_EVAL_MODEL=azureoai/gpt-5.5` and export
> `AZURE_OPENAI_API_VERSION` (the transport reads that name; `.zshrc` sets
> `AZURE_API_VERSION`).

**Purpose.** Everything for the cross-harness cache-efficiency work (docs/55,
TE-19…TE-25b) is landed and tested on branch
`claude/deepseek-reasonix-token-efficiency-tnpi9s`, **except one measurement that
needs a real model** and could not run in the dev sandbox (no provider key). This
file is the self-contained runbook to finish it in a session that has model
access.

## TL;DR

Run this, read the table, act on the decision rule, record the result:

```bash
npm ci && npm run build
OPENAI_API_KEY=sk-...  OPENSWARM_EVAL_MODEL=gpt-5.5  OPENSWARM_EVAL_RUNS=3 \
  bun eval/experiments/constraint-retention.ts
```

Any native-transport model works (OpenAI `gpt-*`/`o*`, xAI `grok*`, Gemini
`gemini-*`, or a `litellm/…` gateway model with `LITELLM_API_KEY`). **Claude
models will NOT work** — they resolve to the SDK engine, which the runner can't
drive directly; the runner prints guidance and exits 0 if you try.

## What is being measured

When a session compacts, do durable user constraints survive the summary so the
resumed model still honors them? Three arms, selected purely by env flags the
real compaction path reads (so this measures shipped behavior, not a mock):

| Arm | Flags | What it tests |
|-----|-------|---------------|
| `baseline` | `STANDING_CONSTRAINTS=0`, `PIN_USER_TURNS=0` | Pre-TE-25 byte-exact Claude Code summary |
| `section` | `STANDING_CONSTRAINTS=1`, `PIN_USER_TURNS=0` | TE-25a: `Standing facts & constraints` summary section (**default on**) |
| `verbatim` | `STANDING_CONSTRAINTS=1`, `PIN_USER_TURNS=1` | TE-25b: section + small user turns pinned verbatim (**gated off**) |

(Env var full names: `OPENSWARM_COMPACT_STANDING_CONSTRAINTS`,
`OPENSWARM_COMPACT_PIN_USER_TURNS`.)

Fixtures (`eval/harness/constraint-retention.ts`): five seeded constraints —
never-touch path (`src/legacy/`), chosen table name (`audit_events`), version
pin (`18.2.0`), library choice (`zod`), and a **security control**
(`$DEPLOY_TOKEN`) the CC baseline already preserves. The security one is a
control: baseline should retain it, isolating TE-25's *non-security* gap. The
grader (`gradeConstraintRetention`) scores **verbatim identifier survival** — a
paraphrase that drops the exact path/name/version counts as a loss, because the
resumed model can't act on a vague memory.

## Expected shape of the result

The runner prints a markdown table:

```
| arm      | overall retention | non-security retention | retained/total |
| baseline | ...%              | ...%                   | n/5            |
| section  | ...%              | ...%                   | n/5            |
| verbatim | ...%              | ...%                   | n/5            |
```

Plus a per-arm list of which fixture/constraint was lost. **`non-security
retention` is the headline metric** — that's the gap TE-25 targets. The
hypothesis: baseline drops several non-security constraints, `section` recovers
most/all, `verbatim` recovers any the section still misses.

## Decision rule (then record it)

1. **`section` ≥ baseline by a clear margin (ideally ~100% non-security)** →
   the default-on section is sufficient. Leave `PIN_USER_TURNS` off. Mark TE-25b
   "available but not default" in docs/55.
2. **`section` still loses constraints that `verbatim` keeps** → promote verbatim
   pinning toward default: flip `pinUserTurnsEnabled` to default-on (keep the
   flag as an escape hatch) in `src/engine/compact-remote.ts`, and note the token
   cost — the pinned `<pinned-user-messages>` block is extra prefix every turn
   after compaction.
3. **No arm meaningfully beats baseline** → the summary already preserves these;
   record that and consider TE-25 closed as low-value (unlikely given the CC
   prompt's security-only scoping, but let the data decide).

After running: update the **TE-25a / TE-25b / TE-25-eval rows** and the **TE-25
open question** in [`55-cross-harness-cache-efficiency.md`](./55-cross-harness-cache-efficiency.md)
with the actual percentages and the decision taken.

## Knobs

| Env var | Default | Use |
|---------|---------|-----|
| `OPENSWARM_EVAL_MODEL` | `gpt-5.5` | Native model id |
| `OPENSWARM_EVAL_RUNS` | `2` | Runs/fixture/arm; use `3`–`5` to smooth model nondeterminism (best-of-N: a constraint counts as retained if it survives any run) |
| `OPENSWARM_EVAL_ARMS` | all | Subset, e.g. `baseline,section` to skip the verbatim arm |

## Deterministic pre-checks (no model — should already pass)

```bash
# grader + fixtures
npx vitest run -c eval/vitest.config.ts eval/harness/constraint-retention.test.ts
# flag → real compaction request wiring (section + pin blocks)
npx vitest run src/engine/compact-remote.test.ts
```

If these fail, fix the wiring before trusting a live run.

## Where things live

- Grader + fixtures + report: `eval/harness/constraint-retention.ts` (+ `.test.ts`)
- Runner: `eval/experiments/constraint-retention.ts`
- Section prompt (TE-25a): `src/engine/compact-prompts.ts`
  (`COMPACT_STANDING_CONSTRAINTS`, `standingConstraintsEnabled`)
- Verbatim pinning (TE-25b): `src/engine/compact-remote.ts`
  (`selectPinnedUserTurns`, `renderPinnedUserTurns`, `pinUserTurnsEnabled`)

## Optional follow-ups (not blocking)

- **TE-26** — per-tool snip geometry for microcompaction. Evaluate necessity
  first: how often does the agent re-read a cleared tool result to recover an
  error? If rarely, skip (the flat placeholder + `read_file` recovery is cheap).
- **TE-27** — CI cache-impact gate (a `scripts/check-cache-impact` + requiring
  the TE-23 guard test on cache-sensitive PRs). Low priority; the guard test in
  CI may be enough on its own.

## Also worth a live smoke while you have a key

`scripts/cache-ab.ts` (TE-22) measures real cache% / ctx-per-turn / $ across two
arms. A quick sanity run confirms the TE-23 byte-stability guard is doing its job
in practice (repeat-prefix run should report high cache%):

```bash
OPENAI_API_KEY=sk-... bun scripts/cache-ab.ts --runs 2 --model gpt-5.5 \
  -- "summarize src/engine/compactor.ts in two sentences"
```
