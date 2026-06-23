#!/usr/bin/env bash
# Prep a small SWE-bench(-Verified) subset into eval/.artifacts/swe-instances/<id>.json
# (the full dataset row + precomputed eval_script, consumed by loadSweInstances). NO E2B/Docker here.
#
# Needs the swebench + datasets Python packages (heavy):  pip install swebench datasets
# Usage:  eval/scripts/prep-swe-subset.sh [instance_id …]   (defaults to a tiny 3-instance set)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
OUT="eval/.artifacts/swe-instances"
SWE_GRADE="node_modules/swarmkit-eval/dist/adapters/swe/swe_grade.py"

IDS=("$@")
if [ ${#IDS[@]} -eq 0 ]; then
  IDS=(astropy__astropy-12907 django__django-11099 sympy__sympy-20212)  # tiny default subset
fi

if ! python3 -c "import swebench, datasets" 2>/dev/null; then
  echo "[prep] missing Python deps. Run:  pip install swebench datasets" >&2
  exit 1
fi
[ -f "$SWE_GRADE" ] || { echo "[prep] $SWE_GRADE not found — is swarmkit-eval built/symlinked?" >&2; exit 1; }

mkdir -p "$OUT"
echo "[prep] swe_grade.py prep-batch → $OUT (${#IDS[@]} instances: ${IDS[*]})" >&2
python3 "$SWE_GRADE" prep-batch "$OUT" "${IDS[@]}"
echo "[prep] done: $(ls "$OUT"/*.json 2>/dev/null | wc -l | tr -d ' ') instance file(s) in $OUT" >&2
