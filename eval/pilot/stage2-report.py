"""docs/07 §7.6's primary comparison, from stage2.py's state file.

    python3 -I stage2-report.py <stage2-state.json> [--seeds 1]

Per task, (f8) and (f16) are two points (mean spend, mean reward over the
seeds given) of the single-agent cost curve: linear between them, flat
beyond either end. (e) is read against the curve at its own mean spend; the
difference is averaged over tasks. The 95 % interval resamples tasks, and
each arm's seeds within a task, 10,000 times. The rules are the
pre-registration's: +0.06 or more with the interval above 0 fires D18's
trigger; within 0.02, or below, keeps division deferred; between is
inconclusive; after seed 1, (e) trailing by more than 0.05 is the futility
stop.
"""
import json
import random
import sys

ARMS = {"f8": "onethread8", "f16": "onethread16", "e": "divprogram"}


ENVELOPE = "--envelope" in sys.argv


def curve(points: list[tuple[float, float]], spend: float) -> float:
    (c0, r0), (c1, r1) = sorted(points)
    if spend <= c0:
        value = r0
    elif spend >= c1 or c1 == c0:
        value = r1
    else:
        value = r0 + (r1 - r0) * (spend - c0) / (c1 - c0)
    # --envelope: the curve never falls with spend. The pre-registration assumed
    # (f16) costs more than (f8) and does no worse; where a seed's noise breaks
    # that, the best single-agent reward at or below (e)'s spend is the fairer bar.
    if ENVELOPE:
        value = max([value] + [r for c, r in points if c <= spend])
    return value


def mean(xs):
    return sum(xs) / len(xs)


def gap(cells: dict[str, dict[str, list[tuple[float, float]]]]) -> tuple[float, dict]:
    per = {}
    for task, arms in cells.items():
        pts = [(mean([c for c, _ in arms[a]]), mean([r for _, r in arms[a]])) for a in ("f8", "f16")]
        e_cost, e_reward = mean([c for c, _ in arms["e"]]), mean([r for _, r in arms["e"]])
        per[task] = {"f8": pts[0], "f16": pts[1], "e": (e_cost, e_reward), "curve": curve(pts, e_cost)}
        per[task]["gap"] = e_reward - per[task]["curve"]
    return mean([p["gap"] for p in per.values()]), per


def main() -> None:
    state = json.load(open(sys.argv[1]))["arms"]
    seeds = [int(x) for x in sys.argv[sys.argv.index("--seeds") + 1].split(",")] if "--seeds" in sys.argv else [1, 2, 3]
    cells: dict = {}
    missing = []
    for key, rec in state.items():
        arm_id, rest = key.split("-", 1)
        task, seed = rest.rsplit("-s", 1)
        arm = next(a for a, v in ARMS.items() if v == arm_id)
        if int(seed) not in seeds:
            continue
        if rec.get("reward") is None:
            missing.append(key)
            continue
        cells.setdefault(task, {a: [] for a in ARMS})[arm].append((rec["usd"], rec["reward"]))
    complete = {t: a for t, a in cells.items() if all(a[x] for x in ARMS)}
    if missing:
        print(f"cells without a reward (left out): {missing}")
    print(f"tasks with every arm: {len(complete)} of {len(cells)}; seeds {seeds}\n")
    observed, per = gap(complete)
    print(f"{'task':<11} {'f8 $':>7} {'f8 r':>5} {'f16 $':>7} {'f16 r':>5} {'e $':>7} {'e r':>5} {'curve':>5} {'gap':>6}")
    for task, p in sorted(per.items()):
        print(f"{task:<11} {p['f8'][0]:>7.2f} {p['f8'][1]:>5.2f} {p['f16'][0]:>7.2f} {p['f16'][1]:>5.2f} {p['e'][0]:>7.2f} {p['e'][1]:>5.2f} {p['curve']:>5.2f} {p['gap']:>+6.3f}")
    rng = random.Random(0)
    boots = []
    tasks = sorted(complete)
    for _ in range(10_000):
        sample = {}
        for i, t in enumerate(rng.choices(tasks, k=len(tasks))):
            sample[f"{t}#{i}"] = {a: rng.choices(complete[t][a], k=len(complete[t][a])) for a in ARMS}
        boots.append(gap(sample)[0])
    boots.sort()
    lo, hi = boots[249], boots[9749]
    print(f"\n(e) − curve: {observed:+.3f}  95% interval [{lo:+.3f}, {hi:+.3f}]")
    spend = sum(r["usd"] for r in state.values() if r.get("usd") is not None)
    print(f"arms spend: ${spend:.2f}")
    if seeds == [1]:
        print("futility stop: (e) trails by more than 0.05" if observed < -0.05 else "futility: continue to seeds 2 and 3")
    elif observed >= 0.06 and lo > 0:
        print("rule: D18's trigger fires (division beats the single-agent curve)")
    elif observed <= 0.02:
        print("rule: within 0.02 of the curve or below it: division stays deferred")
    else:
        print("rule: inconclusive")


if __name__ == "__main__":
    main()
