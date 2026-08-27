import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'

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

/** One fanout assignment: a member name plus its prompt. */
export interface FanoutTask {
  member: string
  prompt: string
}

/** Run every task concurrently, one subagent run per task. */
export interface FanoutSpec {
  topology: 'fanout'
  members: MemberSpec[]
  tasks: FanoutTask[]
}

/**
 * Worker drafts, critic reviews, feedback threads back into the next draft.
 * The critic replies `APPROVED` or `REVISE: <feedback>` (plain-text protocol;
 * a structured `outputSchema` verdict is a later refinement).
 */
export interface CriticLoopSpec {
  topology: 'critic-loop'
  worker: MemberSpec
  critic: MemberSpec
  task: string
  /** Maximum worker→critic rounds before returning unapproved (default 3). */
  maxRounds?: number
}

/** N members answer the same task in parallel; an optional judge synthesizes. */
export interface CommitteeSpec {
  topology: 'committee'
  members: MemberSpec[]
  task: string
  /** Reviews every answer and produces the synthesis. */
  judge?: MemberSpec
}

/** Sequential stages; each stage's prompt receives the previous stage's output. */
export interface PipelineSpec {
  topology: 'pipeline'
  stages: { member: MemberSpec; prompt: string }[]
}

/**
 * Escalation chain: tiers attempt the task in order (cheap first). A tier's
 * result is accepted unless its run failed or the optional gate rejects it
 * (same APPROVED / REVISE protocol as the critic); rejection feedback threads
 * into the next tier's prompt.
 */
export interface CascadeSpec {
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
export interface CoordinatorSpec {
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
}

/**
 * Work-stealing peers over the shared SwarmBoard: every member loops
 * claim-next-ready → run → complete until the whole board is done. Peer
 * messaging between live members needs continuable children and arrives with
 * the mailbox in a later phase.
 */
export interface PeerTeamSpec {
  topology: 'peer-team'
  members: MemberSpec[]
  tasks: PeerTask[]
  /**
   * Run members as continuable peers with the durable mailbox and the
   * `swarm_send_message` tool (in-process providers only in this phase).
   * Default false: one-shot members, no messaging.
   */
  messaging?: boolean
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
