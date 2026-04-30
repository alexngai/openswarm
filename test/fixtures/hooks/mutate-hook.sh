#!/usr/bin/env bash
# mutate-hook — exits 0 with an `updatedInput` field. Exercises the input
# rewrite path (Pre-tool allow + input mutation).
cat >/dev/null
echo '{"updatedInput":{"foo":"mutated"}}'
exit 0
