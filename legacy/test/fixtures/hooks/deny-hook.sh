#!/usr/bin/env bash
# deny-hook — exits 2 with a systemMessage. Maps to decision: "deny".
cat >/dev/null
echo '{"systemMessage":"blocked by policy"}'
exit 2
