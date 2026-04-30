#!/usr/bin/env bash
# timeout-hook — sleeps long enough to trip even a lenient test timeout.
# Combine with a tight `timeoutMs` in the test case to exercise the timeout path.
cat >/dev/null
sleep 10
echo "{}"
exit 0
