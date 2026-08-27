#!/usr/bin/env bash
# allow-hook — emits an empty JSON body and exits 0 (allow).
# Reads its stdin payload but does nothing with it.
cat >/dev/null
echo "{}"
exit 0
