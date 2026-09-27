#!/usr/bin/env python3
"""leak-check.py <task>...: flag plan assignments that name what only the gold solution knows.

A partition may name roadmap targets, directories and files that exist in the
base repo: that is ownership, what a planner surveying the repo would produce.
It must not name a file the reference patch creates, or an identifier that
appears only on the patch's added lines and nowhere in the roadmap: that is a
solution hint the single arm does not get. Exit 1 if anything is flagged.
"""
import json, re, sys

IDENT = re.compile(r"[A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*")
# Code-shaped only: camelCase, PascalCase with an inner capital, snake_case or dotted.
CODE = re.compile(r"[a-z][a-z0-9]*[A-Z]|[A-Z][a-z0-9]+[A-Z]|_|\.")
GENERIC = {"index.ts", "index.js", "index.tsx", "__init__.py", "mod.rs", "lib.rs", "main.go"}
bad = 0
for task in sys.argv[1:]:
    root = f".roadmap/{task}-roadmap"
    roadmap = open(f"{root}/instruction.md").read()
    patch = open(f"{root}/solution/changes.patch").read()
    new_files = set(re.findall(r"^diff --git a/(\S+) b/\S+\nnew file mode", patch, re.M))
    added = "\n".join(l[1:] for l in patch.splitlines() if l.startswith("+") and not l.startswith("+++"))
    existing = "\n".join(l[1:] for l in patch.splitlines() if l[:1] in (" ", "-") and not l.startswith("---"))
    parts = lambda text: {c for tok in IDENT.findall(text) for c in [tok, *tok.split(".")]}
    base_files = set(re.findall(r"^diff --git a/(\S+) ", patch, re.M)) - new_files
    known = parts(existing) | parts(roadmap) | {c for f in base_files for c in parts(f.replace("/", " "))}
    only_added = {c for c in parts(added) if len(c) > 3 and CODE.search(c.replace(".", "")) and c not in known}

    def named_by_roadmap(path: str) -> bool:
        stem = path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        if stem in ("index", "__init__"):  # a package: named by its directory
            path = path.rsplit("/", 1)[0]
            stem = path.rsplit("/", 1)[-1]
        module = path.rsplit(".", 1)[0].replace("/", ".") if "." in path.rsplit("/", 1)[-1] else path.replace("/", ".")
        return path in roadmap or module in roadmap or stem in roadmap

    for thread in json.load(open(f"plans/{task}/plan.json"))["threads"]:
        text = thread["assignment"]
        hits = sorted({f for f in new_files if not named_by_roadmap(f) and (f in text or (
            f.rsplit("/", 1)[-1] not in GENERIC
            and re.search(r"(?<![\w/.])" + re.escape(f.rsplit("/", 1)[-1]) + r"(?![\w])", text)))})
        hits += sorted({tok for tok in IDENT.findall(text) if any(c in only_added for c in [tok, *tok.split(".")])})
        if hits:
            bad += 1
            print(f"{task} {thread['id']}: {hits}")
print("clean" if bad == 0 else f"{bad} thread(s) flagged")
sys.exit(1 if bad else 0)
