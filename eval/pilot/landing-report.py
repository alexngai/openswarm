#!/usr/bin/env python3
"""landing-report.py <run dir>: docs/05 Phase B exit criterion 1, the train against today's
sequential queue on the same branches (arm landtrain; one <host>.landing.json per cell, from
landing.mjs). Per task and pooled over every graded cell, train vs queue:

  landing rate      landed / entries (the branches with commits)
  clean-merge rate  landings whose merge left the train check passing / landings
  reward            held-out test.sh reward of the landed tree, paired by cell

Pre-registered (docs/05 §7.4): exit criterion 1 holds when the pooled landing rate AND the pooled
clean-merge rate under the train are at least the queue's. Clean-merge is flagged "no
discrimination" when no queue landing broke the check (then it cannot tell the two apart). The
paired reward is secondary, over the cells whose graded /app was the train's landed tree, clean.
Also the train's bisects, repairs, resolver successes and ejections, and the cell's cost at $5 /
$0.50 / $30 per M fresh input / cached input / output. Cells expected (cache/*.json) but not
graded are listed with why. Not RunMetrics' cleanMergeRate (landed with no conflict, repair or
resolver, over entries).
"""
import glob, json, os, re, sys
from collections import defaultdict

run = sys.argv[1]
expected = {}  # (task, seed) -> (status, usd)
for f in glob.glob(f"{run}/cache/*.json"):
    if f.endswith(".submission.json"):
        continue
    d = json.load(open(f))
    if d.get("armId") != "landtrain":
        continue
    u = d.get("usage") or {}
    usd = (u.get("inputTokens", 0) * 5 + u.get("cacheReadTokens", 0) * 0.5 + u.get("outputTokens", 0) * 30) / 1e6
    expected[(d["taskId"].split("/")[1], d["seed"])] = (d.get("status"), usd)

found = {}  # (task, seed) -> path of its newest landing.json (a retried cell leaves one per attempt)
for f in glob.glob(f"{run}/verifier-out/**/*.landing.json", recursive=True):
    # the cell's directory is <task>.<arm>.s<seed>.<id>
    m = re.match(r"(.+)\.([a-z0-9]+)\.s(\d+)\.[a-z0-9]+$", os.path.basename(os.path.dirname(f)))
    key = (m.group(1), int(m.group(3))) if m else (f, 0)
    if key not in found or os.path.getmtime(f) > os.path.getmtime(found[key]):
        found[key] = f

cells = defaultdict(list)  # task -> [cell]
dropped, unpaired = [], []
for key in sorted(set(expected) | set(found), key=str):
    task, seed = key
    status, usd = expected.get(key, (None, None))
    if key not in found:
        dropped.append(f"{task} s{seed}: no landing.json (cell {status})")
        continue
    d = json.load(open(found[key]))
    if d.get("error") or "queue" not in d:
        dropped.append(f"{task} s{seed}: {(d.get('error') or 'no entries to land').splitlines()[0]}")
        continue
    t, q = d["train"], d["queue"]
    # The reward pairs only the train's landed tree, graded clean, against a queue reward that was measured.
    why = None if t.get("gradedIsTip") else f"graded /app was not the train's landed tree (HEAD {(t.get('graded') or {}).get('head')}, {len((t.get('graded') or {}).get('dirty') or [])} change(s))"
    why = why or (None if t["reward"] is not None else "no graded reward") or (f"queue reward failed: {q['rewardError']}" if q.get("rewardError") else None)
    why = why or (None if q.get("reward") is not None else "no queue reward")
    if why:
        unpaired.append(f"{task} s{seed}: {why}")
    cells[task].append({
        "entries": len(d["entries"]),
        "train": (len(t["landed"]), sum(c["clean"] for c in t["cleanMerge"]), len(t["cleanMerge"])),
        "queue": (len(q["landed"]), sum(c["clean"] for c in q["cleanMerge"]), len(q["cleanMerge"])),
        "rewards": None if why else (t["reward"], q["reward"]),
        "bisects": t["bisects"], "repairs": t["repairs"], "resolved": len(t["resolved"]), "ejected": len(t["ejected"]),
        "withheld": len(t["withheld"]), "conflicts": len(q["conflicts"]), "same": bool(d.get("sameTree")),
        "usd": usd,
    })


def pooled(cs):
    """Per side: landing rate, clean-merge rate, landed, clean landings, landings, broken landings; and the paired rewards."""
    entries = sum(c["entries"] for c in cs)
    out = {}
    for side in ("train", "queue"):
        landed, clean, landings = (sum(c[side][i] for c in cs) for i in range(3))
        out[side] = (landed / entries if entries else None, clean / landings if landings else None, landed, clean, landings, landings - clean)
    out["paired"] = [c["rewards"] for c in cs if c["rewards"] is not None]
    return out


fmt = lambda x: "  -  " if x is None else f"{x:.2f}"
mean = lambda xs: sum(xs) / len(xs) if xs else None
print(f"{'task':<11}{'n':>2} {'entries':>7} | {'land T':>6} {'land Q':>6} | {'clean T':>8} {'clean Q':>8} {'broke Q':>7} | {'rwd T':>5} {'rwd Q':>5} {'pairs':>5} | bisect repair resolve eject | {'$/cell':>6}")
for task in sorted(cells):
    cs = cells[task]
    p = pooled(cs)
    usd = [c["usd"] for c in cs if c["usd"] is not None]
    print(f"{task:<11}{len(cs):>2} {sum(c['entries'] for c in cs):>7} | {fmt(p['train'][0]):>6} {fmt(p['queue'][0]):>6} | "
          f"{p['train'][3]:>3}/{p['train'][4]:<3}  {p['queue'][3]:>3}/{p['queue'][4]:<3} {p['queue'][5]:>7} | "
          f"{fmt(mean([r[0] for r in p['paired']])):>5} {fmt(mean([r[1] for r in p['paired']])):>5} {len(p['paired']):>5} | "
          f"{sum(c['bisects'] for c in cs):>6} {sum(c['repairs'] for c in cs):>6} {sum(c['resolved'] for c in cs):>7} {sum(c['ejected'] for c in cs):>5} | "
          f"{fmt(mean(usd)):>6}{' (same tree in ' + str(sum(c['same'] for c in cs)) + ')' if any(c['same'] for c in cs) else ''}")

every = [c for cs in cells.values() for c in cs]
print(f"\ngraded {len(every)} of {len(expected)} expected cell(s)")
if every:
    p = pooled(every)
    print(f"pooled over {sum(c['entries'] for c in every)} entries:")
    for side in ("train", "queue"):
        print(f"  {side}: landing rate {fmt(p[side][0])} ({p[side][2]} landed), clean-merge rate {fmt(p[side][1])} ({p[side][3]}/{p[side][4]}; {p[side][5]} broke the check)")
    landing = "MET" if p["train"][0] >= p["queue"][0] else "NOT MET"
    if p["queue"][5] == 0:
        clean = "no discrimination"
    elif p["train"][1] is None:
        clean = "NOT MET (the train landed nothing)"
    else:
        clean = "MET" if p["train"][1] >= p["queue"][1] else "NOT MET"
    verdict = "MET" if landing == "MET" and not clean.startswith("NOT MET") else "NOT MET"
    flag = " (clean-merge: no discrimination)" if clean == "no discrimination" else ""
    print(f"  landing rate, train >= queue: {landing}")
    print(f"  clean-merge rate, train >= queue: {clean}")
    print(f"  exit criterion 1: {verdict}{flag}, on {len(every)} of {len(expected)} expected cells")
    if p["paired"]:
        diff = [t - q for t, q in p["paired"]]
        ahead = sum(x > 0 for x in diff), sum(x < 0 for x in diff)
        print(f"  secondary, reward paired on {len(diff)} cell(s): train {mean([r[0] for r in p['paired']]):.3f}, queue {mean([r[1] for r in p['paired']]):.3f}, "
              f"train - queue {mean(diff):+.3f}; train ahead {ahead[0]}, queue ahead {ahead[1]}, tied {len(diff) - sum(ahead)}")
    else:
        print("  secondary, reward: no cell could be paired")
    print(f"  train: {sum(c['bisects'] for c in every)} bisect(s), {sum(c['repairs'] for c in every)} repair(s), {sum(c['resolved'] for c in every)} resolved, "
          f"{sum(c['ejected'] for c in every)} ejected, {sum(c['withheld'] for c in every)} withheld; queue: {sum(c['conflicts'] for c in every)} conflict(s)")
for line in dropped:
    print(f"dropped: {line}")
for line in unpaired:
    print(f"not in the reward pairing: {line}")
