"""The gate reviewer's benchmark (docs/07 §7.10): fixed trees, held-out labels.

Each tree is a graded cell's final state (its task's image plus the agent's
diff); each label is whether a target's held-out test phase passed. A
reviewer variant reviews every tree once; its verdicts are scored against the
labels. The trees are one-thread (f8) cells of stages 1 and 2, whose recorded
final reviews (the pilot brief, the same model) are a free baseline.

Run on the eval host from openswarm's eval/ directory, Azure route in the env
(or OPENSWARM_MODEL=us.anthropic.claude-opus-4-6-v1 and AWS_BEARER_TOKEN_BEDROCK for a Claude reviewer):

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
INIT = (  # as runner.mjs's: a base commit on a branch, .sbx ignored (safe.directory first: an image's /app may be another user's)
    "git config --global --add safe.directory '*' && cd /app && (git rev-parse --is-inside-work-tree >/dev/null 2>&1 || (git init -q && git add -A && git -c user.email=eval@local -c user.name=eval commit -qm base)) && "
    "(git symbolic-ref -q HEAD >/dev/null || git checkout -q -B eval-base) && "
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
                final = json.load(open(dv[0])).get("final") or {}
                review = final.get("review") or {}
                trees.append({"id": f"s{stage}-{task}-s{seed}", "stage": stage, "task": task, "submission": sub,
                              "labels": phases(open(so[0], errors="replace").read()),
                              "baseline": {str(t["target"]): t["status"] for t in review.get("targets") or [] if isinstance(t.get("target"), int)},
                              "repaired": bool(final.get("repairs"))})
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "manifest.json").write_text(json.dumps(trees, indent=1))
    print(f"{len(trees)} trees, {sum(len(t['labels']) for t in trees)} labeled targets, {sum(sum(t['labels']) for t in trees)} passing")


def image_of(task: str) -> str:
    return re.search(r'docker_image\s*=\s*"([^"]+)"', (ROADMAP / f"{task}-roadmap" / "task.toml").read_text()).group(1)


# $/MTok: input, cache read, cache write, output. Claude at Anthropic's list rates (Bedrock's bill may differ); else gpt-5.5's.
FAMILY = MODEL.split(".")[-1]
PRICE = {"claude-opus-4-6-v1": (5, 0.5, 6.25, 25)}.get(FAMILY, (5, 0.5, 0, 30))
# A Claude reviewer's results sit beside the default model's: product-claude-opus-4-6-v1.
TAG = f"-{FAMILY}" if FAMILY.startswith("claude-") else ""


def usd(u: dict) -> float:
    return (u.get("inputTokens", 0) * PRICE[0] + u.get("cacheReadInputTokens", 0) * PRICE[1]
            + u.get("cacheWriteInputTokens", 0) * PRICE[2] + u.get("outputTokens", 0) * PRICE[3]) / 1e6


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
        for k in ("AZURE_API_BASE", "AZURE_API_KEY", "OPENSWARM_LLM_BASE_URL", "OPENSWARM_LLM_API_KEY", "AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION"):
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
    name += TAG
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


DONE = ("done", "unverifiable")  # the product gate accepts either


def pairs(trees: list[dict], verdict_of) -> list[list[tuple[bool, bool]]]:
    """Per tree, (reviewer said done, held-out passed) for each target; trees without a verdict left out."""
    out = []
    for t in trees:
        v = verdict_of(t)
        if v is not None:
            out.append([(v.get(str(i + 1)) in DONE, passed) for i, passed in enumerate(t["labels"])])
    return out


def stats(tree_pairs: list[list[tuple[bool, bool]]]) -> dict:
    flat = [p for tp in tree_pairs for p in tp]
    tp = sum(s and y for s, y in flat)
    fp = sum(s and not y for s, y in flat)
    fn = sum((not s) and y for s, y in flat)
    tn = sum((not s) and (not y) for s, y in flat)
    n = max(1, tp + fp + fn + tn)
    tpr, tnr = tp / max(1, tp + fn), tn / max(1, tn + fp)
    po = (tp + tn) / n
    pe = ((tp + fp) * (tp + fn) + (fn + tn) * (fp + tn)) / n / n
    return {"done_precision": tp / max(1, tp + fp), "failures_flagged": tnr, "passes_called_done": tpr, "accuracy": po,
            "informedness": tpr + tnr - 1, "kappa": (po - pe) / (1 - pe) if pe < 1 else 0.0}


def interval(tree_pairs, key: str, draws: int = 4000) -> tuple[float, float]:
    """95 % bootstrap over trees: targets within a tree are not independent."""
    import random
    rng = random.Random(0)
    vals = sorted(stats([tree_pairs[rng.randrange(len(tree_pairs))] for _ in tree_pairs])[key] for _ in range(draws))
    return vals[int(0.025 * draws)], vals[int(0.975 * draws)]


def score(root: Path = OUT) -> None:
    trees = json.loads((root / "manifest.json").read_text())

    def file_verdict(d: Path):
        def verdict_of(t):
            f = d / f"{t['id']}.json"
            if not f.exists():
                return None
            v = json.loads(f.read_text())
            return {str(x["target"]): x["status"] for x in v.get("targets") or [] if isinstance(x, dict)} or None
        return verdict_of

    variants = {d.name: file_verdict(d) for d in sorted(p for p in root.iterdir() if p.is_dir())}
    # Compared on the trees every variant judged.
    common = [t for t in trees if all(v(t) is not None for v in variants.values())]
    rows = [("calling every target done", lambda t: {str(i + 1): "done" for i in range(len(t["labels"]))}),
            ("recorded (pre-repair tree)", lambda t: t["baseline"] or None), *variants.items()]
    print(f"{len(common)} trees every variant judged, {sum(len(t['labels']) for t in common)} targets, "
          f"{sum(sum(t['labels']) for t in common)} pass. The recorded verdicts judged the tree before the final repairs "
          f"({sum(1 for t in common if t.get('repaired'))} of these trees were repaired after them): not comparable.")
    print(f"{'reviewer':<28} {'done→pass':>9} {'fails flagged':>13} {'passes→done':>11} {'accuracy':>8} {'informedness (95%)':>22} {'kappa':>6}")
    for name, verdict_of in rows:
        tps = pairs(common, verdict_of)
        m = stats(tps)
        lo, hi = interval(tps, "informedness") if name != "calling every target done" else (0.0, 0.0)
        print(f"{name:<28} {m['done_precision']:>9.0%} {m['failures_flagged']:>13.0%} {m['passes_called_done']:>11.0%} {m['accuracy']:>8.0%} "
              f"{m['informedness']:>+8.2f} [{lo:+.2f}, {hi:+.2f}] {m['kappa']:>+6.2f}")
    names = list(variants)
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            same = [x == y for t in common for x, y in zip([s for s, _ in pairs([t], variants[a])[0]], [s for s, _ in pairs([t], variants[b])[0]])]
            pa = mean_([s for t in common for s, _ in pairs([t], variants[a])[0]])
            pb = mean_([s for t in common for s, _ in pairs([t], variants[b])[0]])
            chance = pa * pb + (1 - pa) * (1 - pb)
            po = mean_(same)
            print(f"agreement {a} vs {b}: {po:.0%} (chance at their rates {chance:.0%}, kappa {(po - chance) / (1 - chance):+.2f})")


def mean_(xs):
    xs = [float(x) for x in xs]
    return sum(xs) / len(xs) if xs else float("nan")


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "select":
        select()
    elif cmd == "run":
        run(sys.argv[2], float(sys.argv[sys.argv.index("--cap") + 1]) if "--cap" in sys.argv else 75.0)
    elif cmd == "score":
        score(Path(sys.argv[2]) if len(sys.argv) > 2 else OUT)
