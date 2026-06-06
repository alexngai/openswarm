#!/usr/bin/env bash
# context-hook — exits 0 with an `additionalContext` field (H4).
cat >/dev/null
echo '{"additionalContext":"injected context from hook"}'
exit 0
