#!/usr/bin/env python3
"""t0-share.py <task>...: t0's share of the reference patch's added source lines.

The pilot's pre-registered decomposable subset (docs/05 §7.5) is the tasks
whose share is under 0.5: there, most of the work sits in target threads that
run in parallel, rather than in the contracts thread the program arm lands first.
Test and doc files are excluded, and so are t0's catch-all files (the rest of
the upstream release, matched by no thread's `paths`): only work a plan assigns
counts. Reads the slices split-patch.py wrote.
"""
import glob, json, re, sys

SKIP = re.compile(r"(^|/)(tests?|docs?|benchmarks?)/|(^|/)test_|\.test\.|\.spec\.|_test\.|\.md$|\.rst$|CHANGES|CHANGELOG")

def added(path, owned=None):
    n, keep = 0, False
    for line in open(path):
        if line.startswith("diff --git "):
            file = line.split(" b/", 1)[-1].strip()
            keep = not SKIP.search(file) and (owned is None or any(file.startswith(p) for p in owned))
        elif keep and line.startswith("+") and not line.startswith("+++"):
            n += 1
    return n

for task in sys.argv[1:]:
    t0_paths = next(t["paths"] for t in json.load(open(f"plans/{task}/plan.json"))["threads"] if t["id"] == "t0")
    counts = {}
    for p in sorted(glob.glob(f".roadmap/refs/{task}/*.patch")):
        tid = p.rsplit("/", 1)[-1][:-6]
        counts[tid] = added(p, t0_paths if tid == "t0" else None)
    share = counts.get("t0", 0) / max(1, sum(counts.values()))
    print(f"{task:11} t0_share={share:.2f} {'decomposable' if share < 0.5 else 'hub-bound'}  {counts}")
