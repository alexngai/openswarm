#!/usr/bin/env bash
# scripts/smoke-codex-consultant.sh — V0.4.Q9 mixed-engine consultant pattern smoke.
#
# A single Claude (transport) agent calls the `agent` tool with
# framework="codex-chatgpt", spawning a one-shot Codex consultant. Verifies
# the result round-trips back through the consultant chain that 4M.5 + 4M.6
# wired and 4M.7 finalised — agent.ts → SpawnRequest.framework →
# StandaloneHost.spawn → spawnWorker → SWARM_HARNESS_FRAMEWORK env →
# CodexFrameworkEngine → codex App Server → ChatGPT.
#
# REQUIRES (live mode):
#   - codex CLI on PATH (`which codex` resolves)
#   - ChatGPT Plus/Pro auth via `codex login` (writes ~/.codex/auth.json)
#   - Claude Max session (parent transport agent)
#
# When codex is missing the script skips with a clear install hint — it does
# NOT fail. CI uses the offline captured-trace test
# (src/providers/codex-app-server-dynamic-tools.test.ts) for the same protocol
# contract; this script is operator-run for end-to-end live verification.
#
# Usage:
#   ./scripts/smoke-codex-consultant.sh             # auto-detect codex
#   ./scripts/smoke-codex-consultant.sh --help

set -uo pipefail

if [[ "${1:-}" == "--help" ]]; then
  sed -n '1,/^set -uo/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# 1. codex CLI presence — gate.
if ! command -v codex >/dev/null 2>&1; then
  echo "[skip] codex CLI not found on PATH."
  echo "       Install: see https://github.com/openai/codex"
  echo "       Auth:    codex login   # writes ~/.codex/auth.json"
  echo "       Then re-run this script."
  exit 0
fi

# 2. Codex auth presence — soft check (codex CLI handles auth errors itself).
if [[ ! -f "$HOME/.codex/auth.json" ]]; then
  echo "[warn] ~/.codex/auth.json not found — consultant call will likely"
  echo "       fail with an auth error. Run 'codex login' first."
fi

# 3. Build.
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

# 4. Construct a deterministic round-trip:
#    The transport agent is told to call the agent tool with
#    framework=codex-chatgpt, requesting a fixed answer ("42") from the
#    consultant. Smoke passes if "42" appears in the recorded output.
TASKS=$(mktemp)
RESULTS=$(mktemp)
trap 'rm -f "$TASKS" "$RESULTS"' EXIT

cat > "$TASKS" <<'EOF'
{"id":"q9-consultant","prompt":"Call the agent tool with these arguments: prompt=\"Reply with exactly the number 42 and nothing else.\", framework=\"codex-chatgpt\", wait=true. Then output the consultant's reply verbatim, prefixed with the literal text 'CONSULTANT-SAYS: '."}
EOF

echo "→ running consultant smoke (transport=claude, consultant=codex-chatgpt)..."
if ! $BIN swarm run "$TASKS" --output "$RESULTS" --concurrency 1 2>&1; then
  echo
  echo "RESULT: FAIL (orchestrator exited non-zero)"
  exit 1
fi

# 5. Verify the consultant's reply made it back.
if grep -q "CONSULTANT-SAYS:.*42" "$RESULTS"; then
  echo
  echo "RESULT: PASS"
  echo "  Q9 consultant pattern verified end-to-end:"
  echo "  Claude transport → agent({framework:\"codex-chatgpt\"}) → Codex App Server → ChatGPT → reply"
  exit 0
fi

echo
echo "RESULT: FAIL (consultant reply not detected in results)"
echo "  Inspect: $RESULTS"
cat "$RESULTS" 2>/dev/null | head -20
exit 1
