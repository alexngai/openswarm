"""How well the gate's reviewer judges a roadmap, against the held-out tests (docs/07 §7.9).

    python3 -I reviewer.py <analysis root>

Two reviewers, the same verdict shape (a status per target, a 0-100 score):
the product's L1 gate (`openswarm --gate`, docs/05 B6; runs gated, gated2,
gated3 on the frozen 12) and the pilot gate (eval/pilot/gate.mjs, the
one-thread and division arms of stages 1 and 2). Each final verdict judged
the tree the held-out tests graded; a target is one test phase.
"""
import glob
import json
import os
import re
import statistics as st
import sys
from collections import Counter, defaultdict

ROOT = sys.argv[1]
DONE = ("done", "unverifiable")  # the product gate accepts either


def phases(stdout: str) -> list[bool]:
    out = []
    for block in re.split(r"^=== Phase \d+:", stdout, flags=re.M)[1:]:
        marks = re.findall(r"^(PASSED|FAILED)$", block, flags=re.M)
        out.append(bool(marks) and marks[-1] == "PASSED")
    return out


def held_out(run_dir: str, task: str, arm: str, seed: int, cache: dict):
    """Per-phase results and reward: the cell's own verifier-out, else the cache's checkpoints."""
    for v in sorted(glob.glob(f"{run_dir}/verifier-out/{task}.{arm}.s{seed}.*/"), reverse=True):
        rj, so = glob.glob(f"{v}*.reward.json"), glob.glob(f"{v}*.stdout.txt")
        if rj and so:
            return phases(open(so[0], errors="replace").read()), float(json.load(open(rj[0]))["reward"])
    sc = cache["score"]
    return [c["passed"] for c in sc["checkpoints"] if c["id"].startswith("phase-")], sc["earned"] / sc["total"]


cells = []  # (gate, run/arm, task, final verdict {target: status} or None, score, phases, reward, rounds, accepted)
product = []  # the product gate: per-round status counts from its stderr summary (stdout is cut at 6000 chars)
ROUND = re.compile(r"^gate: round (\d+) review score (\d+) — (passed|not passed) \(([^;)]*)")
for run in ("gated", "gated2", "gated3"):
    base = f"{ROOT}/gated/{run}"
    for c in glob.glob(f"{base}/cache/*.json"):
        if c.endswith((".submission.json", ".trace.jsonl")):
            continue
        d = json.load(open(c))
        task = d["taskId"].split("/")[1]
        rounds, accepted, stderr = [], False, ""
        tr = c[:-5] + ".trace.jsonl"
        for line in open(tr) if os.path.exists(tr) else []:
            o = json.loads(line)
            if o.get("name") == "cli-harness-io":
                stderr = o["output"].get("stderr") or ""
        for l in stderr.splitlines():
            m = ROUND.match(l)
            if m:
                counts = {k: int(n) for n, k in re.findall(r"(\d+) (done|partial|broken|missing|unverifiable)", m.group(4))}
                rounds.append({"round": int(m.group(1)), "score": int(m.group(2)), "passed": m.group(3) == "passed", "counts": counts})
            accepted = accepted or l.startswith("gate: accepted")
        ph, reward = held_out(base, task, d["armId"], int(d["seed"]), d)
        if rounds:
            product.append(dict(run=run, task=task, rounds=rounds, accepted=accepted, phases=ph, reward=reward,
                                stop=next((l for l in stderr.splitlines() if l.startswith("gate:") and "round" not in l[:12]), "")))

for div in glob.glob(f"{ROOT}/openswarm*/eval/.eval-runs/*/verifier-out/*/*.division.json"):
    v = os.path.dirname(div)
    name = os.path.basename(v)  # <task>.<arm>.s<seed>.<stamp>
    task, arm = name.split(".")[0] + "." + name.split(".")[1] + "." + name.split(".")[2], None
    m = re.match(r"(.+?)\.(onethread\d+|divprogram|divsharded)\.s(\d+)\.", name)
    if not m or ".void" in v:
        continue
    task, arm, seed = m.group(1), m.group(2), int(m.group(3))
    rj, so = glob.glob(f"{v}/*.reward.json"), glob.glob(f"{v}/*.stdout.txt")
    if not (rj and so):
        continue
    dv = json.load(open(div))
    review = (dv.get("final") or {}).get("review") or {}
    verdict = {t["target"]: t["status"] for t in review.get("targets") or [] if isinstance(t.get("target"), int)}
    if not verdict:
        continue
    gate = "pilot, one thread" if arm.startswith("onethread") else "pilot, division"
    cells.append((gate, arm, task, verdict, review.get("score"), phases(open(so[0], errors="replace").read()),
                  float(json.load(open(rj[0]))["reward"]), None, all(s == "done" for s in verdict.values())))

mean = lambda xs: sum(xs) / len(xs) if xs else float("nan")
print(f"== product L1 gate (openswarm --gate): {len(product)} cells, {sum(len(p['phases']) for p in product)} targets")
over = [sum(v for k, v in p["rounds"][-1]["counts"].items() if k in DONE) - sum(p["phases"]) for p in product]
print(f"   final round: targets called done minus targets that pass, per cell: mean {mean(over):+.2f}; "
      f"over-claims in {sum(o > 0 for o in over)} cells, under-claims in {sum(o < 0 for o in over)}, exact in {sum(o == 0 for o in over)}")
dn = sum(sum(v for k, v in p["rounds"][-1]["counts"].items() if k in DONE) for p in product)
ps = sum(sum(p["phases"]) for p in product)
fp_lb = sum(max(0, o) for o in over)
print(f"   'done' precision at most {1 - fp_lb / dn:.0%} ({dn} called done, {ps} pass, at least {fp_lb} done targets fail)")
acc = [p for p in product if p["accepted"]]
rej = [p for p in product if not p["accepted"]]
print(f"   accepted: {len(acc)} cells, mean reward {mean([p['reward'] for p in acc]):.2f}, fully passing {sum(p['reward'] >= 0.999 for p in acc)}")
print(f"   not accepted: {len(rej)} cells, mean reward {mean([p['reward'] for p in rej]):.2f}, fully passing {sum(p['reward'] >= 0.999 for p in rej)}")
sc = [(p["rounds"][-1]["score"], p["reward"]) for p in product]
print(f"   final score vs reward: mean score {mean([s for s, _ in sc]):.0f}/100 against reward {100*mean([r for _, r in sc]):.0f}/100; correlation {st.correlation([s for s, _ in sc], [r for _, r in sc]):+.2f}")
for k in sorted({r["round"] for p in product for r in p["rounds"]}):
    rs = [r for p in product for r in p["rounds"] if r["round"] == k]
    print(f"   round {k}: {len(rs):>2} cells, mean score {mean([r['score'] for r in rs]):.0f}, passed {sum(r['passed'] for r in rs)}")
print(f"   how cells ended: {dict(Counter(re.sub(r'[0-9]+', 'N', p['stop'])[:60] for p in product))}")
print()
for gate in ("pilot, one thread", "pilot, division"):
    cs = [c for c in cells if c[0] == gate]
    pairs = Counter()
    for _, _, task, verdict, score, ph, reward, _, _ in cs:
        for i, p in enumerate(ph):
            pairs[(verdict.get(i + 1, "none"), p)] += 1
    tp = sum(pairs[(s, True)] for s in DONE)
    fp = sum(pairs[(s, False)] for s in DONE)
    fn = sum(v for (s, p), v in pairs.items() if p and s not in DONE)
    tn = sum(v for (s, p), v in pairs.items() if not p and s not in DONE)
    print(f"== {gate}: {len(cs)} final verdicts, {tp+fp+fn+tn} targets")
    for s in ("done", "unverifiable", "partial", "broken", "missing", "none"):
        t, f = pairs[(s, True)], pairs[(s, False)]
        if t + f:
            print(f"   said {s:<12} {t+f:>4} targets   {t/(t+f):5.0%} pass the held-out tests")
    print(f"   'done' precision {tp/(tp+fp):.0%}; of the targets that fail, the reviewer flags {tn/(tn+fp):.0%}; "
          f"of those that pass, it calls done {tp/(tp+fn):.0%}")
    acc = [c for c in cs if c[8]]
    rej = [c for c in cs if not c[8]]
    print(f"   accepted (every target done): {len(acc)} cells, mean reward {mean([c[6] for c in acc]):.2f}, fully passing {sum(c[6] >= 0.999 for c in acc)}")
    print(f"   not accepted: {len(rej)} cells, mean reward {mean([c[6] for c in rej]):.2f}, fully passing {sum(c[6] >= 0.999 for c in rej)}")
    sc = [(c[4], c[6]) for c in cs if isinstance(c[4], (int, float))]
    if len(sc) > 2:
        print(f"   score vs reward: mean score {mean([s for s, _ in sc]):.0f}/100 against mean reward {100*mean([r for _, r in sc]):.0f}/100; "
              f"correlation {st.correlation([s for s, _ in sc], [r for _, r in sc]):+.2f}")

json.dump({"product": product, "pilot": [dict(gate=c[0], arm=c[1], task=c[2], verdict=c[3], score=c[4], phases=c[5], reward=c[6], accepted=c[8]) for c in cells]},
          open(f"{ROOT}/reviewer-cells.json", "w"))
