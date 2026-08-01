# 66 — Live-eval handoff: F4 tool-call repair on an open-weight tier

> **Status: NOT RUN.** Everything in
> [63-tool-call-repair.md](./63-tool-call-repair.md) is landed, unit-tested, and
> verified end-to-end against a fake OpenAI-compatible server
> (`test/integration/open-weight-repair.e2e.test.ts`) — **except one measurement
> that needs a real open-weight tier** and could not run in the dev sandbox (no
> GPU, no gateway). This file is the self-contained runbook to finish it in a
> session that has one.

**Purpose.** Repair is currently justified by mechanism, not by measurement. We
know it converts a silently-truncated run into a working one (the e2e proves the
mechanism on the wire); we do **not** know how often that happens on a real
open-weight tier, or what it is worth in resolve rate. F4 is that number.

It also settles a live question about prior work: [docs/62
§Phase 0](./62-offline-frontier-reconstruction.md) concluded the small tier
"solves ~nothing uniquely." That conclusion assumes its tool calls were *landing*
— which, before this change, was never checked. If repair-off vs repair-on moves
resolve rate materially, some of docs/62's capability gap was serving-layer loss.

---

## TL;DR

```bash
npm ci && npm run build

# Point at a self-hosted open-weight tier (vLLM direct or a LiteLLM gateway).
export LITELLM_BASE_URL=http://127.0.0.1:8000/v1
export LITELLM_API_KEY=dummy          # vLLM ignores it; the auth gate requires it non-empty
export MODEL=litellm/Qwen/Qwen3-30B-A3B

# Stage 0 — the free pre-check (§4). Stop here if repair never fires.
node bin/openswarm.mjs --headless --output-format json --model "$MODEL" \
  --temperature 0 --max-turns 20 "fix the failing test in tests/" > run.jsonl
jq -r 'select(.type=="tool_call_repaired") | .stage' run.jsonl | sort | uniq -c

# Stage 1 — the paired arms (§3), once the pre-check says repair engages.
RUN_REPAIR_EVAL=1 npx tsx eval/experiments/tool-call-repair.ts
```

`eval/experiments/tool-call-repair.ts` **does not exist yet** — §6 says exactly
what it has to do and what it can reuse. Everything it needs from the *product*
side is already shipped.

---

## 1. The confound that decides whether this measurement means anything

**A correctly-configured server hides the effect.** If vLLM is started with a
matching `--tool-call-parser`, case 3 (calls arriving as text) never happens, so
repair only ever fires on cases 1–2 (aliased names, truncated argument JSON).
Both arms then score nearly the same, and the naive reading is "repair does
nothing."

That reading would be wrong, and it is the single easiest way to waste this run.
Repair is insurance against a *misconfiguration*, so the measurement has to
include the misconfigured condition to say anything about its value — and
include the configured condition to say anything about its cost.

So the server configuration is a **first-class axis**, not a setup detail:

| Condition | vLLM flags | What repair is being measured on |
|---|---|---|
| `parser-on` | `--enable-auto-tool-choice --tool-call-parser <family>` | cases 1–2 only: aliased names, truncated/enveloped args |
| `parser-off` | neither flag | case 3: the silent one-turn stop |

`parser-off` is not a strawman. It is the **default state of a fresh vLLM
server** — you get it by not knowing the flag exists, which is the situation this
whole change was written for.

> Report the two conditions separately. A single blended number is
> uninterpretable, in the same way docs/62 §8.1's cache-read confound made a
> blended cost axis uninterpretable.

---

## 2. Tier selection

Any model served behind an OpenAI-compatible endpoint. Prefer one whose native
tool-call syntax is a format the text parser supports (`src/providers/text-tool-call-parser.ts`):

| Family | Native syntax | Parser support |
|---|---|---|
| Qwen 2.5/3 | `<tool_call>…</tool_call>` | ✅ `hermes` |
| Llama 3.1 | `<\|python_tag\|>…` | ✅ `python_tag` |
| Llama 3.2 | `<function=name>…` | ✅ `function_tag` |
| Mistral / Mixtral | `[TOOL_CALLS] […]` | ✅ `mistral` |
| DeepSeek V3 / R1 | `<｜tool▁call▁begin｜>…` | ✅ `deepseek` |

**A tier whose syntax is unsupported is itself a finding** — record it and add
the format, rather than reporting a low recovery rate as a repair failure.

Claude models are out of scope: they resolve to the SDK engine, which owns its
own loop and never reaches this code.

---

## 3. Arms

Two arms, selected purely by an env overlay the shipped code already reads — so
this measures shipped behaviour, not a reimplementation (same discipline as
`eval/experiments/constraint-retention.ts`):

| Arm | Env overlay | Meaning |
|---|---|---|
| `repair-off` | `OPENSWARM_TOOL_CALL_REPAIR=0`, `OPENSWARM_TOOL_CHOICE_ESCALATION=0` | pre-change behaviour |
| `repair-on` | *(defaults)* | shipped behaviour: repair + one-shot escalation |

Optionally a third to separate the two mechanisms, which matters because they
have very different costs (escalation spends an extra round trip):

| Arm | Env overlay |
|---|---|
| `repair-only` | `OPENSWARM_TOOL_CHOICE_ESCALATION=0` |

Hold everything else fixed across arms — same task set, same seeds, same
`--max-turns`, same sampling. Set `--temperature 0` (now reachable, docs/63 F3)
so arm-to-arm variance is the treatment and not the sampler.

---

## 4. Stage 0 — the free pre-check (run this first)

Before spending on a paired resolve-rate study, answer a much cheaper question:
**does repair fire at all on this tier?** Run a handful of tasks on `repair-on`
only and count the events.

```bash
# any small task set; the JSONL is what matters
node bin/openswarm.mjs --headless --output-format json --model "$MODEL" \
  --temperature 0 --max-turns 20 "fix the failing test in tests/" > run.jsonl

jq -r 'select(.type=="tool_call_repaired") | .stage' run.jsonl | sort | uniq -c
jq -r 'select(.type=="info") | .method' run.jsonl | sort | uniq -c
```

Interpretation:

- **Zero `tool_call_repaired` across every run** → repair is structurally
  inert on this tier+config. The resolve-rate delta is necessarily zero;
  **stop, and report that**, rather than buying a null result at full price.
  (This is the same move as docs/62's oracle pre-check: kill a dead cell on
  free evidence before paying for it.)
- **`stage: recovered_text` present** → the server is not converting tool calls.
  Fix the flags and re-check; if you meant to measure `parser-off`, this is your
  condition working as intended.
- **`stage: delivered` / `recovered_stream` present** → cases 1–2 are live even
  with a correct parser. This is the interesting, non-obvious result — it means
  repair earns its keep on a *well-configured* server.

This pre-check costs a few runs and determines whether Stage 1 is worth
launching. Do not skip it.

---

## 5. Metrics

**Primary**
- **resolve rate** per arm × condition (the benchmark's own grader).

**Secondary — all derivable from the headless JSONL, no new instrumentation**
- **repair rate**: `tool_call_repaired` events per run, broken out by `stage`.
  This is the mechanism metric; it explains any resolve-rate delta.
- **silent-stop rate**: fraction of runs ending with ≤1 assistant turn *and* an
  `info` event with `method: "unrecovered_text_tool_call"`. On `repair-off` under
  `parser-off` this should approach 1.0; that is the bug being priced.
- **escalation rate**: `info` events with `method: "tool_choice_escalation"`, and
  how often the forced retry then produced a real tool call.
- **cost**: tokens from the terminal `message_stop` usage. Escalation spends an
  extra round trip per firing — the study should price that, not assume it.

**Do not** report resolve rate alone. A delta with no matching repair-rate
movement means something else changed.

---

## 6. What exists vs what needs building

**Already shipped — no work needed**

| Piece | Where |
|---|---|
| Arms as env overlays | `OPENSWARM_TOOL_CALL_REPAIR`, `OPENSWARM_TOOL_CHOICE_ESCALATION` |
| Per-repair telemetry in headless JSONL | `tool_call_repaired` (`src/core/types.ts`) |
| Silent-stop / escalation telemetry | `info` events, source `tool-call-repair` |
| Deterministic sampling | `--temperature 0` (docs/63 F3) |
| Open-weight routing | `litellm/…` + `LITELLM_BASE_URL` |
| Correct context window | capability probe (docs/63 F1) — compaction now sizes to the real window, so a 32k tier is not silently mis-compacted mid-study |

**Needs building — `eval/experiments/tool-call-repair.ts`**

1. Define the arms above as env overlays; mirror the `Arm { label, env }` shape
   in `eval/experiments/constraint-retention.ts`.
2. Run them over a task set through `swarmkit-eval`'s matrix runner, reusing
   `localSwarmHarness()` from `eval/harness/local.ts` (runs the working-tree
   build — no publish).
3. Post-process each run's JSONL for the §5 secondary metrics. There is no
   existing helper for this; it is ~30 lines of counting, and belongs in
   `eval/harness/` next to `constraint-retention.ts`.
4. Emit a markdown table: arm × condition × {resolve, repair-rate-by-stage,
   silent-stop, tokens}.

Start on FixIt with the in-process backend (cheap, local, sealed-test grading —
see `eval/experiments/fixit.ts`) before spending on SWE + E2B.

> **Note:** `fixit.ts`'s `FIXIT_PROVIDER` currently accepts only
> `bedrock` | `azure` (`providerEnv()`), neither of which routes to a
> self-hosted tier. Reusing it means adding a `litellm` branch that forwards
> `LITELLM_BASE_URL` / `LITELLM_API_KEY` into the agent env — a few lines,
> alongside the existing `azureEnv()`.

---

## 7. Decision rule (then record it)

Read `parser-off` and `parser-on` separately.

**Under `parser-off`:**
1. `repair-on` resolve rate ≫ `repair-off` (expected: `repair-off` ≈ 0, since
   every run stops after one turn) → repair converts a dead configuration into a
   working one. Record the magnitude; this is the headline.
2. Both ≈ 0 → the tier's syntax is not in the parser table, or the model is not
   emitting tool calls at all. Check the Stage 0 event counts before concluding
   anything about repair.

**Under `parser-on`:**
3. `repair-on` > `repair-off` → cases 1–2 matter on a correctly-configured
   server. Strongest argument for repair being default-on. Report which `stage`
   drove it.
4. No difference, and repair rate ≈ 0 → repair is inert here. Still correct to
   keep default-on (it costs nothing when it does not fire), but say so plainly
   rather than implying a benefit that was not observed.
5. `repair-on` < `repair-off` → **a real finding, report it.** The likely
   mechanism is a mis-resolved name routing a call to the wrong tool. Tighten
   the resolution ladder (the fuzzy-match step at distance ≤ 2 is the first
   suspect) before touching anything else.

**On escalation specifically:** compare `repair-only` vs `repair-on`. If
escalation adds resolve rate, the default budget of 1 is defensible; if it only
adds tokens, lower the default to 0 and leave it opt-in. The budget was chosen
conservatively, not empirically — see F7 below.

**Record the result** as a `## Live result` section in
[63-tool-call-repair.md](./63-tool-call-repair.md), following the convention
docs/55 uses, and update the docs/README.md index line. Include the model, the
server flags, seeds, and n — a resolve-rate number without the server
configuration is not interpretable.

---

## 8. Also answered by the same run

- **Does docs/62's Phase 0 conclusion survive?** If `parser-off`-style loss was
  present in those cells, "the small tier solves ~nothing uniquely" was partly
  measuring dropped tool calls. Check whether that harness had a parser
  configured; if it did not, the cells need re-running before the conclusion
  stands.
- **Is the escalation budget right?** (F7)
- **Is the fuzzy-match distance right?** A mis-resolution shows up as a
  `tool_call_repaired{stage:"delivered"}` immediately followed by an error
  `tool_result` — cheap to grep for, and the only signal that the ladder is too
  permissive.

---

## 9. Related follow-ups (not blocking F4)

See [63-tool-call-repair.md §11](./63-tool-call-repair.md#11-remaining-follow-ups)
for the full register: F6 (probe coverage for Azure), F7 (escalation budget),
F8 (`topK` on OpenAI-wire transports), F9 (repair telemetry aggregation).
