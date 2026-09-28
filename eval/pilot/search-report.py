#!/usr/bin/env python3
"""search-report.py <attempt run dir> [<rounds run dir>]: docs/07 §7.1's search arms, per task.

(a) one agent: the mean held-out reward of the attempts, agent cost only.
(c) N attempts, the reviewer's highest score selected (ties: the mean of the tied, i.e. a
    random tie-break; an unparsed review ranks last); cost is every attempt plus every review.
oracle: the best attempt by held-out reward, the ceiling any selector can reach.
(b) the `rounds` run: one agent over up to N rounds fed by the same reviewer.

Rewards are test.sh's own reward.json; the reviewer's reports and usage are search.mjs's
<host>.search.json, joined on the container hostname. Cost at $5 / $0.50 / $30 per M
(fresh input / cached input / output), as screen-report.py.
"""
import glob, json, os, sys
from collections import defaultdict


def usd(u):
    return (u.get("inputTokens", 0) * 5 + u.get("cacheReadInputTokens", 0) * 0.5 + u.get("outputTokens", 0) * 30) / 1e6


def load(run):
    """{task: [(reward, report)]} for every graded container of a run."""
    out = defaultdict(list)
    for f in glob.glob(f"{run}/verifier-out/*.reward.json"):
        task, host = os.path.basename(f).rsplit(".", 3)[:2]
        rep = f"{run}/verifier-out/{host}.search.json"
        out[task].append((json.load(open(f))["reward"], json.load(open(rep)) if os.path.exists(rep) else None))
    return out


def costs(rep):
    agent = sum(usd(r["usage"]) for r in rep["rounds"])
    review = sum(usd(r["review"]["usage"]) for r in rep["rounds"] if "review" in r)
    return agent, review


attempts = load(sys.argv[1])
rounds = load(sys.argv[2]) if len(sys.argv) > 2 else {}
rows = []
print(f"{'task':<12} {'n':>2} {'a':>5} {'c':>5} {'orc':>5} {'b':>5} {'rnd':>3}   {'$a':>6} {'$c':>6} {'$b':>6}  scores / rewards")
for task in sorted(attempts):
    xs = [(r, rep) for r, rep in attempts[task] if rep is not None]
    if not xs:
        continue
    score = lambda rep: rep["rounds"][0].get("review", {}).get("score")
    ranked = [(-1 if score(rep) is None else score(rep), r) for r, rep in xs]
    best = max(s for s, _ in ranked)
    tied = [r for s, r in ranked if s == best]
    a = sum(r for r, _ in xs) / len(xs)
    c = sum(tied) / len(tied)
    orc = max(r for r, _ in xs)
    cost_a = sum(costs(rep)[0] for _, rep in xs) / len(xs)
    cost_c = sum(sum(costs(rep)) for _, rep in xs)
    b = cost_b = nr = None
    if rounds.get(task):
        if len(rounds[task]) > 1:
            print(f"warning: {task} has {len(rounds[task])} graded rounds containers; using the first", file=sys.stderr)
        rb, rep = rounds[task][0]
        b, nr = rb, len(rep["rounds"]) if rep else None
        cost_b = sum(costs(rep)) if rep else None
    rows.append((a, c, orc, b, cost_a, cost_c, cost_b))
    fmt = lambda v, w=5, p=2: f"{v:>{w}.{p}f}" if v is not None else " " * (w - 1) + "-"
    pairs = " ".join(f"{s}/{r:.2f}" for s, r in sorted(ranked, reverse=True))
    print(f"{task:<12} {len(xs):>2} {fmt(a)} {fmt(c)} {fmt(orc)} {fmt(b)} {nr if nr else '-':>3}   {fmt(cost_a, 6)} {fmt(cost_c, 6)} {fmt(cost_b, 6)}  {pairs}")

if rows:
    mean = lambda i: (lambda v: sum(v) / len(v) if v else None)([r[i] for r in rows if r[i] is not None])
    names = ["a", "c", "oracle", "b"]
    print("\nmean reward: " + ", ".join(f"{n} {mean(i):.3f}" for i, n in enumerate(names) if mean(i) is not None))
    print("mean $/task: " + ", ".join(f"{n} {mean(i):.2f}" for i, n in zip((4, 5, 6), ("a", "c", "b")) if mean(i) is not None))
    paired = [r for r in rows if r[3] is not None]
    if paired:
        wins = sum(r[1] > r[3] for r in paired), sum(r[1] < r[3] for r in paired)
        print(f"c vs b on {len(paired)} tasks: c ahead {wins[0]}, b ahead {wins[1]}, tied {len(paired) - sum(wins)}")
