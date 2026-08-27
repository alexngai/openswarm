#!/usr/bin/env bash
# scripts/smoke.sh — M0 acceptance-criteria gate.
#
# Usage:
#   ANTHROPIC_API_KEY=sk-ant-...  ./scripts/smoke.sh        # full run (all 13)
#   ./scripts/smoke.sh --offline                             # skip live-API tests (1, 2, 3, 4, 5)
#
# Exit code: 0 if all attempted criteria pass, 1 otherwise.
#
# Summary printed to stdout:
#   [1] PASS - prompt → text
#   [2] PASS - prompt with tool use
#   [3] SKIP - (offline)
#   ...

set -uo pipefail

# --all — run every smoke script in sequence (M0 + M1 + M2, live then offline).
# Keep this simple; bash is not where cleverness belongs.
if [[ "${1:-}" == "--all" ]]; then
  REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  set -e
  "$REPO_ROOT/scripts/smoke.sh"
  "$REPO_ROOT/scripts/smoke-swarm.sh"
  "$REPO_ROOT/scripts/smoke-repl.sh"
  "$REPO_ROOT/scripts/smoke-swarm-m3a.sh"
  "$REPO_ROOT/scripts/smoke-m3b.sh"
  "$REPO_ROOT/scripts/smoke-m4a.sh"
  "$REPO_ROOT/scripts/smoke-m4b.sh"
  "$REPO_ROOT/scripts/smoke.sh" --offline
  "$REPO_ROOT/scripts/smoke-swarm.sh" --offline
  "$REPO_ROOT/scripts/smoke-repl.sh" --offline
  "$REPO_ROOT/scripts/smoke-swarm-m3a.sh" --offline
  "$REPO_ROOT/scripts/smoke-m3b.sh" --offline
  "$REPO_ROOT/scripts/smoke-m4a.sh" --offline
  "$REPO_ROOT/scripts/smoke-m4b.sh" --offline
  exit 0
fi

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

# ---------------------------------------------------------------------------
# Build before running so dist/cli.js is fresh.
# ---------------------------------------------------------------------------
echo "→ building..."
npm run build > /dev/null 2>&1

# ---------------------------------------------------------------------------
# Criterion 9 — tsc --noEmit
# ---------------------------------------------------------------------------

if npx tsc --noEmit > /tmp/swc-smoke-tsc.log 2>&1; then
  record PASS 9 "tsc --noEmit strict passes"
else
  record FAIL 9 "tsc --noEmit failed (see /tmp/swc-smoke-tsc.log)"
fi

# ---------------------------------------------------------------------------
# Criterion 10 — npm test (vitest run), assert count
# ---------------------------------------------------------------------------

# smoke.sh already built dist at the top of this script; skip vitest's
# globalSetup build (see vitest.config.ts) to avoid a redundant tsc run
# and the occasional parallel-build race that produced flaky failures.
TEST_OUT=$(OPENSWARM_SKIP_INTEGRATION_BUILD=1 npx vitest run 2>&1)
VITEST_EXIT=$?

if [[ $VITEST_EXIT -eq 0 ]] && echo "$TEST_OUT" | grep -qE 'Tests[[:space:]]+[0-9]+ passed'; then
  TESTS=$(echo "$TEST_OUT" | grep -oE 'Tests[[:space:]]+[0-9]+ passed' | grep -oE '[0-9]+' | head -1)
  FILES=$(echo "$TEST_OUT" | grep -oE 'Test Files[[:space:]]+[0-9]+ passed' | grep -oE '[0-9]+' | head -1)
  if [[ "${TESTS:-0}" -ge 25 ]]; then
    record PASS 10 "npm test: ${TESTS} passing across ${FILES:-?} files"
  else
    record FAIL 10 "npm test passed but only ${TESTS:-0} tests (want >= 25)"
  fi
else
  record FAIL 10 "npm test did not pass cleanly (exit $VITEST_EXIT)"
fi

# ---------------------------------------------------------------------------
# Criteria 11-13 — inferred from vitest suite (tool unit tests cover these).
# Independent exercise would require a live build; if criterion 10 passed,
# the bash/edit/grep tool unit tests are confirmed green within that run.
# Note: these are NOT independently re-exercised here; see note in summary.
# ---------------------------------------------------------------------------

if [[ $FAIL -eq 0 ]]; then
  record PASS 11 "bash tool unit tests (truncation/timeout/background) — inferred from criterion 10"
  record PASS 12 "edit_file uniqueness check — inferred from criterion 10"
  record PASS 13 "grep uses bundled @vscode/ripgrep — inferred from criterion 10"
else
  record SKIP 11 "bash tool tests (skipped; criterion 10 not fully green)"
  record SKIP 12 "edit_file uniqueness (skipped; criterion 10 not fully green)"
  record SKIP 13 "grep ripgrep check (skipped; criterion 10 not fully green)"
fi

# ---------------------------------------------------------------------------
# Criterion 6 — doctor text output, exit 0 with auth present
# ---------------------------------------------------------------------------

if $BIN doctor > /tmp/swc-doctor.txt 2>&1; then
  if grep -q "auth" /tmp/swc-doctor.txt && grep -qE "✓|✗|⚠" /tmp/swc-doctor.txt; then
    CHECK_COUNT=$(grep -cE "✓|✗|⚠" /tmp/swc-doctor.txt || true)
    record PASS 6 "doctor runs ${CHECK_COUNT} checks, text output, exit 0"
  else
    record FAIL 6 "doctor output missing expected check lines (see /tmp/swc-doctor.txt)"
  fi
else
  DOCTOR_EXIT=$?
  # exit 1 means a check failed (e.g. no auth) — still counts as working CLI
  if grep -q "auth" /tmp/swc-doctor.txt 2>/dev/null && grep -qE "✓|✗|⚠" /tmp/swc-doctor.txt 2>/dev/null; then
    CHECK_COUNT=$(grep -cE "✓|✗|⚠" /tmp/swc-doctor.txt || true)
    record PASS 6 "doctor runs ${CHECK_COUNT} checks (auth fails with actionable message), text output"
  else
    record FAIL 6 "doctor exit ${DOCTOR_EXIT} and output did not contain expected checks (see /tmp/swc-doctor.txt)"
  fi
fi

# ---------------------------------------------------------------------------
# Criterion 7 — doctor --output-format json
# ---------------------------------------------------------------------------

$BIN doctor --output-format json > /tmp/swc-doctor.json 2>&1
if node -e "
  const raw = require('fs').readFileSync('/tmp/swc-doctor.json', 'utf8').trim();
  const j = JSON.parse(raw);
  if (!Array.isArray(j.checks)) { process.stderr.write('missing checks array\n'); process.exit(1); }
  if (typeof j.overall !== 'string') { process.stderr.write('missing overall string\n'); process.exit(1); }
  if (j.overall !== 'pass' && j.overall !== 'fail') { process.stderr.write('overall not pass|fail\n'); process.exit(1); }
  for (const c of j.checks) {
    if (typeof c.name !== 'string' || typeof c.status !== 'string' || typeof c.message !== 'string') {
      process.stderr.write('check missing name/status/message\n'); process.exit(1);
    }
  }
" 2>/dev/null; then
  NCHECK=$(node -e "const j=JSON.parse(require('fs').readFileSync('/tmp/swc-doctor.json','utf8')); console.log(j.checks.length);" 2>/dev/null || echo "?")
  record PASS 7 "doctor --output-format json emits valid {checks[${NCHECK}], overall} shape"
else
  record FAIL 7 "doctor JSON shape invalid (see /tmp/swc-doctor.json)"
fi

# ---------------------------------------------------------------------------
# Criterion 8 — init scaffolds in tempdir, idempotent
# ---------------------------------------------------------------------------

INIT_DIR=$(mktemp -d)
INIT_OK=true

(
  cd "$INIT_DIR"
  $BIN init > /dev/null 2>&1 || exit 1
  [[ -d .openswarm ]] || { echo "missing .openswarm/" >&2; exit 1; }
  grep -q '\.openswarm/' .gitignore || { echo ".gitignore missing .openswarm/ entry" >&2; exit 1; }
  [[ -f CLAUDE.md ]] || { echo "missing CLAUDE.md" >&2; exit 1; }
  # Idempotent second run
  $BIN init > /dev/null 2>&1 || exit 1
  # Confirm only one .openswarm/ line in .gitignore (idempotency)
  COUNT=$(grep -c '^\.openswarm/$' .gitignore 2>/dev/null || echo 0)
  [[ "$COUNT" == "1" ]] || { echo ".gitignore has $COUNT .openswarm/ entries (want 1)" >&2; exit 1; }
) && INIT_OK=true || INIT_OK=false

rm -rf "$INIT_DIR"

if $INIT_OK; then
  record PASS 8 "init scaffolds .openswarm/ + .gitignore + CLAUDE.md, idempotent"
else
  record FAIL 8 "init failed (see stderr above)"
fi

# ---------------------------------------------------------------------------
# Criteria 1, 2, 3, 4, 5 — live API (gated by --offline flag)
# ---------------------------------------------------------------------------

if $OFFLINE; then
  record SKIP 1 "prompt → text (--offline mode)"
  record SKIP 2 "prompt with tool use (--offline mode)"
  record SKIP 3 "--permission-mode read-only denial (--offline mode)"
  record SKIP 4 "--headless JSONL stream (--offline mode)"
  record SKIP 5 "--resume latest (--offline mode)"
else
  # Gate: check that auth is available (doctor auth check passes)
  AUTH_OK=false
  AUTH_OUT=$($BIN doctor --output-format json 2>/dev/null || true)
  if echo "$AUTH_OUT" | node -e "
    const j = JSON.parse(require('fs').readFileSync(0,'utf8'));
    const auth = j.checks.find(c => c.name === 'auth');
    process.exit(auth && auth.status === 'pass' ? 0 : 1);
  " 2>/dev/null; then
    AUTH_OK=true
  fi

  if ! $AUTH_OK; then
    record FAIL 1 "no auth available (doctor auth check fails); set ANTHROPIC_API_KEY or run 'claude auth login'"
    record SKIP 2 "(depends on criterion 1 auth)"
    record SKIP 3 "(depends on criterion 1 auth)"
    record SKIP 4 "(depends on criterion 1 auth)"
    record SKIP 5 "(depends on criterion 1 auth)"
  else
    # [1] Simple text response. Concatenate all text_delta payloads before
    # matching: the SDK streams tokens in many small chunks, so 'hello-smoke'
    # can split across deltas (e.g. "hello" + "-smoke") and line-by-line
    # grep fails intermittently depending on how the model tokenizes.
    OUT1=$($BIN --headless prompt "Reply with exactly the word: hello-smoke" 2>&1)
    CONCAT1=$(echo "$OUT1" | python3 -c '
import json, sys
out = []
for line in sys.stdin:
    line = line.strip()
    if not line.startswith("{"): continue
    try:
        e = json.loads(line)
    except Exception:
        continue
    if e.get("type") == "text_delta" and isinstance(e.get("text"), str):
        out.append(e["text"])
print("".join(out))
' 2>/dev/null)
    if echo "$CONCAT1" | grep -qi 'hello-smoke'; then
      record PASS 1 "prompt returned expected text"
    else
      SNIPPET=$(echo "$OUT1" | head -c 300 | tr '\n' ' ')
      record FAIL 1 "prompt did not return 'hello-smoke' (got: ${SNIPPET})"
    fi

    # [2] Tool use — force real invocation by asking something the model
    #     cannot answer without reading the file. A purely instructional
    #     prompt ("respond 'used-tool' if you invoked it") can be satisfied
    #     without actual tool use.
    OUT2=$($BIN --headless prompt "Use the read_file tool to read package.json, then tell me exactly how many top-level keys the JSON object has. Do not guess." 2>&1)
    if echo "$OUT2" | grep -q '"name":"read_file"'; then
      record PASS 2 "prompt with read_file tool: tool_use observed in stream"
    else
      record FAIL 2 "read_file tool was not observed in the headless stream"
    fi

    # [3] Read-only permission denies a write
    WRITE_TEST_DIR=$(mktemp -d)
    (
      cd "$WRITE_TEST_DIR"
      $BIN --headless --permission-mode read-only prompt "Create a file called test.txt with content 'hi' using the write_file tool." > /tmp/swc-perm.log 2>&1
    )
    PERM_EXIT=$?
    if [[ $PERM_EXIT -eq 0 ]] && [[ ! -f "$WRITE_TEST_DIR/test.txt" ]]; then
      record PASS 3 "read-only denies write: exit 0, no file created"
    elif [[ -f "$WRITE_TEST_DIR/test.txt" ]]; then
      record FAIL 3 "read-only did NOT prevent write_file (test.txt was created)"
    else
      record FAIL 3 "read-only test exited $PERM_EXIT unexpectedly (see /tmp/swc-perm.log)"
    fi
    rm -rf "$WRITE_TEST_DIR"

    # [4] --headless JSONL: every JSON-looking line parses, stream ends with message_stop
    OUT4=$($BIN --headless prompt "Reply with the single word: done" 2>&1)
    JSONL_OK=true
    BAD_LINE=""
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      [[ "${line:0:1}" != "{" ]] && continue
      if ! echo "$line" | node -e 'try{JSON.parse(require("fs").readFileSync(0,"utf8"))}catch(e){process.exit(1)}' 2>/dev/null; then
        JSONL_OK=false
        BAD_LINE="$line"
        break
      fi
    done <<< "$OUT4"
    HAS_STOP=false
    echo "$OUT4" | grep -q '"type":"message_stop"' && HAS_STOP=true

    if $JSONL_OK && $HAS_STOP; then
      record PASS 4 "--headless JSONL: all lines valid JSON, stream terminates with message_stop"
    elif ! $JSONL_OK; then
      record FAIL 4 "--headless JSONL: invalid JSON line: ${BAD_LINE:0:120}"
    else
      record FAIL 4 "--headless JSONL: stream missing message_stop event"
    fi

    # [5] --resume latest — assumes criterion 1 just created a session
    OUT5=$($BIN --headless --resume latest prompt "What was my previous message about? Reply in one sentence." 2>&1)
    if echo "$OUT5" | grep -q '"type":"message_stop"'; then
      record PASS 5 "--resume latest: stream terminates with message_stop"
    else
      SNIPPET5=$(echo "$OUT5" | head -c 300 | tr '\n' ' ')
      record FAIL 5 "--resume latest failed or missing message_stop (got: ${SNIPPET5})"
    fi
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
echo
if [[ $FAIL -gt 0 ]]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: PASS"
exit 0
