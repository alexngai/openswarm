#!/usr/bin/env bash
# Shell-plugin fixture. Reads the tool-call JSON input on stdin and echoes
# back a ToolResult that embeds the stringified input in its `output` field.
#
# Uses python3 for JSON escaping so payloads with quotes or braces don't
# produce malformed output.
set -euo pipefail
input=$(cat)
python3 -c '
import json, sys
raw = sys.stdin.read()
print(json.dumps({"status": "ok", "output": "shell-plugin echo: " + raw[:200]}))
' <<< "$input"
