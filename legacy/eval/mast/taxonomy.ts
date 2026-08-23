/**
 * MAST — Multi-Agent System failure Taxonomy (Cemri et al., arXiv 2503.13657).
 * 14 fine-grained failure modes in 3 categories. Used as the LLM-as-judge rubric over openswarm
 * traces (docs/45 §6) to produce a per-mode failure histogram for OUR system.
 *
 * Validate the judge against MAST-Data labels before trusting the histogram.
 */

export type MastCategoryId = "FC1" | "FC2" | "FC3";

export interface MastCategory {
  readonly id: MastCategoryId;
  readonly name: string;
  /** Approx share of failures in the source study (paper Fig. 2): FC1 ~42% / FC2 ~37% / FC3 ~21%. */
  readonly paperShare: number;
}

export const MAST_CATEGORIES: Record<MastCategoryId, MastCategory> = {
  FC1: { id: "FC1", name: "Specification & System Design", paperShare: 0.418 },
  FC2: { id: "FC2", name: "Inter-Agent Misalignment", paperShare: 0.369 },
  FC3: { id: "FC3", name: "Task Verification & Termination", paperShare: 0.213 },
};

export interface MastMode {
  readonly code: string; // e.g. "FM-2.3"
  readonly category: MastCategoryId;
  readonly name: string;
  readonly hint: string; // what the judge looks for
}

/** The canonical 14 modes (5 + 6 + 3). Order = paper order. */
export const MAST_MODES: readonly MastMode[] = [
  // FC1 — Specification & System Design (5)
  { code: "FM-1.1", category: "FC1", name: "Disobey task specification", hint: "ignores explicit task constraints/requirements." },
  { code: "FM-1.2", category: "FC1", name: "Disobey role specification", hint: "an agent acts outside its assigned role/responsibilities." },
  { code: "FM-1.3", category: "FC1", name: "Step repetition", hint: "redundantly repeats steps/tool calls already completed." },
  { code: "FM-1.4", category: "FC1", name: "Loss of conversation history", hint: "loses prior context; acts as if earlier turns didn't happen." },
  { code: "FM-1.5", category: "FC1", name: "Unaware of termination conditions", hint: "doesn't recognize when the task is complete / when to stop." },
  // FC2 — Inter-Agent Misalignment (6)
  { code: "FM-2.1", category: "FC2", name: "Conversation reset", hint: "restarts/abandons the in-progress exchange, dropping accumulated state." },
  { code: "FM-2.2", category: "FC2", name: "Fail to ask for clarification", hint: "proceeds on ambiguous input instead of asking." },
  { code: "FM-2.3", category: "FC2", name: "Task derailment", hint: "drifts away from the assigned objective." },
  { code: "FM-2.4", category: "FC2", name: "Information withholding", hint: "an agent holds info another agent needed." },
  { code: "FM-2.5", category: "FC2", name: "Ignored other agent's input", hint: "disregards a peer's relevant output/suggestion." },
  { code: "FM-2.6", category: "FC2", name: "Reasoning-action mismatch", hint: "stated reasoning and the action taken diverge." },
  // FC3 — Task Verification & Termination (3)
  { code: "FM-3.1", category: "FC3", name: "Premature termination", hint: "stops before the task is actually done." },
  { code: "FM-3.2", category: "FC3", name: "No or incomplete verification", hint: "fails to (fully) check the result before finishing." },
  { code: "FM-3.3", category: "FC3", name: "Incorrect verification", hint: "verifies but reaches the wrong conclusion (passes broken work / fails good work)." },
];

export const MAST_MODE_BY_CODE: Record<string, MastMode> = Object.fromEntries(
  MAST_MODES.map((m) => [m.code, m]),
);

export const MAST_MODE_CODES: readonly string[] = MAST_MODES.map((m) => m.code);
