#!/usr/bin/env python3
"""search-audit.py <run dir>...: could the held-out oracle have reached the search arms?

Run on the pilot box from eval/.eval-runs (needs the task images and .roadmap). Per task:

1. The image: any held-out test file (test_0N_*), solve.sh or changes.patch anywhere, and
   git refs beyond HEAD (a future commit would carry the release's implementation).
2. Copying: of each cell's added lines (25+ chars, whitespace-normalised), the share that
   is in the reference solution but in neither the instruction nor the base repository,
   so could not be derived from what the agent was given.
3. Held-out test content: added lines found in the held-out tests but not in the
   instruction or the base repository.
4. The reviewer's reports: identifiers and quoted strings (6+ chars) that occur in the
   held-out tests but in neither the instruction, the reference solution nor the base
   repository, which a reviewer that never saw the tests has no source for.
"""
import glob, json, os, re, subprocess, sys
from collections import defaultdict

ROADMAP = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".roadmap")
TASKS = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "tasks.txt")).read().split()
norm = lambda l: re.sub(r"\s+", " ", l).strip()
lines = lambda text: {norm(l) for l in text.splitlines() if len(norm(l)) >= 25}
added = lambda patch: lines("\n".join(l[1:] for l in patch.splitlines() if l.startswith("+") and not l.startswith("+++")))
tokens = lambda s: set(re.findall(r"[A-Za-z_][A-Za-z0-9_]{5,}", s)) | set(re.findall(r"['\"]([^'\"\n]{6,60})['\"]", s))

PROBE = r"""
echo '@@FOUND'; find / -xdev \( -name 'test_0[1-9]_*' -o -name solve.sh -o -name changes.patch \) -not -path '/proc/*' 2>/dev/null | grep -v '^/app/.*node_modules' | head -20
echo '@@GIT'; cd /app && if git rev-parse HEAD >/dev/null 2>&1; then echo "all=$(git rev-list --all --count) head=$(git rev-list HEAD --count) refs=$(git for-each-ref | wc -l) tags_not_merged=$(git tag --no-merged HEAD 2>/dev/null | wc -l)"; else echo nogit; fi
echo '@@BASE'; find /app -type f -size -2M -not -path '*/node_modules/*' -not -path '*/.git/*' -print0 | xargs -0 grep -Ih '' 2>/dev/null
"""


def probe(task):
    toml = open(f"{ROADMAP}/{task}-roadmap/task.toml").read()
    image = re.search(r'docker_image\s*=\s*"([^"]+)"', toml).group(1)
    out = subprocess.run(["docker", "run", "--rm", "--entrypoint", "sh", image, "-c", PROBE],
                         capture_output=True, text=True, errors="replace").stdout
    found, git, base = re.split(r"^@@(?:GIT|BASE)$", out.split("@@FOUND", 1)[1], maxsplit=2, flags=re.M)
    return found.split(), git.strip(), base


cells = defaultdict(list)  # task -> [(run, added lines)]
reviews = defaultdict(list)  # task -> [(run, text)]
for run in sys.argv[1:]:
    for f in glob.glob(f"{run}/cache/*.submission.json"):
        task = re.search(r"roadmap-bench__(.+?)__", f).group(1)
        cells[task].append((run, added(json.load(open(f)).get("patch") or "")))
    for f in glob.glob(f"{run}/verifier-out/**/*.reward.json", recursive=True):
        task, host = os.path.basename(f).rsplit(".", 3)[:2]
        rep = os.path.join(os.path.dirname(f), f"{host}.search.json")
        for r in json.load(open(rep))["rounds"] if os.path.exists(rep) else []:
            if r.get("review"):
                rv = r["review"]
                reviews[task].append((run, json.dumps(rv.get("targets")) + " " + str(rv.get("regressions")) + " " + rv.get("tail", "")))

totals = defaultdict(lambda: defaultdict(list))
for task in TASKS:
    d = f"{ROADMAP}/{task}-roadmap"
    instr = open(f"{d}/instruction.md").read()
    gold = open(f"{d}/solution/changes.patch").read()
    held = "".join(open(f).read() for f in glob.glob(f"{d}/tests/test_*"))
    found, git, base = probe(task)
    novel_gold = added(gold) - lines(instr) - lines(base)
    held_only_lines = lines(held) - lines(instr) - lines(base)
    held_only_tokens = tokens(held) - tokens(instr) - tokens(gold) - tokens(base)
    print(f"\n{task}: image files {found or 'none'}; git {git}; novel reference lines {len(novel_gold)}")
    for run, a in cells[task]:
        if a:
            totals[run]["novel_ref"].append(len(a & novel_gold) / len(a))
            totals[run]["heldout_lines"].append(len(a & held_only_lines))
    for run, text in reviews[task]:
        hits = tokens(text) & held_only_tokens
        totals[run]["review_tokens"].append(len(hits))
        if hits:
            print(f"  {run} review mentions held-out-only: {sorted(hits)[:10]}")
    for run in sorted({r for r, _ in cells[task]}):
        v = [len(a & novel_gold) / len(a) for r, a in cells[task] if r == run and a]
        print(f"  {run}: novel-reference share per cell {[round(x, 3) for x in v]}")

print("\nsummary (mean, max):")
for run, d in totals.items():
    print(f"  {run}: " + ", ".join(f"{k} {sum(v) / len(v):.4f} / {max(v):.4f}" for k, v in d.items() if v))
