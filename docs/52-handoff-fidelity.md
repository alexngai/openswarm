# 52 — Handoff fidelity: lossless multi-agent handoffs for the cost-frontier study

**Status:** design + Phase A landed. Prerequisite to a fair mono-vs-multi comparison (docs/50).

## Why this exists

docs/50's discrimination runs found the heterogeneous arms (cascade, advisor) tie mono-haiku's
accuracy while costing more — a *negative* result for "coordination expands the frontier." But that
conclusion is **confounded twice**:

1. **Model confound** — haiku/gpt-5.5 are RLHF-tuned to solve tasks *solo*; "mono wins" partly
   measures training distribution, not coordination value. (Addressed by co-training — chorus — not here.)
2. **Framework confound** — OpenSwarm's handoffs are **lossy**. On escalation the cascade passes only
   the prior tier's *prose output* + "improve on it" ([cascade.ts](../src/swarm/topologies/cascade.ts)),
   and the advisor's critic reviews the executor's *self-summary* — it never sees the actual diff. A
   multi-agent loss under a lossy handoff can't be attributed to "coordination doesn't help."

This doc removes the framework confound: give the receiving agent the **full working state** so a fair
test is possible. It also plausibly helps the economics directly — a lossless handoff makes escalation
*cheaper* (build on applied work instead of re-exploring), which is the mechanism by which coordination
could beat mono.

## What the field does (baseline) — and OpenSwarm's opening

Primary-source read of Claude Code, OpenCode, Codex, and claude-code-swarm (full reports in the
session scratchpad). The convergent finding:

- **Every leading agent hands off via a lossy prose bottleneck.** A cold subagent gets a single prompt
  string; the working-tree **diff**, tool-call history, and todo list are never passed. Results return as
  prose (the child's last text block). Codex has no subagent at all. Only claude-code-swarm coordinates
  richly — via a shared task graph + message bus + memory *bolted onto* otherwise-cold agents.
- **OpenSwarm's structural advantage:** all cascade tiers and both critic-loop peers **already share one
  `cwd`** (the sandbox), so the diff is one `git diff` away — *"lossless handoff is an accessible-state
  problem, not a plumbing rewrite."* And OpenSwarm natively has what the field lacks: a lane-event
  **bus** (real trajectory), a **task registry** (durable artifacts), an **inbox** (resident advisor),
  and **git-cascade streams** (diff-as-commits, fork-from-prior-work).

Patterns worth borrowing: a **typed handoff contract** with a named return shape; **return the diff +
the failing reason**, not a prose summary; keep cold-spawn as default but add an **addressable,
resumable** subagent handle; use Codex's compaction checklist (tasks/files/decisions/errors/next) as the
required fields of a handoff record.

## The design: a structured handoff record

Every handoff (cascade escalation, advisor critic) carries four typed slots instead of a prose blob,
each sourced from the primitive that best carries it:

| slot | what | source primitive | phase |
|---|---|---|---|
| **diff** | the applied change | shared FS via `ctx.escalation.exec("git diff")` | A |
| **reason** | why rejected: failing check + confidence + its output | evaluator result + structured `team_note` + `escalation.task` | A (partial) / B |
| **trajectory** | what was tried (tools/files touched) | lane-event bus `onLaneEvent`, or `priorAttempts` | B |
| **feedback** | a required-changes *checklist*, not paragraphs | task-registry artifact / inbox / schema'd prompt | A (framing) / B |

## Phased plan

- **Phase A — adopt the baseline (small, zero-adapter).** Inject `diff + reason + structured framing`
  into the handoff prompt, sourced via `exec` + the confidence + `priorAttempts`. No new plumbing.
  Directly fixes the two observed failures: escalation stops being a cold restart, and **the critic
  finally sees the actual diff** (the django-12708 regression class).
- **Phase B — leverage OpenSwarm's primitives (the differentiator).** Real trajectory off the lane bus;
  durable structured artifacts in the task registry / shared memory; a **resident advisor** over the
  inbox (`ctx.persistent`) so advise-don't-redo keeps state across rounds; thread the evaluator's own
  failing-check detail through instead of re-running it.
- **Phase C — zero-copy worktree handoff (fully lossless).** git-cascade streams: tier N+1 **forks from
  tier N's stream** and starts *from its applied work* rather than reconstructing a diff from a prompt.

## Phase A — what landed

`src/swarm/handoff.ts` — `captureWorkspaceDiff(exec)` (best-effort `git diff` + new-file list of the
shared workspace, capped for prompt size) + `diffBlock(diff)` renderer.

- **CascadeTopology** — captures each tier's applied diff after it runs, and the escalated tier's prompt
  now has structured sections: **its applied changes (diff)**, **why it was rejected** (confidence vs τ /
  hard-fail), and its own summary — framed "build on its work, do not restart."
- **CriticLoopTopology** — the critic prompt now carries **the actual `git diff`** under review plus the
  **failing green-check output** (free — the stop-on-green check already ran it), not just the executor's
  self-summary. The critic reviews the real patch.

Both degrade gracefully (no exec / not a git repo → placeholder). No schema/adapter changes; testable on
the same 8-instance discrimination set.

## How we test it

Re-run the discrimination set (docs/50 §10.4) with the hardened + lossless handoff. The prediction: the
cascade's escalation gets *cheaper* (the strong tier builds on the applied diff instead of re-exploring),
and the advisor's critic makes better accept/reject calls (it sees the diff). Only after this is the
mono-vs-multi comparison a fair test of coordination value.

## References
- docs/50 §10.4 (advisor / advise-don't-redo), docs/51 (eval execution plan).
- External baseline + OpenSwarm-primitives reports (session scratchpad: `handoff-baseline-external.md`,
  `handoff-openswarm-primitives.md`).
- Key seams: `cascade.ts` (escalation prompt), `critic-loop.ts` (critic prompt), `escalation-evaluator.ts`
  (`ExecFn`), `standalone-host.ts` (lane bus, task registry, git-cascade streams).
