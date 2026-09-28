# 07 — Multi-agent coordination that works, and what it means for OpenSwarm

Status: **draft for discussion** · 2026-09-27 · follows [docs/05](05-control-plane-redesign.md) §7.5

The docs/05 pilot's calibration ran four team cells on RoadmapBench and found
them about 35 times the cost of a single agent for lower reward (§1). Over
the same months, coordinated multi-agent systems produced frontier results in
mathematics and science. This doc asks how those systems coordinate, why
that differs from what the pilot tested, and what it implies for OpenSwarm's
design and experiments. Sources were gathered on 2026-09-27 by six research
passes (open mathematics, science systems, coding at scale, the equal-compute
literature, large software projects, and large mathematical projects with the
coordination literature); many primary sites blocked fetching, so every
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

The configuration, not the idea of a team, failed. The literature below
separates two mechanisms: searching alternatives with a verifier (§3), the
best-evidenced one, and dividing one large project among agents (§4), which
works under five specific conditions — conditions the pilot's team arms
violated inside every thread.

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

## 4. Coordinated development on large projects

§3 is about searching alternatives. The other question is whether dividing
one project too large for a single agent among coordinated agents works. A
second research pass (software benchmarks since 2025, Lean formalization
projects, Polymath, and the software-engineering coordination literature)
says it does, under conditions that are specific and repeatable, and fails
without them.

**Uncoordinated division loses to one agent.** Two agents implementing
overlapping features in isolated workspaces, talking only in natural
language, succeed about 30 % less often than one agent doing both
(CooperBench: GPT-5 50.6 % → 32.5 %); planning together first cut merge
conflicts from 51.5 % to 29.4 % but did not raise success [P arxiv
2601.13295]. When two agents build parts of one class, integration accuracy
falls from 58 % to 25 % as the shared spec thins from docstrings to bare
signatures, and a full spec restores the single-agent 89 %; an AST conflict
detector with 97 % precision added nothing [P arxiv 2603.24284].

**Coordinated division beats one agent at library and project scale.**
Co-Coder writes an interface blueprint first, gives each heavily shared hub
file a single owner, partitions files by dependency community and schedules
by dependency: 68.1 % tests passed on DevEval against 56.8 % sequential and
57.7 % file-by-file parallel, 28–35 % cheaper and 45–52 % faster; the gains
appear only on dependency-dense projects [P arxiv 2606.00953]. STORM, whose
engineers share one workspace and have a write rejected if anything they read
has changed, beats one agent on Commit0-Lite (82.5 vs 66.4 macro pass) while
separate git worktrees merged afterwards do not (63.8), at roughly 4.4× the
spend [P arxiv 2605.20563]. AgentRoom's atomic file claims give zero semantic
conflicts and beat one agent at about 2× compute [P arxiv 2608.23740]. Single
agents still fail project-scale benchmarks (best 13–40 % on NL2Repo,
RoadmapBench, SWE-EVO, SWE-Milestone), mostly by stopping early, losing
coherence and accumulating regressions; METR's 50 % time horizon is about 12
hours but the 80 % horizon is about 1.5 [P]. No published program-scale
result is budget-matched against a single agent yet.

**Large mathematics is coordinated the same way.** The PFR formalization
finished in about three weeks from a blueprint — a dependency graph of lemmas
that contributors claimed [P Tao]. Carleson (28 contributors, 179 lemmas)
failed until the blueprint was rewritten so any lemma could be proved from
its statement alone and most statements were formalized before contributors
started [P]. The Equational Theories Project settled 22 million implications
with 50+ contributors, tasks claimed through GitHub issues with CI allowing
one claimant each [P arxiv 2512.07087]. Anthropic's agents formalized
Fermat's Last Theorem in ten days of August 2026 (29,511 theorems, ~13M
lines, accepted by the Lean kernel and a second checker): statements were
immutable nodes in a shared graph, agents checked each other's statements by
computing cases, and earlier attempts had failed because agents "lost track
of the project's state"; about two in five statements were duplicates [P].
Math Inc.'s Gauss formalized the strong prime number theorem in three weeks
and the 8-dimensional sphere packing proof in five days, on top of 22 months
of human blueprint [P]. Polymath's human precedents succeeded when
sub-problems were nearly independent, the metric was measurable and a leader
summarized on a rhythm [P].

**The five conditions every success had:**

1. **Contracts frozen first, and machine-checkable** — statements before
   proofs, interfaces and contract tests before implementations.
2. **A cheap checker on every unit** — the Lean kernel per lemma, tests per
   module.
3. **Claims enforced by the system** — CI, leases or write-time freshness
   checks, never chat.
4. **A small audited trust surface** — Carleson's 170-line statement file;
   everything else is checked mechanically.
5. **A central keeper who repairs the graph** — maintainers, the blueprint's
   author, a chief architect; and a budgeted cleanup pass for duplication.

**Search and division are phases, not rivals.** Blueprint projects divide
work whose route is already known; the blueprint is the handoff from search
to division. Navier–Stokes, whose route was unknown, searched competing
variants at the top level and formalized afterwards. Search where the route
is unknown; divide where it is known.

## 5. What the pilot tested, against this

| Evidence says | The pilot's team arms did |
|---|---|
| search over alternatives, select with a verifier | assembled parts; no selection — every branch was meant to merge |
| exact oracle in the loop | members could not see the held-out tests (correctly) and often could not run the repo's tests at all until `5cfab25` |
| one writer per unit, split along the oracle | 7–13 concurrent writers per thread on overlapping files |
| diversity by construction | one model, one prompt style, one plan |
| shared archive with scores | none; the journal held the board, not candidates |
| contracts frozen first, machine-checkable (§4) | t0's contracts were prose assignments, not a checked statement file or contract tests |
| claims enforced by the system (§4) | none inside a thread; subtasks were merged from worktrees after the fact, the design STORM measured below a single agent |
| a central keeper who repairs the graph (§4) | each thread's coordinator only decomposed and synthesized |

Across threads, docs/05's program design is close to Co-Coder, the strongest
division-of-labor result: a blueprint, contracts first, partition by
dependency, hub files owned by one thread. Inside threads, the pilot ran the
configuration the evidence says loses. The program-vs-sharded question is
therefore still open and worth answering, with each thread run as one writer.

## 6. What this means for OpenSwarm

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
4. **Build division of labor to the five conditions of §4.** The program
   topology keeps its blueprint, but thread 0 lands a machine-checkable
   statement file (interfaces, stubs, contract tests) that CI enforces and
   agents peer-check by computing cases; claims are leases the journal
   enforces (A3 has them) or write-time freshness checks, not worktree merges
   after the fact; every thread has its own oracle plus a whole-program
   regression check at each landing; threads are sized to the single agent's
   reliable horizon (~1.5 h at 80 %), not its 50 % horizon; hub files have one
   owner; and a keeper role repairs the graph and runs a cleanup pass. Phase
   C's scopes are the claims half of this.
5. **Search where the route is unknown, divide where it is known.** A program
   can open with an `explore` or `variants` phase whose winning plan becomes
   the blueprint — the handoff every blueprint project made by hand.
6. **Reprioritize Phase B around the verifier.** The oracle is the
   coordinator; it has to be exact and hard to game, and the train should
   select among candidates as well as merge them.
7. **Always run a budget-matched baseline**: one agent given N× the tokens,
   or N sequential retries. Most published multi-agent wins disappear against
   it; ours must not. No published program-scale result is budget-matched
   yet, so ours would be a contribution.
8. **Aim where single agents plateau and checkers are exact**: the hard end
   of benchmarks (single-agent reward under about 0.45), library-scale work
   (RoadmapBench's median change is 51 files — the scale where Co-Coder and
   STORM win), formal proofs, performance work, large migrations split by
   call site.

## 7. What to test next

The frozen pilot set (docs/05 §10) can test both mechanisms on the same
tasks, each against a budget-matched single agent.

1. **Search** — (a) one agent; (b) one agent given N× the budget as
   sequential retries; (c) N independent attempts selected by the
   repository's own visible tests plus a judge, never the held-out tests,
   which only grade. Costs a few dozen single-agent runs.
2. **Division** — the pilot's arms rebuilt to §4's conditions: each thread
   one writer; thread 0 landing interfaces, stubs and contract tests that
   gate the dependents; a whole-program regression check at each landing;
   (d) sharded vs (e) program vs (b) the budget-matched single agent.
   About 4–5 agents a cell, so an order of magnitude cheaper than the
   calibration.

If (c) beats (b), `explore` earns its place. If (e) beats both (d) and (b)
on landed reward per dollar, program-scale coordination does on our harness
what Co-Coder showed it can; if not, docs/05's Phase C and D are re-scoped as
D10 already provides.
