# 55 — Cross-harness cache efficiency: lessons from DeepSeek-Reasonix

Status: **draft / plan**. Extends [53 (token-efficiency tracker)](./53-token-efficiency-plan.md) and [48 (compaction design)](./48-compaction-design.md). New tracker IDs continue the `TE-N` scheme from 53 (last landed: TE-18) — this doc opens **TE-19…TE-24**.

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

## Remaining delta — tracker (TE-19…TE-24)

Status legend (per 53): `todo` / `in-progress` / `landed` / `evaluated` / `rejected`.

| ID | Improvement | Where | Expected effect | Risk | Status |
|----|-------------|-------|-----------------|------|--------|
| TE-19 | **Native-path request-prefix byte-stability guard.** Assert the *actually serialized* request prefix (system + tool defs + leading messages) is byte-identical across two consecutive turns with unchanged inputs, for the AI-SDK transports. Today `prompt-cache.test.ts` only checks the analytics *fingerprint* is deterministic — it does not exercise the real assembled request. Reasonix's boot-level `TestBuildComposesByteStableSystemPrompt` is the model. | `src/providers/*-transport.ts`, new `src/providers/prefix-stability.test.ts` | Catches the "silent cold-start on every non-Anthropic provider" class before it ships; converts an untested property into a regression-guarded one | Low (test-only) | todo |
| TE-20 | **Cache-miss attribution.** Extend the fingerprint from one opaque hash to per-component hashes (system / tools / message-prefix / rewrite-version), and record which component changed on a cache-miss turn. Reasonix's `PrefixShape` + `CompareShape` name the culprit (`["system","tools","log_rewrite"]`) instead of leaving a miss unexplained. Complements the TE-14 telemetry. | `src/engine/prompt-cache.ts`, `src/swarm/usage-aggregator.ts` | Turns "cache% dropped" into "cache% dropped *because tools changed on turn N*" — makes TE-19 failures and future regressions diagnosable in eval logs | Low | todo |
| TE-21 | **Self-calibrated tokens-per-char.** Derive the chars/token ratio from the previous turn's real `prompt_tokens` instead of the fixed char/4 (compactor) and char/2.5 (preflight) constants. Reasonix's `tokPerChar()` tracks the provider tokenizer without shipping one, adapting to CJK/code density. Falls back to the current constant before any usage is seen. | `src/engine/compactor.ts`, `src/engine/token-preflight.ts` | More accurate trigger sizing on non-Anthropic providers where server `count_tokens` is unavailable (Claude Max/OAuth users always hit the estimate path today) | Low — bound the ratio to a sane range, keep the constant fallback | todo |
| TE-22 | **Pin user-stated constraints through full compaction.** Our L4 rebuild (48) keeps *zero* messages verbatim and reconstructs working state from disk (recent files + todos) — excellent for code state, but a durable user rule stated only in conversation ("never touch X", a chosen key, a naming decision) can be lost if the summary drops it. Reasonix keeps small user turns verbatim and forces a `## Standing facts & constraints` summary heading. Add: (a) a "standing constraints" section to the L3 summary prompt, and (b) optional verbatim pinning of small user turns. | `src/engine/compact-prompts.ts`, `src/engine/compactor.ts`, `src/engine/compact-rebuild.ts` | Fewer post-compaction regressions where the agent violates an earlier user constraint; directly targets handoff-fidelity (52) failure modes | Medium — changes summary shape; keep CC-parity preamble, add section without breaking it. Needs an eval arm | todo |
| TE-23 | **Per-tool snip geometry for microcompaction.** Microcompact currently replaces cleared results with a flat placeholder / disk pointer (max savings, zero inline signal). Reasonix keeps a tuned head/tail inline (read-only tools: long head; side-effecting: both ends, to preserve a trailing build error), via a per-tool `SnipHint`. Optional middle-ground: keep a short head/tail for side-effecting tools so a cleared bash failure still shows its error without a re-read. | `src/engine/microcompact.ts`, tool specs | Fewer paid re-reads to recover an error that was one line of a cleared result | Low–Medium — deviates from CC byte-exact placeholder (parity call, cf. TE-6 precedent) | todo (evaluate necessity) |
| TE-24 | **CI cache-impact gate (process).** Reasonix fails any PR touching cache-sensitive paths unless the body carries `Cache-impact:` / `Cache-guard:` lines, plus a byte-stability guard test in CI. Adopt a lightweight version: a `scripts/check-cache-impact` that flags PRs touching `src/engine/{prompt-cache,default-system-prompt,microcompact,compact*}`, `src/providers/*-transport`, or `src/tools/**` specs, and require TE-19's guard test to run on those PRs. | `scripts/`, `.github/workflows/` | Keeps the TE-19 invariant from silently rotting as the prompt/tool surface evolves | Low — process overhead; scope the path list tightly to avoid noise | todo (optional; land after TE-19) |

## Phasing

Ordered by payoff-to-risk, dependency-aware:

**Phase 1 — Guard the invariant we already have (TE-19, TE-20).** Pure measurement/test, no behavior change (mirrors 53's "land TE-14/15 first" discipline). TE-19 is the highest-leverage item in this doc: it converts our biggest untested property into a guarded one. TE-20 makes any failure legible. Ship together; no eval arm needed (test + telemetry only).

**Phase 2 — Estimator accuracy (TE-21).** Self-contained, low-risk, improves trigger timing on native providers. Verify against a session with known real usage; no quality eval needed, but re-check compaction-trigger timing doesn't regress on the discrimination set.

**Phase 3 — Compaction fidelity (TE-22).** The one with a real quality question, so it gets a dedicated eval arm per 53's methodology (Group-D-style): baseline vs. constraints-pinned, measured on tasks with early user constraints. Accept only if quality improves or holds AND token cost stays within noise.

**Phase 4 — Optional (TE-23, TE-24).** Evaluate whether TE-23 pays for itself (may not, given the re-read path is cheap); land TE-24 only after TE-19 exists to enforce.

## Eval hooks

Reuse the swarmkit-eval cost-frontier harness (51) and the TE-14 telemetry:

- **TE-19/20:** unit + integration tests; assert `cacheReadFraction` stays ≥ baseline on a repeat-prefix arm (regression signal if TE-19 ever fails silently).
- **TE-21:** offline — compare estimated vs. real `prompt_tokens` across a recorded session; target < 10% mean error vs. the fixed-constant baseline.
- **TE-22:** dedicated arm on tasks seeded with an early user constraint; metric = constraint-violation rate post-compaction + `meanQuality` guardrail + `meanTotalTokens`. Accept per the 53 rule (≥10% improvement or hold, quality within σ_D).

## Open questions

- **TE-19 scope:** guard all six AI-SDK transports, or a representative one (openai) plus a shared assembly-layer test? Leaning shared assembly test + one transport smoke, since the prefix assembly is mostly shared.
- **TE-22 verbatim pinning:** pin small user turns (Reasonix) *and* add the summary section, or the summary section alone? The section is lower-risk and CC-parity-preserving; pinning is stronger but changes the zero-verbatim rebuild contract (48 L4). Recommend section-first, evaluate pinning as a follow-up.
- **TE-23 necessity:** does the flat-placeholder + `read_file` recovery path already cost little enough that per-tool geometry isn't worth the CC-parity deviation? Decide from Phase 3 eval logs (how often the agent re-reads a cleared result to recover an error).
- **TE-24:** is a PR-body gate worth the friction on a smaller team, or is the CI guard test (TE-19 in CI) sufficient on its own? Leaning "guard test in CI is enough; skip the PR-body ritual."

## Non-goals

- Rewriting the Anthropic SDK path to own its own caching — the SDK handles Claude well; the exposure is the native path.
- Adopting Reasonix's Go-specific mechanisms (`RewriteVersion` bookkeeping, jsonl archive format) wholesale — we borrow the *ideas* (attribution, stability guard, verbatim constraints), not the implementation.
