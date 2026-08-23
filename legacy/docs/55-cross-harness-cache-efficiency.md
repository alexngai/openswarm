# 55 — Cross-harness cache efficiency: lessons from DeepSeek-Reasonix

Status: **complete** (validated live 2026-07-24; TE-26 deferred as optional). Extends [53 (token-efficiency tracker)](./53-token-efficiency-plan.md) and [48 (compaction design)](./48-compaction-design.md). New tracker IDs continue the `TE-N` scheme from 53 (last landed: TE-18) — this doc opens **TE-19…TE-27** (a measurement/visibility track first, then improvements).

Owner: engine

## Status (2026-07-24)

All of TE-19…TE-27 landed on `claude/deepseek-reasonix-token-efficiency-tnpi9s`; the
efficiency and retention claims are validated on live native-provider sessions
(TE-24 estimator 0.7% error; multi-turn cache 63% mean/77% peak; TE-25 settled
across 4 model configs). Only TE-26 (optional) is deferred.

| ID | What | Status |
|----|------|--------|
| TE-19 | Real `/cost` pricing + `/status` cache%/ctx-turn + session efficiency footer | landed |
| TE-20 | Live cache indicator in the TUI footer | landed |
| TE-21 | Cache-miss attribution (per-component prefix hashes) | landed |
| TE-22 | Local A/B efficiency harness (`scripts/cache-ab.ts`) | landed |
| TE-23 | Native-path request-prefix byte-stability guard | landed |
| TE-24 | Self-calibrated tokens-per-char in the compaction estimator | landed |
| TE-25a | Standing-constraints summary section (default on) | landed |
| TE-25b | Verbatim user-turn pinning (gated off) | landed |
| TE-25-eval | Constraint-retention instrument (grader + fixtures + runner) | landed; **settled across 4 model configs — section justified default-on (recovered the one drop a weak model showed), verbatim gated off** — see [Live result](#live-result-2026-07-22-te-25-constraint-retention) |
| TE-26 | Per-tool snip geometry for microcompaction | **deferred (optional)** — the flat placeholder + `read_file` recovery is cheap; revisit only if re-read cost of cleared results shows up in practice |
| TE-27 | CI cache-impact gate | landed — `scripts/check-cache-impact.ts` + `cache-impact` CI job re-prove TE-23/TE-22 on cache-sensitive diffs |

**TE-25 live comparison — done (2026-07-22).** Ran the three arms on
`azureoai/gpt-5.5` (best-of-3): **all arms 100% non-security retention; baseline
already saturates**, so verbatim pinning stays gated off (no code change). Full
table, decision, and the saturation caveat in [Live result](#live-result-2026-07-22-te-25-constraint-retention).
Runbook: [`65-live-eval-handoff.md`](./65-live-eval-handoff.md).

**Efficiency validated live (2026-07-24).** Beyond the retention work (a quality
guardrail), the two core *token-efficiency* claims are now confirmed on real
native-provider sessions rather than unit tests alone: **TE-24**'s calibrated
estimator predicts real `prompt_tokens` at **0.7% mean error** (vs. 2.1% for the
fixed char/4; target <10%), and a **multi-turn agent session sustains 63%
mean cache-read (77% peak)** — the byte-stable native prefix (**TE-23**) is
cache-eligible across many real turns, not just a 2-turn smoke. Details in
[Eval / measurement hooks](#eval--measurement-hooks).

### New runtime flags (this work)

| Env var | Default | Effect |
|---------|---------|--------|
| `OPENSWARM_COMPACT_STANDING_CONSTRAINTS` | on | Emit the `Standing facts & constraints` summary section (TE-25a). Set `0`/`false`/`off`/`no` for the eval baseline arm |
| `OPENSWARM_COMPACT_PIN_USER_TURNS` | off | Pin small user turns verbatim through compaction (TE-25b). Set `1`/`true`/`on`/`yes` for the eval verbatim arm |
| `OPENSWARM_EVAL_MODEL` | `gpt-5.5` | Native-transport model the constraint-retention runner uses |
| `OPENSWARM_EVAL_RUNS` | `2` | Runs per fixture per arm (best-of-N over model nondeterminism) |
| `OPENSWARM_EVAL_ARMS` | all | Comma-separated arm subset, e.g. `baseline,section` |
| `OPENSWARM_EVAL_FIXTURES` | `default` | Fixture set: `default` (prominent first-turn constraints), `hard` (in-passing/multiple/paraphrasable — the discriminating set), or `all` |
| `OPENSWARM_REASONING_EFFORT` | unset | **Azure transport** (native reasoning models): pins `reasoning_effort` (`none`/`low`/`medium`/`high`/`xhigh`; `none` = reasoning off — the lowest gpt-5.5 accepts). Unset → not sent, request byte-identical to before (TE-23 guard intact). Added for the TE-25 weak-summarizer run; the OpenAI transport is a trivial mirror if ever needed |

## Live result (2026-07-22): TE-25 constraint retention

Run on **`azureoai/gpt-5.5`** (Azure OpenAI direct transport, api-version
`2025-04-01-preview`), **3 runs/fixture/arm, best-of-N**, driving REAL compaction
over all five seeded-constraint fixtures. Deterministic pre-checks green first
(grader 8/8, flag-wiring 40/40).

| arm | overall retention | non-security retention | retained/total | per-run losses |
|-----|-------------------|------------------------|----------------|----------------|
| baseline | 100% | 100% | 5/5 | none (15/15 runs 100%) |
| section  | 100% | 100% | 5/5 | none (15/15 runs 100%) |
| verbatim | 100% | 100% | 5/5 | none (15/15 runs 100%) |

Every one of the **45 runs retained every constraint verbatim** — including the
four non-security identifiers (`src/legacy/`, `audit_events`, `18.2.0`, `zod`)
the section/verbatim arms exist to protect. No arm ever dropped a constraint on
any single run, so best-of-N vs. single-run makes no difference here.

**Decision — rule 3 ("no arm meaningfully beats baseline"):** on gpt-5.5 the
byte-exact CC baseline summary *already* preserves all five constraints, so
TE-25a (section) and TE-25b (verbatim pinning) add **no measurable retention** on
this model/fixture set. Actions taken:

- **No code change.** `OPENSWARM_COMPACT_PIN_USER_TURNS` stays **off** — decision
  rule 2 (promote verbatim) was *not* triggered: the section arm lost nothing for
  verbatim to recover. TE-25b remains an escape-hatch flag, not a default; its
  per-turn `<pinned-user-messages>` prefix cost is unjustified by the data.
- **TE-25a section stays default-on.** It's additive and *one-shot in the L3
  summary prompt* (not the per-turn request prefix), so it carries no cache/TE-23
  exposure — cheap defense-in-depth for the cases this run can't stress.

**Caveat — the instrument saturated.** Baseline hitting 100% means the eval
cannot *discriminate* the arms on this model/fixture set; it shows the additions
aren't *needed* for gpt-5.5, not that they're worthless. Each fixture states its
constraint prominently in the very first user turn around a single distinctive
identifier — exactly what a strong summarizer keeps unprompted. The discriminating
test TE-25a/b were built for (a weaker/smaller summarizer, or many/subtler
constraints stated in passing) is the real follow-up if we want data justifying
the section's existence; noted in [Open questions](#open-questions). Raw run:
`bun eval/experiments/constraint-retention.ts` with the arms/knobs above.

### Follow-up — weak-summarizer run (`reasoning_effort=none`)

To reach the discriminating case the default run couldn't, we re-ran all three
arms with gpt-5.5's **reasoning disabled** — `OPENSWARM_REASONING_EFFORT=none`,
the lowest effort gpt-5.5 accepts (`minimal` is rejected; supported: `none`,
`low`, `medium`, `high`, `xhigh`). This needed a new **env-gated passthrough** in
the Azure transport (`providerOptions.openai.reasoningEffort`), verified on the
wire (request body carries `reasoning_effort:"none"`; unset → not sent, so the
default path stays byte-identical and the TE-23 guard is unaffected — regression
tests 44/44 green).

| arm (effort=none) | overall retention | non-security retention | retained/total | per-run losses |
|-----|-------------------|------------------------|----------------|----------------|
| baseline | 100% | 100% | 5/5 | none (15/15 runs 100%) |
| section  | 100% | 100% | 5/5 | none (15/15 runs 100%) |
| verbatim | 100% | 100% | 5/5 | none (15/15 runs 100%) |

**Still a clean 45/45 sweep.** Even a non-reasoning gpt-5.5 keeps every
constraint under the baseline prompt — so **reasoning budget is not the lever;
the fixtures are.** Each states its rule prominently in the very first user turn
around a single distinctive identifier, a shape any competent summarizer
preserves with or without reasoning. The definitive discriminating test is
therefore *harder fixtures* (constraints stated in passing mid-session, multiple
per fixture, less-distinctive or paraphrasable identifiers) — **not** a weaker
model or lower effort, both of which we've now shown don't move the needle. The
new `OPENSWARM_REASONING_EFFORT` knob is a useful capability regardless (native
reasoning-effort control the transports previously lacked).

### Follow-up — hard fixtures (in-passing / multiple / paraphrasable)

The runs above weakened the *model*; this one hardens the *fixtures* — the lever
the effort=none result pointed at. Added `HARD_CONSTRAINT_FIXTURES` (select with
`OPENSWARM_EVAL_FIXTURES=hard`): five fixtures whose constraints are stated **in
passing mid-session** (not a prominent first-turn "Hard requirement:"), one
packing **three constraints** into a single aside, and several with
**paraphrasable identifiers** (`snake_case`, `enable_new_checkout`) a summary
could reword away. Run at both default effort and `reasoning_effort=none`:

| arm (hard fixtures) | default effort | effort=none |
|-----|----|----|
| baseline | 100% (7/7) | 100% (7/7) |
| section  | 100% (7/7) | 100% (7/7) |
| verbatim | 100% (7/7) | 100% (7/7) |

**Still 100% everywhere — 90/90 runs clean.** Even a non-reasoning gpt-5.5 keeps
in-passing, paraphrasable identifiers **verbatim** under the byte-exact baseline
prompt — it doesn't reword `snake_case` to "snake case" or drop the third
constraint in a three-part aside. Across the **full matrix now tested** —
{default, hard} fixtures × {default, none} effort, **180 runs — the instrument
never once discriminated the arms** on gpt-5.5.

**Conclusion.** Neither weakening the model (effort=none) nor hardening the
fixtures moves baseline off 100% on gpt-5.5, so TE-25a/b carry **no measurable
benefit on this model**. They stay as cheap insurance — section default-on (one-
shot, no cache exposure), verbatim gated off — whose value would only surface on
a genuinely weaker/smaller summarizer. That single remaining lever — a small
model (`gpt-4.1`, or an open model via `litellm/…`) — is the only untested
discriminator left; **fixture difficulty and reasoning effort are now ruled out.**

### Follow-up — weak model (Bedrock `gpt-oss-20b`): the first signal

The gpt-5.5 runs ruled out reasoning effort and fixture difficulty; the last
lever was a genuinely weaker summarizer. Bedrock hosts one reachable via its
**OpenAI-compatible endpoint** — `openai.gpt-oss-20b-1:0` (a 20B open model),
driven through the existing `litellm/` transport pointed **straight at Bedrock
(no gateway, no code change)**:

```bash
LITELLM_BASE_URL=https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1 \
LITELLM_API_KEY=$AWS_BEARER_TOKEN_BEDROCK \
OPENSWARM_EVAL_MODEL=litellm/openai.gpt-oss-20b-1:0 \
OPENSWARM_EVAL_RUNS=3 OPENSWARM_EVAL_FIXTURES=all \
  bun eval/experiments/constraint-retention.ts
```

(Bedrock's OpenAI endpoint serves the `openai.gpt-oss-*` models; current Claude
4.x and Nova/Llama are **not** on it — testing the actual Claude summarizer still
needs the gateway or an SDK-path runner. See below.) All fixtures, best-of-3, 90 runs:

| arm (gpt-oss-20b) | best-of-3 non-security | hard-fixture **per-run** retention |
|-----|----|----|
| baseline | 100% (12/12) | **14/15** |
| section  | 100% (12/12) | **15/15** |
| verbatim | 100% (12/12) | **15/15** |

**The first drop in ~360 runs.** On this weak model, baseline folded away an
in-passing constraint (`legacyTimeoutMs`/`15000`, stated mid-message inside a list
of other tasks) on **1 of 3 runs** — and both the standing-constraints **section
(TE-25a) and verbatim pinning (TE-25b) held it on all 3.** best-of-3 masks it
(baseline keeps it in the other two runs, so the headline table is all-100%), but
the per-run reliability gap is real and is exactly TE-25's predicted mechanism: a
weak summarizer, under a constraint stated in passing, occasionally drops it, and
the addendum recovers it.

**This resolves the TE-25 decision with data:**
- **TE-25a section stays default-on — now with evidence.** It closed the one gap a
  weak model showed (baseline 14/15 → section 15/15) at negligible cost.
- **TE-25b verbatim stays gated off.** It *matched* the section (15/15) but never
  *beat* it, so it earns nothing over the section to justify its per-turn
  `<pinned-user-messages>` prefix cost — **decision rule 1 ("section sufficient")**.

**Caveat:** one dropped run out of 15 baseline hard-fixture runs is a *weak*
signal — directionally right, not statistically strong. Firming it up (more runs,
more fragile fixtures, or an even smaller model) would sharpen the effect size,
but the mechanism is now **demonstrated rather than hypothesized.** The most
on-target future run is the real **Claude** summarizer (the CC prompt is Claude's
own) via Bedrock — which needs the LiteLLM *gateway* (`litellm/claude-haiku`,
requires the gateway's own key) or extending the runner to drive the SDK path.

### Follow-up — on-target Claude summarizer (Bedrock Claude Haiku 4.5 via gateway)

gpt-oss-20b was a *proxy* weak model; the most relevant summarizer is Claude (the
CC compaction prompt is Claude's own). Reached the real thing through the swarmkit
LiteLLM **gateway** — `litellm/claude-haiku` →
`bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0` (LiteLLM's native Bedrock
provider, signed from `AWS_BEARER_TOKEN_BEDROCK`). The gateway's earlier
all-500s were a **red herring**: `litellm[proxy]` was installed without `prisma`,
so its auth-error handler crashes on `import prisma` and mangles every
*auth-failure* into a 500 — a correctly-keyed request never hits that path and
routes fine. All fixtures, best-of-3, 90 runs:

| arm (Claude Haiku 4.5) | best-of-3 non-security | hard-fixture **per-run** |
|-----|----|----|
| baseline | 100% (12/12) | 15/15 |
| section  | 100% (12/12) | 15/15 |
| verbatim | 100% (12/12) | 15/15 |

**Zero drops — Claude Haiku saturates like gpt-5.5.** The smallest current Claude
holds every constraint at baseline, *including* `aside-config-field` (the
in-passing `legacyTimeoutMs`/`15000` rule) that gpt-oss-20b folded 1/3 times. So
across every model tested, the **only** measured drop was on the weak *non-Claude*
gpt-oss-20b.

**Final TE-25 picture (~450 constraint-runs across 4 model configs):**
- On the **native path with a weak/non-Claude summarizer** (gpt-oss-20b), the
  **section (TE-25a) demonstrably helps** — it recovered the one in-passing
  constraint baseline dropped. That is exactly the exposure docs/55 targets (the
  native path we own), so the default-on section is **justified insurance**.
- On **Claude itself** (Haiku → gpt-5.5), baseline already saturates, so the
  section is invisible-but-harmless — the CC byte-exact prompt does its job for the
  family it was written for.
- **Verbatim pinning (TE-25b) never beat the section on any model** → stays gated
  off; its per-turn `<pinned-user-messages>` prefix cost buys nothing over the
  cheaper section.

Models exercised: gpt-5.5 (Azure), gpt-5.5 `effort=none`, gpt-oss-20b (Bedrock),
Claude Haiku 4.5 (Bedrock direct via gateway). **TE-25 is settled.**

## Motivation

We studied [`esengine/DeepSeek-Reasonix`](https://github.com/esengine/DeepSeek-Reasonix) (a Go coding agent purpose-built around DeepSeek's automatic prefix cache) as an external reference for harness-level token efficiency, the same way 53 studied pi / Codex / Claude Code. Reasonix is unusually disciplined about prompt-cache stability — it treats the cacheable prefix as a hard, tested, CI-enforced invariant rather than a best-effort property.

The audit's headline finding is reassuring: **OpenSwarm already implements Reasonix's single biggest idea.** TE-2 moved the memory block to the user turn so the system prompt is a byte-stable cacheable prefix, and TE-16/17/18 fixed cache routing and accounting end-to-end. `default-system-prompt.ts` has no time/random/env/cwd nondeterminism. So the "mid-session mutation craters the cache" class is largely closed on the paths we've measured.

What Reasonix has that we don't is **defense-in-depth around that invariant** — the guards, attributions, and compaction-fidelity choices that keep the prefix stable as the code evolves and that make a cache miss *explainable*. This doc scopes that remaining delta.

## The fundamental architecture difference (context, not a gap)

| | DeepSeek-Reasonix | OpenSwarm |
|---|---|---|
| Cache ownership | Owns the whole request; byte-stable prefix is a tested invariant | Anthropic path: delegated to Claude Agent SDK. Native path (AI-SDK transports): our own assembly, provider auto-cache |
| Consequence | Full control, full responsibility | SDK does the right thing for Claude; **native/DeepSeek/OpenAI/xAI/Google paths depend on our assembly staying byte-stable — and nothing tests that** |

This is the load-bearing observation. Our cache exposure is concentrated on the **native path**, because that is the code we own and the code with no guard. Every TE below is scoped to that path unless noted.

## What OpenSwarm already has (do not re-litigate)

Mapping Reasonix's playbook to landed OpenSwarm work, so this plan doesn't duplicate it:

| Reasonix technique | OpenSwarm equivalent | Status |
|---|---|---|
| Byte-stable system prefix | Static `default-system-prompt.ts`; no per-turn mutation | landed |
| Dynamic state rides the turn tail (`Compose`) | TE-2: memory block moved to user turn, `<memory-context>` markers, change-dedup | landed |
| Cheap tool-result clearing before paid summary | `microcompact.ts` (L2), protect 5 recent + last 2 turns, 20k gate | landed (48) |
| Archive/persist cleared output with a pointer | Microcompact disk-persist + `read_file` pointer | landed (48) |
| Prefix+tools fingerprint, tools sorted, schema excluded | `prompt-cache.ts` FNV-1a fingerprint | landed (analytics-only) |
| Cache read/write token accounting | TE-14/16/17/18 | landed |
| Graduated compaction thresholds | L1 ok→warn→microcompact→compact→blocked | landed (48) |
| Per-arm cache% / ctx-per-call comparison | `eval/analysis/cost-frontier.ts` (`cacheReadFraction`, `contextTokensPerCall`) | landed (53) |
| Session cost/usage command | `/cost`, `/status` slash commands | landed (partial — see gaps) |

## Current visibility surfaces & their gaps

Before adding *improvements*, we need to be able to *see and compare* the effect. The measurement primitives from 53 (TE-14) exist, but the comparison surfaces have concrete gaps:

| Surface | State today | Gap for comparison |
|---|---|---|
| `SwarmUsageAggregator` | Records `cacheReadInputTokens`, `cacheWriteInputTokens`, `calls`, `contextTokensPerCall`, `cacheReadFraction` per member/team (TE-14) | Data exists but has no session-end report or per-turn timeline surface |
| `cache_hit` / `cache_miss` lane events | Emitted by `event-translator.ts` on every turn's usage | **Dropped in the TUI** (`app.tsx` → `return []`) — no live cache signal to a user |
| `/cost` command | Cumulative tokens + cache-hit ratio + estimated $ | Uses **hardcoded opus/sonnet/haiku placeholder pricing**; wrong $ for native providers (DeepSeek/OpenAI/xAI/Google) — exactly where cache exposure is highest. A real `ApiCostModel`/`ModelPricing` already exists in `cost-model.ts`, unwired to the command |
| `/status` command | Model, permission, total tokens | No cache%, no context-per-turn |
| `cost-frontier` eval | Cross-arm `cache%` + `ctx/call` columns | Full eval only — no lightweight local before/after loop for iterating a single change |
| Cache-miss cause | — | No attribution anywhere: a cache% drop is unexplained (Reasonix's `PrefixShape` names the culprit) |

## Tracker (TE-19…TE-27)

Status legend (per 53): `todo` / `in-progress` / `landed` / `evaluated` / `rejected`.

### Track A — Measurement & visibility (prerequisite; no behavior change)

Land this first, exactly as 53 landed TE-14/15 before any efficiency change. You cannot compare what you cannot see, and three of these gaps (dropped cache events, fake pricing, no attribution) mean today's live surfaces actively *mislead* on the native path.

| ID | Improvement | Where | Expected effect | Risk | Status |
|----|-------------|-------|-----------------|------|--------|
| TE-19 | **Accurate live cost + session efficiency summary.** Replace `/cost`'s hardcoded opus/sonnet/haiku placeholder pricing with the real `ApiCostModel`/`ModelPricing` from `cost-model.ts` (already prices cache read/write, per TE-17) so live $ is correct for native providers. Add `cache%` + `ctx/turn` to `/status`, and emit a one-line end-of-session efficiency summary (total in/out, cache-read fraction, ctx/turn, $) from the aggregator. | `src/cli/slash/commands/cost.ts`, `status.ts`, `src/cli/main.ts` (`printSessionEfficiency`) | The live $ and cache numbers stop lying on DeepSeek/OpenAI/xAI/Google; a session ends with a comparable one-line efficiency footer | Low | landed — `/cost` + footer price via `ApiCostModel` with honest `n/a` for unpriced models; `/cost` + `/status` show cache% and ctx/turn (turn count from the store's `usage-update` counter); session-end footer prints totals + cache% + $ (ctx/turn omitted there — turn count lives in the UI store, not the engine) |
| TE-20 | **Surface cache_hit/cache_miss live.** The events are already emitted by `event-translator.ts` but the TUI drops them (`app.tsx` → `return []`). Render a compact status-line cache indicator (running cache% + this-turn hit/miss) so cache behavior is visible during a session, not just in post-hoc eval. | `src/ui/repl-solid/app.tsx`, `footer.tsx`, `src/ui/repl/state.ts` (`UsageStats`, `usage-update`/`cache-signal` events) | Cache regressions become visible the moment they happen instead of surfacing only in a later eval run | Low | landed — `message_stop.usage` now feeds the store on every turn (works on both engine paths; the lane events only exist on the SDK path), footer line 2 shows running cache% with a per-turn `(hit)`/`(miss)` marker where lane events flow; marker resets on submit so it can't go stale |
| TE-21 | **Cache-miss attribution.** Extend the `prompt-cache.ts` fingerprint from one opaque hash to per-component hashes (system / tools / message-prefix), and on a cache-miss turn record which component changed. Reasonix's `PrefixShape`+`CompareShape` name the culprit (`["system","tools",…]`). Surfaced through TE-20 (live) and TE-19 (session summary). | `src/engine/prompt-cache.ts` (`capturePrefixShape`/`comparePrefixShapes`), `src/engine/event-translator.ts`, `src/engine/claude-agent-sdk.ts` | Turns "cache% dropped" into "cache% dropped *because tools changed on turn N*" — the diagnostic that makes TE-23 failures and future regressions legible | Low | landed — SDK engine compares shapes across runs (instance lives for the session) and attributed misses ride `cache_miss.payload.changedComponents`; footer shows `(miss: system+tools)`; combined hash stays byte-compatible with the old fingerprint. Native engines emit no lane events yet — attribution there rides TE-23's serialization work |
| TE-22 | **Local A/B efficiency harness.** A script that runs a fixed scripted task twice — baseline vs. HEAD, or a flag on/off — and diffs `cache%`, `ctx/turn`, `totalTokens`, and `$` in a small table, reusing the aggregator + `cost-frontier` column math. The fast inner loop for iterating TE-23…TE-25 without a full swarmkit-eval run. | `scripts/cache-ab.ts` (CLI wrapper), `src/core/efficiency-report.ts` (unit-tested column math) | A <2-minute local before/after signal for every efficiency change; makes "did this help?" answerable without booking eval time | Low | landed — arms via `--a/--b KEY=VAL` env, N runs per arm, per-run rows + means + delta line; parses the headless JSONL stream (last `message_stop` usage, TE-21 miss reasons); offline self-check via `OPENSWARM_TEST_SCRIPT` scripted engine confirmed delta ≈ 0 on identical arms |

### Track B — Efficiency improvements (each measurable via Track A)

| ID | Improvement | Where | Expected effect | Risk | Status |
|----|-------------|-------|-----------------|------|--------|
| TE-23 | **Native-path request-prefix byte-stability guard.** Assert the *actually serialized* request prefix (system + tool defs + leading messages) is byte-identical across two consecutive turns with unchanged inputs, for the AI-SDK transports. Today `prompt-cache.test.ts` only checks the analytics *fingerprint* is deterministic — it does not exercise the real assembled request. Reasonix's boot-level `TestBuildComposesByteStableSystemPrompt` is the model. | `src/providers/prefix-stability.test.ts` (new) | Catches the "silent cold-start on every non-Anthropic provider" class before it ships; converts an untested property into a regression-guarded one | Low (test-only) | landed — guards at the streamText() boundary (the full output of the assembly code we own: system join, message replay, tool translation, provider options) with real tier-0 tool specs; four properties: non-vacuous schema bytes, identical-request determinism (with a >1ms gap so ms-granularity timestamps can't slip through), append-only prefix across turns, and tool_result round-trip stability. Sensitivity verified by fault injection: an injected `Math.random()`/delayed `Date.now()` in the transport fails the guard; clean code passes. The AI SDK's own HTTP-body construction from identical args is the SDK's contract (out of scope); tool schemas convert from Zod once at module load |
| TE-24 | **Self-calibrated tokens-per-char.** Derive the chars/token ratio from the previous turn's real `prompt_tokens` instead of the fixed char/4 (compactor) and char/2.5 (preflight) constants. Reasonix's `tokPerChar()` tracks the provider tokenizer without shipping one, adapting to CJK/code density. Falls back to the current constant before any usage is seen. | `src/engine/compactor.ts` (`calibrateTokensPerChar`, `messageChars`, `estimateTokens` ratio param), `src/engine/compaction-runner.ts` (`effectiveContextTokens`) | More accurate trigger sizing on non-Anthropic providers where server `count_tokens` is unavailable (Claude Max/OAuth users always hit the estimate path today) | Low — bound the ratio to a sane range, keep the constant fallback | landed — `effectiveContextTokens` (the live trigger hot path) now sizes the appended tail with a ratio calibrated from the last real usage over the covered message chars, bounded to [0.05, 2] with char/4 fallback; `estimateTokens` gained an optional ratio param whose default (0.25) is byte-for-byte the prior char/4. **Scope note:** `token-preflight.localEstimate` (char/2.5) was left as-is — it's the SDK's pre-call fallback with no per-session usage in scope (the accurate path there is the server `count_tokens` call), so calibrating it from an unrelated turn adds risk for no gain |
| TE-25a | **Standing-constraints summary section (section-only).** Our L4 rebuild (48) keeps *zero* messages verbatim and reconstructs working state from disk (recent files + todos) — excellent for code state, but a durable user rule stated only in conversation ("never touch X", a chosen key, a naming decision) can be lost if the summary drops it. The byte-exact CC prompt preserves only *security-relevant* constraints. Add a `Standing facts & constraints` addendum to the L3 summary prompt (composed like the guard/self-exclusion, not a reword) instructing a top-of-summary verbatim section for ALL durable constraints. | `src/engine/compact-prompts.ts` (`COMPACT_STANDING_CONSTRAINTS`, builder opt, `standingConstraintsEnabled`), `src/engine/compact-remote.ts` | Fewer post-compaction regressions where the agent violates an earlier user constraint; directly targets handoff-fidelity (52) failure modes | Low — additive addendum, CC core untouched | landed — default on; env-gated (`OPENSWARM_COMPACT_STANDING_CONSTRAINTS=0` for the eval baseline arm); end-to-end wiring proven by a capturing-provider test (section present with flag on, absent + CC core intact with flag off). **Measured (2026-07-22/23): saturates on gpt-5.5 (no lift, baseline already 100%), but on a weak model (Bedrock gpt-oss-20b) baseline dropped an in-passing constraint 1/3 runs while section held 3/3 (hard-fixture per-run 14/15 → 15/15) — first evidence the section earns its default-on. See [weak-model follow-up](#follow-up--weak-model-bedrock-gpt-oss-20b-the-first-signal)** |
| TE-25-eval | **Constraint-retention measurement instrument.** A pure grader + fixtures (five constraint classes: never-touch path, chosen name, version pin, library choice, and a security control the CC baseline already covers) that scores whether a produced summary preserves a constraint's load-bearing identifiers verbatim; plus a runner that drives REAL compaction per arm (baseline/section/verbatim via env flags) and prints a retention comparison table. | `eval/harness/constraint-retention.ts` (+ `.test.ts`), `eval/experiments/constraint-retention.ts` | Turns "does TE-25 help?" into a number; reusable to compare section-only vs verbatim | Low | landed — grader deterministic + unit-tested (14, incl. hard-fixture well-formedness + selector); `default` and `hard` fixture sets (`OPENSWARM_EVAL_FIXTURES`); runner drives native-transport models, best-of-N. **Live matrix done (2026-07-22/23, azureoai/gpt-5.5, 3 runs/arm): {default, hard} fixtures × {default, effort=none} — all arms 100%, 180/180 runs clean; baseline saturates on every config — [Live result](#live-result-2026-07-22-te-25-constraint-retention)** |
| TE-25b | **Verbatim user-turn pinning through compaction.** Pin small user turns verbatim through full compaction so the user's exact words survive regardless of summary quality (stronger than TE-25a; changes doc 48's zero-verbatim L4 contract). Compared against section-only via the TE-25 eval. | `src/engine/compact-remote.ts` (`selectPinnedUserTurns`, `renderPinnedUserTurns`, `pinUserTurnsEnabled`) | Strongest constraint retention; the durable contract is never at the mercy of the summarizer | Medium — changes the L4 rebuild contract; gated + eval-compared against section-only | landed — gated OFF by default (`OPENSWARM_COMPACT_PIN_USER_TURNS=1`); selects small text-only user turns (≤6k chars/turn, ≤20k total so it can't starve the window), skips assistant/tool/continuation/pasted turns, re-injects them verbatim in a `<pinned-user-messages>` block right after the summary; eval "verbatim" arm wired. **Measured (2026-07-22/23): saturates on gpt-5.5; on the weak model (gpt-oss-20b) verbatim held the fragile constraint 3/3 — but so did the section, so verbatim MATCHED, never BEAT, the section → stays gated OFF (decision rule 1); its per-turn `<pinned-user-messages>` prefix cost buys nothing over the cheaper section. Revisit only if a run shows a gap the section misses but verbatim keeps — see [weak-model follow-up](#follow-up--weak-model-bedrock-gpt-oss-20b-the-first-signal)** |
| TE-26 | **Per-tool snip geometry for microcompaction.** Microcompact currently replaces cleared results with a flat placeholder / disk pointer (max savings, zero inline signal). Reasonix keeps a tuned head/tail inline (read-only tools: long head; side-effecting: both ends, to preserve a trailing build error), via a per-tool `SnipHint`. Optional middle-ground: keep a short head/tail for side-effecting tools so a cleared bash failure still shows its error without a re-read. | `src/engine/microcompact.ts`, tool specs | Fewer paid re-reads to recover an error that was one line of a cleared result | Low–Medium — deviates from CC byte-exact placeholder (parity call, cf. TE-6 precedent) | todo (evaluate necessity) |
| TE-27 | **CI cache-impact gate (process).** Reasonix fails any PR touching cache-sensitive paths unless the body carries `Cache-impact:` / `Cache-guard:` lines, plus a byte-stability guard test in CI. Adopt a lightweight version: a `scripts/check-cache-impact` that flags PRs touching `src/engine/{prompt-cache,default-system-prompt,microcompact,compact*}`, `src/providers/*-transport`, or `src/tools/**` specs, and require TE-23's guard test to run on those PRs. | `scripts/`, `.github/workflows/` | Keeps the TE-23 invariant from silently rotting as the prompt/tool surface evolves | Low — process overhead; scope the path list tightly to avoid noise | landed — dropped the PR-body ritual (open question resolved: guard-test-in-CI is enough). `scripts/check-cache-impact.ts` classifies the diff (transports, `compact*`/`microcompact`/`default-system-prompt`/`prompt-cache`, tool specs) and, only when a cache-sensitive path changed, re-runs the TE-23 byte-stability guard + TE-22 cache-math tests as an attributed gate; a dedicated `cache-impact` CI job wires it on every PR. Pure classifier unit-tested (`test/cache-impact.test.ts`); fail-path verified by fault injection |

## Phasing

Ordered by payoff-to-risk, dependency-aware. Track A is Phase 0 — nothing in Track B can be *evaluated* without it.

**Phase 0 — Measurement & visibility (TE-19…TE-22).** Pure telemetry/UI, no model behavior change. TE-19 + TE-20 are the cheapest and fix actively-misleading surfaces (fake pricing, dropped events) — land them first. TE-21 (attribution) plugs into both. TE-22 (A/B harness) is the tool every later phase uses to prove its delta. No eval arm needed for the track itself.

**Phase 1 — Guard the invariant (TE-23).** The highest-leverage improvement: converts our biggest untested property into a regression-guarded one. Test-only, no behavior change. Verify with the TE-22 harness that a repeat-prefix run reports high `cache%`.

**Phase 2 — Estimator accuracy (TE-24).** Self-contained, low-risk, improves trigger timing on native providers. Verify against a session with known real usage; re-check compaction-trigger timing doesn't regress.

**Phase 3 — Compaction fidelity (TE-25).** The one with a real quality question, so it gets a dedicated eval arm per 53's methodology (Group-D-style): baseline vs. constraints-pinned, on tasks with early user constraints. Accept only if quality improves or holds AND token cost stays within noise.

**Phase 4 — Optional (TE-26, TE-27).** Evaluate whether TE-26 pays for itself (may not, given the re-read path is cheap); land TE-27 only after TE-23 exists to enforce.

## Eval / measurement hooks

Reuse the swarmkit-eval cost-frontier harness (51), the TE-14 telemetry, and the new TE-22 local harness:

- **Track A (TE-19…22):** unit tests for the pricing/attribution math; manual smoke that `/cost`, `/status`, and the live indicator show correct numbers on a native-provider session; TE-22 self-checks by diffing two identical runs (delta ≈ 0).
- **TE-23:** unit/integration test is the deliverable; additionally assert via TE-22 that `cacheReadFraction` stays ≥ baseline on a repeat-prefix run (the regression signal if the guard ever silently fails). **Live smoke (2026-07-22, `scripts/cache-ab.ts`, azureoai/gpt-5.5): a multi-turn run reported 71% cache-read (43.5k cached tokens) — the assembled append-only prefix is byte-stable and cache-eligible in practice.** (The second cache-ab run showed 0% because each run is a fresh session with its own `promptCacheKey`; Azure's keyed routing doesn't reuse a prior process's cache — a session-isolation artifact, not a guard failure. Intra-session multi-turn is the repeat-prefix signal here.) **Multi-turn agent session (2026-07-24, 4 sequential file reads, ~5 turns): 63% mean cache-read, 77% peak — the prefix sustains high cache% across many real turns, not just two. The 49% low run is Azure replica-routing variance (a cold replica starts at 0%), so cache% is provider-routing-dependent, not a guaranteed floor — but the byte-stable prefix is consistently cache-eligible.**
- **TE-24:** offline — compare estimated vs. real `prompt_tokens` across a recorded session; target < 10% mean error vs. the fixed-constant baseline. **Validated live (2026-07-24, azureoai/gpt-5.5, 8-turn code-heavy session): the shipped `effectiveContextTokens` (calibrated) tracked real `prompt_tokens` at 0.7% mean abs error vs. 2.1% for the fixed char/4 — beats the constant AND well under the 10% target. Per-turn error never exceeded 1.8%.**
- **TE-25:** the constraint-retention instrument (`eval/harness/constraint-retention.ts` + runner) is the dedicated arm — seeds an early user constraint, forces compaction, grades verbatim identifier survival. Metric = non-security retention rate per arm (baseline vs section vs verbatim). Grader is deterministic + unit-tested. **Live rates (2026-07-22, azureoai/gpt-5.5, best-of-3): baseline = section = verbatim = 100% non-security.** Baseline saturated, so the accept/escalate gate never fired — section stays default-on as (unmeasured) defense-in-depth, verbatim stays gated off. A discriminating re-run (weaker summarizer / subtler constraints) is the follow-up to actually exercise the gate.

## Handoff: running the live constraint-retention eval

**RESOLVED 2026-07-22** — ran on `azureoai/gpt-5.5` (best-of-3): all arms 100%
non-security retention, baseline saturates, verbatim stays gated off (no code
change). See [Live result](#live-result-2026-07-22-te-25-constraint-retention).
The runbook below is retained for re-running on a different (ideally weaker)
model. Standalone runbook: [`65-live-eval-handoff.md`](./65-live-eval-handoff.md).

```bash
# 1. fresh clone of the branch, then:
npm ci && npm run build

# 2. run the three arms (needs OPENAI_API_KEY or another native-transport key)
OPENAI_API_KEY=sk-...  OPENSWARM_EVAL_MODEL=gpt-5.5  OPENSWARM_EVAL_RUNS=3 \
  bun eval/experiments/constraint-retention.ts
```

The runner prints a markdown table of **non-security retention** per arm
(`baseline` / `section` / `verbatim`) plus a per-fixture loss list.

**Decision rule** (feeds the TE-25 tracker rows):
- If `section` non-security retention is materially above `baseline` (target: ≥
  baseline + a clear margin, ideally ~100%) → the default-on section is
  sufficient; leave `OPENSWARM_COMPACT_PIN_USER_TURNS` off.
- If `section` still drops constraints that `verbatim` keeps → promote verbatim
  pinning toward default (flip the default, keep the flag as an escape hatch),
  and note the token cost verbatim adds (the pinned block is extra prefix).
- Record the numbers back into this doc's TE-25 rows and the open question below.

Deterministic pre-checks (no model, already green in CI):
`npx vitest run -c eval/vitest.config.ts eval/harness/constraint-retention.test.ts`
(grader) and `npx vitest run src/engine/compact-remote.test.ts` (flag wiring).

## Open questions

- ~~**TE-19 pricing source of truth**~~ — RESOLVED: `MODEL_PRICING` (via `ApiCostModel`) is canonical; `/cost`, the footer, the session-end summary, and the eval all consume it. Follow-up data chore: the table's coverage is thin (3 Anthropic + 3 OpenAI + 1 Bedrock entry) — extend it as native providers are actually used; until then those models honestly report `n/a`.
- ~~**TE-20 surface**~~ — RESOLVED: persistent footer % (line 2), annotated with a per-turn `(hit)`/`(miss)` marker when the SDK-path lane events flow; the marker resets on each submit.
- ~~**TE-22 fixture**~~ — RESOLVED: both. The scripted engine (`OPENSWARM_TEST_SCRIPT` + a JSON fixture) gives a deterministic, zero-spend self-check of the harness plumbing; real cache behavior is measured by pointing the same harness at a live short task (`--model` + provider auth).
- ~~**TE-23 scope**~~ — RESOLVED: one transport smoke (openai) that exercises the shared assembly modules (`message-replay.ts`, `tool-translation.ts`) through the real path. The other five AI-SDK transports consume the same modules; a per-transport sweep adds runtime without new coverage. Revisit if a transport grows its own assembly logic. Cross-*process* schema byte-stability (two fresh module loads producing identical `z.toJSONSchema` output) is not covered — would need a spawned-process snapshot test à la Reasonix's persisted environment snapshots; noted as a follow-up, low priority while Zod v4 conversion is deterministic.
- ~~**TE-25 verbatim pinning**~~ — RESOLVED (2026-07-22): shipped section-first (TE-25a, default-on) AND built verbatim pinning (TE-25b, gated) so the eval could compare them head-to-head. Live run on `azureoai/gpt-5.5` (best-of-3): **baseline = section = verbatim = 100%** non-security retention — baseline saturated, so verbatim recovers nothing and stays gated off; section stays the reversible default. See [Live result](#live-result-2026-07-22-te-25-constraint-retention).
- ~~**TE-25 discriminating re-run**~~ — RESOLVED (2026-07-23): gpt-5.5 saturated at baseline 100% across {default, hard} fixtures × {default, `reasoning_effort=none`} (180 runs), ruling out reasoning effort and fixture difficulty. The last lever — a genuinely weaker summarizer — was pulled via **Bedrock `gpt-oss-20b`** (20B open model through the `litellm/` transport). It produced the **first drop in ~360 runs**: baseline folded an in-passing constraint on 1/3 runs (hard-fixture per-run 14/15) while **section and verbatim held all 3 (15/15)**. Conclusion: **TE-25a section justified (default-on), TE-25b verbatim matched-not-beaten (stays gated off) — decision rule 1**. See [Live result → weak-model follow-up](#follow-up--weak-model-bedrock-gpt-oss-20b-the-first-signal).
- ~~**TE-25 on-target Claude run**~~ — RESOLVED (2026-07-24): ran the real Claude summarizer, **Bedrock Claude Haiku 4.5** via the swarmkit LiteLLM gateway (`litellm/claude-haiku`, native Bedrock provider). All arms 100%, 90/90 runs clean, baseline 15/15 on hard fixtures — **Claude Haiku saturates like gpt-5.5**, holding even the in-passing constraint gpt-oss-20b dropped. Conclusion: the section's measured benefit is specific to weak/non-Claude native-path summarizers; on Claude the CC byte-exact prompt already suffices. TE-25 settled — section default-on (justified insurance), verbatim gated off. See [on-target follow-up](#follow-up--on-target-claude-summarizer-bedrock-claude-haiku-45-via-gateway).
- ~~**TE-27:**~~ RESOLVED (landed): skipped the PR-body ritual — the `cache-impact` CI job runs `scripts/check-cache-impact.ts`, which re-proves the TE-23 byte-stability + TE-22 cache-math guards whenever a diff touches a cache-sensitive path (a no-op otherwise). Attributed guard-in-CI is enough; no `Cache-impact:` line required.

## Non-goals

- Rewriting the Anthropic SDK path to own its own caching — the SDK handles Claude well; the exposure is the native path.
- Adopting Reasonix's Go-specific mechanisms (`RewriteVersion` bookkeeping, jsonl archive format) wholesale — we borrow the *ideas* (attribution, stability guard, verbatim constraints), not the implementation.
