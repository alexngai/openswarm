#!/usr/bin/env bash
# scripts/smoke-team-checkpoint-t3.sh — team crash-recovery T3b live smoke
# (peer-team topology).
#
# T3b extends crash-recovery to the batch-spawn topologies (peer-team,
# committee). This smoke verifies, with REAL worker subprocesses, that a
# peer-team daemon which crashes WHILE a member is mid-flight resumes it on
# restart: the member is re-dispatched with a verify-then-continue preamble AND
# the worker resumes its prior engine session (per-unit sidecar) — exactly the
# fanout T2 guarantee, now proven for peer-team.
#
# Deterministic via the ScriptedTestEngine (OPENSWARM_TEST_SCRIPT) with
# OPENSWARM_TEST_ECHO_RESUME=1 — a resumed worker emits "RESUMED:<sessionId>"
# as its first output, which is the observable proof that session resume fired.
# No model/API auth required.
#
# Flow: 1-member peer-team. Worker emits a line (its engine session id is
# persisted to the per-unit sidecar immediately), then waits. We wait until the
# member is recorded in-flight AND its sidecar exists, kill -9 the daemon
# mid-flight, restart, and assert the member's recorded output contains
# "RESUMED:" plus the peer-team re-dispatch note.
#
# Usage:
#   ./scripts/smoke-team-checkpoint-t3.sh
#   ./scripts/smoke-team-checkpoint-t3.sh --help

set -uo pipefail

if [[ "${1:-}" == "--help" ]]; then
  sed -n '1,/^set -uo/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "→ building..."
if ! npm run build > /dev/null 2>&1; then
  echo "[error] build failed"; exit 1
fi
[[ -f "$REPO_ROOT/dist/cli.js" ]] || { echo "[error] dist/cli.js missing"; exit 1; }

BIN="node $REPO_ROOT/dist/cli.js"

RUNTIME_DIR=$(mktemp -d)
export XDG_RUNTIME_DIR="$RUNTIME_DIR"
export TMPDIR="$RUNTIME_DIR"
TEAM_NAME="cp3-smoke-$$"
TEAM_DIR="$RUNTIME_DIR/openswarm/teams/$TEAM_NAME"
mkdir -p "$TEAM_DIR"

SPEC="$TEAM_DIR/spec.json"
PID_FILE="$TEAM_DIR/daemon.pid"
EVENTS="$TEAM_DIR/events.jsonl"
STATE="$TEAM_DIR/state.json"
CHECKPOINT="$TEAM_DIR/checkpoint.json"
SIDECAR="$TEAM_DIR/sessions/m1.session"
SCRIPT_FIXTURE="$TEAM_DIR/worker-script.json"
LOG="$TEAM_DIR/daemon.log"

SOCK=$(node -e "
const { computeTeamPaths } = require('$REPO_ROOT/dist/cli/team-paths.js');
process.stdout.write(computeTeamPaths('$TEAM_NAME').sockPath);
")

# Emit a line immediately (worker persists its session id to the sidecar), then
# wait long enough to be killed mid-flight.
cat > "$SCRIPT_FIXTURE" <<'EOF'
[
  { "event": { "type": "text_delta", "text": "working on it" } },
  { "delayMs": 5000, "event": { "type": "message_stop", "stopReason": "end_turn", "usage": { "inputTokens": 1, "outputTokens": 1 } } }
]
EOF

cat > "$SPEC" <<EOF
{
  "name": "$TEAM_NAME",
  "topology": "peer-team",
  "members": [
    { "id": "m1", "role": "executor", "prompt": "do the thing", "branchPolicy": { "kind": "none" }, "commitPolicy": { "kind": "none" }, "escalationPolicy": { "kind": "none" } }
  ],
  "coordination": { "completion": { "kind": "all" } }
}
EOF

cleanup() {
  if [[ -f "$PID_FILE" ]]; then
    local pid; pid=$(cat "$PID_FILE" 2>/dev/null || true)
    [[ -n "$pid" ]] && kill -9 "$pid" 2>/dev/null || true
  fi
  # Best-effort: reap any orphaned worker from this isolated run.
  pkill -9 -f "OPENSWARM_TEST_SCRIPT=$SCRIPT_FIXTURE" 2>/dev/null || true
  rm -rf "$RUNTIME_DIR"
}
trap cleanup EXIT

inflight_units() {
  node -e "
    const fs=require('fs');
    try { const d=JSON.parse(fs.readFileSync('$CHECKPOINT','utf8'));
      process.stdout.write(String((d.inFlight||[]).length)); }
    catch { process.stdout.write('0'); }"
}
succeeded_units() {
  node -e "
    const fs=require('fs');
    try { const d=JSON.parse(fs.readFileSync('$CHECKPOINT','utf8'));
      process.stdout.write(String((d.units||[]).filter(u=>u.status==='succeeded').length)); }
    catch { process.stdout.write('0'); }"
}
m1_output() {
  node -e "
    const fs=require('fs');
    try { const d=JSON.parse(fs.readFileSync('$CHECKPOINT','utf8'));
      const u=(d.units||[]).find(u=>u.id==='m1');
      process.stdout.write(u&&u.output?u.output:''); }
    catch { process.stdout.write(''); }"
}

start_daemon() {
  OPENSWARM_DAEMON_SPEC="$SPEC" \
  OPENSWARM_DAEMON_SOCK="$SOCK" \
  OPENSWARM_DAEMON_PID="$PID_FILE" \
  OPENSWARM_DAEMON_EVENTS="$EVENTS" \
  OPENSWARM_DAEMON_STATE="$STATE" \
  OPENSWARM_DAEMON_CHECKPOINT="$CHECKPOINT" \
  OPENSWARM_TEST_SCRIPT="$SCRIPT_FIXTURE" \
  OPENSWARM_TEST_ECHO_RESUME="1" \
    $BIN --team-daemon >> "$LOG" 2>&1 &
  for i in $(seq 1 40); do [[ -S "$SOCK" ]] && return 0; sleep 0.25; done
  echo "[fail] daemon did not bind socket"; cat "$LOG" | head -40; exit 1
}

# --- Run 1: start, wait until m1 is in-flight + its session sidecar exists ---
echo "→ run 1: starting peer-team daemon..."
start_daemon
DAEMON1_PID=$(cat "$PID_FILE")
echo "✓ daemon 1 bound (pid $DAEMON1_PID)"

echo "→ waiting for m1 to be recorded in-flight with a persisted session..."
OK=0
for i in $(seq 1 60); do
  if [[ "$(inflight_units)" -ge 1 && -f "$SIDECAR" ]]; then OK=1; break; fi
  sleep 0.25
done
if [[ "$OK" -ne 1 ]]; then
  echo "[fail] m1 not in-flight with sidecar within 15s"
  echo "inFlight=$(inflight_units) sidecar=$([[ -f "$SIDECAR" ]] && echo yes || echo no)"
  cat "$LOG" | tail -30; exit 1
fi
echo "✓ m1 in-flight; session persisted to sidecar: $(cat "$SIDECAR" 2>/dev/null)"

echo "→ simulating crash mid-flight (kill -9 $DAEMON1_PID + orphan worker)..."
kill -9 "$DAEMON1_PID" 2>/dev/null || true
pkill -9 -f "OPENSWARM_TEST_SCRIPT=$SCRIPT_FIXTURE" 2>/dev/null || true
for i in $(seq 1 20); do kill -0 "$DAEMON1_PID" 2>/dev/null || break; sleep 0.25; done
kill -0 "$DAEMON1_PID" 2>/dev/null && { echo "[fail] daemon 1 still alive"; exit 1; }
echo "✓ daemon 1 killed"

RUN1_EVENT_LINES=$(wc -l < "$EVENTS" 2>/dev/null | tr -d ' '); RUN1_EVENT_LINES=${RUN1_EVENT_LINES:-0}

# --- Run 2: restart → m1 re-dispatched with preamble + session resume ---
echo "→ run 2: restarting daemon..."
start_daemon
DAEMON2_PID=$(cat "$PID_FILE")
echo "✓ daemon 2 bound (pid $DAEMON2_PID)"

echo "→ waiting for m1 to complete after resume..."
DONE=0
for i in $(seq 1 80); do
  if [[ "$(succeeded_units)" -ge 1 ]]; then DONE=1; break; fi
  sleep 0.25
done
if [[ "$DONE" -ne 1 ]]; then
  echo "[fail] m1 did not complete after resume"; cat "$LOG" | tail -30; exit 1
fi
echo "✓ m1 completed after resume"

RUN2_EVENTS=$(tail -n "+$((RUN1_EVENT_LINES + 1))" "$EVENTS" 2>/dev/null || true)
if ! echo "$RUN2_EVENTS" | grep -q "re-dispatched in-flight with verify-then-continue"; then
  echo "[fail] run 2 did not emit the peer-team in-flight re-dispatch note"
  echo "$RUN2_EVENTS" | head -40; exit 1
fi
echo "✓ run 2 re-dispatched the in-flight member with verify-then-continue note"

OUT=$(m1_output)
if [[ "$OUT" != *"RESUMED:"* ]]; then
  echo "[fail] m1 output does not show a resumed session (expected 'RESUMED:...')"
  echo "output: $OUT"; exit 1
fi
echo "✓ m1 resumed its prior engine session (output: $OUT)"

echo "→ stopping daemon..."
$BIN team stop "$TEAM_NAME" > /dev/null 2>&1 || true
for i in $(seq 1 20); do kill -0 "$DAEMON2_PID" 2>/dev/null || break; sleep 0.25; done

echo
echo "RESULT: PASS"
echo "  Team crash-recovery T3b verified live: a peer-team member crashed"
echo "  mid-flight was re-dispatched with a verify-then-continue preamble and"
echo "  resumed its prior engine session from the per-unit sidecar."
exit 0
