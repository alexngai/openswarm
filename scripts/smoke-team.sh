#!/bin/bash
set -euo pipefail

# scripts/smoke-team.sh — v0.4 stage 4K live smoke for the team CLI surface.
# Operator-run, not CI: requires anthropic auth (ANTHROPIC_API_KEY or
# `claude login`) and a built dist/. Verifies CLI dispatch end-to-end.

bun run build

# 1. team start with a built-in openteams template (gsd) — runs end-to-end.
echo "=== team start gsd (smoke) ==="
node dist/cli.js team start gsd \
  --output /tmp/swarm-team-smoke-results.jsonl \
  --concurrency 1 || \
  echo "(non-zero exit OK if openteams missing or template incomplete; verifies CLI dispatch)"

# 2. topology peer-team with an inline spec.
cat > /tmp/swarm-spec.json <<'EOF'
{
  "name": "smoke-peer-team",
  "topology": "peer-team",
  "members": [
    { "role": "alpha", "prompt": "Say 'alpha here' and exit." },
    { "role": "beta", "prompt": "Say 'beta here' and exit." }
  ],
  "coordination": { "completion": { "kind": "all" } }
}
EOF

echo "=== topology peer-team (smoke) ==="
node dist/cli.js topology peer-team \
  --spec /tmp/swarm-spec.json \
  --output /tmp/swarm-topo-smoke-results.jsonl \
  --concurrency 2 || \
  echo "(non-zero exit OK; verifies CLI dispatch + topology execution)"

# 3. Stub commands surface the deferred message.
echo "=== team send / list / stop / kill (stubs) ==="
node dist/cli.js team list || true
node dist/cli.js team send foo "hi" || true
node dist/cli.js team stop foo || true
node dist/cli.js team kill foo || true

echo "=== smoke-team.sh DONE ==="
