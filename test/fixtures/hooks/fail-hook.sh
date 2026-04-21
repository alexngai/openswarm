#!/usr/bin/env bash
# fail-hook — exits 1, stderr carries a reason. Maps to decision: "fail".
cat >/dev/null
echo "something went wrong" >&2
exit 1
