# pilot — program vs sharded vs single on RoadmapBench (docs/05 §7.5, D10)

| file | what |
|---|---|
| `tasks.txt` | the frozen task set (12 RoadmapBench Python/TypeScript tasks) |
| `plans/<task>/plan.json` | the hand-written partition each team arm runs: `t0` contracts, 2–3 target threads |
| `runner.mjs` | swarmkit-eval matrix over Docker: arms `single`, `sharded`, `program`, `landtrain`, …; grading by the task's own `tests/test.sh` |
| `pilot-mock.mjs`, `split-patch.py` | zero-token plumbing check: a scripted model applies each thread's slice of the reference solution |
| `leak-check.py` | a plan may name targets, directories and existing files, never what only the reference solution contains |
| `t0-share.py` | t0's share of plan-assigned source lines; under 0.5 is the pre-registered decomposable subset |
| `search.mjs`, `search.check.mjs` | docs/07 §7.1 search arms in the container: `attempt` (agent, then a reviewer) and `rounds` (agent rounds fed by the reviewer); the check runs it against a scripted CLI |
| `search-report.py` | arms (a), (b), (c) and the selection ceiling from an `attempt` run and a `rounds` run |
| `gate.mjs` | the completion gate both drivers share: agent rounds, a reviewer whose report opens the next, rollback of the reviewer's edits |
| `division.mjs`, `division.check.mjs` | docs/07 §7 division arms (`divsharded`, `divprogram`): one gated writer per plan thread in a worktree, thread 0's contract check at every landing, a final whole-roadmap review routed to owners |
| `division-report.py`, `search-audit.py` | the division arms against (a), (b), (b0); the leak audit |
| `screen-report.py` | per-task summary of a run: mean/min/max reward, cost, parser audit against `reward.json` |
| `landing-checks.json`, `landing-base.mjs` | arm `landtrain`'s per-task train check (commands only), and the zero-token check that each passes on its base tree in its image |
| `landing.mjs`, `landing.check.mjs` | docs/05 Phase B exit criterion 1: after grading, today's sequential queue replayed on the train's branches, both measured by the check and the held-out test.sh; the check runs it on a temp repo |
| `landing-report.py` | the train against the queue: exit criterion 1 (landing rate and clean-merge rate, pooled), the paired held-out reward, bisects, repairs, cost, cells graded against expected |

Task data and reference slices live in the gitignored `.roadmap/` (download the task dirs from
the HF dataset `UnipatAI/RoadmapBench`, skipping `environment/repo`). They are the benchmark's
gold solutions, which carry a training-corpus canary: never commit them.

Rig and costs: docs/05 §10 (Task set).
