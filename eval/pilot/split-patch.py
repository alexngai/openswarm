#!/usr/bin/env python3
"""split-patch.py <changes.patch> <plan.json> <outdir>: slice a reference patch into one
patch per thread, by the plan's `paths` prefixes (first match wins; unmatched -> the thread
marked "default": true). Zero-token plumbing check for the pilot arms."""
import json, re, sys
patch, plan, out = sys.argv[1:4]
threads = json.load(open(plan))["threads"]
default = next(t["id"] for t in threads if t.get("default"))
chunks = re.split(r"(?m)^(?=diff --git )", open(patch).read())
slices = {t["id"]: [] for t in threads}
for c in filter(str.strip, chunks):
    path = re.match(r"diff --git a/(\S+)", c).group(1)
    owner = next((t["id"] for t in threads for p in t.get("paths", []) if path.startswith(p)), default)
    slices[owner].append(c)
for tid, cs in slices.items():
    open(f"{out}/{tid}.patch", "w").write("".join(cs))
    print(tid, len(cs), "files")
