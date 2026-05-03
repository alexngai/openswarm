#!/usr/bin/env bash
# scripts/smoke-codex-team.sh — operator-run smoke for Stage 4H codex peer
# tools registration via App Server `dynamicTools`.
#
# WHEN TO RUN: Once stage 4K wires team CLI flags to spec a team that includes
# a codex peer member. This script is a STUB; it currently routes to the
# captured-trace test which exercises the same protocol contract offline.
#
# REQUIRES (live mode, post-4K): codex CLI installed AND authenticated with a
# ChatGPT Plus/Pro account via `codex login`. Skipped from CI.
#
# Usage:
#   ./scripts/smoke-codex-team.sh             # offline (captured-trace test)
#   ./scripts/smoke-codex-team.sh --live      # placeholder — pending stage 4K
#   ./scripts/smoke-codex-team.sh --help

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

case "${1:-}" in
  --live)
    echo "[skipped] live smoke is post-4K — need team CLI flags to spawn"
    echo "          a 1-member peer team with framework=codex-chatgpt."
    echo "          For now, route to the captured-trace test below."
    echo
    ;;
esac

echo "→ running captured-trace test (offline protocol contract)..."
if SWARM_CODER_SKIP_INTEGRATION_BUILD=1 \
    npx vitest run src/providers/codex-app-server-dynamic-tools.test.ts; then
  echo
  echo "RESULT: PASS"
  echo "  Stage 4H protocol contract verified against the captured trace"
  echo "  (test/fixtures/codex-app-server/dynamic-tool-call-spike.jsonl)."
  echo "  Live smoke is deferred to post-4K once team CLI flags land."
  exit 0
fi

echo
echo "RESULT: FAIL"
exit 1
