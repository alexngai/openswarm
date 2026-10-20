"""Load every graded cell of docs/07 §7 (stage 1) and §7.6 (stage 2) into rows."""
import glob
import json
import os
import re
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else "."
RUNS = {
    "openswarm/eval/.eval-runs/division": 1,
    "openswarm/eval/.eval-runs/stage1": 1,
    "openswarm/eval/.eval-runs/search-attempt": 1,
    "openswarm/eval/.eval-runs/search-rounds": 1,
}
for d in glob.glob(f"{ROOT}/openswarm-s2/eval/.eval-runs/stage2-*"):
    if os.path.isdir(d) and ".void" not in d:
        RUNS[os.path.relpath(d, ROOT)] = 2


def usd(u):
    return (u.get("inputTokens", 0) * 5 + u.get("cacheReadTokens", 0) * 0.5 + u.get("outputTokens", 0) * 30) / 1e6


def phases(stdout: str) -> list[bool]:
    out = []
    for block in re.split(r"^=== Phase \d+:", stdout, flags=re.M)[1:]:
        marks = re.findall(r"^(PASSED|FAILED)$", block, flags=re.M)
        out.append(bool(marks) and marks[-1] == "PASSED")
    return out


rows = []
for run, stage in RUNS.items():
    base = f"{ROOT}/{run}"
    vo = glob.glob(f"{base}/verifier-out/*/")
    for f in glob.glob(f"{base}/cache/*.json"):
        if f.endswith(".submission.json"):
            continue
        d = json.load(open(f))
        task = d["taskId"].split("/")[1]
        arm, seed = d["armId"], int(d["seed"])
        cands = sorted(v for v in vo if os.path.basename(v.rstrip("/")).startswith(f"{task}.{arm}.s{seed}."))
        rec = {"stage": stage, "run": os.path.basename(run), "task": task, "arm": arm, "seed": seed,
               "usd": round(usd(d.get("usage") or {}), 2), "minutes": round(d.get("durationMs", 0) / 60000, 1),
               "phase_screen": "arms-" not in run and stage == 2}
        for v in reversed(cands):
            rj = glob.glob(f"{v}*.reward.json")
            if not rj:
                continue
            rec["reward"] = round(float(json.load(open(rj[0]))["reward"]), 4)
            so = glob.glob(f"{v}*.stdout.txt")
            rec["phases"] = phases(open(so[0], errors="replace").read()) if so else []
            dj = glob.glob(f"{v}*.division.json")
            if dj:
                dv = json.load(open(dj[0]))
                rec["threads"] = {k: {"rounds": len(t.get("rounds") or []), "landed": t.get("landed"),
                                      "changed": [r.get("changed") for r in t.get("rounds") or []],
                                      "error": bool(t.get("error")),
                                      "minutes": round(((t.get("endMs") or 0) - (t.get("startMs") or 0)) / 60000, 1) if t.get("endMs") else None}
                                  for k, t in dv["threads"].items()}
                rec["landings"] = [(l["thread"], l["outcome"], (l.get("check") or {}).get("ok"), bool(l.get("repair"))) for l in dv.get("landings", [])]
                fin = dv.get("final") or {}
                rec["review"] = [(t.get("target"), t.get("status")) for t in (fin.get("review") or {}).get("targets") or []]
                rec["repairs"] = [(r["thread"], r["targets"]) for r in fin.get("repairs", [])]
            break
        if "reward" not in rec and (d.get("score") or {}).get("total"):
            # Stage 1's search runs shared one verifier-out; their parser audit matched reward.json.
            sc = d["score"]
            rec["reward"] = round(sc["earned"] / sc["total"], 4)
            rec["phases"] = [c["passed"] for c in sc["checkpoints"] if c["id"].startswith("phase-")]
            rec["reward_from"] = "parser"
        rows.append(rec)

json.dump(rows, open(f"{ROOT}/cells.json", "w"), indent=0)
print(len(rows), "cells;", sum(1 for r in rows if "reward" in r), "graded")
from collections import Counter
print(Counter((r["stage"], r["run"] if r["stage"] == 1 else ("screen" if r["phase_screen"] else "arms"), r["arm"]) for r in rows))
