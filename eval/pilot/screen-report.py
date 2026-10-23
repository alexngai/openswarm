#!/usr/bin/env python3
"""screen-report.py <run dir>: the pilot task-set screen, per task.

Mean / min / max reward over seeds, cost at $5 / $0.50 / $30 per M (fresh input /
cached input / output), minutes, and the selection rule (mean reward in [0.2, 0.8]).
Audits the phase parser: per task, the multiset of cell rewards must equal the
multiset of test.sh's own reward.json values kept in verifier-out/.
"""
import glob, json, os, sys
from collections import defaultdict

run = sys.argv[1]
cells = defaultdict(list)
for f in glob.glob(f"{run}/cache/*.json"):
    if f.endswith(".submission.json"):
        continue
    d = json.load(open(f))
    u, s = d.get("usage") or {}, d.get("score") or {}
    usd = (u.get("inputTokens", 0) * 5 + u.get("cacheReadTokens", 0) * 0.5 + u.get("outputTokens", 0) * 30) / 1e6
    reward = s["earned"] / s["total"] if s.get("total") else None
    cells[d["taskId"].split("/")[1]].append((reward, usd, d.get("durationMs", 0) / 60000, d.get("status")))

truth = defaultdict(list)
for f in glob.glob(f"{run}/verifier-out/**/*.reward.json", recursive=True):
    task = os.path.basename(f).rsplit(".", 3)[0]  # "<task>.<container>.reward.json"
    truth[task].append(round(json.load(open(f))["reward"], 4))

total, picked = 0.0, []
print(f"{'task':<12} {'n':>2} {'mean':>5} {'min':>5} {'max':>5} {'$/run':>6} {'min/run':>7}  audit  pick")
for task in sorted(cells):
    rs = [c[0] for c in cells[task] if c[0] is not None]
    usd = [c[1] for c in cells[task]]
    mins = [c[2] for c in cells[task]]
    total += sum(usd)
    mean = sum(rs) / len(rs) if rs else float("nan")
    audit = "ok" if sorted(round(r, 4) for r in rs) == sorted(truth.get(task, [])) else f"MISMATCH {sorted(truth.get(task, []))}"
    pick = 0.2 <= mean <= 0.8
    if pick:
        picked.append(task)
    print(f"{task:<12} {len(rs):>2} {mean:>5.2f} {min(rs):>5.2f} {max(rs):>5.2f} {sum(usd)/len(usd):>6.2f} {sum(mins)/len(mins):>7.1f}  {audit:<5}  {'*' if pick else ''}")
print(f"\ncells {sum(len(v) for v in cells.values())}, total ${total:.2f}; picked {len(picked)}: {', '.join(picked)}")
