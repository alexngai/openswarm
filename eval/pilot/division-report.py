#!/usr/bin/env python3
"""division-report.py <run dir>...: docs/07 §7's division arms against the single agent.

Reward and cost per task and arm from the harness's own cell records (cost at $5 / $0.50 /
$30 per M fresh input / cached input / output), for every run given: pass the division run
with the search runs, e.g. `search-attempt search-rounds search-selfrounds division`.
(a) is the mean over its attempts, and its cost here includes each attempt's review
(search-report.py has the agent-only figure); the other arms have one cell per task. For the division
arms it also reads each cell's division.json: landings, contract checks, final repairs.
"""
import glob, json, os, re, sys
from collections import defaultdict

ARMS = ["attempt", "selfrounds", "rounds", "divsharded", "divprogram"]
NAMES = {"attempt": "a", "selfrounds": "b0", "rounds": "b", "divsharded": "d", "divprogram": "e"}
cells = defaultdict(lambda: defaultdict(list))  # task -> arm -> [(reward, usd)]
for run in sys.argv[1:]:
    for f in glob.glob(f"{run}/cache/*.json"):
        if f.endswith(".submission.json"):
            continue
        d = json.load(open(f))
        u, s = d.get("usage") or {}, d.get("score") or {}
        if not s.get("total"):
            continue
        usd = (u.get("inputTokens", 0) * 5 + u.get("cacheReadTokens", 0) * 0.5 + u.get("outputTokens", 0) * 30) / 1e6
        cells[d["taskId"].split("/")[1]][d["armId"]].append((s["earned"] / s["total"], usd))

notes = defaultdict(dict)  # task -> arm -> summary of its division.json
for run in sys.argv[1:]:
    for f in glob.glob(f"{run}/verifier-out/**/*.division.json", recursive=True):
        d = json.load(open(f))
        task = re.match(r"(.+?)\.div", os.path.basename(os.path.dirname(f)))
        task = task.group(1) if task else "?"
        land = "".join({"merged": "m", "conflict": "C"}.get(l["outcome"], "?") for l in d["landings"])
        def check(l):  # no check, passed, repaired to a pass, failed
            if not l.get("check"):
                return "-"
            if l["check"]["ok"]:
                return "p"
            return "r" if ((l.get("repair") or {}).get("check") or {}).get("ok") else "F"
        checks = "".join(check(l) for l in d["landings"])
        rounds = ",".join(str(len(t.get("rounds") or [])) for t in d["threads"].values())
        fixes = len((d.get("final") or {}).get("repairs") or [])
        notes[task]["div" + d["arm"]] = f"land {land} check {checks} rounds {rounds} fixes {fixes}"

present = [a for a in ARMS if any(cells[t][a] for t in cells)]
print(f"{'task':<12} " + " ".join(f"{NAMES[a]:>12}" for a in present) + "   division notes")
rows = []
for task in sorted(cells):
    vals = {}
    for a in present:
        xs = cells[task][a]
        vals[a] = (sum(r for r, _ in xs) / len(xs), sum(c for _, c in xs) / len(xs)) if xs else None
    rows.append(vals)
    cell = lambda v: f"{v[0]:.2f} ${v[1]:>6.2f}" if v else f"{'-':>12}"
    print(f"{task:<12} " + " ".join(f"{cell(vals[a]):>12}" for a in present) + "   " + "; ".join(f"{NAMES[k]}: {v}" for k, v in sorted(notes[task].items())))

print()
for a in present:
    vs = [r[a] for r in rows if r[a]]
    print(f"{NAMES[a]:>3}: mean reward {sum(v[0] for v in vs) / len(vs):.3f}, mean $/task {sum(v[1] for v in vs) / len(vs):.2f}, "
          f"reward per $ {sum(v[0] for v in vs) / sum(v[1] for v in vs):.4f} (n={len(vs)})")
for x, y in (("divprogram", "divsharded"), ("divprogram", "rounds"), ("divsharded", "rounds")):
    paired = [r for r in rows if r.get(x) and r.get(y)]
    if paired:
        w = sum(r[x][0] > r[y][0] for r in paired), sum(r[x][0] < r[y][0] for r in paired)
        print(f"{NAMES[x]} vs {NAMES[y]} on {len(paired)}: {NAMES[x]} ahead {w[0]}, {NAMES[y]} ahead {w[1]}, tied {len(paired) - sum(w)}")
