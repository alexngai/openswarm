#!/usr/bin/env bash
# stop-deny-hook — denies a Stop event, forcing the agent to continue.
cat >/dev/null
echo '{"systemMessage":"not done yet","additionalContext":"keep going"}'
exit 2
