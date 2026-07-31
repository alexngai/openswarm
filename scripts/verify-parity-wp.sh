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
#   OPENSWARM_PARITY_LIVE=1   permit the `live` target to call a real provider
#   OPENSWARM_LIVE_MODELS     comma-separated model ids for the `live` target
#
# Writes artifacts/parity/<WP>/<cell>.json plus per-check logs under
# artifacts/parity/<WP>/logs/<cell>/.
#
# Exit codes:
#   0  every check passed
#   1  at least one check failed
#   2  the requested work package has no implemented gate yet
#   3  usage error
#   4  nothing ran (the live target without OPENSWARM_PARITY_LIVE=1, or with no
#      usable credential) — never conflated with 0, since a cell that certified
#      nothing must not be readable as a cell that passed
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
KNOWN_WPS=(baseline live)
for n in $(seq -w 0 33); do
  KNOWN_WPS+=("WP-$n")
  [[ "$n" == "00" ]] && KNOWN_WPS+=("WP-00a")
done

usage() {
  sed -n '2,35p' "$0" | sed 's/^# \{0,1\}//'
}

list_targets() {
  echo "Implemented gates:"
  echo "  baseline   existing repository suite (mirrors .github/workflows/ci.yml)"
  echo "  WP-00      effect-transaction walking skeleton"
  echo "  WP-00a     production adoption of the frozen contracts (partial)"
  echo "  WP-01      capability manifest and evidence harness"
  echo "  WP-02      repository trust and configuration provenance"
  echo "  WP-03      canonical path authorization"
  echo "  WP-04      process broker and fail-closed shell baseline"
  echo "  WP-05      retry operation ledger and cancellation barrier"
  echo "  WP-06      atomic task transitions and safe target CAS"
  echo "  WP-07      session schema, journal, snapshots, and importer"
  echo "  WP-09      approval broker and headless default deny"
  echo
  echo "Opt-in only (spends real tokens, needs OPENSWARM_PARITY_LIVE=1):"
  echo "  live       probes against a real provider; set OPENSWARM_LIVE_MODELS"
  echo
  echo "Declared but not yet implemented (exit 2):"
  printf '%s\n' "${KNOWN_WPS[@]:1}" \
    | grep -vx -e 'live' -e 'WP-00' -e 'WP-00a' -e 'WP-01' -e 'WP-02' -e 'WP-03' \
    -e 'WP-04' -e 'WP-05' -e 'WP-06' -e 'WP-07' -e 'WP-09' \
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

# A check that can legitimately have no result. Only the live target uses it: a
# probe against a model whose credential is absent (exit 4) has certified
# nothing, which is neither a pass nor a defect. Counted separately so that a
# run where every model was unconfigured cannot report pass on an empty set.
SKIP=0
run_probe() {
  local id="$1" desc="$2"; shift 2
  local log="$LOG_DIR/$id.log" t0 t1 dur rc
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

  if [[ $rc -eq 4 ]]; then
    SKIP=$((SKIP + 1))
    printf 'SKIP  %3ds  (no credential)\n' "$dur"
    CHECKS_JSON+=("$(printf '{"id":"%s","description":"%s","status":"SKIP","duration_s":%d,"exit_code":%d,"log":"%s"}' \
      "$id" "$(json_escape "$desc")" "$dur" "$rc" "${log#"$REPO_ROOT"/}")")
    return 0
  fi

  if [[ $rc -eq 0 ]]; then
    PASS=$((PASS + 1))
    printf 'PASS  %3ds\n' "$dur"
    CHECKS_JSON+=("$(printf '{"id":"%s","description":"%s","status":"PASS","duration_s":%d,"exit_code":%d,"log":"%s"}' \
      "$id" "$(json_escape "$desc")" "$dur" "$rc" "${log#"$REPO_ROOT"/}")")
    return 0
  fi

  FAIL=$((FAIL + 1))
  printf 'FAIL  %3ds  (rc=%d)\n' "$dur" "$rc"
  if [[ "${VERBOSE:-0}" != "1" ]]; then
    echo "    ---- last 40 lines of ${log#"$REPO_ROOT"/} ----"
    tail -n 40 "$log" | sed 's/^/    /'
    echo "    ---- end ----"
  fi
  CHECKS_JSON+=("$(printf '{"id":"%s","description":"%s","status":"FAIL","duration_s":%d,"exit_code":%d,"log":"%s"}' \
    "$id" "$(json_escape "$desc")" "$dur" "$rc" "${log#"$REPO_ROOT"/}")")
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

  WP-03)
    # Canonical path authorization. Threshold (docs/63): the generated and
    # swap-race escape corpus reports zero unauthorized access. WP-00a
    # delivered the design half — one central check, one shared helper — so
    # what remains is the part that can only be established by attacking it.
    FIXTURES="FX-PATH-001..020,generated-corpus"
    if ! ensure_deps; then
      RESULT="error"
      FAIL=$((FAIL + 1))
    else
      run_check P1 "broken links resolve to their target, not their own location" \
        npx vitest run src/kernel/workspace-authority.test.ts
      run_check P2 "an unprovable path is a denied path, not a raw errno" \
        npx vitest run src/tools/workspace-path.test.ts
      run_check P3 "FX-PATH-001..020 generated corpus grants no unauthorized access" \
        npx vitest run src/tools/path-escape-corpus.test.ts
      # Asserts nothing outside the workspace where renames anchor, and no
      # chosen content outside where they do not. See WP-25 for prevention.
      run_check P4 "swap race leaves no chosen content outside the workspace" \
        npx vitest run src/tools/path-swap-race.test.ts
      run_check P5 "notebook writes are atomic and read-gated" \
        npx vitest run src/tools/tier1/notebook_edit.test.ts
      run_check P6 "every file tool still agrees with the shared helper" \
        npx vitest run src/tools/tier0/ src/tools/access-contract.test.ts
    fi
    ;;

  WP-02)
    # Repository trust and configuration provenance. Threshold (docs/63):
    # malicious-clone fixtures cause zero process, network, or secret activity
    # before trust. T2 is the one that actually establishes that — it runs the
    # built CLI in a hostile repository and looks for evidence, rather than
    # asking each loader whether it behaved.
    FIXTURES="FX-TRUST-001..006"
    if ! ensure_deps; then
      RESULT="error"
      FAIL=$((FAIL + 1))
    else
      run_check T1 "FX-TRUST-001..006 a malicious clone activates nothing" \
        npx vitest run src/trust/malicious-clone.test.ts
      # Needs dist/: the probe runs the real entry point, not an import of it.
      run_check T2 "opening a hostile repository leaves no evidence behind" \
        sh -c "npm run build && npx vitest run src/trust/startup-activation.test.ts"
      run_check T3 "an untrusted workspace keeps the user's own configuration" \
        npx vitest run src/hooks/ src/mcp/
      run_check T4 "the SDK is not handed project settings before trust" \
        npx vitest run src/engine/claude-agent-sdk.test.ts
      run_check T5 "skill discovery honours the trust decision" \
        npx vitest run src/skills/
      run_check T6 "runtime assembly cannot be reached without a decision" \
        npx vitest run src/cli/runtime.test.ts
    fi
    ;;

  WP-04)
    # Process broker and fail-closed shell baseline. Threshold (docs/63): zero
    # direct untrusted spawns, and an unavailable `require` executes nothing.
    #
    # C1 is the load-bearing check and the only one that can observe the
    # package's actual claim. Every other check here asks one caller whether it
    # behaves; C1 intercepts `node:child_process` and asks the process what was
    # launched, which is the question a newly added caller silently answers
    # wrong.
    FIXTURES="FX-PROC-001..012"
    if ! ensure_deps; then
      RESULT="error"
      FAIL=$((FAIL + 1))
    else
      run_check C1 "FX-PROC-001..012 nothing launches outside the broker" \
        npx vitest run src/process/spawn-corpus.test.ts
      run_check C2 "broker registry, cancellation, and require refusal" \
        npx vitest run src/process/broker.test.ts
      run_check C3 "killing a child reaps its process tree" \
        npx vitest run src/process/tree.test.ts
      run_check C4 "the session's permission mode governs codex's own tooling" \
        npx vitest run src/engine/codex-framework.test.ts src/providers/codex-app-server.test.ts
      run_check C5 "isolation is selectable and reported honestly" \
        npx vitest run src/cli/argv.test.ts src/cli/doctor.test.ts
      run_check C6 "output is bounded while reading, not at close" \
        npx vitest run src/tools/tier0/bounded-output.test.ts src/tools/tier0/shell-session.test.ts
      run_check C7 "shell tools still behave through the broker" \
        npx vitest run src/tools/tier0/bash.test.ts src/tools/tier0/shell.test.ts src/tools/tier0/sandbox.test.ts
      run_check C8 "hooks, MCP, and plugins still behave through the broker" \
        npx vitest run src/hooks/ src/mcp/ src/plugins/
    fi
    ;;

  WP-05)
    # Retry operation ledger and cancellation barrier. Threshold (docs/63):
    # fault injection around dispatch never duplicates a mutating call.
    #
    # R1 is the load-bearing check. Two independent mechanisms have to hold —
    # nothing that can leave a trace is speculated on, and the ledger accounts
    # for whatever did start — and R1 is what fails if either weakens, because
    # it counts dispatches rather than reading back results. A duplicated write
    # is invisible in the result the model finally sees.
    FIXTURES="FX-RETRY-001..010"
    if ! ensure_deps; then
      RESULT="error"
      FAIL=$((FAIL + 1))
    else
      run_check R1 "FX-RETRY-001..010 a retried turn performs no effect twice" \
        npx vitest run src/engine/retry-duplication.test.ts
      run_check R2 "operation identity survives a retry and separates distinct calls" \
        npx vitest run src/engine/operation-ledger.test.ts
      run_check R3 "retry, eager dispatch, and abort behave as before" \
        npx vitest run src/engine/hardened-native.test.ts
      run_check R4 "the unhardened engine and the dispatcher are unaffected" \
        npx vitest run src/engine/native.test.ts src/tools/dispatcher.test.ts
      run_check R5 "the kernel's own durability order still holds" \
        npx vitest run src/kernel/effect-runtime.test.ts src/kernel/event-store.test.ts
    fi
    ;;

  WP-06)
    # Atomic task transitions and safe target CAS. Threshold (docs/63):
    # 10,000 claim attempts produce one owner; a moved target loses no commit.
    #
    # C1 and C4 are the load-bearing checks, and they fail differently. C1 is
    # about authority — who is allowed to say a task changed state — and it
    # catches a regression that no amount of concurrency testing would, because
    # a forged transition is perfectly well-ordered. C4 is about a landing that
    # reports success while dropping commits, which is the one failure here that
    # destroys work rather than confusing bookkeeping.
    FIXTURES="FX-CLAIM-002, FX-CAS-001"
    if ! ensure_deps; then
      RESULT="error"
      FAIL=$((FAIL + 1))
    else
      run_check C1 "a transition is authorized against the caller the transport saw" \
        npx vitest run src/swarm/task-transition-authority.test.ts
      run_check C2 "FX-CLAIM-002 10,000 claim attempts produce one owner" \
        npx vitest run src/swarm/task-claim-atomicity.test.ts
      run_check C3 "the registry, the lane events, and results.jsonl agree on an outcome" \
        npx vitest run src/swarm/task-registry.test.ts src/swarm/task-stop-self.test.ts
      run_check C4 "FX-CAS-001 a moved target loses no commit" \
        npx vitest run src/swarm/adapters/git-cascade-target-cas.test.ts
      run_check C5 "landing, conflict retain, and the task tools are unaffected" \
        npx vitest run src/swarm/adapters/ src/tools/tier2/
    fi
    ;;

  live)
    # Probes against a real provider (docs/63 §Platform matrix, live-provider
    # cells). Not a work-package gate: it does not certify a capability, it
    # checks that the seams between the model, the process, and the filesystem
    # still line up on a machine with credentials.
    #
    # It exists because WP-09's twelve in-process fixtures all passed while a
    # real headless run exited 0 with a tool call outstanding. Every fixture
    # handed the approval reader a fresh stream and asked once; a real run asks
    # twice, and that difference was the whole bug.
    #
    # Two independent locks, because the failure mode of a live cell is a bill
    # and a leaked credential, not a red check:
    #
    #   1. The target has to be named. It is never reached by a matrix over
    #      KNOWN_WPS, since those are all WP-*.
    #   2. OPENSWARM_PARITY_LIVE=1 has to be set, so a copied command line or a
    #      CI job that enumerates --list output still runs nothing.
    #
    # A missing credential reports skipped, never passed. A live cell that
    # cannot reach a provider has certified nothing, and saying otherwise is how
    # a matrix ends up green with no live coverage at all.
    FIXTURES="FX-LIVE-001..005"
    if [[ "${OPENSWARM_PARITY_LIVE:-0}" != "1" ]]; then
      echo "  live probes spend real tokens against a real provider."
      echo "  Set OPENSWARM_PARITY_LIVE=1 to run them, and OPENSWARM_LIVE_MODELS"
      echo "  to a comma-separated list of model ids, e.g.:"
      echo
      echo "    OPENSWARM_PARITY_LIVE=1 OPENSWARM_LIVE_MODELS=azureoai/gpt-5.5 \\"
      echo "      ./scripts/verify-parity-wp.sh live $CELL"
      RESULT="skipped"
    elif [[ -z "${OPENSWARM_LIVE_MODELS:-}" ]]; then
      echo "  error: OPENSWARM_LIVE_MODELS is unset; there is no default model" >&2
      echo "  on purpose — a live cell records which model it certified." >&2
      RESULT="skipped"
    elif ! ensure_deps; then
      RESULT="error"
      FAIL=$((FAIL + 1))
    else
      # The probes drive the compiled CLI as a subprocess, exactly as a user
      # does, so dist has to exist and be current. Nothing else in this target
      # is worth running if it is stale.
      run_check L0 "compile, so the probes drive the current CLI" \
        npm run build

      IFS=',' read -ra LIVE_MODELS <<<"$OPENSWARM_LIVE_MODELS"
      n=0
      for model in "${LIVE_MODELS[@]}"; do
        model="$(printf '%s' "$model" | tr -d '[:space:]')"
        [[ -z "$model" ]] && continue
        n=$((n + 1))
        run_probe "L$n" "FX-LIVE-001..005 against $model" \
          ./scripts/live-probe.sh "$model"
      done
      if [[ $n -eq 0 ]]; then
        echo "  error: OPENSWARM_LIVE_MODELS named no models" >&2
        RESULT="skipped"
      elif [[ $FAIL -eq 0 && $SKIP -eq $n ]]; then
        # Every model named was unconfigured. The build compiled, so PASS is
        # nonzero and the generic rule below would call this a pass.
        echo "  every named model lacked a credential; no live coverage" >&2
        RESULT="skipped"
      fi
    fi
    ;;

  WP-09)
    # Approval broker and headless default deny. Threshold (docs/63): absent,
    # invalid, expired, replayed, disconnected, or late approvals deny.
    #
    # A1 is the load-bearing check. Approval gates are not judged on the path
    # where somebody says yes; they are judged on what "nobody said yes" does,
    # and every one of those paths has to end in a refusal that says which one it
    # was. A3 exists because failing closed forever is its own outage: one
    # unanswered prompt used to take the rest of the session with it.
    FIXTURES="FX-APPROVAL-001..012"
    if ! ensure_deps; then
      RESULT="error"
      FAIL=$((FAIL + 1))
    else
      run_check A1 "FX-APPROVAL-001..012 every way an approval fails to arrive denies" \
        npx vitest run src/permissions/approval-denials.test.ts
      run_check A2 "a grant expires, runs out, is revoked, or loses its workspace" \
        npx vitest run src/permissions/grant-lifetime.test.ts
      run_check A3 "the engine, the broker, and the bridge agree on a decision" \
        npx vitest run src/kernel/policy-engine.test.ts src/permissions/policy-broker.test.ts src/permissions/bridge.test.ts
      run_check A4 "the three approval surfaces are unaffected" \
        npx vitest run src/permissions/headless-prompt.test.ts src/acp/ src/permissions/gate.test.ts
      run_check A5 "the kernel effect path still authorizes before it acts" \
        npx vitest run src/kernel/
    fi
    ;;

  WP-07)
    # Session journal and snapshot durability. Threshold (docs/63): a recorded
    # event survives the process that recorded it, and a snapshot that reads
    # back is the snapshot that was written.
    #
    # J1 is the load-bearing check: two of its four fixtures were failing when
    # written, and both were silent data loss rather than an error anybody saw.
    # J6 is the one to read if the importer is ever changed — it asserts what an
    # import refuses and what it admits to losing, not what it converts.
    FIXTURES="FX-JOURNAL-001..012, FX-MIG-SESSION-001"
    if ! ensure_deps; then
      RESULT="error"
      FAIL=$((FAIL + 1))
    else
      # The crash fixtures run the writer in a real process and kill it, so they
      # need dist. The suite builds it via globalSetup, which the parity
      # environment disables (OPENSWARM_SKIP_INTEGRATION_BUILD=1), so the gate
      # owns that precondition rather than leaving a fixture to fail on an import.
      run_check J0 "compile, so the crash fixtures have a module to run" \
        npm run build
      run_check J1 "FX-JOURNAL-001..004 a recorded event outlives its recorder" \
        npx vitest run src/swarm/session-transcript-durability.test.ts
      run_check J2 "FX-JOURNAL-005..008 a snapshot that reads back is the one written" \
        npx vitest run src/swarm/atomic-snapshot.test.ts
      run_check J3 "resume state is checksummed, and still reads pre-WP-07 files" \
        npx vitest run src/swarm/team-checkpoint.test.ts
      run_check J4 "FX-JOURNAL-009..012 the append writers commit what they acknowledge" \
        npx vitest run src/swarm/durable-append.test.ts
      run_check J5 "the writers' consumers are unaffected by the migration" \
        npx vitest run src/swarm/session-recorder.test.ts src/swarm/team-daemon.test.ts src/cli/swarm.test.ts src/swarm/topologies/ test/integration/retry.test.ts
      run_check J6 "FX-MIG-SESSION-001 legacy sessions import, and say what they lost" \
        npx vitest run src/session/import.test.ts
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
if [[ $SKIP -gt 0 ]]; then
  echo "  result: $RESULT ($PASS passed, $FAIL failed, $SKIP skipped)"
else
  echo "  result: $RESULT ($PASS passed, $FAIL failed)"
fi
echo "  artifact: ${ARTIFACT#"$REPO_ROOT"/}"

case "$RESULT" in
  pass)            exit 0 ;;
  not-implemented) exit 2 ;;
  skipped)         exit 4 ;;
  *)               exit 1 ;;
esac
