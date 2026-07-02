#!/usr/bin/env bash
# Build + pack the LOCAL openswarm so evals run our working-tree changes without publishing.
# Output: eval/.artifacts/openswarm-local.tgz (stable symlink → the versioned tarball).
#
# Local-FS backends (in-process) don't need this — they run the built CLI directly via
# `localSwarmHarness()` (eval/harness/local.ts). The tarball is for SANDBOX backends (E2B/docker),
# which must install the package inside the sandbox. See eval/README → "E2B local-harness transport".
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
ART="eval/.artifacts"
mkdir -p "$ART"
# Use the PUBLISH build (tsconfig.build.json) — excludes tests, so a dirty test tree doesn't block packing.
echo "[pack] tsc publish build (npm run build)…" >&2
npm run build >/dev/null
echo "[pack] npm pack → $ART …" >&2
TARBALL="$(npm pack --pack-destination "$ART" | tail -1)"
ln -sfn "$TARBALL" "$ART/openswarm-local.tgz"
echo "[pack] packed: $ART/$TARBALL" >&2

# Also pack the UNPUBLISHED local sibling dep `skill-tree` (the working tree needs ^0.3.0, but npm has
# only ≤0.2.1). It's installed alongside openswarm in the sandbox so `npm install` resolves the dep
# from the co-installed tarball instead of the registry.
ST_DIR="$(readlink "$ROOT/node_modules/skill-tree" 2>/dev/null || true)"
if [ -n "$ST_DIR" ] && [ -d "$ST_DIR" ]; then
  echo "[pack] building + packing skill-tree from $ST_DIR …" >&2
  ( cd "$ST_DIR" && { npm run build >/dev/null 2>&1 || true; } && npm pack --pack-destination "$ROOT/$ART" >/dev/null )
  ST_TGZ="$(cd "$ART" && ls -t skill-tree-*.tgz | head -1)"
  ln -sfn "$ST_TGZ" "$ART/skill-tree-local.tgz"
  echo "[pack] skill-tree: $ART/$ST_TGZ" >&2
else
  echo "[pack] WARN: skill-tree sibling not found — local install may fail to resolve skill-tree" >&2
fi
echo "$ART/$TARBALL"
