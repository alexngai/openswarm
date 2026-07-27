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

# Work packages defined in docs/63, plus WP-00a — the adoption package the
# WP-00 re-estimate recommends inserting before WP-03, which moves the
# production path onto the frozen contracts. Packages without an implemented
# gate are still declared so --list stays honest about what remains.
KNOWN_WPS=(baseline)
for n in $(seq -w 0 33); do
  KNOWN_WPS+=("WP-$n")
  [[ "$n" == "00" ]] && KNOWN_WPS+=("WP-00a")
done

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

list_targets() {
  echo "Implemented gates:"
  echo "  baseline   existing repository suite (mirrors .github/workflows/ci.yml)"
  echo "  WP-00      effect-transaction walking skeleton"
  echo "  WP-00a     production adoption of the frozen contracts (partial)"
  echo "  WP-01      capability manifest and evidence harness"
  echo
  echo "Declared but not yet implemented (exit 2):"
  printf '%s\n' "${KNOWN_WPS[@]:1}" \
    | grep -vx -e 'WP-00' -e 'WP-00a' -e 'WP-01' \
    | paste -sd' ' - | fold -sw 76 | sed 's/^/  /'
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

# Records a fixture that the work package requires but has not implemented yet.
# Counts as a failure so a partially built work package cannot report green.
pending_check() {
  local id="$1" desc="$2"
  FAIL=$((FAIL + 1))
  printf '  %-4s %-52s PENDING\n' "$id" "$desc"
  CHECKS_JSON+=("$(printf '{"id":"%s","description":"%s","status":"PENDING","duration_s":0,"exit_code":null,"log":null}' \
    "$id" "$(json_escape "$desc")")")
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

  WP-00)
    # Effect-transaction walking skeleton. Threshold (docs/63): the durability
    # invariant passes, and the encrypted 90-day default plus secure-key-missing
    # ephemeral behaviour are explicit.
    FIXTURES="FX-EFFECT-001,FX-CRASH-001,FX-STORAGE-DEFAULT-001"
    if ! ensure_deps; then
      RESULT="error"
      FAIL=$((FAIL + 1))
    else
      run_check E1 "frozen contracts type-check" \
        npx tsc -p tsconfig.build.json --noEmit
      run_check E2 "FX-EFFECT-001 durability order and write CAS" \
        npx vitest run src/kernel/effect-runtime.test.ts
      run_check E3 "FX-EFFECT-001 canonical path authority" \
        npx vitest run src/kernel/workspace-authority.test.ts
      run_check E4 "FX-CRASH-001 journal commit and torn-write recovery" \
        npx vitest run src/kernel/event-store.test.ts
      run_check E5 "discriminated policy and grant scoping" \
        npx vitest run src/kernel/policy-engine.test.ts
      run_check E6 "FX-STORAGE-DEFAULT-001 encryption, retention, key fallback" \
        npx vitest run src/kernel/storage-policy.test.ts
    fi
    ;;

  WP-00a)
    # Production adoption of the frozen contracts. WP-00 proved the kernel in
    # isolation; this gate asks whether the code users actually run goes
    # through it. Threshold: every engine gates tool calls, every tool declares
    # what it touches, and containment is decided in one place.
    FIXTURES="FX-ESCAPE-001,FX-GATE-001"
    if ! ensure_deps; then
      RESULT="error"
      FAIL=$((FAIL + 1))
    else
      run_check A1 "resource-access declarations are honest" \
        npx vitest run src/tools/access-contract.test.ts
      run_check A2 "FX-ESCAPE-001 central containment, incl. symlinked parent" \
        npx vitest run src/permissions/path-containment.test.ts
      run_check A3 "FX-GATE-001 every engine gates tool calls" \
        npx vitest run src/engine/codex-framework.test.ts
      run_check A4 "tier-1 file tools confined" \
        npx vitest run src/tools/tier1/notebook_edit.test.ts src/tools/tier1/view_image.test.ts
      run_check A5 "permission gate suite intact" \
        npx vitest run src/permissions/
      run_check A6 "discriminated authorization binds grants to a resource" \
        npx vitest run src/permissions/gate.test.ts src/kernel/policy-engine.test.ts
      run_check A7 "approval scope reflects what the user chose" \
        npx vitest run src/permissions/policy-broker.test.ts
      run_check A8 "per-tool containment consolidated onto one helper" \
        npx vitest run src/tools/workspace-path.test.ts
    fi
    ;;

  WP-01)
    # Capability manifest and evidence harness. Threshold (docs/63): every ID has
    # evidence ownership, and the corpus, comparator, model IDs, statistics, and
    # guardrails are preregistered. The harness half of this package — this
    # script, compose.parity.yml, Dockerfile.parity — was built ahead of WP-00;
    # what these checks cover is the manifest half.
    FIXTURES="FX-MANIFEST-001,FX-CLAIM-001,FX-EVAL-PLAN-001"
    if ! ensure_deps; then
      RESULT="error"
      FAIL=$((FAIL + 1))
    else
      run_check M1 "FX-MANIFEST-001 every capability has resolvable evidence" \
        npx vitest run src/parity/validate.test.ts
      run_check M2 "capability status derives from artifacts, not assertion" \
        npx vitest run src/parity/status.test.ts
      run_check M3 "FX-CLAIM-001 manifest and docs/63 cannot diverge" \
        npx vitest run src/parity/docs-sync.test.ts
      run_check M4 "FX-EVAL-PLAN-001 preregistered corpus, comparators, margins" \
        npx vitest run src/parity/eval-plan.test.ts
      run_check M5 "FX-EVAL-PLAN-001 paired bootstrap and power rule" \
        npx vitest run src/parity/statistics.test.ts
      # The gate CI runs, over the real documents rather than fixtures. M1-M5
      # prove the checks work; this proves they currently pass on this tree.
      run_check M6 "manifest gate passes against the real documents" \
        bun scripts/check-parity-manifest.ts
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
