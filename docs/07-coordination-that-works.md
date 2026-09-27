# 07 — Multi-agent coordination that works, and what it means for OpenSwarm

Status: **draft for discussion** · 2026-09-27 · follows [docs/05](05-control-plane-redesign.md) §7.5

The docs/05 pilot's calibration ran four team cells on RoadmapBench and found
them about 35 times the cost of a single agent for lower reward (§1). Over
the same months, coordinated multi-agent systems produced frontier results in
mathematics and science. This doc asks how those systems coordinate, why
that differs from what the pilot tested, and what it implies for OpenSwarm's
design and experiments. Sources were gathered on 2026-09-27 by four research
passes (open mathematics, science systems, coding at scale, and the
equal-compute literature); many primary sites blocked fetching, so every
claim below is marked as it was sourced — **[P]** primary, **[S]**
secondary coverage, **[SN]** search snippet only. The central Navier–Stokes
claims were spot-checked against the primary sources.

## 1. What the pilot calibration found

Four live cells (gpt-5.5, one seed), each thread run as `--team`'s
coordinator team: pyg-2.2.0 sharded 0.50 / program 0.20, vbt-1.3.0 sharded
0.00 / program 0.00, about $70 a cell against about $2 for the single agent,
which scored 0.67 and 0.63 on the same tasks (docs/05 §10). Two causes:

1. **Division of labor without ownership.** Each thread's coordinator split
   its assignment into 7–13 subtasks that edited the same files from the same
   base in separate worktrees; 30–60 % of their branches conflicted and were
   retained unmerged (one thread merged 1 and retained 8).
2. **A binding budget.** A 40M-token backstop stopped two cells; vbt
   program's contracts thread alone spent it, so no target thread ran.

The configuration, not the idea of a team, failed. But the literature below
says something sharper: dividing one single-session task among concurrent
writers is the *least*-evidenced multi-agent mechanism there is.

## 2. What coordinated systems have actually achieved

| System | Result (with the honest caveat) | Coordination |
|---|---|---|
| OpenAI, Navier–Stokes (Sept 2026) | 3D Navier–Stokes finite-time blowup, 166 pp. with a Lean formalization; Clay: the problem "has apparently been settled", review "deliberately unhurried", no prize decision [P claymath.org]; coverage disagrees on whether the proved case is forced (Fefferman's alternatives (C)/(D) permit a smooth force) [S]; priority and data-provenance disputes [S] | about 10,000 agents in groups, each group on a different variant of the problem and pushed toward different approaches; Codex periodically pulled the best intermediate insights from each group and fed them to the others; an earlier 100-agent, 50-hour run on Euler seeded it; 88 h, "almost 5 million messages", "several million dollars" [S Quanta, spot-checked] |
| AlphaEvolve (2025) and Georgiev–Gómez-Serrano–Tao–Wagner (Nov 2025) | matched the best known result on ~75 % of 50+ open problems and improved ~20 % (e.g. 4×4 complex matrix multiplication in 48 multiplications) [P arxiv 2506.13131]; 67 problems in the Tao paper, several improved [P arxiv 2511.02864]; exploits loose or floating-point verifiers, weak in analytic number theory [P Tao's blog] | cheap model for breadth plus strong model for depth; a program database mixing MAP-Elites and island populations; a cascade of evaluators pruning early; asynchronous samplers and evaluators |
| FunSearch (2023) | 512-element cap set in dimension 8 [P] | islands reseeded every 4 h from survivors; ~10⁶ programs; 4 of 140 runs found the result — success is heavy-tailed |
| AlphaProof Nexus (May 2026) | 9 of 353 open Erdős problems, 44 of 492 OEIS conjectures, a few hundred dollars per problem [P arxiv 2605.22763] | parallel Lean-checked proof agents; the full agent adds a shared population database, Elo "raters", P-UCB parent sampling and a global cache of solved subgoals keyed by Lean state — yet **the basic agent, independent parallel provers with no shared state, solved all 9**; the full agent was 2–5× cheaper on the two hardest and about half as cost-efficient on the rest [P, spot-checked] |
| Unit-distance conjecture disproved (OpenAI, May 2026) | human-checked writeup by Alon, Bloom, Gowers, Litt, Sawin et al.; "the unique interesting result produced autonomously by AI so far" (Litt) [S] | not detailed publicly |
| Anthropic C compiler (Feb 2026) | 100k-line Rust compiler building Linux 6.9 on three architectures; ~$20k; slower than GCC -O0, near Opus's limit [P] | 16 agents, no orchestrator, no messages; tasks claimed by committing a file under `current_tasks/`; git sync decides races; the compiler test suites are the oracle; when the kernel was one monolithic failure, GCC was used as a known-good oracle to split failing files among agents |
| Cursor long-running agents (Jan–Feb 2026) | >1M-line browser in a week, a 3-week migration [P]; 88 % CI failure rate reported [S] | flat peers with locks or optimistic concurrency failed (20 agents ran at the speed of 2–3; agents became risk-averse); planners and recursive sub-planners create tasks, workers never talk and work on isolated copies, a judge decides each cycle; an integrator role was a bottleneck and was removed; a small stable error rate plus a final reconciliation pass beat per-commit perfection [P] |
| Company migrations (Google, Meta, Spotify, Airbnb) | Google: 39 migrations, 74 % of 595 changes LLM-generated, ~50 % time saved [P] | one agent per call site or file, a check ladder (parse, build, test), human review; no inter-agent coordination at all |

Science systems (Google's AI co-scientist, FutureHouse's Robin and Kosmos,
Anthropic's enzyme screen, Sakana's AI Scientist, the Stanford Virtual Lab)
are covered in §3.6.

## 3. The coordination patterns that carry these results

### 3.1 The oracle comes first

Every result above sits on a cheap, exact checker: the Lean kernel (Navier–
Stokes, Nexus, Aristotle, Seed-Prover, AlphaProof), a numeric scorer
(FunSearch, AlphaEvolve), or a test suite (the C compiler, the migrations).
The equal-compute literature agrees: methods with a verifier scale better
than verifier-free ones and the gap widens with budget; without one, voting
and reward models plateau after a few hundred samples [P arxiv 2502.12118,
2407.21787]. Scale is bounded by the checker, and the checker gets gamed —
AlphaEvolve exploits loose verifiers; Lean certifies whatever statement it is
given, so misformalization is the residual risk.

### 3.2 Populations with selection, not division of labor

The large results are searches over **alternatives**, not assemblies of
**parts**: islands, MAP-Elites, Elo tournaments, or agent groups competing on
different variants of the problem. Candidates never need to merge; the
evaluator picks. In the equal-compute literature, independent sampling plus
verifier selection is the best-evidenced mechanism there is (self-consistency
+17.9 on GSM8K; CodeMonkeys 57.4 % on SWE-bench Verified, 66.2 % selecting
across systems' candidates; hybrid execution + judge verifiers 51 % where
either alone reached 42–43 %) [P/SN]. On single-issue coding benchmarks,
parallel exploration plus a checker adds 5–12 points while splitting the task
adds about zero or less at matched tokens [research pass 3]. Nexus is the
cleanest data point: independent parallel provers solved everything the
elaborate evolutionary agent did.

### 3.3 Diversity by construction

Diversity is engineered, not hoped for: different problem variants per group
(Navier–Stokes), a cheap model for breadth and a strong one for depth
(AlphaEvolve), islands that reseed. Copies of one model talking converge:
thirty debating agents are no more diverse than one on MMLU-Hard, and only
mixing models raises the ceiling [P arxiv 2606.02646]. Near-duplicate
candidates are rejected (ShinkaEvolve) [SN].

### 3.4 Shared state is an archive, not a conversation

What agents share is a store with lineage and scores — a program database, a
cache of solved subgoals keyed by Lean state, git task files — or a periodic
consolidator (Codex pulling the best group insights). Workers do not talk to
each other in any of the coding systems that scaled. Debate and critique add
little at equal compute (majority voting explains most of debate's gains),
except where the critic knows something the author does not, such as test
output [P arxiv 2508.17536, 2402.06782].

### 3.5 Division of labor only along the oracle's units

Where work is split, it is split along the checker: one agent per call site
(migrations), per failing file (the compiler's GCC bisect), per test target,
each with its own check and one writer. Cognition's 2026 position is "writes
stay single-threaded" [P]. Claude Code's agent-teams docs warn that two
teammates editing one file overwrite each other [P]. Error amplification is
17.2× with independent agents and 4.4× with central verification [P arxiv
2512.08296], and returns turn negative once a single agent already scores
above about 45 % on the task.

### 3.6 Science systems

The science systems show the same split, with weaker evaluators and so weaker
evidence. Google's AI co-scientist (Nature 2026) runs a supervisor over
asynchronous generation, reflection, Elo-tournament ranking, proximity
(dedup) and evolution agents; its lab validations are real (AML drug
candidates, liver-fibrosis targets in organoids), but its scaling curve is
Elo scored by its own ranking agent and its baselines were single outputs,
not compute-matched [P arxiv 2502.18864]. FutureHouse's Robin found ripasudil
for dry AMD, and its analysis agent reported a 7.5× effect that human
reanalysis put at 1.75× [P arxiv 2505.13400]. Kosmos shares a structured
world model across ~166 analysis and ~36 literature rollouts a run; an audit
found 79.4 % of statements accurate but only 57.9 % of interpretations, and
the world model is never ablated [P arxiv 2511.02824]. Anthropic ran about
950 agents for 21 hours to filter 200,000+ reverse transcriptases to 20
candidates for human review and wet lab (preprint) [P]. The one compute-aware
comparison found a reimplemented co-scientist scaffold (288 calls) roughly
matching single-pass generation (1 call), while structured search against an
external evaluator did best [P arxiv 2609.15938, a single preprint]; role
personas and meta-review feedback have no ablation behind them or measure at
noise level. The research pass's bottom line: no science study shows
role-structured coordination beating single-agent search at equal compute;
the reproducible gains come from search against external evaluators and
parallel scale.

### 3.7 Costs every design pays

Tokens scale with agents (about 15× chat for Anthropic's research system,
where token usage explained 80 % of variance) [P]; handoffs lose information;
parallel writers make conflicting implicit decisions [P Cognition]; success
is heavy-tailed, so many independent restarts matter; and "getting answers"
decouples from "getting understanding" (Tao) [P].

## 4. What the pilot tested, against this

| Evidence says | The pilot's team arms did |
|---|---|
| search over alternatives, select with a verifier | assembled parts; no selection — every branch was meant to merge |
| exact oracle in the loop | members could not see the held-out tests (correctly) and often could not run the repo's tests at all until `5cfab25` |
| one writer per unit, split along the oracle | 7–13 concurrent writers per thread on overlapping files |
| diversity by construction | one model, one prompt style, one plan |
| shared archive with scores | none; the journal held the board, not candidates |

The program-vs-sharded question is a question about division of labor, the
mechanism with the weakest evidence at this task size. It is still worth
answering cheaply (one writer per thread), but it is not where multi-agent
coordination has earned its results.

## 5. What this means for OpenSwarm

The kernel already has most of what the effective systems use, under other
names: the run journal is an archive with lineage (A3–A4); worktrees isolate
attempts; the merge queue is a selection gate; Phase B's verifier levels are
the oracle; the question queue is the human checkpoint. What is missing is
the topology that uses them the way the evidence says.

1. **Make verifier-selected exploration the first-class topology.** An
   `explore` run launches N independent attempts at the *same* task in
   isolated worktrees, scores each with the verifier ladder (L2 commands, an
   exploitation-resistant L3, an LLM judge only as a tiebreaker), and lands
   the winner. This is best-of-N with a real checker — the best-evidenced
   mechanism — and it fits our cost research: a cheap model for breadth and a
   strong one for depth (legacy docs/62) is AlphaEvolve's split.
2. **Add an archive-driven `evolve` topology for optimization-shaped goals**
   (performance, benchmark score, pass rate): candidates recorded in the
   journal with parent, score vector and evaluator output; parents sampled
   with an exploration bonus; islands for diversity; near-duplicates dropped.
3. **Add `variants`: groups on different formulations or approaches with a
   periodic consolidator** that distills the best insights back into the
   shared journal — the Navier–Stokes pattern, and a use for the protocol's
   events and steering.
4. **Keep division of labor, but only along oracle units with one writer
   each** — Phase C's scopes are exactly this, and should come before any
   more program-scale experiments.
5. **Reprioritize Phase B around the verifier.** The oracle is the
   coordinator; it has to be exact and hard to game, and the train should
   select among candidates as well as merge them.
6. **Always run a budget-matched baseline**: one agent given N× the tokens,
   or N sequential retries. Most published multi-agent wins disappear against
   it; ours must not.
7. **Aim where single agents plateau and checkers are exact**: the hard end
   of benchmarks (single-agent reward under about 0.45), formal proofs,
   performance work, large migrations split by call site.

## 6. What to test next

The pilot's frozen set (docs/05 §10) can test the best-evidenced mechanism
for the cost of a few dozen single-agent runs: on each task, compare (a) one
agent, (b) one agent given N× the budget as sequential retries, and (c) N
independent attempts selected by the repository's own visible tests plus a
judge — never the held-out tests, which only grade. If (c) beats (b) on
landed reward per dollar, `explore` earns its place; if not, the evidence
does not transfer to our harness and we should know that before building
more topology. The program-vs-sharded comparison, rerun with one writer per
thread, is the second, cheaper question.
