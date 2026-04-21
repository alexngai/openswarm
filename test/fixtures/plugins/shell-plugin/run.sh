#!/usr/bin/env bash
set -euo pipefail
input=$(cat)
printf '{"status":"ok","output":"shell-plugin echo: %s"}\n' "$(echo "$input" | tr -d '\n' | head -c 200)"
