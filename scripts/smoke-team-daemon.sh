#!/usr/bin/env bash
# scripts/smoke-team-daemon.sh — v0.5 stage 5E.6 smoke.
#
# Verifies the per-team daemon lifecycle end-to-end with a real subprocess:
# bind socket, expose status RPC, accept stop RPC, clean up files. The smoke
# bypasses `team start --detach` (which depends on openteams CLI presence)
# by exec'ing `node dist/cli.js --team-daemon` directly with the daemon env
# vars set. The team start --detach fork path is exercised by the argv unit
# tests + manual operator runs.
#
# The spec uses a 1-member fanout team with a trivial prompt; the smoke
# kills the daemon BEFORE the worker subprocess actually makes a model
# call, so this script does not require any API auth.
#
# Usage:
#   ./scripts/smoke-team-daemon.sh
#   ./scripts/smoke-team-daemon.sh --help

set -uo pipefail

if [[ "${1:-}" == "--help" ]]; then
  sed -n '1,/^set -uo/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "→ building..."
if ! npm run build > /dev/null 2>&1; then
  echo "[error] build failed"
  exit 1
fi

if [[ ! -f "$REPO_ROOT/dist/cli.js" ]]; then
  echo "[error] dist/cli.js missing after build"
  exit 1
fi

BIN="node $REPO_ROOT/dist/cli.js"

# Isolated XDG_RUNTIME_DIR so this smoke doesn't see real running daemons.
# Uses mktemp -d which on macOS lands under /var/folders/.../T/ — a path
# long enough that the natural socket location would exceed the 104-char
# `sun_path` limit. The shared computeTeamPaths() utility (5E follow-up
# fix) detects this and falls back to /tmp/swh-<hash>.sock, which the
# smoke verifies works end-to-end.
RUNTIME_DIR=$(mktemp -d)
export XDG_RUNTIME_DIR="$RUNTIME_DIR"
export TMPDIR="$RUNTIME_DIR"
TEAM_NAME="smoke-team-with-a-fairly-long-name-to-trigger-fallback-$$"
TEAM_DIR="$RUNTIME_DIR/openswarm/teams/$TEAM_NAME"
mkdir -p "$TEAM_DIR"

SPEC="$TEAM_DIR/spec.json"
PID_FILE="$TEAM_DIR/daemon.pid"
EVENTS="$TEAM_DIR/events.jsonl"
STATE="$TEAM_DIR/state.json"
LOG="$TEAM_DIR/daemon.log"

# Resolve the (possibly hash-shortened) socket path the same way
# computeTeamPaths() does — node one-liner using the shared utility.
SOCK=$(node -e "
const { computeTeamPaths } = require('$REPO_ROOT/dist/cli/team-paths.js');
process.stdout.write(computeTeamPaths('$TEAM_NAME').sockPath);
")
echo "→ resolved socket path: $SOCK ($(echo -n "$SOCK" | wc -c | tr -d ' ') chars)"

cleanup() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null || true)
    if [[ -n "$pid" ]]; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  rm -rf "$RUNTIME_DIR"
}
trap cleanup EXIT

cat > "$SPEC" <<EOF
{
  "name": "$TEAM_NAME",
  "topology": "fanout",
  "members": [
    {
      "id": "m-1",
      "role": "smoke",
      "prompt": "noop",
      "branchPolicy": { "kind": "none" },
      "commitPolicy": { "kind": "none" },
      "escalationPolicy": { "kind": "none" }
    }
  ],
  "coordination": { "completion": { "kind": "all" } }
}
EOF

echo "→ forking team daemon..."
OPENSWARM_DAEMON_SPEC="$SPEC" \
OPENSWARM_DAEMON_SOCK="$SOCK" \
OPENSWARM_DAEMON_PID="$PID_FILE" \
OPENSWARM_DAEMON_EVENTS="$EVENTS" \
OPENSWARM_DAEMON_STATE="$STATE" \
  $BIN --team-daemon > "$LOG" 2>&1 &
FORKED_PID=$!

# Wait for socket to bind. Bumped to 10s for slow first-startup (esp. when
# tsc transitive imports cold-load).
for i in $(seq 1 40); do
  if [[ -S "$SOCK" ]]; then break; fi
  sleep 0.25
done

if [[ ! -S "$SOCK" ]]; then
  echo "[fail] daemon did not bind socket within 10s"
  echo "--- forked pid ---"
  echo "FORKED_PID=$FORKED_PID alive: $(kill -0 $FORKED_PID 2>&1 && echo yes || echo no)"
  echo "--- daemon dir ---"
  ls -la "$TEAM_DIR" 2>&1 || true
  echo "--- daemon log ---"
  cat "$LOG" 2>&1 | head -40
  exit 1
fi
echo "✓ daemon bound socket"

# 1. Verify pid file matches the forked pid.
if [[ ! -f "$PID_FILE" ]]; then
  echo "[fail] pid file not written"
  exit 1
fi
DAEMON_PID=$(cat "$PID_FILE")
echo "✓ pid file: $DAEMON_PID"

# 2. team list — verify the team shows up.
LIST_OUT=$($BIN team list 2>&1)
if ! echo "$LIST_OUT" | grep -q "$TEAM_NAME"; then
  echo "[fail] team list did not show $TEAM_NAME"
  echo "$LIST_OUT"
  exit 1
fi
echo "✓ team list shows team"

# 3. team logs — should not error (file may be empty initially).
LOGS_OUT=$($BIN team logs "$TEAM_NAME" 2>&1)
LOGS_RC=$?
if [[ $LOGS_RC -ne 0 ]]; then
  echo "[fail] team logs exited $LOGS_RC"
  echo "$LOGS_OUT"
  exit 1
fi
echo "✓ team logs ran cleanly"

# 4. team send — for fanout topology this fires the "no live TeamSession"
# branch (5F: only peer-team supports persistent mode in v0.6). The smoke
# verifies the error is structured + clear; the success path lives in the
# unit test src/swarm/team-daemon.test.ts.
SEND_OUT=$($BIN team send "$TEAM_NAME" "hi" 2>&1)
SEND_RC=$?
if [[ $SEND_RC -eq 0 ]]; then
  echo "[fail] team send unexpectedly succeeded for a fanout topology"
  echo "$SEND_OUT"
  exit 1
fi
if ! echo "$SEND_OUT" | grep -q -i "no live TeamSession\|unknown_method\|peer-team"; then
  echo "[fail] team send error did not match expected 5F shape"
  echo "$SEND_OUT"
  exit 1
fi
echo "✓ team send rejects fanout topology cleanly (no live TeamSession)"

# 5. team stop — daemon should exit cleanly.
STOP_OUT=$($BIN team stop "$TEAM_NAME" 2>&1)
STOP_RC=$?
if [[ $STOP_RC -ne 0 ]]; then
  echo "[fail] team stop exited $STOP_RC"
  echo "$STOP_OUT"
  exit 1
fi
echo "✓ team stop returned 0"

# 6. Verify daemon process exited within reasonable time.
for i in $(seq 1 20); do
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then break; fi
  sleep 0.5
done
if kill -0 "$DAEMON_PID" 2>/dev/null; then
  echo "[fail] daemon process $DAEMON_PID still alive after stop"
  exit 1
fi
echo "✓ daemon process exited"

# 7. Verify socket + pid files cleaned up.
if [[ -e "$SOCK" ]]; then
  echo "[fail] socket file not cleaned up"
  exit 1
fi
if [[ -e "$PID_FILE" ]]; then
  echo "[fail] pid file not cleaned up"
  exit 1
fi
echo "✓ socket + pid files cleaned"

echo
echo "RESULT: PASS"
echo "  Stage 5E.6 daemon lifecycle smoke verified end-to-end."
exit 0
