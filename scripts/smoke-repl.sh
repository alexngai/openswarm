#!/usr/bin/env bash
# scripts/smoke-repl.sh — M2 REPL acceptance-criteria gate.
#
# Usage:
#   ANTHROPIC_API_KEY=sk-ant-... ./scripts/smoke-repl.sh         # live run
#   ./scripts/smoke-repl.sh --offline                            # skip live tests
#
# Exits 0 if every run scenario passes, 1 otherwise.
#
# Scenarios:
#   Offline (ScriptedTestEngine via SWARM_CODER_TEST_SCRIPT, no API):
#     [O1] REPL lifecycle (headless prompt + text_delta + message_stop)
#     [O2] /help slash command lists every registered command
#     [O3] Hook fixture denies a tool via exit 2
#     [O4] Plugin fixture registered as plugin__shell-plugin__echo
#   Live (real Anthropic API; gated by --offline):
#     [L1] Single-prompt lifecycle against real engine
#     [L2] Model flag — `--model sonnet` reaches the engine
#     [L3] /status and /cost deferred (PTY) — marked SKIP
#     [L4] WebSearch via SDK built-in (gated by --enable-web-search)
#     [L5] One hook invocation live (hook script writes to a log file)

set -uo pipefail

OFFLINE=false
[[ "${1:-}" == "--offline" ]] && OFFLINE=true

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BIN="node $REPO_ROOT/dist/cli.js"
WORKER_SCRIPT="$REPO_ROOT/test/fixtures/worker-scripts/text-only.json"
PLUGINS_DIR="$REPO_ROOT/test/fixtures/plugins"
HOOKS_FIXTURES="$REPO_ROOT/test/fixtures/hooks"

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
# OFFLINE SCENARIOS
# ---------------------------------------------------------------------------

# [O1] REPL lifecycle — headless prompt + scripted engine.
OUT=$(SWARM_CODER_TEST_SCRIPT="$WORKER_SCRIPT" $BIN prompt --headless "hi" 2>&1)
EC=$?
if [[ $EC -eq 0 ]] && \
   echo "$OUT" | grep -q '"type":"text_delta"' && \
   echo "$OUT" | grep -q '"type":"message_stop"'; then
  record PASS O1 "REPL lifecycle: text_delta + message_stop emitted (exit $EC)"
else
  record FAIL O1 "REPL lifecycle: missing events or exit!=0 (exit=$EC)"
fi

# [O2] /help — dispatcher-level. We don't have a REPL-loop headless pipe mode,
# so exercise the slash-dispatch path via a small inline node script. This is
# the same path the ink REPL uses on /help.
if node -e '
  (async () => {
    const { buildDefaultRegistry } = await import("./dist/cli/slash/index.js");
    const { dispatchSlashLine } = await import("./dist/cli/slash/dispatcher.js");
    const { createInitialState } = await import("./dist/ui/repl/state.js");
    const r = buildDefaultRegistry({});
    const s = createInitialState({ permissionMode: "workspace-write" });
    const res = await dispatchSlashLine("/help", s, r);
    if (res.kind !== "message") { console.error("not message"); process.exit(1); }
    for (const cmd of ["/help","/exit","/status","/cost","/model","/permissions","/resume","/doctor","/tasks","/approve","/deny","/stop","/compact","/clear"]) {
      if (!res.text.includes(cmd)) { console.error("missing " + cmd); process.exit(1); }
    }
  })().catch((err) => { console.error(err); process.exit(1); });
' > /tmp/swc-o2.log 2>&1; then
  record PASS O2 "/help slash command lists all 14 commands"
else
  record FAIL O2 "/help missing commands or dispatcher broken (see /tmp/swc-o2.log)"
fi

# [O3] Hook fixture — configure a PreToolUse hook that denies bash; run a
# prompt via --dump-tools (which doesn't invoke tools) to confirm the hook
# config loads; then exercise the dispatcher-level deny path via node.
TMP_O3=$(mktemp -d)
mkdir -p "$TMP_O3/.swarm-coder"
cat > "$TMP_O3/.swarm-coder/hooks.json" <<EOF
{"PreToolUse":[{"matcher":"read_file","command":"bash $HOOKS_FIXTURES/deny-hook.sh"}]}
EOF

OUT_O3=$((cd "$TMP_O3" && SWARM_CODER_TEST_SCRIPT="$WORKER_SCRIPT" $BIN prompt --headless --dump-tools --no-plugins --no-mcp --no-skills noop) 2>&1)
EC_O3=$?
if [[ $EC_O3 -eq 0 ]] && echo "$OUT_O3" | grep -q "hooks loaded from"; then
  # Dispatcher-level deny: invoke the hook via the runtime and assert deny.
  if (cd "$REPO_ROOT" && node -e '
    (async () => {
      const { HookRuntime } = await import("./dist/hooks/runtime.js");
      const r = new HookRuntime({
        PreToolUse: [{ matcher: "*", command: "bash '"$HOOKS_FIXTURES"'/deny-hook.sh" }],
      });
      const res = await r.invoke("PreToolUse", {
        event: "PreToolUse", toolName: "read_file", toolInput: {},
      });
      if (res.decision !== "deny") { console.error("expected deny, got " + res.decision); process.exit(1); }
    })().catch((e) => { console.error(e); process.exit(1); });
  ') > /tmp/swc-o3.log 2>&1; then
    record PASS O3 "hook fixture: config loaded + deny-hook returns decision=deny"
  else
    record FAIL O3 "hook fixture: dispatcher deny path broken (see /tmp/swc-o3.log)"
  fi
else
  record FAIL O3 "hook fixture: config did not load cleanly (exit=$EC_O3)"
fi
rm -rf "$TMP_O3"

# [O4] Plugin fixture — SWARM_CODER_PLUGINS_DIR + --dump-tools
OUT_O4=$(SWARM_CODER_TEST_SCRIPT="$WORKER_SCRIPT" SWARM_CODER_PLUGINS_DIR="$PLUGINS_DIR" SWARM_CODER_CONFIG_DIR="/tmp/swc-o4-empty" $BIN prompt --headless --dump-tools --no-mcp --no-hooks --no-skills noop 2>/dev/null)
EC_O4=$?
if [[ $EC_O4 -eq 0 ]] && \
   echo "$OUT_O4" | tail -1 | grep -q 'plugin__shell-plugin__echo' && \
   echo "$OUT_O4" | tail -1 | grep -q 'plugin__node-plugin__greet'; then
  record PASS O4 "plugin fixture loaded: shell-plugin + node-plugin tools registered"
else
  record FAIL O4 "plugin fixture: expected tools not registered (exit=$EC_O4)"
fi

# ---------------------------------------------------------------------------
# LIVE SCENARIOS
# ---------------------------------------------------------------------------

if $OFFLINE; then
  record SKIP L1 "live REPL lifecycle (offline mode)"
  record SKIP L2 "live --model flag (offline mode)"
  record SKIP L3 "live /status + /cost (PTY; deferred)"
  record SKIP L4 "live web_search via SDK built-in (offline mode)"
  record SKIP L5 "live hook invocation (offline mode)"
else
  # Confirm auth.
  if ! $BIN doctor > /dev/null 2>&1; then
    record FAIL L1 "no auth available (doctor failed); set ANTHROPIC_API_KEY or run 'claude auth login'"
    record SKIP L2 "(depends on auth)"
    record SKIP L3 "(depends on auth)"
    record SKIP L4 "(depends on auth)"
    record SKIP L5 "(depends on auth)"
  else
    # [L1] Live prompt — message_stop observed.
    OUT_L1=$($BIN prompt --headless "Reply with exactly the word: live-repl-ok" 2>&1)
    EC_L1=$?
    if [[ $EC_L1 -eq 0 ]] && echo "$OUT_L1" | grep -q '"type":"message_stop"'; then
      record PASS L1 "live REPL lifecycle: message_stop observed"
    else
      record FAIL L1 "live REPL lifecycle: no message_stop (exit=$EC_L1)"
    fi

    # [L2] Model flag — the `--model sonnet` alias reaches the engine.
    OUT_L2=$($BIN prompt --headless --model sonnet "Reply with exactly the word: sonnet-ok" 2>&1)
    EC_L2=$?
    if [[ $EC_L2 -eq 0 ]] && echo "$OUT_L2" | grep -q '"type":"message_stop"'; then
      record PASS L2 "live --model sonnet: completed with message_stop"
    else
      record FAIL L2 "live --model sonnet: no message_stop (exit=$EC_L2)"
    fi

    # [L3] /status + /cost — deferred (requires PTY or REPL-loop stdin).
    record SKIP L3 "/status + /cost require PTY driver (deferred to manual smoke)"

    # [L4] WebSearch built-in — enable + ask for a time-sensitive query.
    OUT_L4=$($BIN prompt --headless --enable-web-search "What is today's date? Use web_search if helpful. Reply in one short sentence." 2>&1)
    EC_L4=$?
    if [[ $EC_L4 -eq 0 ]] && echo "$OUT_L4" | grep -q '"type":"message_stop"'; then
      record PASS L4 "live --enable-web-search: completed with message_stop"
    else
      record FAIL L4 "live web_search: no message_stop (exit=$EC_L4)"
    fi

    # [L5] One hook invocation — hook writes to a log file; verify it exists.
    TMP_L5=$(mktemp -d)
    mkdir -p "$TMP_L5/.swarm-coder"
    LOG="$TMP_L5/hook.log"
    cat > "$TMP_L5/.swarm-coder/hooks.json" <<EOF
{"PreToolUse":[{"matcher":"*","command":"cat >/dev/null; echo pre-hook-fired >> $LOG; echo '{}'; exit 0"}]}
EOF
    OUT_L5=$((cd "$TMP_L5" && $BIN prompt --headless "Use the read_file tool to read package.json, then tell me one field." ) 2>&1)
    EC_L5=$?
    if [[ $EC_L5 -eq 0 ]] && [[ -f "$LOG" ]] && grep -q 'pre-hook-fired' "$LOG"; then
      record PASS L5 "live hook: PreToolUse fired (log written)"
    else
      record FAIL L5 "live hook: log not written or prompt failed (exit=$EC_L5)"
    fi
    rm -rf "$TMP_L5"
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
