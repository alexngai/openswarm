# pilot — program vs sharded vs single on RoadmapBench (docs/05 §7.5, D10)

| file | what |
|---|---|
| `tasks.txt` | the frozen task set (12 RoadmapBench Python/TypeScript tasks) |
| `plans/<task>/plan.json` | the hand-written partition each team arm runs: `t0` contracts, 2–3 target threads |
| `runner.mjs` | swarmkit-eval matrix over Docker: arms `single`, `sharded`, `program`; grading by the task's own `tests/test.sh` |
| `pilot-mock.mjs`, `split-patch.py` | zero-token plumbing check: a scripted model applies each thread's slice of the reference solution |
| `leak-check.py` | a plan may name targets, directories and existing files, never what only the reference solution contains |
| `t0-share.py` | t0's share of plan-assigned source lines; under 0.5 is the pre-registered decomposable subset |
| `screen-report.py` | per-task summary of a run: mean/min/max reward, cost, parser audit against `reward.json` |

Task data and reference slices live in the gitignored `.roadmap/` (download the task dirs from
the HF dataset `UnipatAI/RoadmapBench`, skipping `environment/repo`). They are the benchmark's
gold solutions, which carry a training-corpus canary: never commit them.

Rig and costs: docs/05 §10 (Task set).
