import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import type { VerifierLevel } from './gate'

/**
 * One addressable team peer. In-process peers carry the durable continuable
 * child id (activations are transient — never a captured Agent); remote
 * peers carry the live subprocess port.
 */
export interface PeerHandle {
  readonly name: string
  readonly childId?: SessionId
  readonly remote?: import('./remote-peer').RemotePeer
}

/** One swarm member: a named role over a subagent provider. */
export interface MemberSpec {
  /** Unique member name within the team; used as the run label. */
  name: string
  /**
   * Role framing prepended to every prompt this member receives. Embedded in
   * the prompt text rather than the seam's `persona` capability so members
   * work over providers that do not advertise persona support (e.g. dsh-sdk).
   */
  persona?: string
  /** Per-member provider/model route; omitted fields inherit from the parent agent. */
  agentOptions?: AgentOptions
  /** Subagent provider registry name; defaults to the swarm config default. */
  subagentProvider?: string
}

/**
 * Commander's intent (docs/05 §6.1): why the work exists and how to tell it
 * is done. Rendered as a header on every member prompt it applies to.
 */
export interface Intent {
  purpose: string
  /** Checkable: a member can tell whether it holds. */
  endState: string
  constraints?: string[]
  preferences?: string[]
}

/** What every topology's spec may carry. */
export interface TeamSpecBase {
  /** The run's intent; a peer-team task's own intent replaces it for that task. */
  intent?: Intent
}

/** One fanout assignment: a member name plus its prompt. */
export interface FanoutTask {
  member: string
  prompt: string
}

/** Run every task concurrently, one subagent run per task. */
export interface FanoutSpec extends TeamSpecBase {
  topology: 'fanout'
  members: MemberSpec[]
  tasks: FanoutTask[]
}

/**
 * Worker drafts, critic reviews, feedback threads back into the next draft.
 * The critic replies `APPROVED` or `REVISE: <feedback>` (plain-text protocol;
 * a structured `outputSchema` verdict is a later refinement).
 */
export interface CriticLoopSpec extends TeamSpecBase {
  topology: 'critic-loop'
  worker: MemberSpec
  critic: MemberSpec
  task: string
  /** Maximum worker→critic rounds before returning unapproved (default 3). */
  maxRounds?: number
}

/** N members answer the same task in parallel; an optional judge synthesizes. */
export interface CommitteeSpec extends TeamSpecBase {
  topology: 'committee'
  members: MemberSpec[]
  task: string
  /** Reviews every answer and produces the synthesis. */
  judge?: MemberSpec
}

/** Sequential stages; each stage's prompt receives the previous stage's output. */
export interface PipelineSpec extends TeamSpecBase {
  topology: 'pipeline'
  stages: { member: MemberSpec; prompt: string }[]
}

/**
 * Escalation chain: tiers attempt the task in order (cheap first). A tier's
 * result is accepted unless its run failed or the optional gate rejects it
 * (same APPROVED / REVISE protocol as the critic); rejection feedback threads
 * into the next tier's prompt.
 */
export interface CascadeSpec extends TeamSpecBase {
  topology: 'cascade'
  tiers: MemberSpec[]
  task: string
  /** LLM gate member (APPROVED / REVISE protocol). */
  gate?: MemberSpec
  /**
   * Command-confidence gate (the eval-harness escalation evaluator): after a
   * tier completes, every command runs in the workspace; confidence is the
   * weakest link (all must exit 0 for 1.0). Escalate when confidence < tau.
   * Takes precedence over the LLM `gate` when both are set.
   */
  confidence?: { commands: string[]; tau: number }
}

/**
 * A coordinator decomposes the task into a numbered subtask list, workers run
 * the subtasks concurrently (round-robin), and the coordinator synthesizes.
 */
export interface CoordinatorSpec extends TeamSpecBase {
  topology: 'coordinator'
  coordinator: MemberSpec
  workers: MemberSpec[]
  task: string
}

/** One board task seeded by a peer-team run; `blockedBy` are task indices. */
export interface PeerTask {
  subject: string
  prompt: string
  blockedBy?: number[]
  /** Replaces the run's intent for this task. */
  intent?: Intent
  /** This task's gate checks, replacing the team's (`PeerTeamSpec.gate`); an empty list means review mode. */
  checks?: string[]
  /** This task's verifier level and hidden suite, replacing the team's (docs/05 B1). */
  minLevel?: VerifierLevel
  suite?: string
}

/**
 * Work-stealing peers over the shared SwarmBoard: every member loops
 * claim-next-ready → run → complete until the whole board is done. Peer
 * messaging between live members needs continuable children and arrives with
 * the mailbox in a later phase.
 */
export interface PeerTeamSpec extends TeamSpecBase {
  topology: 'peer-team'
  members: MemberSpec[]
  tasks: PeerTask[]
  /**
   * Run members as continuable peers with the durable mailbox and the
   * `swarm_send_message` tool (in-process providers only in this phase).
   * Default false: one-shot members, no messaging.
   */
  messaging?: boolean
  /** Times one task may be retried on a sibling before it is abandoned (default 2). */
  maxTaskAttempts?: number
  /**
   * Warm restarts allowed per member before its task falls to a sibling
   * (default 1). Remote messaging teams only — the replacement resumes the
   * dead member's persisted session in its surviving worktree.
   */
  maxMemberRestarts?: number
  /**
   * Nudge a member turn producing no event for this long, then raise a stall
   * question after as long again (default 5min).
   */
  memberIdleTimeoutMs?: number
  /**
   * The completion gate on every task (docs/05 B6b): a task completes only
   * with passing evidence. A task with checks (its own, else these) is gated
   * by them, run where its member's work lands; one without is measured by an
   * independent reviewer, which needs worktree execution. A task that never
   * passes is retried up to `maxTaskAttempts`, then a person may accept it
   * without evidence; by default it is abandoned. Not yet with `messaging`.
   */
  gate?: {
    /** Agent rounds per attempt before the gate gives up (default 4). */
    rounds?: number
    checks?: string[]
    /** Whether a task without checks is reviewed (default true); false makes such a task an error. */
    review?: boolean
    /**
     * The verifier level every task must reach (docs/05 B1): 1 a reviewer, 2
     * checks, 3 a hidden suite. The board refuses evidence below it. Unset,
     * a task reaches whatever its sources give.
     */
    minLevel?: VerifierLevel
    /**
     * The hidden suite (L3) every task runs, by the name the verifier holds
     * it under (`openswarm verifier add-suite`). Its checks or the reviewer
     * then give feedback only.
     */
    suite?: string
  }
}

export type TeamSpec =
  | FanoutSpec
  | CriticLoopSpec
  | CommitteeSpec
  | PipelineSpec
  | CascadeSpec
  | CoordinatorSpec
  | PeerTeamSpec

/** Outcome of one member run. */
export interface MemberRunResult {
  member: string
  /** The subagent run id (equals the child session id for local providers). */
  runId: string
  /** Concatenated text blocks of the final assistant output. */
  text: string
  output: ContentBlock[]
  stopReason: SubagentStopReason
}

export interface FanoutResult {
  topology: 'fanout'
  results: MemberRunResult[]
}

export interface CriticLoopResult {
  topology: 'critic-loop'
  approved: boolean
  rounds: number
  /** The last worker draft (final deliverable whether or not approved). */
  final: MemberRunResult
  history: { draft: MemberRunResult; verdict: MemberRunResult }[]
}

export interface CommitteeResult {
  topology: 'committee'
  answers: MemberRunResult[]
  synthesis?: MemberRunResult
}

export interface PipelineResult {
  topology: 'pipeline'
  stages: MemberRunResult[]
  /** The last stage's result. */
  final: MemberRunResult
}

export interface CascadeAttempt {
  tier: number
  result: MemberRunResult
  verdict?: MemberRunResult
  /** Command-gate confidence measured for this tier, when configured. */
  confidence?: number
  /**
   * Which command rejected this tier, and what it printed. Present only when a
   * command gate failed. Without this a rejected tier is unattributable — an
   * environment problem and a genuine defect look identical, which is how a
   * correct edit once scored 0 (docs/01).
   */
  failure?: { command: string; output: string }
}

export interface CascadeResult {
  topology: 'cascade'
  /** Whether any tier's result was accepted before the chain was exhausted. */
  accepted: boolean
  /** Index into `tiers` of the accepted (or final attempted) tier. */
  tier: number
  final: MemberRunResult
  attempts: CascadeAttempt[]
}

export interface CoordinatorResult {
  topology: 'coordinator'
  plan: MemberRunResult
  subtasks: { prompt: string; worker: string; result: MemberRunResult }[]
  synthesis: MemberRunResult
}

export interface PeerTeamResult {
  topology: 'peer-team'
  /** Completed board tasks in board order, results recorded on each. */
  tasks: import('./board').SwarmTaskSnapshot[]
  /** Member run results keyed by board task id. */
  runs: Record<string, MemberRunResult>
}

export type TeamResult =
  | FanoutResult
  | CriticLoopResult
  | CommitteeResult
  | PipelineResult
  | CascadeResult
  | CoordinatorResult
  | PeerTeamResult
