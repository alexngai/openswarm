# 63 — Tool-call repair for open-weight models

> Status: implemented (engines + primitives + tests). Extends
> [62-offline-frontier-reconstruction.md](62-offline-frontier-reconstruction.md)
> and the open-weight tiers in [50](50-heterogeneous-cost-scaling.md) /
> [51](51-eval-execution-plan.md).

## 1. The problem

OpenSwarm never parses the model's prose. Actions come only from provider-native
structured tool calls, which arrive as typed stream events
(`tool-input-start` → `tool-input-delta` → `tool-call`). For frontier models
that is exactly right, and it is why the harness has no bespoke output grammar.

For an open-weight model behind an OpenAI-compatible endpoint it is a liability,
because the conversion from the model's *native* tool-call syntax to OpenAI
`tool_calls[]` does not happen in OpenSwarm — it happens in the serving layer
(vLLM's `--enable-auto-tool-choice --tool-call-parser <family>`, SGLang's
equivalent, llama.cpp's grammar). When that conversion mis-fires, three things
can go wrong, and before this change all three ended the same way:

| # | Failure | What the engine saw | Outcome |
|---|---|---|---|
| 1 | **Delivered but mislabelled** — aliased name (`shell`), namespaced name (`functions.bash`), enveloped args (`{"arguments":{…}}`) | a normal `tool-call` | dispatcher rejects → `invalid_tool_name` / `invalid_tool_arguments` → a wasted turn |
| 2 | **Started but dropped** — args streamed, then the provider SDK's `JSON.parse` failed | `tool-input-*` with no `tool-call` | call vanishes; the turn looks terminal |
| 3 | **Never structured** — no parser configured, so the call is emitted as assistant *text* in the model's native syntax | text deltas only | call vanishes; the turn looks terminal |

Cases 2 and 3 are the expensive ones. `toolUseBuffer` is empty, so the engine
takes the terminal-turn branch and emits `message_stop{end_turn}`. **The agent
stops after one turn having narrated a tool call it never made**, and from the
outside that is indistinguishable from the model choosing to answer. The actual
fix is a vLLM flag — invisible from inside the harness.

Case 3 is also the reason a "the model is too weak" conclusion can be wrong:
the model produced a perfectly good tool call, in its own format.

## 2. Why not `experimental_repairToolCall`

The Vercel AI SDK offers `experimental_repairToolCall` on `streamText`. It was
rejected as the primary mechanism:

- It fires only for `NoSuchToolError` / `InvalidToolInputError` — i.e. case 1
  and part of case 2. **It cannot see case 3 at all**, because no tool call was
  ever attempted.
- It would need wiring into all seven AI-SDK transports separately, and would
  not cover the transports that bypass the SDK (Codex Responses, Bedrock
  Converse).
- It is `experimental_` — a version-fragile surface for a correctness path.

Repair therefore lives at the **engine** level, driven off the `NormalizedEvent`
stream the engines already own. One implementation, every provider, including
the non-AI-SDK ones.

## 3. Design

Three layers, split so the policy is testable without a provider:

```
src/providers/tool-call-repair.ts       pure primitives — names, JSON, envelopes
src/providers/text-tool-call-parser.ts  pure primitives — native text syntaxes
src/engine/tool-call-recovery.ts        per-turn policy + engine glue
      ↑ used by native.ts and hardened-native.ts
```

### 3.1 Name resolution (`repairToolName`)

Ladder, most-confident first, resolving against the tool surface **actually
advertised this run**:

1. exact match
2. namespace-prefix strip — `functions.bash`, `default_api.read_file`
3. case-insensitive — `Bash`
4. alias table — `shell`, `run_command`, `python`, `str_replace_editor`, `cat`, …
5. punctuation-insensitive — `edit-file`, `editFile`
6. unique nearest neighbour, edit distance ≤ 2

Two safety properties:

- An alias never shadows a registered tool. `apply_patch` aliases to
  `edit_file`, but if `apply_patch` is itself registered, step 1 wins.
- An **ambiguous** nearest-neighbour match resolves to nothing. Guessing between
  two equally-close tools is worse than the existing `invalid_tool_name`
  feedback.

The alias table is now the single source of truth shared with
`src/tools/tool-feedback.ts`, which also gained a "Closest matches:" line.

### 3.2 Argument coercion (`coerceArgumentJson`)

A cumulative transform ladder, re-parsing after every step so the first success
wins and no further mangling happens:

markdown fence → wrapper-tag strip → embedded-object extraction → Python
literals (`True`/`None`) → trailing commas → bare keys → single quotes →
**close truncated JSON** → double-encoded unwrap.

Closing truncated JSON is the highest-value step: a `max_tokens`-cut argument
object (`{"command":"npm te`) is the single most common open-weight failure, and
it is deterministically recoverable. Single-quote conversion is deliberately
attempted only when the fragment contains no double quote at all — otherwise it
corrupts any string containing an apostrophe.

### 3.3 Envelope unwrapping (`unwrapArgumentEnvelope`)

Models echo the tool-call schema into the argument slot:
`{"arguments":{…}}`, `{"name":…,"parameters":{…}}`. Unwrapping only fires when
the envelope is unambiguous — keys must be a subset of `{name, <envelope key>}`
— so a tool that genuinely takes an `input` parameter alongside others is never
unwrapped.

### 3.4 Text extraction (`extractToolCallsFromText`)

Native syntaxes of the families commonly self-hosted for coding work:

| Format | Emitted by |
|---|---|
| `<tool_call>{…}</tool_call>` | Qwen, Hermes, most finetunes |
| `<\|python_tag\|>{…}<\|eom_id\|>` | Llama 3.1 JSON tool format |
| `<function=name>{…}</function>` | Llama 3.2 / Groq |
| `[TOOL_CALLS] [{…}]` | Mistral / Mixtral |
| `<｜tool▁call▁begin｜>…` | DeepSeek V3 / R1 |

All of these are **delimited**, which is what makes extracting them safe enough
to be on by default — a model does not emit `<|python_tag|>` in prose by
accident. Undelimited forms (a bare JSON object with `name` + `arguments`) are
gated behind the `aggressive` level, because a model *discussing* a tool call in
its final answer would otherwise be hijacked into making one.

Two further guards:

- Text extraction runs **only when the turn produced zero structured calls**, so
  a turn that made real calls is never re-read.
- An extracted call is kept only if its name resolves to a **registered** tool.

## 4. Engine integration

`applyRecovery()` runs after the provider stream completes and **before the
assistant message is committed**. That ordering is load-bearing, not cosmetic:
`providerMessagesToVercel` throws when a `tool_result` has no matching
`tool_use` in history, so a recovered call must be represented as a `tool_use`
block on the assistant message it belongs to.

Order of operations per turn:

1. `tool-call` arrives → `repairDelivered` (case 1) before gating, so a repaired
   call reaches `canUseTool` rather than the dispatcher's reject path.
2. Stream ends → `recoverDroppedCalls` (case 2) from buffered `tool-input`
   fragments.
3. Still zero calls → `recoverFromText` (case 3), and the extracted syntax is
   **excised** from the replayed text. Echoing both the malformed syntax and a
   real `tool_result` back would teach the model that its broken format worked.
4. Still zero calls, but text smells like a tool call → emit a diagnostic
   `info` event naming the likely serving-layer misconfiguration.

Repair **never bypasses gating**. A recovered call re-enters the normal path:
`canUseTool`, then `ToolDispatcher.dispatch` with full Zod validation. When
arguments cannot be coerced at all, the call dispatches with `{}` — an
actionable `invalid_tool_arguments` schema error beats a vanished call.

In `HardenedNativeEngine` the eager drain iterates `inFlight`, so recovered
calls are pushed into it via `onRecovered` → `startEagerDispatch`. Without that
they would be in `toolUseBuffer` but skipped by the drain; the eager path's
`startEagerDispatch` was extracted from the inline `tool-call` case for exactly
this reuse.

Buffers are cleared on `reset()` at each retry boundary, so a failed attempt
cannot "recover" a call the model is about to re-emit.

## 5. Configuration

`RunConfig.toolCallRepair`, defaulting to `OPENSWARM_TOOL_CALL_REPAIR`:

| Level | Behaviour |
|---|---|
| `off` (`0`, `false`, `none`) | prior drop-on-malformed behaviour |
| `standard` (**default**) | name resolution, argument coercion, envelope unwrapping, dropped-stream recovery, delimited text extraction |
| `aggressive` (`2`, `all`) | additionally mines undelimited JSON out of prose |

An unrecognised value degrades to `standard`, not `off` — a typo must not
silently disable recovery.

Recovery is inert when the run advertises no tools, so paths that pass
`tools: []` are unaffected.

**Default-on rationale.** Repair only ever fires where a call would otherwise be
dropped or rejected, it can only resolve to a registered tool, and the result
still passes schema validation. The cost of being wrong is one bad tool call
with an actionable error; the cost of being off is a silently truncated run.

## 6. Observability

New `NormalizedEvent`:

```ts
{ type: "tool_call_repaired", id, stage, toolName, repairs, originalName?, format? }
```

`stage` is `delivered` | `recovered_stream` | `recovered_text`; `repairs` is the
ordered audit trail. Headless JSONL passes it through unchanged, so eval runs
can attribute open-weight failures to serving-layer misconfiguration instead of
model capability — directly relevant to docs/62's conclusion that the small tier
"solves ~nothing uniquely", which assumes its tool calls were landing at all.

The unrecovered case emits `info{source:"tool-call-repair"}` naming the missing
vLLM flags.

## 7. Other countermeasures in this change

- **`buildToolUseWarmupPrompt` wired into the single-agent CLI.** It was
  previously only in `worker-entry.ts`, so a single-agent run against an
  open-weight model never got it even with `OPENSWARM_TOOL_USE_WARMUP=1` set.
- **"Closest matches" in `invalid_tool_name` feedback**, and the alias table
  deduplicated between the feedback and repair layers.

## 8. Serving-layer recipe (still the real fix)

Repair is a safety net, not a substitute for configuring the server:

```bash
vllm serve Qwen/Qwen3-30B-A3B \
  --enable-auto-tool-choice \
  --tool-call-parser hermes \
  --max-model-len 65536
```

If `tool_call_repaired{stage:"recovered_text"}` events appear in a run, the
server is mis-configured — fix the flags rather than relying on extraction.

## 9. Adjacent gaps — F1–F3 (resolved)

Three gaps sat next to repair and made the open-weight path worse in ways repair
could not reach. All three are now closed.

### F1 — capability probing (was: a hardcoded 200k window for every model)

`LiteLLMTransportProvider` serves arbitrary gateway/self-hosted models, so it
cannot use the static capability catalog. It guessed 200k context / 8k output
for everything. That number drives compaction: a model actually served at 32k
never trips the L1 trigger, so instead of compacting, the run walks into a
provider-side context-overflow error.

`src/providers/capability-probe.ts` discovers the real limits from the two
places OpenAI-compatible servers advertise them:

| Source | Endpoint | Field |
|---|---|---|
| vLLM / SGLang | `GET /v1/models` | `data[].max_model_len` |
| LiteLLM proxy | `GET /model/info` | `data[].model_info.max_input_tokens` |

Resolution order is **env → `/models` → `/model/info` → baseline**. An operator
who knows the number should not have to argue with a probe, so
`OPENSWARM_MAX_CONTEXT_TOKENS` / `OPENSWARM_MAX_OUTPUT_TOKENS` short-circuit the
network entirely; `OPENSWARM_CAPABILITY_PROBE=0` disables probing.

The probe is best-effort by construction: 2s timeout, never throws, any failure
or unrecognised shape falls back to the baseline. It runs once in
`create()`. Two deliberate conservatisms: a multi-model server with no matching
id yields nothing rather than a guess (a single-model server is accepted as
unambiguous even when the id was aliased), and `applyProbedCapabilities` clamps
the output cap to the discovered window so a 4k-window model cannot be asked
for 8k of output.

### F2 — `toolChoice` (was: the field existed but nothing wrote it)

`ProviderRequest.toolChoice` had been present since M4a, but no engine wrote it
and only the Codex Responses builder read it — so all seven AI-SDK transports
silently ran on the SDK default. `src/providers/tool-choice.ts` maps our union
(`{name}`) to the SDK's (`{type:"tool",toolName}`), and every transport now
spreads `...toolChoiceOption(req)` into its `streamText` call.

Reachable as `RunConfig.toolChoice`, `--tool-choice`, or
`OPENSWARM_TOOL_CHOICE`, accepting `auto` | `required` | `none` | a tool name.

Two guards, both in the mapper so no transport can forget them: a choice is
dropped when the request advertises **no tools** (`required` against an empty
tool set is a provider-side error), and a named tool is dropped when that tool
is not advertised.

> **`required` applies to every turn.** A model that must always call a tool can
> never end the conversation naturally, so it will run to `maxTurns`. It is the
> right lever for a model answering in prose instead of calling tools; pair it
> with `--max-turns`.

### F3 — sampling parameters (was: unreachable from `RunConfig`)

Every transport already read `temperature` / `topP` / `topK` off
`ProviderRequest` — no engine ever wrote them. The only way to tune a
self-hosted model was `LITELLM_EXTRA_BODY`, which the swarm worker path could
not set per-role at all. Lower temperature measurably improves tool-call
well-formedness on small open-weight models, so this was a real lever to be
missing.

Added to `RunConfig` and threaded through both native engines, with
`src/engine/sampling.ts` resolving flags over environment:

| Lever | Flag | Env |
|---|---|---|
| temperature | `--temperature` | `OPENSWARM_TEMPERATURE` |
| top-p | `--top-p` | `OPENSWARM_TOP_P` |
| top-k | `--top-k` | `OPENSWARM_TOP_K` |
| tool choice | `--tool-choice` | `OPENSWARM_TOOL_CHOICE` |

Environment is the propagation mechanism on purpose: the subprocess spawner
spreads `process.env`, so a value resolved once on the orchestrator reaches
every worker without a new IPC field. `exportSamplingEnv` publishes the
resolved values but never clobbers an already-set variable, so a per-worker
override stays authoritative.

Unset levers are omitted from `ProviderRequest` entirely rather than sent as
`undefined`, so provider defaults survive. `temperature: 0` is honoured, not
treated as falsy.

`topK` has no OpenAI-wire equivalent, so the OpenAI-compatible transports
(LiteLLM, Azure, DashScope) ignore it — use `LITELLM_EXTRA_BODY` for vLLM's
`top_k`. Google, xAI and Bedrock accept it natively.

### F5 — one-shot `toolChoice` escalation

A turn that ends with no tool call while its text plainly contained one means
the model *wanted* a tool and the serving layer did not produce one. Diagnosing
that is useful; acting on it is better. `ToolChoiceEscalation` re-runs the same
turn with `toolChoice: "required"`, routing the call through the provider's own
tool-call path instead of its content stream.

Three guards keep it from becoming a loop or a nuisance:

- **Never overrides the caller.** If `toolChoice` was set explicitly, escalation
  is disabled outright.
- **One-shot per arming.** `consume()` disarms while building the request, so
  the escalated turn cannot escalate itself.
- **Per-run budget** (`OPENSWARM_TOOL_CHOICE_ESCALATION`, default 1). A model
  that ignores `required` costs one extra round trip, not a retry storm.

The escalated turn's assistant message is deliberately **not committed** — the
model is about to produce a replacement for it, and replaying a dead turn would
waste context and teach the wrong thing. Usage *is* tallied before the retry, so
the extra round trip stays visible in the ledger.

False-positive risk is low because arming requires `looksLikeTextToolCall`,
which only matches delimited syntaxes (`<tool_call>`, `<|python_tag|>`,
`[TOOL_CALLS]`, `<function=`). A model writing a genuine final answer does not
emit those.

## 10. Verification

Unit and engine tests use scripted `ProviderEvent`s, which necessarily encode an
*assumption* about AI SDK behaviour. `test/integration/open-weight-repair.e2e.test.ts`
is what verifies it: a real OpenAI-compatible HTTP server (SSE chat completions
+ `/v1/models`) driving the **compiled CLI** over the `litellm/` route. Nothing
is mocked below the CLI boundary — argv → routing → transport → capability probe
→ `@ai-sdk/openai`'s real streaming parser → engine → recovery → permission gate
→ dispatcher → the real `glob` tool → headless JSONL. No network, no
credentials, no user state.

Two things it established that the unit tests could not:

- **A tool call with unparseable arguments is silently dropped by the SDK.**
  Confirmed on the wire: `tool-input-start` fires, the truncated delta streams,
  and no `tool-call` ever arrives. Case 2 recovery is therefore load-bearing,
  not defensive — the observed repair trail is
  `["rebuilt tool call the provider dropped mid-stream", "closed truncated JSON"]`.
- **`@ai-sdk/openai` writes `tool_choice: "auto"` itself** whenever tools are
  present. Our "unset" is absence of *our* lever, not absence of the field —
  worth knowing before reading a request body and concluding the lever is broken.

The suite also pins the regression this whole change exists to prevent: with
`OPENSWARM_TOOL_CALL_REPAIR=0`, a text-format tool call produces exactly one
completion request and zero tool results — the silent one-turn stop.

## 11. Remaining follow-ups

Repair is justified here by **mechanism**, not by measurement: the e2e proves it
converts a silently-truncated run into a working one, but nothing in this change
establishes how often that happens on a real tier or what it is worth. F4 is
that gap, and it is the one that matters.

### F4 — resolve-rate measurement on an open-weight tier (open, runbook written)

**Runbook: [63-live-eval-handoff.md](./63-live-eval-handoff.md).**

Deliberately not run here — it needs a real open-weight tier and GPU/API budget,
neither of which the dev sandbox has. Deliberately not *scaffolded* here either:
eval code that cannot be executed bit-rots, and guessing at the harness shape
would produce something worse than a precise spec.

What the runbook pins down, because these are the parts that are easy to get
wrong:

- **The server-configuration confound.** A correctly-configured vLLM hides most
  of the effect — case 3 never fires, both arms score alike, and the naive
  reading is "repair does nothing." Server config is therefore a first-class
  axis (`parser-on` / `parser-off`), reported separately. `parser-off` is not a
  strawman: it is the default state of a fresh server.
- **A free pre-check before any spend.** Count `tool_call_repaired` events on a
  handful of `repair-on` runs. Zero across the board ⇒ repair is structurally
  inert on that tier and the resolve-rate delta is necessarily zero — report
  that instead of buying a null result at full price. (Same move as docs/62's
  oracle pre-check.)
- **Mechanism metrics alongside the headline.** Repair rate by `stage`,
  silent-stop rate, escalation rate, and tokens — all already in the headless
  JSONL. A resolve-rate delta with no matching repair-rate movement means
  something else changed.

Enablement is complete: arms are env overlays the shipped code already reads
(`OPENSWARM_TOOL_CALL_REPAIR`, `OPENSWARM_TOOL_CHOICE_ESCALATION`), telemetry is
already emitted, `--temperature 0` is now reachable (F3) so arm variance is the
treatment rather than the sampler, and the capability probe (F1) means a 32k tier
is no longer silently mis-compacted mid-study. **What is missing is the run and
one experiment file, not the plumbing.**

### F6 — probe coverage beyond LiteLLM

`AzureTransportProvider` still hardcodes `maxContextTokens: 200_000` /
`maxOutputTokens: 8_192` (`src/providers/azure-transport.ts`), so an Azure
deployment of an open-weight model — e.g. the `gpt-oss-20b` used in docs/55 —
has exactly the F1 problem F1 fixed for LiteLLM. `probeOpenAICompatCapabilities`
is transport-agnostic and would drop straight in; it was scoped to LiteLLM
because that is the self-hosted path. DashScope is fine (it uses a capability
catalog).

### F7 — the escalation budget is unmeasured

`DEFAULT_ESCALATION_BUDGET = 1` was chosen conservatively, not empirically. The
F4 run answers it directly by comparing a `repair-only` arm against `repair-on`:
if escalation adds resolve rate the default is defensible, if it only adds tokens
it should drop to 0 and become opt-in.

### F8 — `topK` unreachable on OpenAI-wire transports

`topK` has no OpenAI Chat Completions equivalent, so LiteLLM/Azure/DashScope
ignore it; vLLM *does* accept `top_k`, reachable only via
`LITELLM_EXTRA_BODY`. A transport-level passthrough would remove that asymmetry,
at the cost of sending a non-standard field to gateways that may reject it.

### F9 — no aggregated repair telemetry

`tool_call_repaired` is per-event only. `ToolCallRecovery.repairCount` and
`ToolChoiceEscalation.escalationCount` are tracked but never surfaced — a
per-session line in `/cost` or the session summary ("3 tool calls repaired, 1
escalation") would make a mis-configured server obvious to a human without
grepping JSONL.
