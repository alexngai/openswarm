# 55 — Cross-harness cache efficiency: lessons from DeepSeek-Reasonix

Status: **draft / plan**. Extends [53 (token-efficiency tracker)](./53-token-efficiency-plan.md) and [48 (compaction design)](./48-compaction-design.md). New tracker IDs continue the `TE-N` scheme from 53 (last landed: TE-18) — this doc opens **TE-19…TE-27** (a measurement/visibility track first, then improvements).

Owner: engine

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
| TE-24 | **Self-calibrated tokens-per-char.** Derive the chars/token ratio from the previous turn's real `prompt_tokens` instead of the fixed char/4 (compactor) and char/2.5 (preflight) constants. Reasonix's `tokPerChar()` tracks the provider tokenizer without shipping one, adapting to CJK/code density. Falls back to the current constant before any usage is seen. | `src/engine/compactor.ts`, `src/engine/token-preflight.ts` | More accurate trigger sizing on non-Anthropic providers where server `count_tokens` is unavailable (Claude Max/OAuth users always hit the estimate path today) | Low — bound the ratio to a sane range, keep the constant fallback | todo |
| TE-25 | **Pin user-stated constraints through full compaction.** Our L4 rebuild (48) keeps *zero* messages verbatim and reconstructs working state from disk (recent files + todos) — excellent for code state, but a durable user rule stated only in conversation ("never touch X", a chosen key, a naming decision) can be lost if the summary drops it. Reasonix keeps small user turns verbatim and forces a `## Standing facts & constraints` summary heading. Add: (a) a "standing constraints" section to the L3 summary prompt, and (b) optional verbatim pinning of small user turns. | `src/engine/compact-prompts.ts`, `src/engine/compactor.ts`, `src/engine/compact-rebuild.ts` | Fewer post-compaction regressions where the agent violates an earlier user constraint; directly targets handoff-fidelity (52) failure modes | Medium — changes summary shape; keep CC-parity preamble, add section without breaking it. Needs an eval arm | todo |
| TE-26 | **Per-tool snip geometry for microcompaction.** Microcompact currently replaces cleared results with a flat placeholder / disk pointer (max savings, zero inline signal). Reasonix keeps a tuned head/tail inline (read-only tools: long head; side-effecting: both ends, to preserve a trailing build error), via a per-tool `SnipHint`. Optional middle-ground: keep a short head/tail for side-effecting tools so a cleared bash failure still shows its error without a re-read. | `src/engine/microcompact.ts`, tool specs | Fewer paid re-reads to recover an error that was one line of a cleared result | Low–Medium — deviates from CC byte-exact placeholder (parity call, cf. TE-6 precedent) | todo (evaluate necessity) |
| TE-27 | **CI cache-impact gate (process).** Reasonix fails any PR touching cache-sensitive paths unless the body carries `Cache-impact:` / `Cache-guard:` lines, plus a byte-stability guard test in CI. Adopt a lightweight version: a `scripts/check-cache-impact` that flags PRs touching `src/engine/{prompt-cache,default-system-prompt,microcompact,compact*}`, `src/providers/*-transport`, or `src/tools/**` specs, and require TE-23's guard test to run on those PRs. | `scripts/`, `.github/workflows/` | Keeps the TE-23 invariant from silently rotting as the prompt/tool surface evolves | Low — process overhead; scope the path list tightly to avoid noise | todo (optional; land after TE-23) |

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
- **TE-23:** unit/integration test is the deliverable; additionally assert via TE-22 that `cacheReadFraction` stays ≥ baseline on a repeat-prefix run (the regression signal if the guard ever silently fails).
- **TE-24:** offline — compare estimated vs. real `prompt_tokens` across a recorded session; target < 10% mean error vs. the fixed-constant baseline.
- **TE-25:** dedicated eval arm on tasks seeded with an early user constraint; metric = constraint-violation rate post-compaction + `meanQuality` guardrail + `meanTotalTokens`. Accept per the 53 rule (≥10% improvement or hold, quality within σ_D).

## Open questions

- ~~**TE-19 pricing source of truth**~~ — RESOLVED: `MODEL_PRICING` (via `ApiCostModel`) is canonical; `/cost`, the footer, the session-end summary, and the eval all consume it. Follow-up data chore: the table's coverage is thin (3 Anthropic + 3 OpenAI + 1 Bedrock entry) — extend it as native providers are actually used; until then those models honestly report `n/a`.
- ~~**TE-20 surface**~~ — RESOLVED: persistent footer % (line 2), annotated with a per-turn `(hit)`/`(miss)` marker when the SDK-path lane events flow; the marker resets on each submit.
- ~~**TE-22 fixture**~~ — RESOLVED: both. The scripted engine (`OPENSWARM_TEST_SCRIPT` + a JSON fixture) gives a deterministic, zero-spend self-check of the harness plumbing; real cache behavior is measured by pointing the same harness at a live short task (`--model` + provider auth).
- ~~**TE-23 scope**~~ — RESOLVED: one transport smoke (openai) that exercises the shared assembly modules (`message-replay.ts`, `tool-translation.ts`) through the real path. The other five AI-SDK transports consume the same modules; a per-transport sweep adds runtime without new coverage. Revisit if a transport grows its own assembly logic. Cross-*process* schema byte-stability (two fresh module loads producing identical `z.toJSONSchema` output) is not covered — would need a spawned-process snapshot test à la Reasonix's persisted environment snapshots; noted as a follow-up, low priority while Zod v4 conversion is deterministic.
- **TE-25 verbatim pinning:** pin small user turns (Reasonix) *and* add the summary section, or the summary section alone? The section is lower-risk and CC-parity-preserving; pinning is stronger but changes the zero-verbatim rebuild contract (48 L4). Recommend section-first, evaluate pinning as a follow-up.
- **TE-27:** is a PR-body gate worth the friction on a smaller team, or is the CI guard test (TE-23 in CI) sufficient on its own? Leaning "guard test in CI is enough; skip the PR-body ritual."

## Non-goals

- Rewriting the Anthropic SDK path to own its own caching — the SDK handles Claude well; the exposure is the native path.
- Adopting Reasonix's Go-specific mechanisms (`RewriteVersion` bookkeeping, jsonl archive format) wholesale — we borrow the *ideas* (attribution, stability guard, verbatim constraints), not the implementation.
