#!/usr/bin/env bash
# scripts/verify-parity-wp.sh — the single verification entry point for the
# product-parity program (docs/63 §Per-work-package verification contract).
#
# Every work package is verified through one command shape so that each run
# produces one comparable, machine-readable artifact:
#
#   docker compose -f compose.parity.yml run --rm parity \
#     ./scripts/verify-parity-wp.sh <WP> <cell>
#
# Usage:
#   ./scripts/verify-parity-wp.sh --list                # known targets
#   ./scripts/verify-parity-wp.sh baseline linux-x64    # existing repo suite
#   ./scripts/verify-parity-wp.sh WP-00 linux-x64       # a work-package gate
#
# Environment:
#   VERBOSE=1                 stream check output instead of capturing it
#   OPENSWARM_PARITY_IMAGE    image digest to record in the artifact
#
# Writes artifacts/parity/<WP>/<cell>.json plus per-check logs under
# artifacts/parity/<WP>/logs/<cell>/.
#
# Exit codes:
#   0  every check passed
#   1  at least one check failed
#   2  the requested work package has no implemented gate yet
#   3  usage error
#
# A work package with no gate exits nonzero on purpose: an unimplemented
# capability must never be able to report green.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Work packages defined in docs/63. Only `baseline` has an implemented gate;
# the rest are declared so --list stays honest about what remains.
KNOWN_WPS=(baseline)
for n in $(seq -w 0 33); do KNOWN_WPS+=("WP-$n"); done

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

list_targets() {
  echo "Implemented gates:"
  echo "  baseline   existing repository suite (mirrors .github/workflows/ci.yml)"
  echo
  echo "Declared but not yet implemented (exit 2):"
  printf '  %s\n' "${KNOWN_WPS[@]:1}" | paste -sd' ' - | fold -sw 76 | sed 's/^/  /'
  echo
  echo "See docs/63-product-parity-roadmap.md for each gate's fixtures and threshold."
}

case "${1:-}" in
  --list|-l) list_targets; exit 0 ;;
  --help|-h) usage; exit 0 ;;
esac

WP="${1:-}"
CELL="${2:-}"

if [[ -z "$WP" || -z "$CELL" ]]; then
  echo "error: expected <WP> <cell>" >&2
  echo >&2
  usage >&2
  exit 3
fi

if ! printf '%s\n' "${KNOWN_WPS[@]}" | grep -qx -- "$WP"; then
  echo "error: unknown work package '$WP' (try --list)" >&2
  exit 3
fi

OUT_DIR="$REPO_ROOT/artifacts/parity/$WP"
LOG_DIR="$OUT_DIR/logs/$CELL"
mkdir -p "$LOG_DIR"

# ---------------------------------------------------------------------------
# Environment capture. Recorded in the artifact so a result can be reproduced
# or invalidated later.
# ---------------------------------------------------------------------------
COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then DIRTY=true; else DIRTY=false; fi
PLATFORM="$(uname -s)/$(uname -m)"
NODE_VERSION="$(node -v 2>/dev/null || echo absent)"
BUN_VERSION="$(bun -v 2>/dev/null || echo absent)"
OS_NAME="$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -sr)"
IMAGE_DIGEST="${OPENSWARM_PARITY_IMAGE:-unrecorded}"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

PASS=0
FAIL=0
CHECKS_JSON=()

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

run_check() {
  local id="$1" desc="$2"; shift 2
  local log="$LOG_DIR/$id.log" t0 t1 dur status rc
  t0=$(date +%s)
  printf '  %-4s %-52s ' "$id" "$desc"

  if [[ "${VERBOSE:-0}" == "1" ]]; then
    echo
    "$@" 2>&1 | tee "$log"
    rc=${PIPESTATUS[0]}
  else
    "$@" >"$log" 2>&1
    rc=$?
  fi

  t1=$(date +%s); dur=$((t1 - t0))

  if [[ $rc -eq 0 ]]; then
    status=PASS; PASS=$((PASS + 1))
    printf 'PASS  %3ds\n' "$dur"
  else
    status=FAIL; FAIL=$((FAIL + 1))
    printf 'FAIL  %3ds  (rc=%d)\n' "$dur" "$rc"
    if [[ "${VERBOSE:-0}" != "1" ]]; then
      echo "    ---- last 40 lines of ${log#"$REPO_ROOT"/} ----"
      tail -n 40 "$log" | sed 's/^/    /'
      echo "    ---- end ----"
    fi
  fi

  CHECKS_JSON+=("$(printf '{"id":"%s","description":"%s","status":"%s","duration_s":%d,"exit_code":%d,"log":"%s"}' \
    "$id" "$(json_escape "$desc")" "$status" "$dur" "$rc" "${log#"$REPO_ROOT"/}")")
}

ensure_deps() {
  # The container masks node_modules with its own volume, so the first run in
  # a fresh volume installs. Later runs reuse it.
  if [[ ! -d node_modules/typescript ]]; then
    echo "  ..   installing dependencies (npm ci, first run in this volume)"
    npm ci >"$LOG_DIR/npm-ci.log" 2>&1 || {
      echo "  !!   npm ci failed; see ${LOG_DIR#"$REPO_ROOT"/}/npm-ci.log" >&2
      tail -n 40 "$LOG_DIR/npm-ci.log" | sed 's/^/    /' >&2
      return 1
    }
  fi
}

# ---------------------------------------------------------------------------
# Gates
# ---------------------------------------------------------------------------
FIXTURES="none"
RESULT="unknown"

echo "parity: $WP / $CELL"
echo "  commit $COMMIT (dirty=$DIRTY)  $PLATFORM  node $NODE_VERSION  bun $BUN_VERSION"
echo

case "$WP" in
  baseline)
    # Mirrors .github/workflows/ci.yml so a green parity baseline and a green
    # CI run carry the same meaning. The compiled-binary step is intentionally
    # excluded: it pulls a ~205MB native helper and is covered by CI's own
    # per-OS matrix, not by this hermetic cell.
    FIXTURES="ci-parity"
    if ! ensure_deps; then
      RESULT="error"
      FAIL=$((FAIL + 1))
    else
      run_check B1 "bun.lock freshness (frozen-lockfile dry run)" \
        bun install --frozen-lockfile --dry-run
      run_check B2 "type-check (tsc -p tsconfig.build.json)" \
        npm run build
      run_check B3 "type-check eval harness" \
        npx tsc -p eval/tsconfig.json --noEmit
      run_check B4 "type-check experimental archive" \
        npx tsc -p experimental/tsconfig.json --noEmit
      run_check B5 "vitest suite (unit + integration)" \
        npm test
      run_check B6 "bun test (OpenTUI/Solid components)" \
        bun test src/ui/repl-solid/
    fi
    ;;

  *)
    echo "  no gate implemented for $WP yet."
    echo "  Its fixtures and threshold are specified in docs/63-product-parity-roadmap.md;"
    echo "  implement them here before the work package can report a result."
    echo
    RESULT="not-implemented"
    ;;
esac

# ---------------------------------------------------------------------------
# Artifact
# ---------------------------------------------------------------------------
FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [[ "$RESULT" == "unknown" ]]; then
  if [[ $FAIL -eq 0 && $PASS -gt 0 ]]; then RESULT="pass"; else RESULT="fail"; fi
fi

ARTIFACT="$OUT_DIR/$CELL.json"
{
  printf '{\n'
  printf '  "work_package": "%s",\n' "$WP"
  printf '  "cell": "%s",\n' "$CELL"
  printf '  "result": "%s",\n' "$RESULT"
  printf '  "passed": %d,\n' "$PASS"
  printf '  "failed": %d,\n' "$FAIL"
  printf '  "fixtures": "%s",\n' "$FIXTURES"
  printf '  "commit": "%s",\n' "$COMMIT"
  printf '  "working_tree_dirty": %s,\n' "$DIRTY"
  printf '  "platform": "%s",\n' "$PLATFORM"
  printf '  "os": "%s",\n' "$(json_escape "$OS_NAME")"
  printf '  "node": "%s",\n' "$NODE_VERSION"
  printf '  "bun": "%s",\n' "$BUN_VERSION"
  printf '  "image_digest": "%s",\n' "$(json_escape "$IMAGE_DIGEST")"
  printf '  "started_at": "%s",\n' "$STARTED_AT"
  printf '  "finished_at": "%s",\n' "$FINISHED_AT"
  printf '  "checks": [\n'
  local_first=1
  for c in ${CHECKS_JSON[@]+"${CHECKS_JSON[@]}"}; do
    if [[ $local_first -eq 1 ]]; then local_first=0; else printf ',\n'; fi
    printf '    %s' "$c"
  done
  [[ ${#CHECKS_JSON[@]} -gt 0 ]] && printf '\n'
  printf '  ]\n'
  printf '}\n'
} >"$ARTIFACT"

echo
echo "  result: $RESULT ($PASS passed, $FAIL failed)"
echo "  artifact: ${ARTIFACT#"$REPO_ROOT"/}"

case "$RESULT" in
  pass)            exit 0 ;;
  not-implemented) exit 2 ;;
  *)               exit 1 ;;
esac
