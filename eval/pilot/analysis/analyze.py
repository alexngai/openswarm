"""Zero-spend analysis of docs/07 §7 and §7.6–7.7 cells (cells.json from load.py)."""
import json
import statistics as st
import sys
from collections import Counter, defaultdict

import re

rows = json.load(open(sys.argv[1]))
# Phase labels only where they reproduce test.sh's reward (load.py's labels_ok).
labelled = [r for r in rows if r.get("labels_ok")]
ARMS2 = {"onethread8": "f8", "onethread16": "f16", "divprogram": "e"}
s2 = [r for r in labelled if r["stage"] == 2 and not r["phase_screen"]]
screen = [r for r in labelled if r["stage"] == 2 and r["phase_screen"]]
s1 = [r for r in labelled if r["stage"] == 1]
mean = lambda xs: sum(xs) / len(xs) if xs else float("nan")


def by(rs, *keys):
    out = defaultdict(list)
    for r in rs:
        out[tuple(r[k] for k in keys)].append(r)
    return out


print("== A. Per-target pass rate, stage 2 (3 seeds per arm); * marks where e beats both single arms by >= 2 seeds' worth")
wins = Counter()
for task in sorted({r["task"] for r in s2}):
    cells = by([r for r in s2 if r["task"] == task], "arm")
    n = len(cells[("divprogram",)][0]["phases"])
    line = []
    for i in range(n):
        rate = {ARMS2[a]: mean([c["phases"][i] for c in cells[(a,)] if len(c["phases"]) > i]) for a in ARMS2}
        mark = "*" if rate["e"] - max(rate["f8"], rate["f16"]) >= 0.66 else ("-" if max(rate["f8"], rate["f16"]) - rate["e"] >= 0.66 else " ")
        wins[mark] += 1
        line.append(f"T{i+1}:{rate['f8']:.1f}/{rate['f16']:.1f}/{rate['e']:.1f}{mark}")
    print(f"  {task:<10} " + "  ".join(line))
print(f"  targets where e beats both singles by 2+ seeds: {wins['*']}; where a single beats e by 2+: {wins['-']}; neither: {wins[' ']}")

print("\n== B. Horizon: single-agent pass rate by target position (first / middle / last third), all stages")
def thirds(rs):
    buckets = defaultdict(list)
    for r in rs:
        n = len(r["phases"])
        for i, p in enumerate(r["phases"]):
            buckets[min(2, int(3 * i / n))].append(p)
    return [mean(buckets[k]) for k in range(3)]
for label, rs in [
    ("stage1 one agent (attempt)", [r for r in s1 if r["arm"] == "attempt"]),
    ("stage1 f8", [r for r in s1 if r["arm"] == "onethread8"]),
    ("stage2 screen f8 (31 tasks)", screen),
    ("stage2 arms f8+f16", [r for r in s2 if r["arm"] in ("onethread8", "onethread16")]),
    ("stage2 arms e", [r for r in s2 if r["arm"] == "divprogram"]),
    ("stage1 e", [r for r in s1 if r["arm"] == "divprogram"]),
]:
    a, b, c = thirds(rs)
    print(f"  {label:<30} first {a:.2f}  middle {b:.2f}  last {c:.2f}   (n={len(rs)})")

print("\n== C. Reviewer calibration (final whole-roadmap review vs held-out phase result), one-thread arms and e")
print("   only cells with no repair after the final review: a repaired cell was graded on a tree the review never saw")
for label, arms in [("one-thread (f4/f8/f16)", ("onethread4", "onethread8", "onethread16")), ("division e", ("divprogram",))]:
    pairs = Counter()
    allsaid = []
    for r in labelled:
        if r["arm"] not in arms or not r.get("review") or r.get("repairs"):
            continue
        st_ = {t: s for t, s in r["review"] if isinstance(t, int)}
        for i, p in enumerate(r["phases"]):
            pairs[(st_.get(i + 1, "none"), p)] += 1
        said_done = all(st_.get(i + 1) == "done" for i in range(len(r["phases"])))
        allsaid.append((said_done, r["reward"]))
    for s in ("done", "partial", "missing", "none"):
        t, f = pairs[(s, True)], pairs[(s, False)]
        if t + f:
            print(f"  {label:<24} reviewer '{s}': {t+f:>3} targets, {t/(t+f):.0%} pass the held-out tests")
    sd = [rw for d, rw in allsaid if d]
    print(f"  {label:<24} cells the reviewer called fully done: {len(sd)} of {len(allsaid)}, mean held-out reward {mean(sd):.2f}")

print("\n== D. Gate behaviour in one-thread arms: rounds used, and how many changed nothing")
for arm in ("onethread4", "onethread8", "onethread16"):
    rs = [r for r in rows if r["arm"] == arm and r.get("threads")]  # gate behaviour needs no labels
    used = [r["threads"]["t0"]["rounds"] for r in rs]
    cap = int(arm[len("onethread"):])
    print(f"  {arm:<12} n={len(rs):>3} rounds used mean {mean(used):.1f} (cap {cap}); hit the cap {sum(u >= cap for u in used)}/{len(used)}; "
          f"final repairs {mean([len(r['repairs']) for r in rs]):.2f}/cell")

print("\n== E. Division (e) process, stage 2")
es = [r for r in s2 if r["arm"] == "divprogram"]
lands = [l for r in es for l in r["landings"]]
print(f"  landings {len(lands)}: merged {sum(l[1]=='merged' for l in lands)}, conflict {sum(l[1]=='conflict' for l in lands)}; "
      f"contract check run {sum(l[2] is not None for l in lands)}, failing {sum(l[2] is False for l in lands)}, repaired {sum(l[3] for l in lands)}")
print(f"  threads per cell {mean([len(r['threads']) for r in es]):.1f}; thread errors {sum(t['error'] for r in es for t in r['threads'].values())}; "
      f"rounds per thread {mean([t['rounds'] for r in es for t in r['threads'].values()]):.2f}")
print(f"  final review: open targets per cell {mean([sum(s!='done' for _, s in r['review']) for r in es]):.2f}; repairs per cell {mean([len(r['repairs']) for r in es]):.2f}")
for task in sorted({r["task"] for r in es}):
    tr = [r for r in es if r["task"] == task]
    print(f"    {task:<10} conflicts {sum(l[1]=='conflict' for r in tr for l in r['landings'])}  open-after-review {mean([sum(s!='done' for _, s in r['review']) for r in tr]):.1f}  "
          f"repairs {mean([len(r['repairs']) for r in tr]):.1f}  reward {mean([r['reward'] for r in tr]):.2f}")

print("\n== F. Cost and wall-clock, stage 2 arms")
for a, l in ARMS2.items():
    rs = [r for r in s2 if r["arm"] == a]
    print(f"  {l:<4} reward {mean([r['reward'] for r in rs]):.3f}  $ {mean([r['usd'] for r in rs]):6.2f}  minutes {mean([r['minutes'] for r in rs]):6.1f}  "
          f"reward/$ {mean([r['reward'] for r in rs]) / mean([r['usd'] for r in rs]):.4f}")

print("\n== G. Division's gain against the single agent's level, per task, both stages")
pts = []
for stage, rs, single in ((1, s1, "onethread8"), (2, s2, "onethread8")):
    for task in sorted({r["task"] for r in rs}):
        f = [r["reward"] for r in rs if r["task"] == task and r["arm"] == single]
        e = [r["reward"] for r in rs if r["task"] == task and r["arm"] == "divprogram"]
        if f and e:
            pts.append((stage, task, mean(f), mean(e) - mean(f)))
for stage, task, f, g in sorted(pts, key=lambda p: p[2]):
    print(f"  s{stage} {task:<10} single {f:.2f}  e−single {g:+.2f}")
xs, ys = [p[2] for p in pts], [p[3] for p in pts]
print(f"  correlation(single level, gain) = {st.correlation(xs, ys):+.2f} over {len(pts)} cells of {len({p[1] for p in pts})} tasks "
      "((f8) is on both axes, which biases this negative)")
ind = []
for task in sorted({r["task"] for r in s2}):
    lvl = [r["reward"] for r in s2 if r["task"] == task and r["arm"] == "onethread16"]
    f8 = [r["reward"] for r in s2 if r["task"] == task and r["arm"] == "onethread8"]
    e = [r["reward"] for r in s2 if r["task"] == task and r["arm"] == "divprogram"]
    ind.append((mean(lvl), mean(e) - mean(f8)))
print(f"  stage 2 only, level from (f16), gain (e) - (f8): correlation {st.correlation([a for a, _ in ind], [b for _, b in ind]):+.2f} over {len(ind)} tasks")
lo = [g for _, _, f, g in pts if f < 0.5]
hi = [g for _, _, f, g in pts if f >= 0.5]
print(f"  mean gain where single < 0.5: {mean(lo):+.3f} (n={len(lo)}); where single >= 0.5: {mean(hi):+.3f} (n={len(hi)})")

print("\n== H. Contested targets by the load of the thread that owns them (division.mjs's owner rule), stage 2")
from pathlib import Path
PLANS = Path(__file__).resolve().parent.parent / "plans"
loads = []
for task in sorted({r["task"] for r in s2}):
    plan = json.loads((PLANS / task / "plan.json").read_text())
    threads = plan["threads"]
    owner = lambda n: next((t["id"] for t in threads[1:] if re.search(rf"Target {n}\b", t["assignment"])), threads[0]["id"])
    carried = Counter(owner(n) for n in range(1, len(next(r for r in s2 if r["task"] == task)["phases"]) + 1))
    cells = [r for r in s2 if r["task"] == task]
    for i in range(len(cells[0]["phases"])):
        allp = [c["phases"][i] for c in cells]
        if any(allp) and not all(allp):
            rate = {ARMS2[a]: mean([c["phases"][i] for c in cells if c["arm"] == a]) for a in ARMS2}
            o = owner(i + 1)
            loads.append((task, i + 1, o, carried[o] if o != threads[0]["id"] else 0, rate["e"] - mean([rate["f8"], rate["f16"]])))
for k in sorted({l[3] for l in loads}):
    g = [l for l in loads if l[3] == k]
    print(f"  owner carries {k} target(s){' (t0)' if k == 0 else ''}: n={len(g)} mean e - singles {mean([l[4] for l in g]):+.2f}  tasks {sorted({l[0] for l in g})}")

print("\n== I. Seed variance (SD of reward over 3 seeds), stage 2")
for a, l in ARMS2.items():
    sds = [st.pstdev([r["reward"] for r in s2 if r["task"] == t and r["arm"] == a]) for t in sorted({r["task"] for r in s2})]
    print(f"  {l:<4} mean SD {mean(sds):.3f}   per task {' '.join(f'{x:.2f}' for x in sds)}")
