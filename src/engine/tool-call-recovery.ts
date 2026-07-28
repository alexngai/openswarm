/**
 * tool-call-recovery — per-turn policy layer over the tool-call repair
 * primitives.
 *
 * The engines own a turn's event stream, so they are the only place that can
 * see the three distinct ways an open-weight model's tool call goes missing:
 *
 *   1. **Delivered but mislabelled.** A `tool-call` event arrives with an
 *      aliased name (`shell`), a namespaced name (`functions.bash`), or an
 *      argument object wrapped in an envelope (`{"arguments": {…}}`). The
 *      dispatcher would reject it with `invalid_tool_name` /
 *      `invalid_tool_arguments` and burn a turn.
 *
 *   2. **Started but dropped.** The transport emits `tool-input-start` and
 *      streams `tool-input-delta` fragments, then the provider SDK fails to
 *      `JSON.parse` the accumulated argument string and never emits the
 *      `tool-call`. Nothing downstream ever learns the call existed. This is
 *      what a `max_tokens`-truncated argument object looks like.
 *
 *   3. **Never structured at all.** The server has no tool-call parser
 *      configured for the model family, so the call arrives as assistant text
 *      in the model's native syntax (`<tool_call>…`, `<|python_tag|>…`). The
 *      turn buffers zero tool uses and the engine reads it as terminal — the
 *      agent stops after one turn having narrated a call it never made.
 *
 * Case 3 is the expensive one and the reason this module exists: it is silent,
 * it looks like the model "chose" to stop, and the fix (a vLLM flag) is
 * invisible from inside the harness. See docs/63-tool-call-repair.md.
 *
 * Recovery never bypasses gating. Recovered calls re-enter the normal path —
 * `canUseTool`, then `ToolDispatcher.dispatch` with full Zod validation.
 */

import type { NormalizedEvent } from "../core/types.js";
import {
  repairToolCall,
  repairToolName,
  type ToolCallRepairResult,
} from "../providers/tool-call-repair.js";
import {
  exciseSpans,
  extractToolCallsFromText,
  looksLikeTextToolCall,
  type ExtractedToolCall,
} from "../providers/text-tool-call-parser.js";

// ---------------------------------------------------------------------------
// Level
// ---------------------------------------------------------------------------

/**
 * How hard to try.
 *
 *   - `off`        — no repair. Prior behaviour.
 *   - `standard`   — (default) name resolution, argument coercion, envelope
 *                    unwrapping, recovery of dropped streaming calls, and
 *                    extraction of *delimited* text-format tool calls.
 *   - `aggressive` — additionally extracts undelimited JSON tool calls from
 *                    prose. Can misfire on a model that discusses a tool call
 *                    in its final answer; opt in when a model needs it.
 */
export type ToolCallRepairLevel = "off" | "standard" | "aggressive";

export const DEFAULT_REPAIR_LEVEL: ToolCallRepairLevel = "standard";

/**
 * Resolve the level from `OPENSWARM_TOOL_CALL_REPAIR`. Unset or unrecognised
 * values fall back to the default, so a typo degrades to the safe standard
 * behaviour rather than silently disabling recovery.
 */
export function resolveRepairLevel(
  env: NodeJS.ProcessEnv = process.env,
): ToolCallRepairLevel {
  const raw = env["OPENSWARM_TOOL_CALL_REPAIR"]?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) return DEFAULT_REPAIR_LEVEL;
  if (raw === "off" || raw === "0" || raw === "false" || raw === "none") return "off";
  if (raw === "aggressive" || raw === "2" || raw === "all") return "aggressive";
  return "standard";
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Where in the pipeline a repair happened — surfaced on `tool_call_repaired`. */
export type RepairStage =
  | "delivered" // case 1 — arrived as a tool-call, name/args fixed
  | "recovered_stream" // case 2 — rebuilt from buffered tool-input deltas
  | "recovered_text"; // case 3 — extracted from assistant text

export interface RepairedToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly repairs: readonly string[];
  readonly stage: RepairStage;
  readonly originalName?: string;
  /** Native text syntax the call was written in (stage `recovered_text`). */
  readonly format?: string;
}

export interface TextRecovery {
  readonly calls: readonly RepairedToolCall[];
  /** Assistant text with the extracted call syntax removed, for replay. */
  readonly cleanedText: string;
}

interface PendingInput {
  readonly name: string;
  readonly parts: string[];
  delivered: boolean;
}

// ---------------------------------------------------------------------------
// ToolCallRecovery
// ---------------------------------------------------------------------------

export interface ToolCallRecoveryOptions {
  readonly level: ToolCallRepairLevel;
  /** Registered tool names — the resolution target for every repair. */
  readonly availableTools: readonly string[];
}

/**
 * Per-turn recovery state machine. One instance per `run()`; `reset()` between
 * retry attempts so a failed attempt's buffers cannot leak into the retry
 * (mirrors how HardenedNativeEngine resets `toolUseBuffer` / `inFlight`).
 */
export class ToolCallRecovery {
  private readonly level: ToolCallRepairLevel;
  private readonly availableTools: readonly string[];
  private readonly pending = new Map<string, PendingInput>();
  private recoveredCount = 0;

  constructor(options: ToolCallRecoveryOptions) {
    this.level = options.level;
    this.availableTools = options.availableTools;
  }

  /** False when repair is disabled or there are no tools to resolve against. */
  get enabled(): boolean {
    return this.level !== "off" && this.availableTools.length > 0;
  }

  /** Total repairs performed this run — surfaced for eval telemetry. */
  get repairCount(): number {
    return this.recoveredCount;
  }

  /** Clear per-attempt buffers (retry boundary). */
  reset(): void {
    this.pending.clear();
  }

  /** Record `tool-input-start`. */
  noteInputStart(id: string, name: string): void {
    if (!this.enabled) return;
    this.pending.set(id, { name, parts: [], delivered: false });
  }

  /** Record a `tool-input-delta` fragment. */
  noteInputDelta(id: string, delta: string): void {
    if (!this.enabled) return;
    const entry = this.pending.get(id);
    if (entry === undefined) {
      this.pending.set(id, { name: "", parts: [delta], delivered: false });
      return;
    }
    entry.parts.push(delta);
  }

  /**
   * Record that the transport successfully delivered a `tool-call` for `id`.
   * Its buffered fragments are no longer a recovery candidate.
   */
  noteDelivered(id: string): void {
    if (!this.enabled) return;
    const entry = this.pending.get(id);
    if (entry !== undefined) entry.delivered = true;
  }

  /**
   * Case 1. Repair a delivered tool call. Returns `undefined` when the call is
   * already well-formed (the overwhelmingly common path — no allocation) or
   * when the name cannot be resolved at all, in which case the dispatcher's
   * existing `invalid_tool_name` feedback is the better answer.
   */
  repairDelivered(
    id: string,
    name: string,
    input: unknown,
  ): RepairedToolCall | undefined {
    if (!this.enabled) return undefined;

    const repaired: ToolCallRepairResult | undefined = repairToolCall({
      name,
      input,
      availableTools: this.availableTools,
    });
    if (repaired === undefined || repaired.repairs.length === 0) return undefined;

    this.recoveredCount++;
    return {
      id,
      name: repaired.name,
      input: repaired.input,
      repairs: repaired.repairs,
      stage: "delivered",
      ...(repaired.originalName !== undefined
        ? { originalName: repaired.originalName }
        : {}),
    };
  }

  /**
   * Case 2. Rebuild calls whose argument stream was buffered but never
   * delivered as a `tool-call`. Consumes the buffers, so it is safe to call
   * once at the end of a stream.
   */
  recoverDroppedCalls(): readonly RepairedToolCall[] {
    if (!this.enabled) return [];

    const recovered: RepairedToolCall[] = [];
    for (const [id, entry] of this.pending) {
      if (entry.delivered) continue;
      if (entry.name.length === 0) continue; // no name — nothing to resolve
      const raw = entry.parts.join("");
      const repaired = repairToolCall({
        name: entry.name,
        rawArguments: raw,
        availableTools: this.availableTools,
      });
      if (repaired === undefined) continue;
      this.recoveredCount++;
      recovered.push({
        id,
        name: repaired.name,
        input: repaired.input,
        repairs: [
          "rebuilt tool call the provider dropped mid-stream",
          ...repaired.repairs,
        ],
        stage: "recovered_stream",
        ...(repaired.originalName !== undefined
          ? { originalName: repaired.originalName }
          : {}),
      });
    }
    this.pending.clear();
    return recovered;
  }

  /**
   * Case 3. Extract tool calls the model wrote as plain text. Only called when
   * a turn produced zero structured tool calls.
   *
   * A candidate is kept only when its name resolves to a *registered* tool —
   * that check is what keeps prose describing a tool call from being executed
   * as one.
   */
  recoverFromText(text: string, idPrefix: string): TextRecovery {
    if (!this.enabled || text.length === 0) {
      return { calls: [], cleanedText: text };
    }
    const allowBareJson = this.level === "aggressive";
    if (!allowBareJson && !looksLikeTextToolCall(text)) {
      return { calls: [], cleanedText: text };
    }

    const extracted = extractToolCallsFromText(text, { allowBareJson });
    if (extracted.length === 0) return { calls: [], cleanedText: text };

    const calls: RepairedToolCall[] = [];
    const consumed: ExtractedToolCall[] = [];

    for (const candidate of extracted) {
      // Resolve against the real tool surface before trusting the extraction.
      if (repairToolName(candidate.name, this.availableTools) === undefined) continue;
      const repaired = repairToolCall({
        name: candidate.name,
        rawArguments: candidate.rawArguments,
        availableTools: this.availableTools,
      });
      if (repaired === undefined) continue;

      this.recoveredCount++;
      consumed.push(candidate);
      calls.push({
        id: `${idPrefix}_${calls.length}`,
        name: repaired.name,
        input: repaired.input,
        repairs: [
          `extracted ${candidate.format}-format tool call from assistant text — ` +
            `the server is not converting this model's tool calls (check ` +
            `--enable-auto-tool-choice / --tool-call-parser)`,
          ...repaired.repairs,
        ],
        stage: "recovered_text",
        format: candidate.format,
        ...(repaired.originalName !== undefined
          ? { originalName: repaired.originalName }
          : {}),
      });
    }

    return { calls, cleanedText: exciseSpans(text, consumed) };
  }

  /**
   * Diagnostic for a turn that ended with no tool calls and none recovered,
   * yet whose text still carries tool-call syntax. Returns a message to
   * surface, or `undefined` when the turn looks like a genuine final answer.
   */
  diagnoseSilentStop(text: string): string | undefined {
    if (text.length === 0) return undefined;
    if (!looksLikeTextToolCall(text)) return undefined;
    return (
      "assistant text contains tool-call syntax but no tool call could be " +
      "recovered — the serving layer is likely missing a tool-call parser " +
      "(vLLM: --enable-auto-tool-choice --tool-call-parser <model-family>), " +
      "or the tool name is not registered"
    );
  }
}

/**
 * Build a recovery instance for a run. Centralises the env fallback so every
 * engine construction site gets the same default without extra wiring.
 */
export function createToolCallRecovery(
  availableTools: readonly string[],
  level?: ToolCallRepairLevel,
): ToolCallRecovery {
  return new ToolCallRecovery({
    level: level ?? resolveRepairLevel(),
    availableTools,
  });
}

// ---------------------------------------------------------------------------
// Tool-choice escalation (docs/63 F5)
// ---------------------------------------------------------------------------

/** Set to "0" to disable, or to an integer budget. Default: 1 per run. */
export const ESCALATION_ENV = "OPENSWARM_TOOL_CHOICE_ESCALATION";
export const DEFAULT_ESCALATION_BUDGET = 1;

/**
 * Resolve the per-run escalation budget. `0` disables; a malformed value falls
 * back to the default rather than silently disabling.
 */
export function resolveEscalationBudget(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[ESCALATION_ENV]?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_ESCALATION_BUDGET;
  if (raw === "off" || raw === "false") return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) || n < 0 ? DEFAULT_ESCALATION_BUDGET : n;
}

/**
 * One-shot `toolChoice: "required"` escalation for a turn that ended with no
 * tool call while its text plainly contained one.
 *
 * That state means the model *wanted* to call a tool and the serving layer did
 * not turn it into one — so the useful next move is to re-run the same turn
 * with tool use forced, which routes the call through the provider's own
 * tool-call path instead of its content stream.
 *
 * Three guards keep this from becoming a loop or a nuisance:
 *   - it never fires when the caller set `toolChoice` explicitly (their choice
 *     wins);
 *   - the override is consumed exactly once per arming, so the escalated turn
 *     cannot re-escalate itself;
 *   - a per-run budget (default 1) bounds the total, so a model that ignores
 *     `required` costs one extra round trip, not an unbounded retry storm.
 */
export class ToolChoiceEscalation {
  private armed = false;
  private used = 0;

  constructor(
    private readonly budget: number = DEFAULT_ESCALATION_BUDGET,
    /** True when the caller pinned toolChoice — escalation must not override it. */
    private readonly callerPinned: boolean = false,
  ) {}

  get enabled(): boolean {
    return this.budget > 0 && !this.callerPinned;
  }

  /** How many escalations this run has spent — surfaced for telemetry. */
  get escalationCount(): number {
    return this.used;
  }

  /**
   * Arm an escalation for the next request. Returns false when disabled, when
   * one is already armed, or when the budget is spent.
   */
  arm(): boolean {
    if (!this.enabled || this.armed || this.used >= this.budget) return false;
    this.armed = true;
    this.used++;
    return true;
  }

  /**
   * Take the pending override, disarming it. Called once while building a
   * provider request, so the forced turn cannot force itself again.
   */
  consume(): "required" | undefined {
    if (!this.armed) return undefined;
    this.armed = false;
    return "required";
  }
}

// ---------------------------------------------------------------------------
// Engine glue
// ---------------------------------------------------------------------------

/** Render a repair as the observational `tool_call_repaired` event. */
export function toolCallRepairedEvent(call: RepairedToolCall): NormalizedEvent {
  return {
    type: "tool_call_repaired",
    id: call.id,
    stage: call.stage,
    toolName: call.name,
    repairs: call.repairs,
    ...(call.originalName !== undefined ? { originalName: call.originalName } : {}),
    ...(call.format !== undefined ? { format: call.format } : {}),
  };
}

/**
 * Assistant content block, structurally identical to the engines' private
 * `AssistantBlock`. Declared here so the post-stream recovery pass can be
 * shared by NativeEngine and HardenedNativeEngine instead of duplicated.
 */
export type RecoveryAssistantBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | { readonly type: "reasoning"; readonly signature: string };

/** Mirrors the engines' private `PendingToolUse`. */
export interface RecoveryPendingToolUse {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ApplyRecoveryParams {
  readonly recovery: ToolCallRecovery;
  /** The turn's accumulated assistant blocks. Mutated in place. */
  readonly assistantContent: RecoveryAssistantBlock[];
  /** The turn's pending tool uses. Mutated in place. */
  readonly toolUseBuffer: RecoveryPendingToolUse[];
  /** Stable prefix for synthesised tool-use ids (unique per turn). */
  readonly turnId: string;
  /**
   * Called for each recovered call so the engine can start eager dispatch for
   * it. Omitted on the batch path, where dispatch happens after this pass.
   */
  readonly onRecovered?: (call: RepairedToolCall) => void;
  /**
   * When supplied, a turn that ended with unrecoverable tool-call syntax arms a
   * one-shot `toolChoice: "required"` retry instead of just diagnosing
   * (docs/63 F5).
   */
  readonly escalation?: ToolChoiceEscalation;
}

export interface ApplyRecoveryOutcome {
  /** How many calls were admitted into the turn. */
  readonly recovered: number;
  /**
   * True when the turn should be re-run with tool use forced. The caller must
   * NOT commit the assistant message or dispatch — it re-requests instead.
   */
  readonly escalated: boolean;
}

/**
 * Post-stream recovery pass, shared by both native engines.
 *
 * Runs after the provider stream completes and before the assistant message is
 * committed, so recovered calls land in `assistantContent` as real `tool_use`
 * blocks. That pairing matters beyond tidiness: `providerMessagesToVercel`
 * throws when a `tool_result` has no matching `tool_use` in history, so a
 * recovered call MUST be represented on the assistant message it belongs to.
 *
 * Yields the observational events; mutates the two buffers in place.
 */
export function* applyRecovery(
  params: ApplyRecoveryParams,
): Generator<NormalizedEvent, ApplyRecoveryOutcome> {
  const { recovery, assistantContent, toolUseBuffer, turnId } = params;
  if (!recovery.enabled) return { recovered: 0, escalated: false };
  let recovered = 0;

  /**
   * Admit a recovered call into the turn.
   *
   * `announce` controls whether the tool-use block is opened here. A
   * stream-recovered call was already announced during streaming
   * (`tool-input-start` → `tool_use_start`, plus its raw deltas), so
   * re-announcing it would reset consumers' input accumulators and lose the
   * fragments; it only needs closing. A text-recovered call is new to every
   * consumer, so it gets the full start → input → end sequence with the
   * repaired arguments.
   */
  const admit = function* (
    call: RepairedToolCall,
    announce: boolean,
  ): Generator<NormalizedEvent> {
    if (announce) {
      yield { type: "tool_use_start", id: call.id, name: call.name };
      let serialized: string;
      try {
        serialized = JSON.stringify(call.input) ?? "{}";
      } catch {
        serialized = "{}";
      }
      yield { type: "tool_use_input", id: call.id, jsonDelta: serialized };
    }
    yield { type: "tool_use_end", id: call.id };
    yield toolCallRepairedEvent(call);
    assistantContent.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.input,
    });
    toolUseBuffer.push({ id: call.id, name: call.name, input: call.input });
    params.onRecovered?.(call);
  };

  // Case 2 — calls the provider started streaming but never delivered.
  for (const call of recovery.recoverDroppedCalls()) {
    yield* admit(call, false);
    recovered++;
  }

  if (toolUseBuffer.length > 0) return { recovered, escalated: false };

  // Case 3 — calls the model wrote as text. Only when the turn would
  // otherwise be terminal, so a turn that made real calls is never re-read.
  const text = assistantContent
    .filter((b): b is Extract<RecoveryAssistantBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");

  const { calls, cleanedText } = recovery.recoverFromText(text, `${turnId}_repair`);

  if (calls.length > 0) {
    // Replay the prose but not the malformed syntax — echoing both back would
    // teach the model that its broken format worked.
    const preserved = assistantContent.filter((b) => b.type !== "text");
    assistantContent.length = 0;
    assistantContent.push(...preserved);
    if (cleanedText.length > 0) {
      assistantContent.push({ type: "text", text: cleanedText });
    }
    for (const call of calls) {
      yield* admit(call, true);
      recovered++;
    }
    return { recovered, escalated: false };
  }

  // Nothing recovered, but the text still smells like a tool call. The model
  // wanted a tool; the serving layer did not produce one.
  const diagnosis = recovery.diagnoseSilentStop(text);
  if (diagnosis === undefined) return { recovered, escalated: false };

  // Prefer re-running the turn with tool use forced (docs/63 F5) — that routes
  // the call through the provider's own tool-call path instead of its content
  // stream. Budgeted and one-shot, so a model that ignores `required` costs a
  // single extra round trip.
  if (params.escalation?.arm() === true) {
    yield {
      type: "info",
      source: "tool-call-repair",
      method: "tool_choice_escalation",
      payload: {
        message:
          "assistant text contained tool-call syntax but no tool call was " +
          "produced; retrying this turn with toolChoice=required",
      },
    };
    return { recovered, escalated: true };
  }

  // Escalation unavailable or spent — surface the diagnosis rather than
  // letting the run end looking like a deliberate final answer.
  yield {
    type: "info",
    source: "tool-call-repair",
    method: "unrecovered_text_tool_call",
    payload: { message: diagnosis },
  };
  return { recovered, escalated: false };
}
