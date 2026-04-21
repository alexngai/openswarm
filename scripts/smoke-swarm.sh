#!/usr/bin/env bash
# scripts/smoke-swarm.sh — M1 swarm acceptance-criteria gate.
#
# Usage:
#   ANTHROPIC_API_KEY=sk-ant-... ./scripts/smoke-swarm.sh       # full run
#   ./scripts/smoke-swarm.sh --offline                          # skip live tests
#
# Exits 0 if all tests pass, 1 otherwise.

set -uo pipefail

OFFLINE=false
[[ "${1:-}" == "--offline" ]] && OFFLINE=true

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BIN="node $REPO_ROOT/dist/cli.js"

PASS=0
FAIL=0
SKIP=0

record() {
  local status="$1" n="$2" label="$3"
  echo "[$n] $status - $label"
  case "$status" in
    PASS) PASS=$((PASS+1)) ;;
    FAIL) FAIL=$((FAIL+1)) ;;
    SKIP) SKIP=$((SKIP+1)) ;;
  esac
}

echo "→ building..."
npm run build > /dev/null

# ---------------------------------------------------------------------------
# [S1] Offline: `swarm run` with ScriptedTestEngine fixtures (no API).
#      Uses the integration-test fixture path to exercise the full orchestrator
#      + subprocess + IPC stack without live API calls.
# ---------------------------------------------------------------------------

SMOKE_DIR=$(mktemp -d)
cat > "$SMOKE_DIR/tasks.jsonl" <<'EOF'
{"id":"t1","prompt":"task one","branchPolicy":"main","commitPolicy":"never","escalationPolicy":"abort-on-error"}
{"id":"t2","prompt":"task two","branchPolicy":"main","commitPolicy":"never","escalationPolicy":"abort-on-error"}
{"id":"t3","prompt":"task three","branchPolicy":"main","commitPolicy:"never","escalationPolicy":"abort-on-error"}
EOF
# Note: embed a syntax error in tasks file so CLI input validation fires
# cleanly first — commented out; using the valid version below.
cat > "$SMOKE_DIR/tasks.jsonl" <<'EOF'
{"id":"t1","prompt":"task one","branchPolicy":"main","commitPolicy":"never","escalationPolicy":"abort-on-error"}
{"id":"t2","prompt":"task two","branchPolicy":"main","commitPolicy":"never","escalationPolicy":"abort-on-error"}
{"id":"t3","prompt":"task three","branchPolicy":"main","commitPolicy":"never","escalationPolicy":"abort-on-error"}
EOF

# Set the test-script env globally so the spawned workers pick it up.
export SWARM_CODER_TEST_SCRIPT="$REPO_ROOT/test/fixtures/worker-scripts/text-only.json"
EXIT_CODE=0
$BIN swarm run "$SMOKE_DIR/tasks.jsonl" --concurrency 2 --output "$SMOKE_DIR/results.jsonl" > /tmp/swc-swarm-offline.log 2>&1 || EXIT_CODE=$?
unset SWARM_CODER_TEST_SCRIPT

if [[ $EXIT_CODE -eq 0 ]] && [[ -f "$SMOKE_DIR/results.jsonl" ]]; then
  LINES=$(wc -l < "$SMOKE_DIR/results.jsonl" | tr -d ' ')
  if [[ "$LINES" == "3" ]]; then
    # Also verify every line is valid JSON with status=succeeded
    ALL_OK=true
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      if ! echo "$line" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); if (j.status !== "succeeded") process.exit(1);' 2>/dev/null; then
        ALL_OK=false
        break
      fi
    done < "$SMOKE_DIR/results.jsonl"
    if $ALL_OK; then
      record PASS S1 "swarm run (offline, 3 tasks, concurrency=2): results.jsonl has 3 succeeded lines"
    else
      record FAIL S1 "swarm run (offline): not all lines are status=succeeded"
    fi
  else
    record FAIL S1 "swarm run (offline): expected 3 result lines, got $LINES"
  fi
else
  record FAIL S1 "swarm run (offline) exit=$EXIT_CODE (see /tmp/swc-swarm-offline.log)"
fi
rm -rf "$SMOKE_DIR"

# ---------------------------------------------------------------------------
# [S2] Offline: concurrency cap honored under ScriptedTestEngine.
#      5 tasks, concurrency=2 → results.jsonl has 5 lines, no errors.
# ---------------------------------------------------------------------------

SMOKE_DIR=$(mktemp -d)
cat > "$SMOKE_DIR/tasks.jsonl" <<'EOF'
{"id":"t1","prompt":"a","branchPolicy":"main","commitPolicy":"never","escalationPolicy":"abort-on-error"}
{"id":"t2","prompt":"b","branchPolicy":"main","commitPolicy":"never","escalationPolicy":"abort-on-error"}
{"id":"t3","prompt":"c","branchPolicy":"main","commitPolicy":"never","escalationPolicy":"abort-on-error"}
{"id":"t4","prompt":"d","branchPolicy":"main","commitPolicy":"never","escalationPolicy":"abort-on-error"}
{"id":"t5","prompt":"e","branchPolicy":"main","commitPolicy":"never","escalationPolicy":"abort-on-error"}
EOF
export SWARM_CODER_TEST_SCRIPT="$REPO_ROOT/test/fixtures/worker-scripts/text-only.json"
EXIT_CODE=0
$BIN swarm run "$SMOKE_DIR/tasks.jsonl" --concurrency 2 --output "$SMOKE_DIR/results.jsonl" > /tmp/swc-swarm-concurrency.log 2>&1 || EXIT_CODE=$?
unset SWARM_CODER_TEST_SCRIPT

if [[ $EXIT_CODE -eq 0 ]] && [[ -f "$SMOKE_DIR/results.jsonl" ]]; then
  LINES=$(wc -l < "$SMOKE_DIR/results.jsonl" | tr -d ' ')
  if [[ "$LINES" == "5" ]]; then
    record PASS S2 "swarm run (offline, 5 tasks, concurrency=2): 5 succeeded lines"
  else
    record FAIL S2 "swarm run (offline, 5 tasks): expected 5 result lines, got $LINES"
  fi
else
  record FAIL S2 "swarm run (concurrency test) exit=$EXIT_CODE"
fi
rm -rf "$SMOKE_DIR"

# ---------------------------------------------------------------------------
# [S3] Live: 3 real tasks against Claude Max / Anthropic API.
#      Gated behind --offline.
# ---------------------------------------------------------------------------

if $OFFLINE; then
  record SKIP S3 "live swarm (offline mode)"
else
  # Check auth is available.
  if ! $BIN doctor > /dev/null 2>&1; then
    record FAIL S3 "no auth available (doctor failed); set ANTHROPIC_API_KEY or run 'claude auth login'"
  else
    SMOKE_DIR=$(mktemp -d)
    cat > "$SMOKE_DIR/tasks.jsonl" <<'EOF'
{"id":"live1","prompt":"Reply with exactly the word: alpha","branchPolicy":"main","commitPolicy":"never","escalationPolicy":"abort-on-error"}
{"id":"live2","prompt":"Reply with exactly the word: beta","branchPolicy":"main","commitPolicy":"never","escalationPolicy":"abort-on-error"}
{"id":"live3","prompt":"Reply with exactly the word: gamma","branchPolicy":"main","commitPolicy":"never","escalationPolicy":"abort-on-error"}
EOF
    EXIT_CODE=0
    $BIN swarm run "$SMOKE_DIR/tasks.jsonl" --concurrency 2 --output "$SMOKE_DIR/results.jsonl" > /tmp/swc-swarm-live.log 2>&1 || EXIT_CODE=$?

    if [[ $EXIT_CODE -eq 0 ]] && [[ -f "$SMOKE_DIR/results.jsonl" ]]; then
      LINES=$(wc -l < "$SMOKE_DIR/results.jsonl" | tr -d ' ')
      if [[ "$LINES" == "3" ]]; then
        # Verify every line parses and has status=succeeded
        ALL_OK=true
        while IFS= read -r line; do
          [[ -z "$line" ]] && continue
          if ! echo "$line" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); if (j.status !== "succeeded") process.exit(1);' 2>/dev/null; then
            ALL_OK=false
            break
          fi
        done < "$SMOKE_DIR/results.jsonl"
        if $ALL_OK; then
          record PASS S3 "live swarm (3 tasks against real API): all 3 succeeded"
        else
          record FAIL S3 "live swarm: not all result lines are status=succeeded (see /tmp/swc-swarm-live.log)"
        fi
      else
        record FAIL S3 "live swarm: expected 3 result lines, got $LINES (see /tmp/swc-swarm-live.log)"
      fi
    else
      record FAIL S3 "live swarm exit=$EXIT_CODE (see /tmp/swc-swarm-live.log)"
    fi
    rm -rf "$SMOKE_DIR"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo
echo "=== Summary ==="
echo "Passed:  $PASS"
echo "Failed:  $FAIL"
echo "Skipped: $SKIP"

if [[ $FAIL -gt 0 ]]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: PASS"
exit 0
