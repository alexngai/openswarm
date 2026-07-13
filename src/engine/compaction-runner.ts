/**
 * compaction-runner — engine-side compaction orchestration shared by
 * NativeEngine and HardenedNativeEngine (docs/48-compaction-design.md).
 *
 * Owns the L1 trigger (usage-token thresholds with estimator fallback), the
 * L2 microcompaction wiring, the L5 circuit breakers, and manual `/compact`
 * requests. The engines call `preTurnCompaction` at each turn boundary and
 * yield the events it produces.
 */

import type { ProviderMessage } from "../providers/index.js";
import type { NormalizedEvent, Usage } from "../core/types.js";
import {
  type CompactionConfig,
  type CompactionResult,
  contextUsageStatus,
  type ContextUsageLevel,
  shouldCompact,
  compactSession,
  estimateTokens,
  NOT_ENOUGH_MESSAGES_TO_COMPACT,
} from "./compactor.js";
import {
  compactSessionRemote,
  isRemoteCompactionConfig,
} from "./compact-remote.js";
import type { RecontextualizeFn } from "./compact-rebuild.js";
import { microcompactMessages } from "./microcompact.js";

// ---------------------------------------------------------------------------
// Circuit-breaker constants (CC l2n semantics)
// ---------------------------------------------------------------------------

/** A compaction landing within this many turns of the previous one is a rapid refill. */
export const RAPID_REFILL_TURN_WINDOW = 3;
/** Consecutive rapid refills that trip the auto-compaction breaker. */
export const RAPID_REFILL_BREAKER_LIMIT = 3;
/** Consecutive summarizer failures that force mechanical-only compaction. */
export const SUMMARIZER_FAILURE_BREAKER_LIMIT = 3;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface CompactionState {
  /**
   * Real context occupancy from the provider's most recent finish event
   * (input + cache read + cache write + output ≈ next request size).
   * 0 = unknown (pre-first-turn or just compacted) → estimator fallback.
   */
  lastContextTokens: number;
  /**
   * messages.length high-water mark covered by lastContextTokens. Messages
   * appended after this index (tool results, new prompts) are not in the
   * provider's usage yet, so the trigger adds their char/4 estimate on top —
   * this is what makes MID-turn overflow detectable (CC/MiMoCode both do it).
   */
  lastUsageMessageCount: number;
  /** Turn index of the last completed compaction (−1 = never). */
  lastCompactTurn: number;
  /** Consecutive rapid refills (compactions < RAPID_REFILL_TURN_WINDOW apart). */
  rapidRefillCount: number;
  /** Consecutive model-summarizer failures (mechanical fallback used). */
  consecutiveSummarizerFailures: number;
  /** Rapid-refill breaker: stop auto-compacting (except blocked emergencies). */
  breakerTripped: boolean;
  /** Failure breaker: skip the model summarizer, go straight to mechanical. */
  mechanicalOnly: boolean;
  /** Warn-level notice already surfaced since the last compaction. */
  warnedSinceCompact: boolean;
  /** Pending manual /compact request, consumed at the next turn boundary. */
  pendingManual?: { customInstructions?: string };
}

export function initialCompactionState(): CompactionState {
  return {
    lastContextTokens: 0,
    lastUsageMessageCount: 0,
    lastCompactTurn: -1,
    rapidRefillCount: 0,
    consecutiveSummarizerFailures: 0,
    breakerTripped: false,
    mechanicalOnly: false,
    warnedSinceCompact: false,
  };
}

/** The persistable subset of CompactionState (snapshots). */
export interface PersistedCompactionState {
  readonly lastContextTokens: number;
  readonly lastUsageMessageCount: number;
  readonly lastCompactTurn: number;
  readonly rapidRefillCount: number;
  readonly consecutiveSummarizerFailures: number;
  readonly breakerTripped: boolean;
  readonly mechanicalOnly: boolean;
}

export function persistCompactionState(
  state: CompactionState,
): PersistedCompactionState {
  return {
    lastContextTokens: state.lastContextTokens,
    lastUsageMessageCount: state.lastUsageMessageCount,
    lastCompactTurn: state.lastCompactTurn,
    rapidRefillCount: state.rapidRefillCount,
    consecutiveSummarizerFailures: state.consecutiveSummarizerFailures,
    breakerTripped: state.breakerTripped,
    mechanicalOnly: state.mechanicalOnly,
  };
}

export function restoreCompactionState(
  persisted: Partial<PersistedCompactionState> | undefined,
): CompactionState {
  const state = initialCompactionState();
  if (persisted === undefined) return state;
  state.lastContextTokens = persisted.lastContextTokens ?? 0;
  state.lastUsageMessageCount = persisted.lastUsageMessageCount ?? 0;
  state.lastCompactTurn = persisted.lastCompactTurn ?? -1;
  state.rapidRefillCount = persisted.rapidRefillCount ?? 0;
  state.consecutiveSummarizerFailures =
    persisted.consecutiveSummarizerFailures ?? 0;
  state.breakerTripped = persisted.breakerTripped ?? false;
  state.mechanicalOnly = persisted.mechanicalOnly ?? false;
  return state;
}

/** Context tokens from a finish-event usage (≈ next request size). */
export function usageContextTokens(usage: Usage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    (usage.cacheReadInputTokens ?? 0) +
    (usage.cacheWriteInputTokens ?? 0)
  );
}

/**
 * Record a finish-event usage. `messageCountAtFinish` is the engine's
 * messages.length when the finish event arrived — the assistant message the
 * usage's output tokens describe has not been appended yet, so the covered
 * high-water mark is that length + 1.
 */
export function recordTurnUsage(
  state: CompactionState,
  usage: Usage,
  messageCountAtFinish: number,
): void {
  state.lastContextTokens = usageContextTokens(usage);
  state.lastUsageMessageCount = messageCountAtFinish + 1;
}

/**
 * Effective context occupancy: the provider-reported tokens plus the char/4
 * estimate of messages appended since that report (tool results, prompts).
 * 0 when no usage has been reported yet (estimator-fallback regime).
 */
export function effectiveContextTokens(
  state: CompactionState,
  messages: readonly ProviderMessage[],
): number {
  if (state.lastContextTokens <= 0) return 0;
  let extra = 0;
  for (let i = state.lastUsageMessageCount; i < messages.length; i++) {
    extra += estimateTokens(messages[i]!);
  }
  return state.lastContextTokens + extra;
}

// ---------------------------------------------------------------------------
// Pre-turn compaction
// ---------------------------------------------------------------------------

export interface CompactionDeps {
  readonly compactionConfig: CompactionConfig;
  readonly contextWindow: number;
  /** Session dir for microcompaction persisted outputs. */
  readonly sessionDir?: string;
  readonly abort?: AbortSignal;
  /** Extra compact_metadata merged into full-compaction events (e.g. midTurn). */
  readonly extraMetadata?: Record<string, unknown>;
  /**
   * F1 hook: re-inject project instructions (CLAUDE.md/AGENTS.md) as
   * attachments after a full remote compaction. Forwarded to
   * compactSessionRemote; no effect on the mechanical path.
   */
  readonly recontextualize?: RecontextualizeFn;
}

function microcompactEnabled(): boolean {
  const flag = (process.env.OPENSWARM_MICROCOMPACT ?? "").toLowerCase();
  return !["0", "false", "off", "no"].includes(flag);
}

/**
 * Microcompaction policy from env, for tuning the tool-result eviction lever
 * without a rebuild. `OPENSWARM_MICROCOMPACT_KEEP_RECENT` overrides how many of
 * the most-recent tool results are preserved (lower = more aggressive eviction,
 * frees context but busts more of the prompt-cache prefix). `_MIN_SAVINGS`
 * overrides the token-savings gate (lower = eviction fires on smaller sessions).
 * Unset/invalid values fall back to the CC defaults inside microcompactMessages.
 */
export function microcompactPolicyFromEnv(): {
  keepRecent?: number;
  minSavingsTokens?: number;
} {
  const out: { keepRecent?: number; minSavingsTokens?: number } = {};
  // NB: Number("") === 0, so guard empty/whitespace explicitly — an unset or blank
  // knob must fall back to the CC default, not silently pin keepRecent to 0.
  const parse = (raw: string | undefined): number | undefined => {
    if (raw === undefined || raw.trim() === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const kr = parse(process.env.OPENSWARM_MICROCOMPACT_KEEP_RECENT);
  if (kr !== undefined) out.keepRecent = kr;
  const ms = parse(process.env.OPENSWARM_MICROCOMPACT_MIN_SAVINGS);
  if (ms !== undefined) out.minSavingsTokens = ms;
  return out;
}

export interface PreTurnCompactionOutcome {
  readonly messages: ProviderMessage[];
  /** True when a full compaction ran (not micro/warn) — snapshot counter. */
  readonly compacted: boolean;
}

/**
 * Run the pre-turn compaction pipeline: trigger classification →
 * microcompaction → full compaction (with breakers). Yields the engine
 * events to forward; returns the (possibly rewritten) message array plus
 * whether a full compaction ran.
 */
export async function* preTurnCompaction(
  state: CompactionState,
  messages: ProviderMessage[],
  turn: number,
  deps: CompactionDeps,
): AsyncGenerator<NormalizedEvent, PreTurnCompactionOutcome> {
  const manual = state.pendingManual;
  state.pendingManual = undefined;

  // ---- L1: classify --------------------------------------------------------
  let level: ContextUsageLevel;
  const contextTokens = effectiveContextTokens(state, messages);
  let threshold: number;
  let pctLeft = 100;
  if (contextTokens > 0) {
    const status = contextUsageStatus(contextTokens, deps.contextWindow);
    level = status.level;
    threshold = status.threshold;
    pctLeft = status.pctLeft;
  } else {
    // Estimator fallback — providers that have not reported usage yet.
    level = shouldCompact({ messages }, deps.compactionConfig)
      ? "compact"
      : "ok";
    threshold = deps.compactionConfig.maxEstimatedTokens;
  }

  if (manual === undefined && level === "ok") {
    return { messages, compacted: false };
  }

  // ---- Manual /compact ------------------------------------------------------
  if (manual !== undefined) {
    if (messages.length < 2) {
      yield {
        type: "error",
        error: {
          code: "invalid_request",
          message: NOT_ENOUGH_MESSAGES_TO_COMPACT,
          retryable: false,
        },
      };
      return { messages, compacted: false };
    }
    return yield* runFullCompaction(state, messages, turn, deps, {
      trigger: "manual",
      ...(manual.customInstructions !== undefined
        ? { customInstructions: manual.customInstructions }
        : {}),
    });
  }

  // ---- L2: microcompaction --------------------------------------------------
  if (microcompactEnabled()) {
    const micro = microcompactMessages(messages, {
      ...(deps.sessionDir !== undefined ? { stateDir: deps.sessionDir } : {}),
      ...microcompactPolicyFromEnv(),
    });
    if (micro !== null) {
      yield {
        type: "compaction",
        payload: {
          phase: "begin",
          trigger: "auto",
          compact_metadata: { micro: true },
        },
      };
      messages = micro.messages;
      yield {
        type: "compaction",
        payload: {
          phase: "end",
          trigger: "auto",
          compact_metadata: {
            micro: true,
            tokensSaved: micro.tokensSaved,
            toolsCleared: micro.toolsCleared,
            toolsKept: micro.toolsKept,
          },
        },
      };
      // Defer full compaction when microcompaction covered the overage
      // (CC: MC first, summarize only if still needed).
      if (
        (level === "compact" || level === "blocked") &&
        contextTokens > 0 &&
        micro.tokensSaved >= contextTokens - threshold + 1_000
      ) {
        state.lastContextTokens = Math.max(
          0,
          state.lastContextTokens - micro.tokensSaved,
        );
        return { messages, compacted: false };
      }
    }
  }

  // ---- Warn level: surface once, no full compaction -------------------------
  if (level === "warn") {
    if (!state.warnedSinceCompact) {
      state.warnedSinceCompact = true;
      yield {
        type: "compaction",
        payload: {
          phase: "warn",
          trigger: "auto",
          compact_metadata: { contextTokens, threshold, pctLeft },
        },
      };
    }
    return { messages, compacted: false };
  }

  // ---- L5: rapid-refill breaker ---------------------------------------------
  // Blocked-level compactions bypass the breaker — refusing would wedge the
  // session entirely.
  if (state.breakerTripped && level !== "blocked") {
    return { messages, compacted: false };
  }

  // ---- Full compaction -------------------------------------------------------
  return yield* runFullCompaction(state, messages, turn, deps, {
    trigger: "auto",
  });
}

/** Request a manual compaction at the next turn boundary (slash /compact). */
export function requestManualCompaction(
  state: CompactionState,
  customInstructions?: string,
): void {
  state.pendingManual = {
    ...(customInstructions !== undefined ? { customInstructions } : {}),
  };
}

// ---------------------------------------------------------------------------
// Full compaction + breaker bookkeeping
// ---------------------------------------------------------------------------

async function* runFullCompaction(
  state: CompactionState,
  messages: ProviderMessage[],
  turn: number,
  deps: CompactionDeps,
  opts: { trigger: "auto" | "manual"; customInstructions?: string },
): AsyncGenerator<NormalizedEvent, PreTurnCompactionOutcome> {
  yield {
    type: "compaction",
    payload: {
      phase: "begin",
      trigger: opts.trigger,
      ...(deps.extraMetadata !== undefined
        ? { compact_metadata: { ...deps.extraMetadata } }
        : {}),
    },
  };

  const useRemote =
    isRemoteCompactionConfig(deps.compactionConfig) && !state.mechanicalOnly;

  let result: CompactionResult;
  if (useRemote && isRemoteCompactionConfig(deps.compactionConfig)) {
    result = await compactSessionRemote(
      { messages },
      deps.compactionConfig,
      deps.abort,
      {
        force: true,
        trigger: opts.trigger,
        ...(opts.customInstructions !== undefined
          ? { customInstructions: opts.customInstructions }
          : {}),
        ...(deps.recontextualize !== undefined
          ? { recontextualize: deps.recontextualize }
          : {}),
      },
    );
  } else {
    // Mechanical path — force past the estimator (the usage trigger decided).
    result = compactSession(
      { messages },
      { ...deps.compactionConfig, maxEstimatedTokens: 0 },
    );
  }

  yield {
    type: "compaction",
    payload: {
      phase: "end",
      trigger: opts.trigger,
      compact_metadata: {
        ...(deps.extraMetadata ?? {}),
        removedMessageCount: result.removedMessageCount,
        boundaryWalkedBack: result.boundaryWalkedBack,
        ...(result.summarizerFailed === true ? { summarizerFailed: true } : {}),
      },
    },
  };

  // Breaker bookkeeping (auto only — manual compactions are user-driven).
  if (opts.trigger === "auto") {
    if (
      state.lastCompactTurn >= 0 &&
      turn - state.lastCompactTurn < RAPID_REFILL_TURN_WINDOW
    ) {
      state.rapidRefillCount++;
    } else {
      state.rapidRefillCount = 0;
    }
    if (
      state.rapidRefillCount >= RAPID_REFILL_BREAKER_LIMIT &&
      !state.breakerTripped
    ) {
      state.breakerTripped = true;
      yield {
        type: "error",
        error: {
          code: "invalid_request",
          message:
            "autocompact: circuit breaker tripped — context refills too quickly after compaction. Start a fresh session to continue.",
          retryable: false,
        },
      };
    }
  }

  if (result.summarizerFailed === true) {
    state.consecutiveSummarizerFailures++;
    if (
      state.consecutiveSummarizerFailures >= SUMMARIZER_FAILURE_BREAKER_LIMIT &&
      !state.mechanicalOnly
    ) {
      state.mechanicalOnly = true;
      yield {
        type: "compaction",
        payload: {
          phase: "warn",
          trigger: "auto",
          compact_metadata: {
            message: `autocompact: circuit breaker tripped after ${state.consecutiveSummarizerFailures} consecutive failures — using mechanical compaction for the rest of the session`,
          },
        },
      };
    }
  } else if (result.removedMessageCount > 0) {
    state.consecutiveSummarizerFailures = 0;
  }

  state.lastCompactTurn = turn;
  state.lastContextTokens = 0; // unknown until the next finish event
  state.lastUsageMessageCount = 0;
  state.warnedSinceCompact = false;

  return { messages: result.compactedSession.messages.slice(), compacted: true };
}
