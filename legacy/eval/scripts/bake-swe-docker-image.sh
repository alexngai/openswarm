#!/usr/bin/env bash
# bake-swe-docker-image.sh — pre-bake a local Docker image for the cascade-swe eval's DOCKER backend.
#
# The self-hosted (x86 EC2) counterpart to E2B's `buildSweTemplates`. It reproduces, in a plain
# `docker build`, the EXACT bake the E2B template does: FROM the swebench per-instance image (which
# ships NO node), install a self-contained node tarball to /opt/node, `npm install -g --prefix
# /opt/node` the two LOCAL tarballs (skill-tree + openswarm) so the openswarm CLI is available, and
# symlink node/npm/npx/openswarm onto /usr/local/bin. The install steps below are copied VERBATIM
# from swarmkit-eval `npmCliInstall()` (backends/e2b-template.ts) so build+run parity with E2B holds.
#
# Usage:
#   bash eval/scripts/bake-swe-docker-image.sh <instanceId> <swebench-image> [<baked-tag>]
#
# Requires (packed once, up front):  bash eval/scripts/pack-local-harness.sh
#   → eval/.artifacts/openswarm-local.tgz  and  eval/.artifacts/skill-tree-local.tgz
#
# On an arm64 host (e.g. a dev Mac) the swebench x86_64 images run under emulation — pass
# CS_DOCKER_PLATFORM=linux/amd64 (slow but fine for a wiring smoke). On x86 EC2 leave it unset.
#
# cascade-swe.ts calls this per instance when BACKEND=docker; it is also runnable standalone.
set -euo pipefail

INSTANCE_ID="${1:?usage: bake-swe-docker-image.sh <instanceId> <swebench-image> [tag]}"
BASE_IMAGE="${2:?usage: bake-swe-docker-image.sh <instanceId> <swebench-image> [tag]}"
TAG="${3:-cs-${INSTANCE_ID}:baked}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
ART="eval/.artifacts"

# Resolve the two local tarballs (follow the stable symlinks the packer creates).
OPENSWARM_TGZ="$ART/openswarm-local.tgz"
SKILLTREE_TGZ="$ART/skill-tree-local.tgz"
for f in "$OPENSWARM_TGZ" "$SKILLTREE_TGZ"; do
  [ -e "$f" ] || { echo "[bake] missing $f — run: bash eval/scripts/pack-local-harness.sh" >&2; exit 1; }
done

# The self-contained node tarball URL is the SAME one npmCliInstall() uses (v22.12.0 linux-x64).
NODE_TARBALL="${CS_NODE_TARBALL:-https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.gz}"

# Stage a build context with just the two tarballs (Docker COPY can't reach outside the context).
CTX="$(mktemp -d)"
trap 'rm -rf "$CTX"' EXIT
cp -L "$OPENSWARM_TGZ" "$CTX/openswarm-local.tgz"
cp -L "$SKILLTREE_TGZ" "$CTX/skill-tree-local.tgz"

# The RUN steps below MIRROR swarmkit-eval npmCliInstall("<openswarm-tgz> <skilltree-tgz>", ["openswarm"]):
#   node bootstrap → symlink node/npm/npx → npm install -g --prefix /opt/node <pkgs> → symlink bins → version.
# Both tarballs go in ONE `npm install` so openswarm→skill-tree resolves from the co-installed tgz, not npm.
cat > "$CTX/Dockerfile" <<DOCKERFILE
FROM ${BASE_IMAGE}
COPY skill-tree-local.tgz /opt/skill-tree-local.tgz
COPY openswarm-local.tgz  /opt/openswarm-local.tgz
RUN command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || (apt-get update && apt-get install -y curl) || true
RUN curl -fsSL ${NODE_TARBALL} -o /tmp/node.tgz || wget -qO /tmp/node.tgz ${NODE_TARBALL}
RUN mkdir -p /opt/node && tar -xzf /tmp/node.tgz -C /opt/node --strip-components=1
RUN for b in node npm npx; do ln -sf /opt/node/bin/\$b /usr/local/bin/\$b; done
RUN /opt/node/bin/npm install -g --omit=optional --no-audit --no-fund --prefix /opt/node /opt/skill-tree-local.tgz /opt/openswarm-local.tgz
RUN for b in openswarm; do ln -sf /opt/node/bin/\$b /usr/local/bin/\$b; done
RUN /opt/node/bin/openswarm --version
DOCKERFILE

PLATFORM_ARG=()
if [ -n "${CS_DOCKER_PLATFORM:-}" ]; then
  PLATFORM_ARG=(--platform "$CS_DOCKER_PLATFORM")
fi

echo "[bake] $INSTANCE_ID: FROM $BASE_IMAGE → $TAG ${CS_DOCKER_PLATFORM:+(platform $CS_DOCKER_PLATFORM)}" >&2
docker build "${PLATFORM_ARG[@]}" -t "$TAG" -f "$CTX/Dockerfile" "$CTX" 1>&2
echo "$TAG"
