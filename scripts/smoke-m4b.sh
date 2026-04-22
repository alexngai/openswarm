#!/usr/bin/env bash
# scripts/smoke-m4b.sh — M4b provider breadth + OAuth acceptance-criteria gate.
#
# Offline strategy: run vitest against specific test files.
# This is the same pragmatic approach as smoke-m4a.sh — running vitest directly
# against provider, plugin, auth, quirks, and routing test suites is the faithful
# offline signal for M4b work.
#
# Usage:
#   ./scripts/smoke-m4b.sh               # offline + live (if env keys set)
#   ./scripts/smoke-m4b.sh --offline      # offline only
#   ./scripts/smoke-m4b.sh --live         # live only (fails if no API keys set)
#   ./scripts/smoke-m4b.sh --help         # this help text
#
# Offline cases (always run unless --live):
#   [O1] xAI provider:         npx vitest run src/providers/xai-transport.test.ts
#   [O2] Google provider:      npx vitest run src/providers/google-transport.test.ts
#   [O3] DashScope provider:   npx vitest run src/providers/dashscope-transport.test.ts src/providers/dashscope-preflight.test.ts
#   [O4] DashScope over-cap:   covered by same suite (7MB rejection case called out explicitly)
#   [O5] Plugin lifecycle:     npx vitest run src/plugins/ src/cli/plugin.test.ts
#   [O6] Codex OAuth mock:     npx vitest run src/auth/openai-oauth.test.ts
#   [O7] Quirks centralization: npx vitest run src/providers/quirks.test.ts
#   [O8] Framework-filter:     npx vitest run src/tools/framework-filter.test.ts
#   [O9] Routing M4b:          npx vitest run src/providers/routing.test.ts
#
# Live cases (gated on env):
#   [L1] Real xAI turn (gated on XAI_API_KEY)
#   [L2] Real Google turn (gated on GOOGLE_GENERATIVE_AI_API_KEY)
#   [L3] Real DashScope turn (gated on DASHSCOPE_API_KEY)
#   [L4] Codex ChatGPT — Phase 5 not yet implemented; login path works end-to-end
#
# Exit code: 0 if all attempted cases pass, 1 otherwise.

set -uo pipefail

if [[ "${1:-}" == "--help" ]]; then
  sed -n '1,/^set -uo/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
  exit 0
fi

OFFLINE=false
LIVE_ONLY=false

case "${1:-}" in
  --offline) OFFLINE=true ;;
  --live)    LIVE_ONLY=true ;;
  "")        ;;
  *)
    echo "Unknown flag: ${1}" >&2
    echo "Usage: $0 [--offline|--live|--help]" >&2
    exit 1
    ;;
esac

if $LIVE_ONLY && [[ -z "${XAI_API_KEY:-}" ]] && [[ -z "${GOOGLE_GENERATIVE_AI_API_KEY:-}" ]] && [[ -z "${DASHSCOPE_API_KEY:-}" ]]; then
  echo "[error] --live requires at least one of XAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, or DASHSCOPE_API_KEY to be set" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BIN="node $REPO_ROOT/dist/cli.js"

PASS=0
FAIL=0
SKIP=0

record() {
  local status="$1" n="$2" label="$3"
  echo "[$status] [$n] $label"
  case "$status" in
    passed) PASS=$((PASS+1)) ;;
    failed) FAIL=$((FAIL+1)) ;;
    skipped) SKIP=$((SKIP+1)) ;;
  esac
}

echo "→ building..."
npm run build > /dev/null 2>&1

# ---------------------------------------------------------------------------
# OFFLINE CASES
# Each case runs the corresponding vitest test file(s) and checks exit status.
# ---------------------------------------------------------------------------

if ! $LIVE_ONLY; then

  # [O1] xAI TransportProvider
  echo "[O1] xAI provider (xai-transport.test.ts)"
  if SWARM_CODER_SKIP_INTEGRATION_BUILD=1 npx vitest run src/providers/xai-transport.test.ts \
      > /tmp/swc-m4b-o1.log 2>&1; then
    record passed O1 "xAI provider — mocked one-turn scenario"
  else
    record failed O1 "xai-transport.test.ts failed (see /tmp/swc-m4b-o1.log)"
  fi

  # [O2] Google TransportProvider
  echo "[O2] Google provider (google-transport.test.ts)"
  if SWARM_CODER_SKIP_INTEGRATION_BUILD=1 npx vitest run src/providers/google-transport.test.ts \
      > /tmp/swc-m4b-o2.log 2>&1; then
    record passed O2 "Google provider — mocked one-turn scenario"
  else
    record failed O2 "google-transport.test.ts failed (see /tmp/swc-m4b-o2.log)"
  fi

  # [O3] DashScope TransportProvider (under 6 MB)
  # [O4] DashScope over-cap preflight (7 MB rejection) — same suite, called out explicitly
  echo "[O3] DashScope provider under 6MB (dashscope-transport.test.ts + dashscope-preflight.test.ts)"
  echo "[O4] DashScope over-cap preflight: 7MB request body → request_body_exceeded (covered by same suite)"
  if SWARM_CODER_SKIP_INTEGRATION_BUILD=1 npx vitest run \
      src/providers/dashscope-transport.test.ts \
      src/providers/dashscope-preflight.test.ts \
      > /tmp/swc-m4b-o34.log 2>&1; then
    record passed O3 "DashScope provider — mocked one-turn scenario (under 6MB)"
    record passed O4 "DashScope over-cap preflight — 7MB payload rejected before HTTP"
  else
    record failed O3 "dashscope-transport/preflight tests failed (see /tmp/swc-m4b-o34.log)"
    record failed O4 "dashscope-transport/preflight tests failed (see /tmp/swc-m4b-o34.log)"
  fi

  # [O5] Plugin lifecycle (install / enable / disable / update / uninstall)
  echo "[O5] Plugin lifecycle (src/plugins/ + src/cli/plugin.test.ts)"
  if SWARM_CODER_SKIP_INTEGRATION_BUILD=1 npx vitest run src/plugins/ src/cli/plugin.test.ts \
      > /tmp/swc-m4b-o5.log 2>&1; then
    record passed O5 "Plugin lifecycle — install → list → disable → enable → update → uninstall"
  else
    record failed O5 "plugin lifecycle tests failed (see /tmp/swc-m4b-o5.log)"
  fi

  # [O6] Codex OAuth mock flow (PKCE + token exchange + persistence)
  echo "[O6] Codex OAuth mock flow (src/auth/openai-oauth.test.ts)"
  if SWARM_CODER_SKIP_INTEGRATION_BUILD=1 npx vitest run src/auth/openai-oauth.test.ts \
      > /tmp/swc-m4b-o6.log 2>&1; then
    record passed O6 "Codex OAuth mock flow — PKCE + token refresh + auth.json persistence"
  else
    record failed O6 "openai-oauth.test.ts failed (see /tmp/swc-m4b-o6.log)"
  fi

  # [O7] Quirks centralization (temperature strip, max_completion_tokens, etc.)
  echo "[O7] Quirks centralization (src/providers/quirks.test.ts)"
  if SWARM_CODER_SKIP_INTEGRATION_BUILD=1 npx vitest run src/providers/quirks.test.ts \
      > /tmp/swc-m4b-o7.log 2>&1; then
    record passed O7 "Quirks centralization — model-family quirks applied correctly"
  else
    record failed O7 "quirks.test.ts failed (see /tmp/swc-m4b-o7.log)"
  fi

  # [O8] Framework-filter (removes SwarmHost tools in framework mode)
  echo "[O8] Framework-filter (src/tools/framework-filter.test.ts)"
  if SWARM_CODER_SKIP_INTEGRATION_BUILD=1 npx vitest run src/tools/framework-filter.test.ts \
      > /tmp/swc-m4b-o8.log 2>&1; then
    record passed O8 "Framework-filter — codex-chatgpt/claude-agent-sdk strips SwarmHost tools"
  else
    record failed O8 "framework-filter.test.ts failed (see /tmp/swc-m4b-o8.log)"
  fi

  # [O9] Routing M4b additions (xai / gemini / qwen / kimi prefixes)
  echo "[O9] Routing M4b additions (src/providers/routing.test.ts)"
  if SWARM_CODER_SKIP_INTEGRATION_BUILD=1 npx vitest run src/providers/routing.test.ts \
      > /tmp/swc-m4b-o9.log 2>&1; then
    record passed O9 "Routing M4b additions — grok/gemini/qwen/kimi prefix coverage"
  else
    record failed O9 "routing.test.ts failed (see /tmp/swc-m4b-o9.log)"
  fi

fi  # end offline cases

# ---------------------------------------------------------------------------
# LIVE CASES (gated on per-provider env vars)
# ---------------------------------------------------------------------------

if ! $OFFLINE; then

  # [L1] Real xAI turn
  if [[ -z "${XAI_API_KEY:-}" ]]; then
    record skipped L1 "Real xAI turn (skipped: no XAI_API_KEY)"
  else
    echo "[L1] xAI grok-3 'say hi'"
    L1_OUT=$(timeout 60 $BIN --framework native --model grok-3 prompt "say hi" 2>&1) \
      && L1_EXIT=0 || L1_EXIT=$?
    if [[ $L1_EXIT -eq 0 ]] && [[ -n "$L1_OUT" ]]; then
      record passed L1 "xAI grok-3 text prompt: exit 0, got output"
    elif [[ $L1_EXIT -eq 124 ]]; then
      record failed L1 "xAI grok-3 text prompt: timed out after 60s"
    else
      SNIPPET=$(echo "$L1_OUT" | head -c 200 | tr '\n' ' ')
      record failed L1 "xAI grok-3 text prompt: exit $L1_EXIT (got: ${SNIPPET})"
    fi
  fi

  # [L2] Real Google turn
  if [[ -z "${GOOGLE_GENERATIVE_AI_API_KEY:-}" ]]; then
    record skipped L2 "Real Google turn (skipped: no GOOGLE_GENERATIVE_AI_API_KEY)"
  else
    echo "[L2] Google gemini-2.0-flash 'say hi'"
    L2_OUT=$(timeout 60 $BIN --framework native --model gemini-2.0-flash prompt "say hi" 2>&1) \
      && L2_EXIT=0 || L2_EXIT=$?
    if [[ $L2_EXIT -eq 0 ]] && [[ -n "$L2_OUT" ]]; then
      record passed L2 "Google gemini-2.0-flash text prompt: exit 0, got output"
    elif [[ $L2_EXIT -eq 124 ]]; then
      record failed L2 "Google gemini-2.0-flash text prompt: timed out after 60s"
    else
      SNIPPET=$(echo "$L2_OUT" | head -c 200 | tr '\n' ' ')
      record failed L2 "Google gemini-2.0-flash text prompt: exit $L2_EXIT (got: ${SNIPPET})"
    fi
  fi

  # [L3] Real DashScope turn
  if [[ -z "${DASHSCOPE_API_KEY:-}" ]]; then
    record skipped L3 "Real DashScope turn (skipped: no DASHSCOPE_API_KEY)"
  else
    echo "[L3] DashScope qwen-plus 'say hi'"
    L3_OUT=$(timeout 60 $BIN --framework native --model qwen-plus prompt "say hi" 2>&1) \
      && L3_EXIT=0 || L3_EXIT=$?
    if [[ $L3_EXIT -eq 0 ]] && [[ -n "$L3_OUT" ]]; then
      record passed L3 "DashScope qwen-plus text prompt: exit 0, got output"
    elif [[ $L3_EXIT -eq 124 ]]; then
      record failed L3 "DashScope qwen-plus text prompt: timed out after 60s"
    else
      SNIPPET=$(echo "$L3_OUT" | head -c 200 | tr '\n' ' ')
      record failed L3 "DashScope qwen-plus text prompt: exit $L3_EXIT (got: ${SNIPPET})"
    fi
  fi

  # [L4] Codex ChatGPT — Phase 5 provider not yet implemented; login path works
  record skipped L4 "Codex ChatGPT — Phase 5 provider not yet implemented; login flow works via \`swarm-coder login --provider codex-chatgpt\`"

fi  # end live cases

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
