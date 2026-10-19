#!/bin/bash
# Stage 2 grading watchdog (docs/07 §7.6): the runner enforces no verifier timeout,
# so a held-out test that hangs on an agent's code blocks a cell forever. Every
# minute, in every task container, a test process descended from /tests/test.sh
# and older than the task's verifier timeout (1800 s) is killed: its phase fails
# and test.sh goes on. The agent's own test runs are never touched.
LIMIT=${LIMIT:-1800}
INNER='now=$(cut -d" " -f1 /proc/uptime); now=${now%.*}; hz=$(getconf CLK_TCK 2>/dev/null || echo 100)
for p in /proc/[0-9]*; do
  pid=${p#/proc/}
  cmd=$(tr "\0" " " < $p/cmdline 2>/dev/null) || continue
  case "$cmd" in *pytest*|*jest*|*vitest*|*mocha*|*"node --test"*) ;; *) continue;; esac
  q=$pid; under=0
  for i in 1 2 3 4 5 6 7 8; do
    q=$(sed -n "s/^PPid:[[:space:]]*//p" /proc/$q/status 2>/dev/null)
    { [ -z "$q" ] || [ "$q" = 0 ]; } && break
    tr "\0" " " < /proc/$q/cmdline 2>/dev/null | grep -q "/tests/test.sh" && { under=1; break; }
  done
  [ $under = 1 ] || continue
  # Fields after the command name, which is in parentheses and may hold spaces
  # (jest is "npm exec jest t"): split there, or every later field shifts.
  line=$(cat $p/stat 2>/dev/null) || continue
  read -r -a st <<< "${line##*) }"
  age=$(( now - ${st[19]} / hz ))
  if [ $age -gt '"$LIMIT"' ]; then kill -9 $pid && echo "killed pid $pid age ${age}s: ${cmd:0:120}"; fi
done'
once() {
  for c in $(docker ps --format '{{.ID}} {{.Image}}' | awk '/roadmapbench/{print $1}'); do
    out=$(docker exec "$c" bash -c "$INNER" 2>/dev/null)
    [ -n "$out" ] && echo "$(date -u +%FT%TZ) $(docker inspect -f '{{.Config.Image}} {{.Name}}' $c) $out"
  done
}
if [ "$1" = once ]; then once; else while true; do once; sleep 60; done; fi
