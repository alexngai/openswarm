"""docs/07 §7.6's file rule, defined 2026-10-17 before any task was screened.

A task enters stage 2's screen if its reference patch touches at least 3
top-level source directories and at least 15 files. A source file is a changed
file outside test, doc and example directories and not data or configuration
(.md .rst .txt .json .lock .toml .yml .yaml .cfg); its top-level source
directory is its first two path components (its first, for a file one level
deep; "." for a file at the root); the 15 counts every changed file.

    python3 -I file-rule.py <roadmap-dir> <task>...    # prints one line per task
"""
import re
import sys
from pathlib import Path

SKIP_DIRS = {"test", "tests", "testing", "__tests__", "doc", "docs", "example", "examples"}
DATA = {".md", ".rst", ".txt", ".json", ".lock", ".toml", ".yml", ".yaml", ".cfg"}


def changed(patch: str) -> list[str]:
    paths = []
    for a, b in re.findall(r"^diff --git a/(\S+) b/(\S+)$", patch, re.M):
        paths.append(b if b != "/dev/null" else a)
    return paths


def top_dir(path: str) -> str | None:
    parts = path.split("/")
    dirs, name = parts[:-1], parts[-1]
    if any(d in SKIP_DIRS for d in dirs) or Path(name).suffix in DATA:
        return None
    return "." if not dirs else "/".join(dirs[:2])


def rule(patch: str) -> tuple[bool, int, list[str]]:
    files = changed(patch)
    tops = sorted({t for t in map(top_dir, files) if t is not None})
    return len(tops) >= 3 and len(files) >= 15, len(files), tops


if __name__ == "__main__":
    root = Path(sys.argv[1])
    for task in sys.argv[2:]:
        ok, n, tops = rule((root / f"{task}-roadmap" / "solution" / "changes.patch").read_text(errors="replace"))
        print(f"{task}\t{'pass' if ok else 'fail'}\t{n} files\t{len(tops)} dirs\t{' '.join(tops)}")
