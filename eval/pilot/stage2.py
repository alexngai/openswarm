"""docs/07 §7.6's stage 2: the screen, then the arms, under the owner's ceiling.

Run on the eval host from openswarm's eval/ directory (where runner.mjs's
.eval-runs/ live), with the Azure route in the environment:

    python3 -I pilot/stage2.py screen <candidates.txt> [--cap USD]
    python3 -I pilot/stage2.py arms <frozen.txt> [--cap USD] [--seeds 2,3]
    python3 -I pilot/stage2.py spend

screen: candidates in RoadmapBench's order (those passing file-rule.py). Each
gets the reference check (solve.sh then test.sh, three times, all 1.0; no
model), then arm (f8) at seed 1 and, unless seed 1 already rules it out
(above 0.90, so the two-seed mean cannot be at most 0.45), seed 2. A task
qualifies at a mean of at most 0.45; the first 8 that qualify, in order, are
frozen. Up to four tasks run at once; none is started while the qualified
so far and the ones running could already make 8.

arms: (f8), (f16) and (e) on the frozen tasks, seed by seed: seed 1 alone
first (the futility check is computed from it), then `--seeds 2,3`.

STAGE2_PREFIX (default stage2) names the runs, so a zero-token rehearsal
against pilot-mock.mjs is kept out of the spend.

Spend is every stage-2 cell's usage at $5 / $0.50 / $30 per M (fresh input,
cached input, output). Nothing starts when what is spent, plus a reserve of
$RESERVE for each cell running and the one starting, would pass the cap.
"""
import glob
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROADMAP = Path(os.environ.get("ROADMAP_DIR", HERE / ".roadmap"))
RESERVE = float(os.environ.get("STAGE2_RESERVE", 100))
CEILING = 7000.0  # the owner's, 2026-10-18
PREFIX = os.environ.get("STAGE2_PREFIX", "stage2")
STATE = Path(f".eval-runs/{PREFIX}-state.json")
LOG = Path(f".eval-runs/{PREFIX}.log")
lock = threading.Lock()


def log(line: str) -> None:
    with lock, LOG.open("a") as f:
        f.write(f"{time.strftime('%H:%M:%S')} {line}\n")
    print(line, flush=True)


def usd(u: dict) -> float:
    return (u.get("inputTokens", 0) * 5 + u.get("cacheReadTokens", 0) * 0.5 + u.get("outputTokens", 0) * 30) / 1e6


def cells(run_glob: str = f"{PREFIX}-*"):
    for f in glob.glob(f".eval-runs/{run_glob}/cache/*.json"):
        if not f.endswith(".submission.json"):
            yield json.load(open(f))


def spend() -> float:
    return sum(usd(d.get("usage") or {}) for d in cells())


class Budget:
    def __init__(self, cap: float):
        self.cap = min(cap, CEILING)
        self.running = 0

    def admit(self) -> bool:
        with lock:
            if spend() + RESERVE * (self.running + 1) > self.cap:
                return False
            self.running += 1
            return True

    def done(self) -> None:
        with lock:
            self.running -= 1


def image_of(task: str) -> str:
    toml = (ROADMAP / f"{task}-roadmap" / "task.toml").read_text()
    return toml.split('docker_image = "', 1)[1].split('"', 1)[0]


def gold(task: str) -> list[float]:
    """The reference solution's reward, three times, each in a fresh container."""
    d = ROADMAP / f"{task}-roadmap"
    rewards = []
    for _ in range(3):
        r = subprocess.run(
            ["docker", "run", "--rm", "--cpus", "8", "--memory", "16g",
             "-v", f"{d / 'solution'}:/solution:ro", "-v", f"{d / 'tests'}:/tests-src:ro", image_of(task),
             "bash", "-c", "cp -r /tests-src /tests && bash /solution/solve.sh >/dev/null 2>&1; bash /tests/test.sh >/dev/null 2>&1; cat /logs/verifier/reward.json"],
            capture_output=True, text=True, timeout=3600,
        )
        try:
            rewards.append(float(json.loads(r.stdout.strip().splitlines()[-1])["reward"]))
        except Exception:
            rewards.append(-1.0)
    return rewards


def cell(task: str, arm: str, seed: int) -> dict | None:
    """One runner cell; its record (reward, cost), or None when it failed to run."""
    run_id = f"{PREFIX}-{arm}-{task}-s{seed}"
    env = {**os.environ, "ROADMAP_TASKS": task, "ROADMAP_ARMS": arm, "ROADMAP_SEEDS": str(seed), "ROADMAP_RUN_ID": run_id, "ROADMAP_CONCURRENCY": "1"}
    with open(f".eval-runs/{run_id}.out", "w") as out:
        subprocess.run(["node", str(HERE / "runner.mjs")], env=env, stdout=out, stderr=subprocess.STDOUT)
    for d in cells(run_id):
        s, u = d.get("score") or {}, d.get("usage") or {}
        reward = s["earned"] / s["total"] if s.get("total") else None
        return {"reward": reward, "usd": round(usd(u), 2), "status": d.get("status"), "minutes": round(d.get("durationMs", 0) / 60000)}
    return None


def load() -> dict:
    return json.loads(STATE.read_text()) if STATE.exists() else {"screen": {}, "arms": {}}


def save(state: dict) -> None:
    with lock:
        STATE.write_text(json.dumps(state, indent=1))


def screen(candidates: list[str], cap: float) -> None:
    state = load()
    budget = Budget(cap)
    results = state["screen"]
    running: dict[str, threading.Thread] = {}

    def qualified() -> list[str]:
        return [t for t in candidates if results.get(t, {}).get("verdict") == "qualifies"]

    def work(task: str) -> None:
        rec = results.setdefault(task, {})
        try:
            if "gold" not in rec:
                rec["gold"] = gold(task)
                save(state)
                log(f"{task} gold {rec['gold']}")
            if rec["gold"] != [1.0, 1.0, 1.0]:
                rec["verdict"] = "reference fails"
                return
            for seed in (1, 2):
                key = f"s{seed}"
                if key in rec:
                    continue
                if seed == 2 and rec["s1"]["reward"] is not None and rec["s1"]["reward"] > 0.90:
                    break
                if not budget.admit():
                    rec["verdict"] = "stopped: cap"
                    return
                try:
                    rec[key] = cell(task, "onethread8", seed) or {"reward": None}
                finally:
                    budget.done()
                save(state)
                log(f"{task} f8 seed {seed}: {rec[key]}")
            rewards = [rec[k]["reward"] for k in ("s1", "s2") if k in rec]
            if any(r is None for r in rewards):
                rec["verdict"] = "cell failed"
            else:
                mean = sum(rewards) / 2 if len(rewards) == 2 else None
                rec["mean"] = mean
                rec["verdict"] = "qualifies" if mean is not None and mean <= 0.45 else "too easy"
        finally:
            save(state)
            log(f"{task}: {rec.get('verdict')} (spent ${spend():.2f})")

    for task in candidates:
        if results.get(task, {}).get("verdict") in ("qualifies", "too easy", "reference fails"):
            continue
        while True:
            for t in [t for t, th in running.items() if not th.is_alive()]:
                del running[t]
            if len(qualified()) >= 8:
                break
            if len(running) < 4 and len(qualified()) + len(running) < 8:
                break
            time.sleep(30)
        if len(qualified()) >= 8 or spend() + RESERVE > budget.cap:
            break
        running[task] = threading.Thread(target=work, args=(task,))
        running[task].start()
        log(f"{task}: started")
    for th in running.values():
        th.join()
    frozen = qualified()[:8]
    state["frozen_screened"] = frozen
    save(state)
    log(f"screen done: {len(frozen)} frozen {frozen}; spent ${spend():.2f}")


def arms(frozen: list[str], cap: float, seeds: list[int]) -> None:
    state = load()
    budget = Budget(cap)
    results = state["arms"]
    for seed in seeds:
        jobs = [(t, a) for t in frozen for a in ("onethread8", "onethread16", "divprogram") if f"{a}-{t}-s{seed}" not in results]
        running: list[threading.Thread] = []
        stopped = False

        def work(task: str, arm: str, seed: int = seed) -> None:
            try:
                results[f"{arm}-{task}-s{seed}"] = cell(task, arm, seed) or {"reward": None}
            finally:
                budget.done()
            save(state)
            log(f"{arm} {task} seed {seed}: {results[f'{arm}-{task}-s{seed}']} (spent ${spend():.2f})")

        for task, arm in jobs:
            while len([th for th in running if th.is_alive()]) >= 4:
                time.sleep(30)
            if not budget.admit():
                stopped = True
                break
            th = threading.Thread(target=work, args=(task, arm))
            th.start()
            running.append(th)
        for th in running:
            th.join()
        if stopped:
            log(f"arms stopped at the cap during seed {seed}; spent ${spend():.2f}")
            return
        log(f"seed {seed} done; spent ${spend():.2f}")


if __name__ == "__main__":
    cmd = sys.argv[1]
    cap = float(sys.argv[sys.argv.index("--cap") + 1]) if "--cap" in sys.argv else CEILING
    if cmd == "spend":
        print(f"${spend():.2f}")
    elif cmd == "screen":
        screen([t for t in Path(sys.argv[2]).read_text().split() if t], cap)
    elif cmd == "arms":
        seeds = [int(x) for x in sys.argv[sys.argv.index("--seeds") + 1].split(",")] if "--seeds" in sys.argv else [1]
        arms([t for t in Path(sys.argv[2]).read_text().split() if t], cap, seeds)
