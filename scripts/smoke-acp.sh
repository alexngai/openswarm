#!/usr/bin/env bash
# scripts/smoke-acp.sh — ACP subcommand acceptance gate (Stage A).
#
# Two parts:
#   [O] Offline — vitest against the ACP module (unit + in-process prompt-turn
#       integration test). The faithful offline signal.
#   [W] Wire    — spawn `acp` and drive `initialize` + `session/new` over ndjson
#       JSON-RPC, asserting a valid InitializeResponse + sessionId and that
#       stdout carries nothing but protocol frames.
#
# Usage:
#   ./scripts/smoke-acp.sh            # offline + wire
#   ./scripts/smoke-acp.sh --offline  # offline only
#   ./scripts/smoke-acp.sh --wire     # wire only
set -uo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-all}"
FAIL=0
note() { printf '%s\n' "$*"; }
ok()   { printf '  [PASS] %s\n' "$*"; }
bad()  { printf '  [FAIL] %s\n' "$*"; FAIL=1; }

if [ "$MODE" != "--wire" ]; then
  note "[O] vitest run src/acp"
  if npx vitest run src/acp > /tmp/smoke-acp-vitest.txt 2>&1; then
    ok "acp unit + integration tests"
  else
    bad "acp tests (see /tmp/smoke-acp-vitest.txt)"
  fi
fi

if [ "$MODE" != "--offline" ]; then
  note "[W] wire: initialize + session/new over stdio"
  SCRIPT="$(mktemp)"
  echo '[{"event":{"type":"message_stop","stopReason":"end_turn","usage":{"inputTokens":1,"outputTokens":1}}}]' > "$SCRIPT"
  CWD="$(pwd)"
  FRAMES=$(printf '%s\n%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
    "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"session/new\",\"params\":{\"cwd\":\"$CWD\",\"mcpServers\":[]}}")
  # SWARM_HARNESS_TEST_SCRIPT skips auth and wires the scripted engine so the
  # smoke needs no API key. The trailing sleep keeps stdin open long enough for
  # the agent to answer before EOF closes the connection.
  OUT=$({ printf '%s' "$FRAMES"; sleep 2; } | SWARM_HARNESS_TEST_SCRIPT="$SCRIPT" bun src/cli.ts acp --single 2>/dev/null)
  rm -f "$SCRIPT"

  PURE=1
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in
      '{"jsonrpc":"2.0"'*) : ;;
      *) PURE=0 ;;
    esac
  done <<< "$OUT"
  [ "$PURE" = 1 ] && ok "stdout is pure JSON-RPC" || bad "stdout had non-JSON-RPC lines"

  echo "$OUT" | grep -q '"agentInfo":{"name":"openswarm"' \
    && ok "initialize -> InitializeResponse" || bad "no InitializeResponse"
  echo "$OUT" | grep -q '"sessionId"' \
    && ok "session/new -> sessionId" || bad "no session/new response"
fi

if [ "$FAIL" = 0 ]; then note "ACP smoke PASSED"; exit 0; else note "ACP smoke FAILED"; exit 1; fi
