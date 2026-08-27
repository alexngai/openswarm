#!/usr/bin/env bash
# demo-env.sh — environment + a thin `openswarm` shim for the see-and-steer
# recording. Source this before running the demo (the tape does it hidden):
#
#     source demo/demo-env.sh
#
# What it does
#   • Points `openswarm team watch` at a demo-local runtime dir via
#     XDG_RUNTIME_DIR, so the daemon path `team watch <name>` resolves
#     (computeTeamPaths → $XDG_RUNTIME_DIR/openswarm/teams/<name>/events.jsonl)
#     lands under a throwaway temp dir — no root pollution, no real daemon.
#   • `team watch` runs the REAL CLI against that curated log.
#   • `team start` / `team send` are illustrative, log-driven shims (see
#     demo/README.md): they print the friendly line the real commands will
#     print once built-in team presets land, and drive the curated log via
#     demo/play-events.mjs instead of spending API tokens.

# Resolve repo root from this script's location (portable for the owner).
OSW_DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
export OSW_ROOT="$(cd "$OSW_DEMO_DIR/.." && pwd)"

# Demo-local runtime dir → team watch resolves events.jsonl under here.
# Kept short + stable so the board header path reads cleanly on one line.
export XDG_RUNTIME_DIR="${OSW_DEMO_RUNTIME:-/tmp/osw-demo}"
export OSW_TEAM="review"
export OSW_EVENTS="$XDG_RUNTIME_DIR/openswarm/teams/$OSW_TEAM/events.jsonl"

# Prefer the existing node bundle (no build needed); fall back to bun on source.
if [ -f "$OSW_ROOT/dist/cli.js" ]; then
  OSW_RUN=(node "$OSW_ROOT/dist/cli.js")
else
  OSW_RUN=(bun "$OSW_ROOT/src/cli.ts")
fi

# Reset demo state (fresh events.jsonl location, kill stray dribblers).
osw_demo_clean() {
  pkill -f "demo/play-events.mjs" 2>/dev/null
  rm -rf "$XDG_RUNTIME_DIR/openswarm/teams/$OSW_TEAM"
  mkdir -p "$XDG_RUNTIME_DIR/openswarm/teams/$OSW_TEAM"
}

openswarm() {
  if [ "$1" = "team" ] && [ "$2" = "start" ]; then
    printf '\033[1;36m▶ team "%s" started (detached) — tailing events…\033[0m\n' "$OSW_TEAM"
    ( node "$OSW_ROOT/demo/play-events.mjs" base "$OSW_EVENTS" --delay 240 >/dev/null 2>&1 & )
    return 0
  fi
  if [ "$1" = "team" ] && [ "$2" = "send" ]; then
    printf '\033[1;35m✎ steer delivered → team "%s"\033[0m\n' "$OSW_TEAM"
    ( node "$OSW_ROOT/demo/play-events.mjs" steer "$OSW_EVENTS" --delay 240 >/dev/null 2>&1 & )
    return 0
  fi
  # Everything else (notably `team watch`) hits the real CLI.
  "${OSW_RUN[@]}" "$@"
}
export -f openswarm osw_demo_clean

# Quiet job control so background dribblers don't print "[1] 12345" / "Done".
set +m 2>/dev/null || true
