#!/usr/bin/env python3
"""search-report.py <attempt run dir> [<rounds run dir> [<selfrounds run dir>]]: docs/07 §7.1's search arms, per task.

(a) one agent: the mean held-out reward of the attempts, agent cost only.
(c) N attempts, the reviewer's highest score selected (ties: the mean of the tied, i.e. a
    random tie-break; an unparsed review ranks last); cost is every attempt plus every review.
oracle: the best attempt by held-out reward, the ceiling any selector can reach.
(b) the `rounds` run: one agent over up to N rounds fed by the same reviewer.
(b0) the `selfrounds` run: the same rounds opened by a self-check prompt, no reviewer.

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
    # Flat before per-cell mounts (2026-09-28), one directory per cell after.
    for f in glob.glob(f"{run}/verifier-out/**/*.reward.json", recursive=True):
        task, host = os.path.basename(f).rsplit(".", 3)[:2]
        rep = os.path.join(os.path.dirname(f), f"{host}.search.json")
        out[task].append((json.load(open(f))["reward"], json.load(open(rep)) if os.path.exists(rep) else None))
    return out


def costs(rep):
    agent = sum(usd(r["usage"]) for r in rep["rounds"])
    review = sum(usd(r["review"]["usage"]) for r in rep["rounds"] if "review" in r)
    return agent, review


attempts = load(sys.argv[1])
rounds = load(sys.argv[2]) if len(sys.argv) > 2 else {}
selfrounds = load(sys.argv[3]) if len(sys.argv) > 3 else {}


def single(runs, task):
    """(reward, rounds used, cost) of a one-cell-per-task run."""
    if not runs.get(task):
        return None, None, None
    if len(runs[task]) > 1:
        print(f"warning: {task} has {len(runs[task])} graded containers; using the first", file=sys.stderr)
    r, rep = runs[task][0]
    return r, (len(rep["rounds"]) if rep else None), (sum(costs(rep)) if rep else None)


rows = []
print(f"{'task':<12} {'n':>2} {'a':>5} {'c':>5} {'orc':>5} {'b':>5} {'rnd':>3} {'b0':>5} {'rnd':>3}   {'$a':>6} {'$c':>6} {'$b':>6} {'$b0':>6}  scores / rewards")
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
    b, nr, cost_b = single(rounds, task)
    b0, nr0, cost_b0 = single(selfrounds, task)
    rows.append((a, c, orc, b, cost_a, cost_c, cost_b, b0, cost_b0))
    fmt = lambda v, w=5, p=2: f"{v:>{w}.{p}f}" if v is not None else " " * (w - 1) + "-"
    pairs = " ".join(f"{s}/{r:.2f}" for s, r in sorted(ranked, reverse=True))
    print(f"{task:<12} {len(xs):>2} {fmt(a)} {fmt(c)} {fmt(orc)} {fmt(b)} {nr if nr else '-':>3} {fmt(b0)} {nr0 if nr0 else '-':>3}   "
          f"{fmt(cost_a, 6)} {fmt(cost_c, 6)} {fmt(cost_b, 6)} {fmt(cost_b0, 6)}  {pairs}")

if rows:
    mean = lambda i: (lambda v: sum(v) / len(v) if v else None)([r[i] for r in rows if r[i] is not None])
    print("\nmean reward: " + ", ".join(f"{n} {mean(i):.3f}" for i, n in ((0, "a"), (1, "c"), (2, "oracle"), (3, "b"), (7, "b0")) if mean(i) is not None))
    print("mean $/task: " + ", ".join(f"{n} {mean(i):.2f}" for i, n in ((4, "a"), (5, "c"), (6, "b"), (8, "b0")) if mean(i) is not None))
    for x, y, nx, ny in ((1, 3, "c", "b"), (3, 7, "b", "b0"), (7, 0, "b0", "a")):
        paired = [r for r in rows if r[x] is not None and r[y] is not None]
        if paired:
            wins = sum(r[x] > r[y] for r in paired), sum(r[x] < r[y] for r in paired)
            print(f"{nx} vs {ny} on {len(paired)} tasks: {nx} ahead {wins[0]}, {ny} ahead {wins[1]}, tied {len(paired) - sum(wins)}")
