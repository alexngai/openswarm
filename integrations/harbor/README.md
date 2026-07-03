# openswarm ⇄ Harbor agent

Runs **openswarm** as an agent in the [Harbor](https://github.com/) benchmark harness
(SWE-Atlas / SWE-bench-style task → sandbox → agent → verifier → reward). swarmkit-eval
drives Harbor and selects the agent by id, so this makes `openswarm` a first-class
choice alongside `mini-swe-agent`, `codex`, `claude-code`, etc.

It lives **in the openswarm repo** (not a Harbor fork): Harbor loads it by *import path*.

## Files

| file | what |
|---|---|
| `openswarm_harbor_agent.py` | `OpenswarmAgent(BaseInstalledAgent)` — installs the CLI, runs `openswarm prompt … --headless`, parses usage into the trial context. |
| `openswarm_stream.py` | pure-stdlib parser for openswarm's headless JSONL stream (no Harbor dep). Mirror of the TS `openSwarmParse` and the HAL bridge's `_parse_openswarm_stream`. |
| `test_openswarm_stream.py` | standalone tests: `python3 test_openswarm_stream.py`. |

## Why a dedicated agent (approach B), not the generic ACP agent (approach A)

openswarm *does* ship a standard ACP server (`openswarm acp`), and Harbor has a generic
ACP agent — but for an eval it loses on the two things that matter most:

- **Token/cost:** openswarm's ACP stream emits **no** usage; its headless
  `--output-format json` stream carries `message_stop.usage`. Approach B captures cost;
  A cannot.
- **Model routing:** Harbor selects the model over ACP `session/set_model`, which
  openswarm doesn't implement (model is a fixed `--model` CLI flag). B passes `--model`
  explicitly; A's `-m` would silently not bind.
- **Nonstandard ACP:** openswarm's ACP defaults to *team* mode (`_meta.swarm`,
  `swarm/steer`); Harbor's generic client ignores those, so ACP buys nothing for
  grading anyway. B sidesteps it.

openswarm edits the workspace directly on disk, so Harbor's diff-based verifier grades
it with no client-side fs cooperation.

## Run it from Harbor directly

```bash
PYTHONPATH=/path/to/openswarm/integrations/harbor \
harbor run <task-or-dataset> \
  -a openswarm_harbor_agent:OpenswarmAgent \
  -m anthropic/claude-sonnet-4-6 \
  --ae ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
```

The `:` in `-a` makes Harbor treat the value as an import path
(`factory.create_agent_from_import_path`) — no `AgentName` enum entry, no Harbor edit.
`PYTHONPATH` must include **this directory** so `openswarm_harbor_agent` and
`openswarm_stream` are importable by the host-side Harbor process.

### Agent kwargs (`--ak key=value`, all optional)

| kwarg | default | meaning |
|---|---|---|
| `permission_mode` | `danger-full-access` | openswarm `--permission-mode`; full access stops headless turns blocking on prompts |
| `model_override` | — | pass verbatim to `--model` instead of the Harbor `-m` name (for gateway ids) |
| `swarm` | `false` | drop `--single` and run openswarm's coordinator team (multi-agent) |
| `install_spec` | `openswarm@latest` | npm spec `install()` installs into the sandbox |
| `version` | — | pin the reported agent version (skips auto-detect) |

### Auth / model

`OpenswarmAgent` forwards `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`,
`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL` from `--ae`/host env into
the sandbox (openswarm lets the underlying Claude Agent SDK read them). For a LiteLLM
gateway route, set `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` via `--ae` and pass the
gateway model id via `-m` or `--ak model_override=`. A bare `anthropic/<name>` `-m` is
stripped to `<name>` for openswarm; other providers pass through unchanged.

## Wire it from swarmkit-eval (swe-atlas adapter)

The swe-atlas adapter already selects the agent by id (`-a`) and forwards agent
kwargs/env — no swarmkit code change is needed. In a `sweAtlasHarborArms` arm:

```ts
{ id: "openswarm", agent: "openswarm_harbor_agent:OpenswarmAgent", environment: "e2b" }
```

and add this directory to the Harbor command env so it's importable, e.g. set
`PYTHONPATH=/path/to/openswarm/integrations/harbor` on the Harbor process
(alongside the existing `HARBOR_COMMAND_JSON` setup), and pass creds via `agentEnv`
(`--ae`). Token usage lands on `TrialResult.agent_result.n_input_tokens/…`, which the
swe-atlas driver already reads.

## ✅ Live-run blocker — RESOLVED (v0.3.7 / current v0.3.8)

**Historical (≤ v0.3.5):** `openswarm prompt --headless` failed in-process with
`transport: Claude Code process exited with code 1`. Inside a `bun build --compile`
standalone binary the Claude Agent SDK's own resolver
(`require.resolve("@anthropic-ai/claude-agent-sdk-<plat>/claude")`) can't see
`node_modules` (it isn't in the embedded fs), so `query()` spawned a bad path and the
child died at startup **before emitting any `result`** — hence the bare exit-1 (distinct
from an auth failure, which surfaces as `Claude Code returned an error result: …`).

**Fix (`3d4be49`, v0.3.7):** `src/engine/claude-agent-sdk.ts` now computes a real
on-disk path (`resolveClaudeExecutablePath`) — co-located next to the executable, else
`node_modules/@anthropic-ai/claude-agent-sdk-<plat>-<arch>/claude` at any ancestor — and
hands it to the SDK via `pathToClaudeCodeExecutable`. Regression-tested in
`src/engine/claude-agent-sdk.test.ts` (Scenario 0).

Verified on the current tree (v0.3.8) with the compiled darwin-arm64 binary
(`packages/cli-darwin-arm64/openswarm`): `prompt --headless --output-format json` emits a
valid JSONL stream (`text_delta` → `message_stop` with usage, exit 0) against real
keychain auth. A dummy key now cleanly yields the auth-error result rather than a spawn
crash.

Everything in this directory is validated offline: the parser tests pass, and the agent
class instantiates + runs end-to-end against the real Harbor `BaseInstalledAgent` /
`AgentContext` with a stubbed environment. The remaining validation is a live Harbor
trial once the engine bug is resolved.

## Tests

```bash
python3 test_openswarm_stream.py          # parser (no deps)
# agent class against real Harbor types:
uv --directory /path/to/harbor run python - <<'PY'
import sys, logging, pathlib; sys.path.insert(0, ".")
from openswarm_harbor_agent import OpenswarmAgent
a = OpenswarmAgent(logs_dir=pathlib.Path("/tmp/x"), model_name="anthropic/claude-sonnet-4-6", logger=logging.getLogger("t"))
print(a.import_path(), "->", a._build_command("fix it", "/logs/agent/openswarm.jsonl"))
PY
```
