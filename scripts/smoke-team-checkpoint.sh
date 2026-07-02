#!/usr/bin/env bash
# scripts/smoke-team-checkpoint.sh — team crash-recovery T1 live smoke.
#
# Verifies, end-to-end with REAL worker subprocesses, that a team daemon which
# crashes mid-topology resumes from `checkpoint.json` on restart: already-
# succeeded members are skipped (not re-spawned), the rest re-run.
#
# Live but deterministic: workers use the repo's ScriptedTestEngine (via
# OPENSWARM_TEST_SCRIPT) so no model/API auth is required. Each worker emits a
# text line + a delayed message_stop so the daemon can be killed mid-run.
#
# Flow: 3-member fanout (daemon runs concurrency=1 → sequential). Start daemon,
# wait until member 1 completes (checkpoint has 1 succeeded unit), kill -9 the
# daemon (simulate crash), restart with the SAME spec/paths, wait for the team
# to finish (3 units), then assert the events log shows a resume + skip.
#
# Usage:
#   ./scripts/smoke-team-checkpoint.sh
#   ./scripts/smoke-team-checkpoint.sh --help

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
TEAM_NAME="cp-smoke-$$"
TEAM_DIR="$RUNTIME_DIR/openswarm/teams/$TEAM_NAME"
mkdir -p "$TEAM_DIR"

SPEC="$TEAM_DIR/spec.json"
PID_FILE="$TEAM_DIR/daemon.pid"
EVENTS="$TEAM_DIR/events.jsonl"
STATE="$TEAM_DIR/state.json"
CHECKPOINT="$TEAM_DIR/checkpoint.json"
SCRIPT_FIXTURE="$TEAM_DIR/worker-script.json"
LOG="$TEAM_DIR/daemon.log"

SOCK=$(node -e "
const { computeTeamPaths } = require('$REPO_ROOT/dist/cli/team-paths.js');
process.stdout.write(computeTeamPaths('$TEAM_NAME').sockPath);
")

# Worker fixture: emit a line, then stop after a delay so the daemon can be
# killed mid-topology. ~2s per member; concurrency=1 → members finish ~2s apart.
cat > "$SCRIPT_FIXTURE" <<'EOF'
[
  { "event": { "type": "text_delta", "text": "member done" } },
  { "delayMs": 2000, "event": { "type": "message_stop", "stopReason": "end_turn", "usage": { "inputTokens": 1, "outputTokens": 1 } } }
]
EOF

cat > "$SPEC" <<EOF
{
  "name": "$TEAM_NAME",
  "topology": "fanout",
  "members": [
    { "id": "c1", "role": "executor", "prompt": "p1", "branchPolicy": { "kind": "none" }, "commitPolicy": { "kind": "none" }, "escalationPolicy": { "kind": "none" } },
    { "id": "c2", "role": "executor", "prompt": "p2", "branchPolicy": { "kind": "none" }, "commitPolicy": { "kind": "none" }, "escalationPolicy": { "kind": "none" } },
    { "id": "c3", "role": "executor", "prompt": "p3", "branchPolicy": { "kind": "none" }, "commitPolicy": { "kind": "none" }, "escalationPolicy": { "kind": "none" } }
  ],
  "coordination": { "completion": { "kind": "all" } }
}
EOF

cleanup() {
  if [[ -f "$PID_FILE" ]]; then
    local pid; pid=$(cat "$PID_FILE" 2>/dev/null || true)
    [[ -n "$pid" ]] && kill -9 "$pid" 2>/dev/null || true
  fi
  rm -rf "$RUNTIME_DIR"
}
trap cleanup EXIT

# Count succeeded units in checkpoint.json (0 if missing/unreadable).
succeeded_units() {
  node -e "
    const fs=require('fs');
    try {
      const d=JSON.parse(fs.readFileSync('$CHECKPOINT','utf8'));
      const n=(d.units||[]).filter(u=>u.status==='succeeded').length;
      process.stdout.write(String(n));
    } catch { process.stdout.write('0'); }
  "
}

start_daemon() {
  OPENSWARM_DAEMON_SPEC="$SPEC" \
  OPENSWARM_DAEMON_SOCK="$SOCK" \
  OPENSWARM_DAEMON_PID="$PID_FILE" \
  OPENSWARM_DAEMON_EVENTS="$EVENTS" \
  OPENSWARM_DAEMON_STATE="$STATE" \
  OPENSWARM_DAEMON_CHECKPOINT="$CHECKPOINT" \
  OPENSWARM_TEST_SCRIPT="$SCRIPT_FIXTURE" \
    $BIN --team-daemon >> "$LOG" 2>&1 &
  for i in $(seq 1 40); do [[ -S "$SOCK" ]] && return 0; sleep 0.25; done
  echo "[fail] daemon did not bind socket"; cat "$LOG" | head -40; exit 1
}

# ---------------------------------------------------------------------------
# Run 1 — start, let member c1 finish, then crash.
# ---------------------------------------------------------------------------
echo "→ run 1: starting daemon..."
start_daemon
DAEMON1_PID=$(cat "$PID_FILE")
echo "✓ daemon 1 bound (pid $DAEMON1_PID)"

echo "→ waiting for first member to complete..."
FIRST=0
for i in $(seq 1 60); do
  FIRST=$(succeeded_units)
  if [[ "$FIRST" -ge 1 ]]; then break; fi
  sleep 0.25
done
if [[ "$FIRST" -lt 1 ]]; then
  echo "[fail] no member completed within 15s"; cat "$LOG" | head -40; exit 1
fi
echo "✓ checkpoint recorded $FIRST succeeded unit(s) before crash"
if [[ "$FIRST" -ge 3 ]]; then
  echo "[warn] all members finished before crash — increase delayMs to test resume"
fi

echo "→ simulating crash (kill -9 $DAEMON1_PID)..."
kill -9 "$DAEMON1_PID" 2>/dev/null || true
for i in $(seq 1 20); do kill -0 "$DAEMON1_PID" 2>/dev/null || break; sleep 0.25; done
if kill -0 "$DAEMON1_PID" 2>/dev/null; then echo "[fail] daemon 1 still alive"; exit 1; fi
echo "✓ daemon 1 killed"

# Mark a boundary in the events log so we can scope resume assertions to run 2.
RUN1_EVENT_LINES=$(wc -l < "$EVENTS" 2>/dev/null | tr -d ' ')
RUN1_EVENT_LINES=${RUN1_EVENT_LINES:-0}

# ---------------------------------------------------------------------------
# Run 2 — restart with same spec/paths → should resume from checkpoint.
# ---------------------------------------------------------------------------
echo "→ run 2: restarting daemon (same spec + checkpoint)..."
start_daemon
DAEMON2_PID=$(cat "$PID_FILE")
echo "✓ daemon 2 bound (pid $DAEMON2_PID)"

echo "→ waiting for team to finish (3 units)..."
FINAL=0
for i in $(seq 1 80); do
  FINAL=$(succeeded_units)
  if [[ "$FINAL" -ge 3 ]]; then break; fi
  sleep 0.25
done
if [[ "$FINAL" -lt 3 ]]; then
  echo "[fail] team did not reach 3 succeeded units after resume (got $FINAL)"
  cat "$LOG" | tail -40; exit 1
fi
echo "✓ all 3 members succeeded after resume"

# Scope to run-2 events (lines appended after the crash boundary).
RUN2_EVENTS=$(tail -n "+$((RUN1_EVENT_LINES + 1))" "$EVENTS" 2>/dev/null || true)

if ! echo "$RUN2_EVENTS" | grep -q "resuming from checkpoint"; then
  echo "[fail] run 2 did not emit a 'resuming from checkpoint' note"
  echo "--- run2 events ---"; echo "$RUN2_EVENTS" | head -40; exit 1
fi
echo "✓ run 2 emitted resume note"

if ! echo "$RUN2_EVENTS" | grep -q "skipped (resumed from checkpoint)"; then
  echo "[fail] run 2 did not skip any previously-succeeded member"
  echo "--- run2 events ---"; echo "$RUN2_EVENTS" | head -40; exit 1
fi
SKIP_COUNT=$(echo "$RUN2_EVENTS" | grep -c "skipped (resumed from checkpoint)")
echo "✓ run 2 skipped $SKIP_COUNT previously-succeeded member(s) (expected ~$FIRST)"

echo "→ stopping daemon..."
$BIN team stop "$TEAM_NAME" > /dev/null 2>&1 || true
for i in $(seq 1 20); do kill -0 "$DAEMON2_PID" 2>/dev/null || break; sleep 0.25; done

echo
echo "RESULT: PASS"
echo "  Team crash-recovery T1 verified live: crashed daemon resumed from"
echo "  checkpoint.json, skipped $SKIP_COUNT completed member(s), finished the rest."
exit 0
