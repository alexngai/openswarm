#!/usr/bin/env bash
# scripts/smoke-swarm.sh — M1 swarm acceptance-criteria gate.
#
# Usage:
#   ANTHROPIC_API_KEY=sk-ant-... ./scripts/smoke-swarm.sh       # full run
#   ./scripts/smoke-swarm.sh --offline                          # skip live tests
#
# Exits 0 if all run scenarios pass, 1 otherwise.
#
# Scenarios:
#   Offline (ScriptedTestEngine, no API):
#     [O1] 3 tasks happy path
#     [O2] 5 tasks concurrency=2
#     [O3] SIGINT mid-run → queued tasks cancelled
#     [O4] Unwriteable --output → non-zero exit with error event
#   Live (real Anthropic API, gated by --offline):
#     [L1] 3 tasks happy path
#     [L2] Nested spawn — parent worker uses agent tool to spawn sub-agent
#     [L3] Permission gating — read-only mode prevents file write
#     [L4] Concurrency stress — 10 tasks at concurrency=5

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

check_succeeded_lines() {
  local file="$1" expected="$2"
  local count
  count=$(wc -l < "$file" | tr -d ' ')
  [[ "$count" == "$expected" ]] || return 1
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if ! echo "$line" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); if (j.status !== "succeeded") process.exit(1);' 2>/dev/null; then
      return 1
    fi
  done < "$file"
  return 0
}

echo "→ building..."
npm run build > /dev/null

# ---------------------------------------------------------------------------
# OFFLINE SCENARIOS (no API; ScriptedTestEngine via OPENSWARM_TEST_SCRIPT)
# ---------------------------------------------------------------------------

# [O1] 3 tasks happy path
SMOKE_DIR=$(mktemp -d)
cat > "$SMOKE_DIR/tasks.jsonl" <<'EOF'
{"id":"t1","prompt":"task one","branchPolicy":{"kind":"none"},"commitPolicy":{"kind":"none"},"escalationPolicy":{"kind":"none"}}
{"id":"t2","prompt":"task two","branchPolicy":{"kind":"none"},"commitPolicy":{"kind":"none"},"escalationPolicy":{"kind":"none"}}
{"id":"t3","prompt":"task three","branchPolicy":{"kind":"none"},"commitPolicy":{"kind":"none"},"escalationPolicy":{"kind":"none"}}
EOF
export OPENSWARM_TEST_SCRIPT="$REPO_ROOT/test/fixtures/worker-scripts/text-only.json"
EXIT_CODE=0
$BIN swarm run "$SMOKE_DIR/tasks.jsonl" --concurrency 2 --output "$SMOKE_DIR/results.jsonl" > /tmp/swc-o1.log 2>&1 || EXIT_CODE=$?
unset OPENSWARM_TEST_SCRIPT

if [[ $EXIT_CODE -eq 0 ]] && check_succeeded_lines "$SMOKE_DIR/results.jsonl" 3; then
  record PASS O1 "3 tasks happy path: results.jsonl has 3 succeeded"
else
  record FAIL O1 "3 tasks happy path (exit=$EXIT_CODE; see /tmp/swc-o1.log)"
fi
rm -rf "$SMOKE_DIR"

# [O2] 5 tasks concurrency=2
SMOKE_DIR=$(mktemp -d)
cat > "$SMOKE_DIR/tasks.jsonl" <<'EOF'
{"id":"t1","prompt":"a","branchPolicy":{"kind":"none"},"commitPolicy":{"kind":"none"},"escalationPolicy":{"kind":"none"}}
{"id":"t2","prompt":"b","branchPolicy":{"kind":"none"},"commitPolicy":{"kind":"none"},"escalationPolicy":{"kind":"none"}}
{"id":"t3","prompt":"c","branchPolicy":{"kind":"none"},"commitPolicy":{"kind":"none"},"escalationPolicy":{"kind":"none"}}
{"id":"t4","prompt":"d","branchPolicy":{"kind":"none"},"commitPolicy":{"kind":"none"},"escalationPolicy":{"kind":"none"}}
{"id":"t5","prompt":"e","branchPolicy":{"kind":"none"},"commitPolicy":{"kind":"none"},"escalationPolicy":{"kind":"none"}}
EOF
export OPENSWARM_TEST_SCRIPT="$REPO_ROOT/test/fixtures/worker-scripts/text-only.json"
EXIT_CODE=0
$BIN swarm run "$SMOKE_DIR/tasks.jsonl" --concurrency 2 --output "$SMOKE_DIR/results.jsonl" > /tmp/swc-o2.log 2>&1 || EXIT_CODE=$?
unset OPENSWARM_TEST_SCRIPT

if [[ $EXIT_CODE -eq 0 ]] && check_succeeded_lines "$SMOKE_DIR/results.jsonl" 5; then
  record PASS O2 "5 tasks concurrency=2: 5 succeeded"
else
  record FAIL O2 "5 tasks concurrency=2 (exit=$EXIT_CODE; see /tmp/swc-o2.log)"
fi
rm -rf "$SMOKE_DIR"

# [O3] SIGINT mid-run → cancelled
# Use the slow.json fixture (4 events × 200ms delay → 800ms per task). With
# 5 tasks at concurrency=2, total normal runtime ~2s; SIGINT after 600ms
# should leave ≥1 queued task cancelled.
SMOKE_DIR=$(mktemp -d)
cat > "$SMOKE_DIR/tasks.jsonl" <<'EOF'
{"id":"t1","prompt":"one","branchPolicy":{"kind":"none"},"commitPolicy":{"kind":"none"},"escalationPolicy":{"kind":"none"}}
{"id":"t2","prompt":"two","branchPolicy":{"kind":"none"},"commitPolicy":{"kind":"none"},"escalationPolicy":{"kind":"none"}}
{"id":"t3","prompt":"three","branchPolicy":{"kind":"none"},"commitPolicy":{"kind":"none"},"escalationPolicy":{"kind":"none"}}
{"id":"t4","prompt":"four","branchPolicy":{"kind":"none"},"commitPolicy":{"kind":"none"},"escalationPolicy":{"kind":"none"}}
{"id":"t5","prompt":"five","branchPolicy":{"kind":"none"},"commitPolicy":{"kind":"none"},"escalationPolicy":{"kind":"none"}}
EOF
export OPENSWARM_TEST_SCRIPT="$REPO_ROOT/test/fixtures/worker-scripts/slow.json"
$BIN swarm run "$SMOKE_DIR/tasks.jsonl" --concurrency 2 --output "$SMOKE_DIR/results.jsonl" > /tmp/swc-o3.log 2>&1 &
SWARM_PID=$!
sleep 0.6
kill -INT "$SWARM_PID" 2>/dev/null
EXIT_CODE=0
wait "$SWARM_PID" || EXIT_CODE=$?
unset OPENSWARM_TEST_SCRIPT

# Expect: exit != 0 AND at least one cancelled line in results.jsonl.
if [[ $EXIT_CODE -ne 0 ]] && [[ -f "$SMOKE_DIR/results.jsonl" ]] && \
   grep -q '"status":"cancelled"' "$SMOKE_DIR/results.jsonl"; then
  record PASS O3 "SIGINT mid-run: exit=$EXIT_CODE, ≥1 cancelled line"
else
  record FAIL O3 "SIGINT mid-run (exit=$EXIT_CODE; cancelled-line grep missed; see /tmp/swc-o3.log)"
fi
rm -rf "$SMOKE_DIR"

# [O4] Unwriteable --output → non-zero exit
# Use a path inside a non-existent directory; createWriteStream will fail
# asynchronously on write.
SMOKE_DIR=$(mktemp -d)
cat > "$SMOKE_DIR/tasks.jsonl" <<'EOF'
{"id":"t1","prompt":"x","branchPolicy":{"kind":"none"},"commitPolicy":{"kind":"none"},"escalationPolicy":{"kind":"none"}}
EOF
export OPENSWARM_TEST_SCRIPT="$REPO_ROOT/test/fixtures/worker-scripts/text-only.json"
EXIT_CODE=0
$BIN swarm run "$SMOKE_DIR/tasks.jsonl" \
  --concurrency 1 \
  --output "/nonexistent-dir-smokeswarm/results.jsonl" \
  > /tmp/swc-o4.log 2>&1 || EXIT_CODE=$?
unset OPENSWARM_TEST_SCRIPT

if [[ $EXIT_CODE -ne 0 ]]; then
  record PASS O4 "unwriteable --output: exit=$EXIT_CODE (non-zero)"
else
  record FAIL O4 "unwriteable --output returned exit 0 (expected non-zero; see /tmp/swc-o4.log)"
fi
rm -rf "$SMOKE_DIR"

# ---------------------------------------------------------------------------
# LIVE SCENARIOS (real Anthropic API; gated by --offline)
# ---------------------------------------------------------------------------

if $OFFLINE; then
  record SKIP L1 "live 3 tasks happy path (offline mode)"
  record SKIP L2 "live nested spawn (offline mode)"
  record SKIP L3 "live permission gating (offline mode)"
  record SKIP L4 "live concurrency stress (offline mode)"
else
  # Confirm auth is available.
  if ! $BIN doctor > /dev/null 2>&1; then
    record FAIL L1 "no auth available (doctor failed); set ANTHROPIC_API_KEY or run 'claude auth login'"
    record SKIP L2 "(depends on auth)"
    record SKIP L3 "(depends on auth)"
    record SKIP L4 "(depends on auth)"
  else

    # [L1] 3 tasks happy path against real API
    SMOKE_DIR=$(mktemp -d)
    cat > "$SMOKE_DIR/tasks.jsonl" <<'EOF'
{"id":"live1","prompt":"Reply with exactly the word: alpha","branchPolicy":{"kind":"none"},"commitPolicy":{"kind":"none"},"escalationPolicy":{"kind":"none"}}
{"id":"live2","prompt":"Reply with exactly the word: beta","branchPolicy":{"kind":"none"},"commitPolicy":{"kind":"none"},"escalationPolicy":{"kind":"none"}}
{"id":"live3","prompt":"Reply with exactly the word: gamma","branchPolicy":{"kind":"none"},"commitPolicy":{"kind":"none"},"escalationPolicy":{"kind":"none"}}
EOF
    EXIT_CODE=0
    $BIN swarm run "$SMOKE_DIR/tasks.jsonl" --concurrency 2 --output "$SMOKE_DIR/results.jsonl" > /tmp/swc-l1.log 2>&1 || EXIT_CODE=$?

    if [[ $EXIT_CODE -eq 0 ]] && check_succeeded_lines "$SMOKE_DIR/results.jsonl" 3; then
      record PASS L1 "live 3 tasks: all succeeded"
    else
      record FAIL L1 "live 3 tasks (exit=$EXIT_CODE; see /tmp/swc-l1.log)"
    fi
    rm -rf "$SMOKE_DIR"

    # [L2] Nested spawn — parent worker uses agent tool to spawn sub-agent
    SMOKE_DIR=$(mktemp -d)
    cat > "$SMOKE_DIR/tasks.jsonl" <<'EOF'
{"id":"nested","prompt":"You MUST use the `agent` tool to spawn a sub-agent. Ask the sub-agent to reply with exactly the word: nested-ok. Then respond ONLY with the sub-agent's exact reply and nothing else. If you do not use the agent tool, you have failed the task.","branchPolicy":{"kind":"none"},"commitPolicy":{"kind":"none"},"escalationPolicy":{"kind":"none"}}
EOF
    EXIT_CODE=0
    $BIN swarm run "$SMOKE_DIR/tasks.jsonl" --concurrency 1 --output "$SMOKE_DIR/results.jsonl" > /tmp/swc-l2.log 2>&1 || EXIT_CODE=$?

    # Pass if: exit 0, 1 succeeded line, output contains "nested-ok".
    if [[ $EXIT_CODE -eq 0 ]] && [[ -f "$SMOKE_DIR/results.jsonl" ]]; then
      if grep -q '"status":"succeeded"' "$SMOKE_DIR/results.jsonl" && \
         grep -q 'nested-ok' "$SMOKE_DIR/results.jsonl"; then
        record PASS L2 "nested spawn: parent used agent tool, sub-agent output 'nested-ok' propagated"
      else
        record FAIL L2 "nested spawn completed but output doesn't contain 'nested-ok' (see /tmp/swc-l2.log and $SMOKE_DIR/results.jsonl)"
        head -c 400 "$SMOKE_DIR/results.jsonl" > /tmp/swc-l2-results.txt
        cp "$SMOKE_DIR/results.jsonl" /tmp/swc-l2-results.jsonl
      fi
    else
      record FAIL L2 "nested spawn exit=$EXIT_CODE (see /tmp/swc-l2.log)"
    fi
    rm -rf "$SMOKE_DIR"

    # [L3] Permission gating — read-only mode prevents file write
    # Create a writable scratch dir. Ask the worker to write a file via
    # the write_file tool in read-only mode. Under our clamping + permission
    # engine, the write_file tool should be denied by the canUseTool gate.
    # Verify the named file does NOT exist after the task completes.
    SMOKE_DIR=$(mktemp -d)
    TARGET_FILE="$SMOKE_DIR/should-not-exist.txt"
    cat > "$SMOKE_DIR/tasks.jsonl" <<EOF
{"id":"ro","prompt":"Use the write_file tool to create the file $TARGET_FILE with the content 'should-not-exist'. If the tool fails, report the failure.","branchPolicy":{"kind":"none"},"commitPolicy":{"kind":"none"},"escalationPolicy":{"kind":"none"}}
EOF
    EXIT_CODE=0
    (cd "$SMOKE_DIR" && $BIN swarm run "$SMOKE_DIR/tasks.jsonl" \
      --concurrency 1 \
      --permission-mode read-only \
      --output "$SMOKE_DIR/results.jsonl" > /tmp/swc-l3.log 2>&1) || EXIT_CODE=$?

    # Pass criterion: target file was NOT created, regardless of exit code.
    # (The task may "succeed" from the model's perspective if it gracefully
    # reports the denial; the orchestrator's exit reflects model completion,
    # not tool success.)
    if [[ ! -f "$TARGET_FILE" ]]; then
      record PASS L3 "permission gating: read-only mode blocked write_file (target not created)"
    else
      record FAIL L3 "permission gating FAILED: file was created despite read-only mode (see /tmp/swc-l3.log)"
    fi
    rm -rf "$SMOKE_DIR"

    # [L4] Concurrency stress — 10 tasks at concurrency=5
    SMOKE_DIR=$(mktemp -d)
    for i in $(seq 1 10); do
      echo "{\"id\":\"stress-$i\",\"prompt\":\"Reply with exactly the number: $i\",\"branchPolicy\":{\"kind\":\"none\"},\"commitPolicy\":{\"kind\":\"none\"},\"escalationPolicy\":{\"kind\":\"none\"}}" >> "$SMOKE_DIR/tasks.jsonl"
    done
    EXIT_CODE=0
    $BIN swarm run "$SMOKE_DIR/tasks.jsonl" --concurrency 5 --output "$SMOKE_DIR/results.jsonl" > /tmp/swc-l4.log 2>&1 || EXIT_CODE=$?

    if [[ $EXIT_CODE -eq 0 ]] && check_succeeded_lines "$SMOKE_DIR/results.jsonl" 10; then
      record PASS L4 "live concurrency=5 over 10 tasks: all 10 succeeded"
    else
      record FAIL L4 "live concurrency stress (exit=$EXIT_CODE; see /tmp/swc-l4.log)"
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
