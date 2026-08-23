import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'

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

export type TeamSpec = FanoutSpec | CriticLoopSpec

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

export type TeamResult = FanoutResult | CriticLoopResult
