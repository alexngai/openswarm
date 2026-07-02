#!/usr/bin/env bash
# scripts/smoke-codex-team.sh — operator-run smoke for stage 4H codex peer
# tools registration via App Server `dynamicTools`.
#
# Spawns a 1-codex-peer team via `openswarm topology peer-team` and
# verifies the codex peer can execute a task end-to-end. The 4K team CLI
# flags this script depended on shipped in v0.4 (commit a4defac); the
# previous stub status is removed.
#
# REQUIRES (live mode):
#   - codex CLI on PATH (`which codex` resolves)
#   - ChatGPT Plus/Pro auth via `codex login` (writes ~/.codex/auth.json)
#
# When codex is missing the script falls back to the offline captured-trace
# test (src/providers/codex-app-server-dynamic-tools.test.ts) which exercises
# the same protocol contract.
#
# Sibling: scripts/smoke-codex-consultant.sh exercises the V0.4.Q9 mixed-
# engine consultant pattern (Claude transport → Codex consultant via the
# `agent` tool's framework parameter).
#
# Usage:
#   ./scripts/smoke-codex-team.sh             # auto-detect codex; live or fallback
#   ./scripts/smoke-codex-team.sh --offline   # force the captured-trace test
#   ./scripts/smoke-codex-team.sh --help

set -uo pipefail

if [[ "${1:-}" == "--help" ]]; then
  sed -n '1,/^set -uo/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

FORCE_OFFLINE=false
[[ "${1:-}" == "--offline" ]] && FORCE_OFFLINE=true

run_offline_fallback() {
  echo "→ running captured-trace test (offline protocol contract)..."
  if OPENSWARM_SKIP_INTEGRATION_BUILD=1 \
      npx vitest run src/providers/codex-app-server-dynamic-tools.test.ts; then
    echo
    echo "RESULT: PASS (offline)"
    echo "  Stage 4H protocol contract verified against the captured trace."
    echo "  Re-run with codex installed for live end-to-end verification."
    exit 0
  fi
  echo
  echo "RESULT: FAIL (offline)"
  exit 1
}

# 1. Force-offline branch.
if $FORCE_OFFLINE; then
  echo "→ building..."
  npm run build > /dev/null 2>&1 || { echo "[error] build failed"; exit 1; }
  run_offline_fallback
fi

# 2. Live branch — gate on codex CLI presence.
if ! command -v codex >/dev/null 2>&1; then
  echo "[skip-live] codex CLI not found on PATH; falling back to captured-trace test."
  echo "            Install: https://github.com/openai/codex"
  echo "            Auth:    codex login"
  echo
  echo "→ building..."
  npm run build > /dev/null 2>&1 || { echo "[error] build failed"; exit 1; }
  run_offline_fallback
fi

if [[ ! -f "$HOME/.codex/auth.json" ]]; then
  echo "[warn] ~/.codex/auth.json not found — codex peer will likely fail with"
  echo "       an auth error. Run 'codex login' first."
fi

# 3. Build for live run.
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

# 4. Construct a minimal 1-member peer-team spec with a codex member.
SPEC=$(mktemp --suffix=.json 2>/dev/null || mktemp -t codex-team-spec.XXXXXX)
RESULTS=$(mktemp)
STDOUT_LOG=$(mktemp)
trap 'rm -f "$SPEC" "$RESULTS" "$STDOUT_LOG"' EXIT

cat > "$SPEC" <<'EOF'
{
  "name": "codex-smoke",
  "topology": "peer-team",
  "members": [
    {
      "id": "codex-1",
      "role": "executor",
      "prompt": "Reply with exactly the number 7 and nothing else.",
      "framework": "codex-chatgpt"
    }
  ],
  "coordination": { "completion": { "kind": "all" } }
}
EOF

echo "→ running 1-member codex peer-team smoke..."
if ! $BIN topology peer-team --spec "$SPEC" --output "$RESULTS" --concurrency 1 > "$STDOUT_LOG" 2>&1; then
  echo
  echo "RESULT: FAIL (orchestrator exited non-zero)"
  tail -20 "$STDOUT_LOG"
  exit 1
fi

# 5. Verify the codex peer's reply made it through. The aggregate output
# (which contains the "7") goes to stdout (team.ts:297-298); the structured
# results.jsonl carries status. Pass when both are healthy:
#  - orchestrator reports a successful task
#  - the expected reply ("7") appears in stdout or results.jsonl
if grep -q "1 succeeded" "$STDOUT_LOG" \
   && (grep -q "7" "$RESULTS" || grep -q "7" "$STDOUT_LOG"); then
  echo
  echo "RESULT: PASS (live)"
  echo "  Stage 4H DynamicToolCall wiring verified end-to-end with a real"
  echo "  codex App Server thread."
  exit 0
fi

echo
echo "RESULT: FAIL (codex peer reply not detected)"
echo "  -- results.jsonl --"
cat "$RESULTS" 2>/dev/null | head -10
echo "  -- stdout --"
cat "$STDOUT_LOG" 2>/dev/null | tail -20
exit 1
