#!/usr/bin/env bash
# scripts/smoke-opentui.sh — Phase 0 acceptance gate for the OpenTUI/Solid
# migration. Mirrors the shape of the other smoke-*.sh scripts but runs the
# CLI under `bun` (required by @opentui/core's bun:ffi dependency).
#
# Usage:
#   ./scripts/smoke-opentui.sh              # full run (unit + live)
#   ./scripts/smoke-opentui.sh --offline    # skip live-API tests
#
# Exit code: 0 if every attempted criterion passes, 1 otherwise.
#
# Scenarios:
#   Offline (no API calls, always runs):
#     [O1] bun test: every repl-solid/**/*.test.tsx suite passes
#     [O2] bun src/cli.ts --help prints usage
#     [O3] bun src/cli.ts doctor runs all 4 checks
#   Live (real Anthropic API; skipped via --offline):
#     [L1] bun src/cli.ts prompt "..." --headless completes a turn
#          (verifies full engine stack runs under Bun against real API)

set -uo pipefail

OFFLINE=false
[[ "${1:-}" == "--offline" ]] && OFFLINE=true

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PASS=0
FAIL=0
SKIP=0
RESULTS=()

record() {
  local tag="$1" status="$2" msg="$3"
  RESULTS+=("[$tag] $status - $msg")
  case "$status" in
    PASS) PASS=$((PASS + 1)) ;;
    FAIL) FAIL=$((FAIL + 1)) ;;
    SKIP) SKIP=$((SKIP + 1)) ;;
  esac
}

# ---------------------------------------------------------------------------
# O1: bun test — every OpenTUI/Solid test passes.
# ---------------------------------------------------------------------------
if OPENSWARM_SKIP_LIVE=1 bun test src/ui/repl-solid/ >/tmp/smoke-opentui-o1.log 2>&1; then
  record O1 PASS "bun test src/ui/repl-solid/ — all tests green"
else
  record O1 FAIL "bun test src/ui/repl-solid/ failed (see /tmp/smoke-opentui-o1.log)"
fi

# ---------------------------------------------------------------------------
# O2: bun src/cli.ts --help.
# ---------------------------------------------------------------------------
if bun src/cli.ts --help 2>/tmp/smoke-opentui-o2.err \
  | grep -q "openswarm"; then
  record O2 PASS "bun src/cli.ts --help prints usage"
else
  record O2 FAIL "bun src/cli.ts --help failed (see /tmp/smoke-opentui-o2.err)"
fi

# ---------------------------------------------------------------------------
# O3: bun src/cli.ts doctor.
# ---------------------------------------------------------------------------
DOCTOR_OUT=$(bun src/cli.ts doctor 2>/tmp/smoke-opentui-o3.err)
if echo "$DOCTOR_OUT" | grep -qE "auth|install|workspace"; then
  record O3 PASS "bun src/cli.ts doctor runs all checks"
else
  record O3 FAIL "bun src/cli.ts doctor did not produce expected output"
fi

# ---------------------------------------------------------------------------
# O4: bun build --compile produces a working standalone binary.
# ---------------------------------------------------------------------------
# Resolved from the build below, not hardcoded. build-binary.ts writes to
# packages/cli-<platform>-<arch>/ and has since the packages layout landed, but
# this pointed at the pre-layout dist/openswarm — so the build succeeded, the
# binary was never found, and O4 reported "compiled binary --help or doctor
# failed" for a binary that was fine. O5 and L2 gate on `-x "$BINARY_PATH"` and
# had been silently skipping for the same reason. Parsing the build's own
# "OK. <path>" line keeps this from drifting again.
BINARY_PATH=""
if bun "$REPO_ROOT/scripts/build-binary.ts" >/tmp/smoke-opentui-o4-build.log 2>&1; then
  BINARY_PATH="$REPO_ROOT/$(sed -n 's/^OK\. //p' /tmp/smoke-opentui-o4-build.log | tail -1)"
  # Capture first, then grep — same shape as O3 above. Piping the binary
  # straight into grep fails under `set -o pipefail` whenever the command exits
  # nonzero, and `doctor` exits 1 when any check fails: on a host with no
  # Anthropic credential (any CI runner) the auth check fails by design. That
  # made O4 report "compiled binary --help or doctor failed" for a binary that
  # built and ran correctly. What this check is for is that the binary WORKS,
  # not that the host is configured.
  O4_HELP_OUT=$("$BINARY_PATH" --help 2>/tmp/smoke-opentui-o4-help.err || true)
  O4_DOCTOR_OUT=$("$BINARY_PATH" doctor 2>/tmp/smoke-opentui-o4-doctor.err || true)
  if echo "$O4_HELP_OUT" | grep -q "openswarm" \
    && echo "$O4_DOCTOR_OUT" | grep -qE "auth|install|workspace"; then
    record O4 PASS "compiled binary passes --help and doctor"
  else
    # Say which half failed and show what came back. The /tmp logs are not
    # retrievable from a CI runner, so a bare "--help or doctor failed" is
    # undiagnosable from the outside — print the evidence inline instead.
    echo "--- O4 diagnostics ---" >&2
    echo "binary: ${BINARY_PATH:-<unresolved>}" >&2
    echo "--help matched: $(echo "$O4_HELP_OUT" | grep -qc "openswarm" || true)" >&2
    echo "--help stdout (first 5):" >&2
    echo "$O4_HELP_OUT" | head -5 >&2
    echo "--help stderr (first 5):" >&2
    head -5 /tmp/smoke-opentui-o4-help.err >&2 || true
    echo "doctor stdout (first 10):" >&2
    echo "$O4_DOCTOR_OUT" | head -10 >&2
    echo "doctor stderr (first 10):" >&2
    head -10 /tmp/smoke-opentui-o4-doctor.err >&2 || true
    record O4 FAIL "compiled binary --help or doctor failed"
  fi
else
  record O4 FAIL "bun build --compile failed (see /tmp/smoke-opentui-o4-build.log)"
fi

# ---------------------------------------------------------------------------
# O5: PTY e2e — real terminal coverage via the compiled binary.
#     Requires the binary from O4; node-pty runs under Node, not Bun.
# ---------------------------------------------------------------------------
if [[ -x "$BINARY_PATH" ]]; then
  if OPENSWARM_SKIP_INTEGRATION_BUILD=1 npx vitest run test/integration/pty.test.ts \
    >/tmp/smoke-opentui-o5.log 2>&1; then
    record O5 PASS "PTY e2e — mount, slash dropdown, /exit, SIGINT"
  else
    record O5 FAIL "PTY e2e failed (see /tmp/smoke-opentui-o5.log)"
  fi
else
  record O5 SKIP "PTY e2e (no binary from O4)"
fi

# ---------------------------------------------------------------------------
# L1: Live API call through the full stack under Bun.
# ---------------------------------------------------------------------------
if $OFFLINE; then
  record L1 SKIP "(offline) live Bun CLI turn"
else
  L1_OUT=$(bun src/cli.ts prompt "say hi in 3 words" --headless --model haiku \
    2>/tmp/smoke-opentui-l1.err) || true
  if echo "$L1_OUT" | grep -q '"type":"message_stop"'; then
    record L1 PASS "live Bun CLI turn — message_stop emitted"
  else
    record L1 FAIL "live Bun CLI turn did not complete (see /tmp/smoke-opentui-l1.err)"
  fi
fi

# ---------------------------------------------------------------------------
# L2: Live API call through the compiled binary.
# ---------------------------------------------------------------------------
if $OFFLINE; then
  record L2 SKIP "(offline) live compiled-binary turn"
elif [[ ! -x "$BINARY_PATH" ]]; then
  record L2 FAIL "compiled binary missing; O4 build must succeed first"
else
  L2_OUT=$("$BINARY_PATH" prompt "say hi in 3 words" --headless --model haiku \
    2>/tmp/smoke-opentui-l2.err) || true
  if echo "$L2_OUT" | grep -q '"type":"message_stop"'; then
    record L2 PASS "live compiled-binary turn — message_stop emitted"
  else
    record L2 FAIL "live compiled-binary turn did not complete (see /tmp/smoke-opentui-l2.err)"
  fi
fi

# ---------------------------------------------------------------------------
# Summary.
# ---------------------------------------------------------------------------
echo
echo "=== OpenTUI / Solid smoke results ==="
for line in "${RESULTS[@]}"; do
  echo "$line"
done
echo
echo "Totals: PASS=$PASS FAIL=$FAIL SKIP=$SKIP"

if (( FAIL > 0 )); then
  exit 1
fi
exit 0
