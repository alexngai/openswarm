"""The gate reviewer's benchmark (docs/07 §7.10): fixed trees, held-out labels.

Each tree is a graded cell's final state (its task's image plus the agent's
diff); each label is whether a target's held-out test phase passed. A
reviewer variant reviews every tree once; its verdicts are scored against the
labels. The trees are one-thread (f8) cells of stages 1 and 2, whose recorded
final reviews (the pilot brief, the same model) are a free baseline.

Run on the eval host from openswarm's eval/ directory, Azure route in the env:

    python3 -I pilot/reviewer-bench.py select
    python3 -I pilot/reviewer-bench.py run <variant> [--cap USD]   # product | pilot | <brief file>
    python3 -I pilot/reviewer-bench.py score

Spend: a review is about $1.60. Nothing starts once what the variant spent,
plus $3 for each review running and the one starting, would pass the cap.
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROADMAP = HERE / ".roadmap"
OUT = Path(".eval-runs/reviewer-bench")
SOURCES = [  # (stage, run dir glob): the trees
    (2, os.path.expanduser("~/openswarm-s2/eval/.eval-runs/stage2-arms-onethread8-*")),
    (1, os.path.expanduser("~/openswarm/eval/.eval-runs/stage1")),
]
OPENSWARM = os.environ.get("OPENSWARM_ROOT", os.path.expanduser("~/openswarm-s2"))
MODEL = os.environ.get("OPENSWARM_MODEL", "mock-model" if os.environ.get("OPENSWARM_LLM_BASE_URL") else "azureoai/gpt-5.5")
FLAGS = ["--single", "--headless", "--output-format", "json", "--model", MODEL, "--permission-mode", "danger-full-access"]
ENTRY = "import { runCli } from '/opt/openswarm/packages/cli/dist/index.js'\nprocess.exit(await runCli(process.argv.slice(2)))\n"
INIT = (  # as runner.mjs's: a base commit on a branch, .sbx ignored
    "cd /app && (git rev-parse --is-inside-work-tree >/dev/null 2>&1 || (git init -q && git add -A && git -c user.email=eval@local -c user.name=eval commit -qm base)) && "
    "(git symbolic-ref -q HEAD >/dev/null || git checkout -q -B eval-base) && git config --global --add safe.directory '*' && "
    "x=$(git rev-parse --git-path info/exclude) && mkdir -p \"$(dirname \"$x\")\" && (grep -qx '.sbx/' \"$x\" 2>/dev/null || echo '.sbx/' >> \"$x\")"
)
lock = threading.Lock()


def phases(stdout: str) -> list[bool]:
    out = []
    for block in re.split(r"^=== Phase \d+:", stdout, flags=re.M)[1:]:
        marks = re.findall(r"^(PASSED|FAILED)$", block, flags=re.M)
        out.append(bool(marks) and marks[-1] == "PASSED")
    return out


def select() -> None:
    trees = []
    for stage, pattern in SOURCES:
        for run in sorted(glob.glob(pattern)):
            if ".void" in run:  # a voided cell's labels are not the held-out tests' (docs/07 §7.6)
                continue
            for c in glob.glob(f"{run}/cache/*.json"):
                if c.endswith((".submission.json", ".trace.jsonl")):
                    continue
                d = json.load(open(c))
                if d["armId"] != "onethread8":
                    continue
                task, seed = d["taskId"].split("/")[1], int(d["seed"])
                sub = c[:-5] + ".submission.json"
                vo = sorted(glob.glob(f"{run}/verifier-out/{task}.onethread8.s{seed}.*/"), reverse=True)
                if not os.path.exists(sub) or not vo:
                    continue
                so, dv = glob.glob(f"{vo[0]}*.stdout.txt"), glob.glob(f"{vo[0]}*.division.json")
                if not so or not dv:
                    continue
                review = (json.load(open(dv[0])).get("final") or {}).get("review") or {}
                trees.append({"id": f"s{stage}-{task}-s{seed}", "stage": stage, "task": task, "submission": sub,
                              "labels": phases(open(so[0], errors="replace").read()),
                              "baseline": {str(t["target"]): t["status"] for t in review.get("targets") or [] if isinstance(t.get("target"), int)}})
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "manifest.json").write_text(json.dumps(trees, indent=1))
    print(f"{len(trees)} trees, {sum(len(t['labels']) for t in trees)} labeled targets, {sum(sum(t['labels']) for t in trees)} passing")


def image_of(task: str) -> str:
    return re.search(r'docker_image\s*=\s*"([^"]+)"', (ROADMAP / f"{task}-roadmap" / "task.toml").read_text()).group(1)


def usd(u: dict) -> float:
    return (u.get("inputTokens", 0) * 5 + u.get("cacheReadInputTokens", 0) * 0.5 + u.get("outputTokens", 0) * 30) / 1e6


def spent(variant: str) -> float:
    return sum(usd(json.load(open(f)).get("usage") or {}) for f in glob.glob(str(OUT / variant / "*.json")))


def review_one(tree: dict, variant: str, brief_mount: list[str], brief_name: str) -> None:
    out = OUT / variant
    stage = Path(tempfile.mkdtemp(prefix="rbench-"))
    try:
        patch = json.load(open(tree["submission"])).get("patch") or ""
        (stage / "patch.diff").write_text(patch)
        (stage / "openswarm.mjs").write_text(ENTRY)
        for f in ("gate.mjs", "review-driver.mjs"):
            shutil.copy(HERE / f, stage / f)
        env = []
        for k in ("AZURE_API_BASE", "AZURE_API_KEY", "OPENSWARM_LLM_BASE_URL", "OPENSWARM_LLM_API_KEY"):
            if os.environ.get(k):
                env += ["-e", k]
        roadmap = (ROADMAP / f"{tree['task']}-roadmap" / "instruction.md").read_text()
        (stage / "roadmap.md").write_text(roadmap)
        cmd = (f"{INIT} && cd /app && (git apply --whitespace=nowarn /opt/pilot/patch.diff 2>/out/apply.err || git apply --whitespace=nowarn --reject /opt/pilot/patch.diff 2>>/out/apply.err; true) && "
               f"/opt/node/bin/node /opt/pilot/review-driver.mjs {' '.join(FLAGS)} \"$(cat /opt/pilot/roadmap.md)\"")
        o = stage / "out"
        o.mkdir()
        r = subprocess.run(["docker", "run", "--rm", "--cpus", "8", "--memory", "16g",
                            "-v", f"{OPENSWARM}:/opt/openswarm:ro", "-v", "/opt/node:/opt/node:ro",
                            "-v", f"{stage}:/opt/pilot:ro", "-v", f"{o}:/out", *brief_mount, *env,
                            "-e", f"BENCH_BRIEF={brief_name}", "-e", "BENCH_OUT=/out/verdict.json",
                            "-e", "OPENSWARM_HOME=/tmp/openswarm-home", "-e", "HOME=/root",
                            *(["--add-host", "host.docker.internal:host-gateway"] if os.environ.get("OPENSWARM_LLM_BASE_URL") else []),
                            image_of(tree["task"]), "bash", "-c", cmd],
                           capture_output=True, text=True, timeout=3 * 3600)
        verdict = json.loads((o / "verdict.json").read_text()) if (o / "verdict.json").exists() else {"error": r.stderr[-2000:]}
        verdict["apply_errors"] = (o / "apply.err").read_text()[-1000:] if (o / "apply.err").exists() else ""
        (out / f"{tree['id']}.json").write_text(json.dumps(verdict))
        with lock:
            print(f"{tree['id']}: score {verdict.get('score')} ${usd(verdict.get('usage') or {}):.2f} (spent ${spent(variant):.2f})", flush=True)
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def run(variant: str, cap: float) -> None:
    trees = json.loads((OUT / "manifest.json").read_text())
    if variant in ("product", "pilot"):
        name, brief_mount, brief_name = variant, [], variant
    else:  # a brief file: its results go under its stem
        name, brief_mount, brief_name = Path(variant).stem, ["-v", f"{Path(variant).resolve()}:/opt/bench/brief.txt:ro"], "/opt/bench/brief.txt"
    if os.environ.get("BENCH_TREES"):
        trees = [t for t in trees if t["id"] in os.environ["BENCH_TREES"].split(",")]
    (OUT / name).mkdir(parents=True, exist_ok=True)
    running: list[threading.Thread] = []
    for tree in trees:
        if (OUT / name / f"{tree['id']}.json").exists():
            continue
        while len([t for t in running if t.is_alive()]) >= int(os.environ.get("BENCH_CELLS", 6)):
            time.sleep(10)
        if spent(name) + 3 * (len([t for t in running if t.is_alive()]) + 1) > cap:
            print(f"stopped at the cap: spent ${spent(name):.2f}")
            break
        th = threading.Thread(target=review_one, args=(tree, name, brief_mount, brief_name))
        th.start()
        running.append(th)
    for th in running:
        th.join()
    print(f"{name}: done, spent ${spent(name):.2f}")


DONE = ("done", "unverifiable")


def metrics(trees: list[dict], verdict_of) -> dict:
    tp = fp = fn = tn = 0
    acc, rej = [], []
    for t in trees:
        v = verdict_of(t)
        if v is None:
            continue
        for i, passed in enumerate(t["labels"]):
            said = v.get(str(i + 1)) in DONE
            tp += said and passed
            fp += said and not passed
            fn += (not said) and passed
            tn += (not said) and (not passed)
        reward = sum(t["labels"]) / len(t["labels"])
        (acc if all(v.get(str(i + 1)) in DONE for i in range(len(t["labels"]))) else rej).append(reward)
    m = lambda xs: sum(xs) / len(xs) if xs else float("nan")
    return {"trees": len(acc) + len(rej), "done_precision": tp / max(1, tp + fp), "failures_flagged": tn / max(1, tn + fp),
            "passes_called_done": tp / max(1, tp + fn), "accuracy": (tp + tn) / max(1, tp + fp + fn + tn),
            "accepted": len(acc), "accepted_reward": m(acc), "rejected_reward": m(rej)}


def score() -> None:
    trees = json.loads((OUT / "manifest.json").read_text())
    rows = [("baseline (recorded)", metrics(trees, lambda t: t["baseline"] or None))]
    for d in sorted(p for p in OUT.iterdir() if p.is_dir()):
        def verdict_of(t, d=d):
            f = d / f"{t['id']}.json"
            if not f.exists():
                return None
            v = json.loads(f.read_text())
            return {str(x["target"]): x["status"] for x in v.get("targets") or [] if isinstance(x, dict)} or None
        rows.append((d.name, metrics(trees, verdict_of)))
    print(f"{'reviewer':<22} {'trees':>5} {'done→pass':>9} {'fails flagged':>13} {'passes→done':>11} {'accuracy':>8}  accepted (reward) / not")
    for name, m in rows:
        print(f"{name:<22} {m['trees']:>5} {m['done_precision']:>9.0%} {m['failures_flagged']:>13.0%} {m['passes_called_done']:>11.0%} {m['accuracy']:>8.0%}  "
              f"{m['accepted']} ({m['accepted_reward']:.2f}) / {m['rejected_reward']:.2f}")


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "select":
        select()
    elif cmd == "run":
        run(sys.argv[2], float(sys.argv[sys.argv.index("--cap") + 1]) if "--cap" in sys.argv else 75.0)
    elif cmd == "score":
        score()
