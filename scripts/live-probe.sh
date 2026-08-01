#!/usr/bin/env bash
# scripts/live-probe.sh — drive the compiled CLI against a real provider.
#
#   ./scripts/live-probe.sh <model-id> [workdir]
#
# Exists because the unit suite cannot reach a whole class of defect. Its
# fixtures are the ones that motivated it: a headless run that denied one
# approval and approved the next emitted both questions, returned one result,
# and exited 0 with the turn unfinished — which whoever is driving it reads as
# success. Every in-process fixture passed throughout, because each handed the
# reader a fresh stream and asked once, and that is the single shape where
# borrowing stdin per question behaves like owning it (docs/63 WP-09).
#
# So these probes deliberately assert on the seams between the model, the
# process, and the filesystem rather than on model output. Nothing here checks
# that a model reasoned well; the probes check that a tool call reached the
# filesystem, an approval reached the reader, a denial did not take the rest of
# the session with it, and a worker's result reached the results file intact.
#
# Costs real tokens. Never invoked by the default gate — see the `live` target
# in verify-parity-wp.sh, which requires OPENSWARM_PARITY_LIVE=1 as well as
# being named explicitly.
#
# Exit codes:
#   0  every probe passed
#   1  at least one probe failed
#   3  usage error
#   4  no usable credential for this model — nothing was certified
#
# 4 is separate from 1 because the two mean opposite things to whoever reads the
# result. A failed probe is a defect; an absent credential is an absent result,
# and the one thing it must never be recorded as is a pass.

set -uo pipefail

MODEL="${1:-}"
if [[ -z "$MODEL" ]]; then
  echo "usage: $0 <model-id> [workdir]" >&2
  exit 3
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$REPO_ROOT/dist/cli.js"

if [[ ! -f "$CLI" ]]; then
  echo "error: $CLI is absent; run 'npm run build' first" >&2
  exit 3
fi

WORKDIR="${2:-$(mktemp -d "${TMPDIR:-/tmp}/live-probe.XXXXXX")}"
mkdir -p "$WORKDIR"
OWNED_WORKDIR=0
[[ -z "${2:-}" ]] && OWNED_WORKDIR=1

cleanup() {
  [[ $OWNED_WORKDIR -eq 1 ]] && rm -rf "$WORKDIR"
}
trap cleanup EXIT

PASS=0
FAIL=0

# Probes run in their own git repository. A live probe that wrote into the
# checkout would be indistinguishable from the agent doing something wrong.
( cd "$WORKDIR" && git init -q . 2>/dev/null )

say() { printf '  %-6s %-56s ' "$1" "$2"; }
ok() { PASS=$((PASS + 1)); printf 'PASS\n'; }
bad() {
  FAIL=$((FAIL + 1))
  printf 'FAIL\n'
  printf '         %s\n' "$1"
  [[ -n "${2:-}" ]] && sed 's/^/         | /' <<<"$(tail -n 6 "$2")"
}

# Each probe asserts several things at once, so a failure has to name which one.
# The first draft of this script reported "results or artifacts missing" for a
# conjunction of three conditions and sent me to reproduce the run by hand to
# find out which — the same unfalsifiable report the probes exist to catch.
WHY=""
require() {
  local desc="$1"; shift
  "$@" || WHY="${WHY:+$WHY; }$desc"
}
verdict() {
  if [[ -z "$WHY" ]]; then ok; else bad "$WHY" "${1:-}"; fi
  WHY=""
}

# A live probe runs against whatever the model decides to do, so every one of
# them is bounded. Before these caps a weak model looping on denied approvals
# spent 1.1M input tokens in a single probe, which is a bill rather than a
# result. The caps are generous against a model that is behaving and immediate
# against one that is not.
BOUNDS=(--max-turns 12 --max-wall-clock 4m)

run_cli() {
  ( cd "$WORKDIR" && node "$CLI" "$@" )
}

count() { grep -c -- "$1" "$2" 2>/dev/null || true; }

# Quiet about a file that is not there. An absent artifact is a result this script
# reports in its own words; grep announcing it on stderr lands in the middle of
# the report instead.
file_says() { grep -q -- "$2" "$1" 2>/dev/null; }

# ---------------------------------------------------------------------------
# L1 — a turn completes.
#
# The cheapest possible signal, and the one that fails first when a transport,
# credential, or model id is wrong. Everything after it assumes this works.
# ---------------------------------------------------------------------------
L1="$WORKDIR/l1.jsonl"
say L1 "a turn completes and stops cleanly"
run_cli prompt "Reply with exactly: PROBE OK" --headless --model "$MODEL" \
  "${BOUNDS[@]}" >"$L1" 2>&1
rc=$?
require "the CLI exited $rc" test "$rc" -eq 0
require "expected one message_stop, saw $(count '"type":"message_stop"' "$L1")" \
  test "$(count '"type":"message_stop"' "$L1")" = "1"

# Distinguished here rather than reported as a failure, and checked before the
# verdict so it costs one request instead of five. The probes below would each
# fail the same way for the same reason, and five red checks would describe a
# broken build rather than an unconfigured one.
#
# Both shapes have to be recognized: a provider that refuses to construct
# without its variable ("requires AZURE_OPENAI_API_KEY env var"), and one that
# constructs and is then rejected over the wire.
AUTHLESS='requires .{0,80}env var|no auth found|auth login|unauthor|forbidden|invalid.?(api.?)?key|expired token|credential|\b401\b|\b403\b|AccessDenied|could not (be )?authenticat|no api key|not logged in'
if [[ -n "$WHY" ]] && grep -qiE "$AUTHLESS" "$L1"; then
  printf 'SKIP\n'
  printf '         no usable credential for %s; certified nothing\n' "$MODEL"
  sed 's/^/         | /' <<<"$(grep -iE "$AUTHLESS" "$L1" | tail -n 2)"
  exit 4
fi
verdict "$L1"

# ---------------------------------------------------------------------------
# L2 — a tool call reaches the filesystem through the real containment path.
#
# Worth doing live because canonicalization is where the platform disagrees with
# the test suite: on macOS the workdir is under /tmp, which is a symlink to
# /private/tmp, so this exercises the symlink resolution WP-03 rewrote against a
# path the model chose rather than one a fixture constructed.
# ---------------------------------------------------------------------------
L2="$WORKDIR/l2.jsonl"
printf 'the probe word is albatross\n' >"$WORKDIR/note.txt"
say L2 "a tool call reads a real file through containment"
run_cli prompt "Read note.txt and reply with only the probe word." \
  --headless --model "$MODEL" --permission-mode workspace-write \
  "${BOUNDS[@]}" >"$L2" 2>&1
require "no read_file call was made" grep -q '"name":"read_file"' "$L2"
require "no tool result carried the file's contents" grep -q 'albatross' "$L2"
verdict "$L2"

# ---------------------------------------------------------------------------
# L3 — the approval transport survives being used twice.
#
# The probe that found the bug. Both answers are written in one go, which is what
# an orchestrator does, and the second question has to be answered by the second
# line rather than by nothing.
#
# The invariant is that every question asked produces a result, not that exactly
# two are asked. A first draft demanded two and failed against a model that
# looped to fifty-two, reporting a transport failure where there was only a
# model with poor discipline. Counting answers against questions is the property
# the bug actually violated — it asked twice and answered once — and it holds
# whatever the model does.
# ---------------------------------------------------------------------------
L3="$WORKDIR/l3.jsonl"
say L3 "every approval question asked gets answered"
printf 'n\ny\n' | ( cd "$WORKDIR" && node "$CLI" prompt \
  "Run 'echo FIRST' with the shell. It may be denied; that is fine. Regardless, you MUST then run 'echo SECOND' with the shell as a separate call." \
  --headless --model "$MODEL" --permission-mode workspace-write "${BOUNDS[@]}" ) >"$L3" 2>&1
asks="$(count '"type":"permission_required"' "$L3")"
results="$(count '"type":"tool_result"' "$L3")"
stops="$(count '"type":"message_stop"' "$L3")"
require "asked $asks times, wanted at least twice to exercise a reused reader" \
  test "$asks" -ge 2
require "asked $asks times but only $results results came back" \
  test "$asks" -eq "$results"
require "expected one message_stop, saw $stops" test "$stops" -eq 1
require "the answered 'n' did not deny anything" grep -q 'denied bash' "$L3"
require "the answered 'y' never ran; the second line was lost" \
  grep -q '"content":"SECOND"' "$L3"
verdict "$L3"

# ---------------------------------------------------------------------------
# L4 — a multi-agent run reaches its results file intact.
#
# Covers what no single-agent probe can: real worker subprocesses through the
# broker, task claims and terminal transitions, and the durable results writer.
# The assertions are on the artifacts rather than on the summary line, because
# the summary is written by the same process that would be wrong.
# ---------------------------------------------------------------------------
L4="$WORKDIR/l4.log"
RESULTS="$WORKDIR/results.jsonl"
cat >"$WORKDIR/tasks.jsonl" <<'TASKS'
{"id":"p1","prompt":"Write a file called alpha.txt containing exactly the word ALPHA. Then reply DONE.","branchPolicy":{"kind":"none"},"commitPolicy":{"kind":"none"},"escalationPolicy":{"kind":"none"}}
{"id":"p2","prompt":"Write a file called beta.txt containing exactly the word BETA. Then reply DONE.","branchPolicy":{"kind":"none"},"commitPolicy":{"kind":"none"},"escalationPolicy":{"kind":"none"}}
TASKS
say L4 "two live workers land two results and two files"
run_cli swarm run tasks.jsonl --concurrency 2 --output "$RESULTS" \
  --model "$MODEL" --permission-mode workspace-write "${BOUNDS[@]}" >"$L4" 2>&1
require "wanted two succeeded results, saw $(count '"status":"succeeded"' "$RESULTS")" \
  test "$(count '"status":"succeeded"' "$RESULTS")" = "2"
# Checked separately from the status above, because a task reports succeeded when
# its loop ended, which is not the same as the work having happened.
require "alpha.txt is absent or does not say ALPHA" file_says "$WORKDIR/alpha.txt" ALPHA
require "beta.txt is absent or does not say BETA" file_says "$WORKDIR/beta.txt" BETA
verdict "$L4"

# ---------------------------------------------------------------------------
# L5 — the writers produced records that parse, ending on a line boundary.
#
# A torn trailing line is how a durability bug presents to whoever reads these
# files, and it cannot happen in a fixture that writes one record. This reads
# what a live run actually left behind.
# ---------------------------------------------------------------------------
say L5 "every written record parses and the file ends whole"
require "the results file is empty or absent" test -s "$RESULTS"
if [[ -n "$WHY" ]]; then verdict; else
if node -e '
  const fs = require("node:fs");
  const raw = fs.readFileSync(process.argv[1], "utf8");
  if (!raw.endsWith("\n")) { console.error("file does not end on a line boundary"); process.exit(1); }
  const lines = raw.split("\n").filter((l) => l !== "");
  for (const [i, l] of lines.entries()) {
    try { JSON.parse(l); } catch { console.error(`line ${i + 1} does not parse`); process.exit(1); }
  }
  if (lines.length === 0) { console.error("no records"); process.exit(1); }
' "$RESULTS" 2>"$WORKDIR/l5.log"; then
  ok
else
  bad "the results file is torn or unparseable" "$WORKDIR/l5.log"
fi
fi

# ---------------------------------------------------------------------------
# L6 — a session resumes in a second process, and remembers.
#
# Two processes, because that is the claim: state written by one run is picked up
# by the next. An in-process fixture can assert the journal round-trips and still
# tell us nothing about whether the CLI resolves the session, hands the snapshot
# to an engine that accepts it, and keeps appending to the same journal.
#
# The first version of this seam passed its type check and every unit test while
# nesting the payload one level too deep, which surfaced only here, on a real
# second turn (docs/63 WP-08).
# ---------------------------------------------------------------------------
L6A="$WORKDIR/l6a.jsonl"
L6B="$WORKDIR/l6b.jsonl"
RESUME_DIR="$WORKDIR/resume"
mkdir -p "$RESUME_DIR"
( cd "$RESUME_DIR" && git init -q . 2>/dev/null )
say L6 "a second process resumes the session and recalls it"
(
  cd "$RESUME_DIR" &&
    OPENSWARM_SESSION_STORE=unencrypted-durable node "$CLI" prompt \
      "My favourite bird is the GANNET. Reply with just: OK" \
      --headless --model "$MODEL" "${BOUNDS[@]}"
) >"$L6A" 2>&1
(
  cd "$RESUME_DIR" &&
    OPENSWARM_SESSION_STORE=unencrypted-durable node "$CLI" prompt \
      "What is my favourite bird? Reply with just the bird name." \
      --headless --model "$MODEL" --resume latest "${BOUNDS[@]}"
) >"$L6B" 2>&1
JOURNAL="$(find "$RESUME_DIR/.openswarm/sessions" -name journal.jsonl 2>/dev/null | head -1)"
require "the first run recorded no journal" test -n "$JOURNAL"
require "the resumed run did not complete" \
  test "$(count '"type":"message_stop"' "$L6B")" = "1"

# What this asserts is that *we* delivered the history, not that the model
# remembered it. An earlier version failed against a model that was handed the
# whole first turn and still answered "Condor", which is a fact about the model
# and not about resume; the same model answered correctly on the next run. The
# journal accumulating a second turn over a longer message list, and the resumed
# request costing more input tokens than the fresh one, are the parts this
# codebase is responsible for and they hold whatever the model says.
if [[ -n "$JOURNAL" ]]; then
  require "the journal did not accumulate a second turn over a longer history" \
    node -e '
      const fs = require("node:fs");
      const records = fs.readFileSync(process.argv[1], "utf8").trim().split("\n")
        .map((l) => JSON.parse(l))
        .filter((r) => r.type === "EngineStateRecorded");
      if (records.length < 2) { console.error(`only ${records.length} state records`); process.exit(1); }
      const first = records[0].payload.data, last = records[records.length - 1].payload.data;
      if (!(last.turnCount > first.turnCount)) { console.error("turn count did not advance"); process.exit(1); }
      if (!(last.messages.length > first.messages.length)) { console.error("history did not grow"); process.exit(1); }
      if (records.some((r) => r.payload.engineId !== records[0].payload.engineId)) {
        console.error("engine id changed between turns"); process.exit(1);
      }
    ' "$JOURNAL"
fi

tokens_of() { rg -o '"inputTokens":[0-9]+' "$1" | tail -1 | grep -o '[0-9]*'; }
fresh_tokens="$(tokens_of "$L6A")"
resumed_tokens="$(tokens_of "$L6B")"
require "resumed prompt was not larger than the fresh one ($resumed_tokens vs $fresh_tokens input tokens), so no history was sent" \
  test "${resumed_tokens:-0}" -gt "${fresh_tokens:-0}"
verdict "$L6B"

# Reported rather than asserted, for the reason above.
resumed_text="$(rg -o '"text":"[^"]*"' "$L6B" 2>/dev/null | sed 's/"text":"//;s/"$//' | tr -d '\n')"
if ! grep -qi 'GANNET' <<<"$resumed_text"; then
  printf '         note: %s did not recall the fact (said: %s)\n' "$MODEL" "${resumed_text:0:60}"
fi

printf '\n  %s: %d passed, %d failed\n' "$MODEL" "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
