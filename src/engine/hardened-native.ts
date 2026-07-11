/**
 * HardenedNativeEngine — production-hardened variant of NativeEngine.
 *
 * Ports Codex-grade resilience into openswarm's composable architecture:
 *   - Retry with exponential backoff (Codex: responses_retry.rs:22-79)
 *   - Eager tool dispatch during streaming (Codex: turn.rs:1830-2214)
 *   - Mid-turn compaction (Codex: turn.rs:268-321)
 *
 * NativeEngine stays as the reference/test baseline (simple, predictable) and
 * remains available via the explicit `--framework native` escape hatch.
 * HardenedNativeEngine is the default for `--framework auto` + any non-Claude
 * model on both the single-agent CLI and swarm workers (Phase 2.1), and the
 * only engine behind `--framework hardened-native` and `codex-native`.
 *
 * See docs/37-hardened-engine-design.md and docs/archive/38-hardened-engine-implementation-plan.md.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  Provider,
  ProviderMessage,
  ProviderRequest,
} from "../providers/index.js";
import type {
  NormalizedEvent,
  ProviderError,
  StopReason,
  Usage,
} from "../core/types.js";
import type {
  AgentEngine,
  EngineCapabilities,
  RunConfig,
  PermissionDecision,
} from "./index.js";
import {
  shouldCompact,
  compactSession,
  DEFAULT_COMPACTION,
  type CompactionConfig,
} from "./compactor.js";
import {
  compactSessionReactive,
  isRemoteCompactionConfig,
} from "./compact-remote.js";
import type { RecontextualizeFn } from "./compact-rebuild.js";
import {
  initialCompactionState,
  restoreCompactionState,
  persistCompactionState,
  preTurnCompaction,
  requestManualCompaction,
  recordTurnUsage,
  type CompactionState,
} from "./compaction-runner.js";
import {
  makeHardenedSnapshot,
  extractHardenedNativeSnapshot,
} from "./hardened-native-snapshot.js";
import { type RetryPolicy, DEFAULT_RETRY_POLICY } from "./retry-policy.js";
import {
  isRetryableError,
  classifyProviderError,
} from "../providers/error-classifier.js";
import { ToolScheduler } from "../tools/scheduler.js";
import {
  ToolAccesses,
  type ToolAccesses as ToolAccessesType,
} from "../tools/access.js";
import type { ToolRequest } from "../tools/dispatcher.js";
import type { ToolResult } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Internal buffers
// ---------------------------------------------------------------------------

interface PendingToolUse {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

type AssistantBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | { readonly type: "reasoning"; readonly signature: string };

// ---------------------------------------------------------------------------
// Abort-aware sleep — maps to Codex responses_retry.rs:58-72
// ---------------------------------------------------------------------------

function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// HardenedNativeEngine
// ---------------------------------------------------------------------------

export interface HardenedNativeEngineOptions {
  readonly provider: Provider;
  readonly compactionConfig?: CompactionConfig;
  readonly sessionDir?: string;
  readonly sessionId?: string;
  readonly retryPolicy?: RetryPolicy;
  readonly eagerToolDispatch?: boolean;
  readonly midTurnCompaction?: boolean;
  /**
   * F1 hook: returns project-instruction attachments (CLAUDE.md/AGENTS.md) to
   * re-inject after a full remote compaction (pre-turn, mid-turn, and
   * reactive overflow paths).
   */
  readonly recontextualize?: RecontextualizeFn;
}

export class HardenedNativeEngine implements AgentEngine {
  readonly id = "hardened-native" as const;
  readonly capabilities: EngineCapabilities;

  private readonly provider: Provider;
  private readonly compactionConfig: CompactionConfig;
  private readonly sessionDir?: string;
  private readonly sessionId?: string;
  private readonly retryPolicy: RetryPolicy;
  private readonly eagerToolDispatch: boolean;
  private readonly midTurnCompaction: boolean;
  private readonly recontextualize?: RecontextualizeFn;
  private cumulativeUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  private retryStats = { totalRetries: 0, retriesThisTurn: 0 };
  private compactionState: CompactionState = initialCompactionState();

  constructor(opts: HardenedNativeEngineOptions) {
    this.provider = opts.provider;
    this.compactionConfig = opts.compactionConfig ?? DEFAULT_COMPACTION;
    if (opts.sessionDir !== undefined) this.sessionDir = opts.sessionDir;
    if (opts.sessionId !== undefined) this.sessionId = opts.sessionId;
    this.retryPolicy = opts.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.eagerToolDispatch = opts.eagerToolDispatch ?? false;
    this.midTurnCompaction = opts.midTurnCompaction ?? false;
    if (opts.recontextualize !== undefined)
      this.recontextualize = opts.recontextualize;

    const pcap = opts.provider.capabilities;
    this.capabilities = {
      streaming: pcap.streaming,
      promptCache: pcap.promptCache,
      parallelToolUse: pcap.parallelToolUse,
      mcp: false,
      compaction: false,
      resume: true,
      maxContextTokens: pcap.maxContextTokens,
      maxOutputTokens: pcap.maxOutputTokens,
      retry: true,
      eagerToolDispatch: this.eagerToolDispatch,
    };
  }

  getCumulativeUsage(): Usage {
    return this.cumulativeUsage;
  }

  /**
   * Queue a manual compaction (slash /compact). Runs at the next turn
   * boundary with trigger "manual"; optional text becomes CC "Additional
   * Instructions" for the summarizer.
   */
  requestManualCompaction(customInstructions?: string): void {
    requestManualCompaction(this.compactionState, customInstructions);
  }

  /**
   * Set the session transcript path (events.jsonl) — the continuation
   * message's "read the full transcript at: …" pointer. Callable after
   * construction because recording starts per-turn (worker-entry).
   */
  setTranscriptPath(transcriptPath: string): void {
    this.compactionConfig.transcriptPath = transcriptPath;
  }

  /**
   * context_overflow recovery — the reactive compaction path
   * (docs/48-compaction-design.md §L4). With a remote (model-based) config,
   * runs CC's group compaction: keep the newest user-turn groups verbatim
   * within the MiMoCode tail budget, summarize the rest with the
   * RECENT-portion prompt. Falls back to mechanical emergency compaction.
   * Returns null when there is nothing to compact (caller yields the error).
   */
  private async recoverFromOverflow(
    messages: ProviderMessage[],
    abort?: AbortSignal,
  ): Promise<{ messages: ProviderMessage[]; removed: number; walkedBack: boolean } | null> {
    // Emergency config ignores the token threshold — the server has already
    // told us the context is too large.
    const emergencyConfig = { ...this.compactionConfig, maxEstimatedTokens: 0 };
    if (!shouldCompact({ messages }, emergencyConfig)) return null;

    if (isRemoteCompactionConfig(this.compactionConfig)) {
      const result = await compactSessionReactive(
        { messages },
        this.compactionConfig,
        abort,
        {
          contextWindow: this.capabilities.maxContextTokens,
          ...(this.recontextualize !== undefined
            ? { recontextualize: this.recontextualize }
            : {}),
        },
      );
      if (result.removedMessageCount > 0) {
        this.compactionState.lastContextTokens = 0;
        this.compactionState.lastUsageMessageCount = 0;
        return {
          messages: result.compactedSession.messages.slice(),
          removed: result.removedMessageCount,
          walkedBack: result.boundaryWalkedBack,
        };
      }
    }

    const result = compactSession({ messages }, emergencyConfig);
    this.compactionState.lastContextTokens = 0;
    this.compactionState.lastUsageMessageCount = 0;
    return {
      messages: result.compactedSession.messages.slice(),
      removed: result.removedMessageCount,
      walkedBack: result.boundaryWalkedBack,
    };
  }

  async *run(config: RunConfig): AsyncIterable<NormalizedEvent> {
    // -----------------------------------------------------------------
    // 1. Resume handling
    // -----------------------------------------------------------------

    let messages: ProviderMessage[];
    let turnCount = 0;
    let compactionCount = 0;

    if (config.resumeFrom !== undefined) {
      if (config.resumeFrom.engineId !== "hardened-native") {
        yield {
          type: "error",
          error: {
            code: "invalid_request",
            message:
              "hardened-native engine cannot resume snapshots produced by another engine",
            retryable: false,
          },
        };
        return;
      }
      const snap = extractHardenedNativeSnapshot(config.resumeFrom);
      messages = snap.messages.slice();
      turnCount = snap.turnCount;
      compactionCount = snap.compactionCount;
      this.cumulativeUsage = snap.cumulativeUsage;
      this.compactionState = restoreCompactionState(snap.compaction);
      this.retryStats = {
        totalRetries: snap.retryStats.totalRetries,
        retriesThisTurn: 0,
      };
    } else {
      messages = [];
    }

    // -----------------------------------------------------------------
    // 2. Seed the user prompt
    // -----------------------------------------------------------------

    messages.push({
      role: "user",
      content: [{ type: "text", text: config.prompt }],
    });

    // No default cap: an omitted maxTurns means unbounded (Codex-style),
    // bounded instead by the model's stop reason, abort, or a budget.
    const maxTurns = config.maxTurns ?? Number.POSITIVE_INFINITY;
    const startTime = Date.now();
    let terminated = false;

    // Merge retry policy from RunConfig if provided.
    const retryPolicy = config.retryPolicy ?? this.retryPolicy;

    // -----------------------------------------------------------------
    // 3. Turn loop — maps to Codex run_turn (turn.rs:136-422)
    // -----------------------------------------------------------------

    for (let turn = 0; turn < maxTurns; turn++) {
      if (config.abort !== undefined && config.abort.aborted) return;

      // Wall-clock budget — soft stop at the turn boundary.
      if (
        config.maxWallClockMs !== undefined &&
        Date.now() - startTime >= config.maxWallClockMs
      ) {
        yield {
          type: "message_stop",
          stopReason: "max_wall_clock",
          usage: this.cumulativeUsage,
        };
        await this.persistSnapshot(messages, turnCount, compactionCount);
        terminated = true;
        break;
      }

      this.retryStats.retriesThisTurn = 0;

      // 3a. Pre-turn compaction pipeline (L1 trigger → L2 micro → L3–L5 full).
      {
        const outcome = yield* preTurnCompaction(
          this.compactionState,
          messages,
          turn,
          {
            compactionConfig: this.compactionConfig,
            contextWindow: this.capabilities.maxContextTokens,
            ...(this.sessionDir !== undefined
              ? { sessionDir: this.sessionDir }
              : {}),
            ...(config.abort !== undefined ? { abort: config.abort } : {}),
            ...(this.recontextualize !== undefined
              ? { recontextualize: this.recontextualize }
              : {}),
          },
        );
        messages = outcome.messages;
        if (outcome.compacted) {
          compactionCount++;

          if (config.dispatcher !== undefined) {
            try {
              await config.dispatcher.dispatch(
                "glob",
                { pattern: "*" },
                { cwd: process.cwd() },
              );
            } catch {
              yield {
                type: "error",
                error: {
                  code: "transport",
                  message: "post-compaction probe failed",
                  retryable: false,
                },
              };
            }
          }
        }
      }

      // 3b. Stream provider turn with retry — maps to Codex
      //     run_sampling_request (turn.rs:999-1087)
      const toolUseBuffer: PendingToolUse[] = [];
      const assistantContent: AssistantBlock[] = [];
      let turnUsage: Usage = { inputTokens: 0, outputTokens: 0 };
      let stopReason: StopReason = "end_turn";
      let streamErrored = false;
      let fatalError = false;

      // Eager dispatch state — maps to Codex FuturesOrdered pattern
      // (turn.rs:1830-2214). Map preserves insertion order (ES2015).
      const eagerDispatch =
        (config.eagerToolDispatch ?? this.eagerToolDispatch) &&
        config.dispatcher !== undefined;
      let inFlight = new Map<string, Promise<ToolResult>>();
      // ToolScheduler for eager path — serializes conflicting tools
      // (maps to Codex handle_tool_call_with_source, parallel.rs:81-178).
      // Recreated per retry attempt so stale active-task state doesn't
      // block new tool calls.
      let eagerScheduler = eagerDispatch
        ? new ToolScheduler<ToolResult>()
        : undefined;

      const buildRequest = (): ProviderRequest => ({
        messages,
        tools: config.tools.map((t) => t.spec),
        systemPrompt: config.systemPrompt,
        model: config.model,
        ...(config.abort !== undefined ? { abort: config.abort } : {}),
        ...(config.maxOutputTokens !== undefined
          ? { maxOutputTokens: config.maxOutputTokens }
          : {}),
        ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
      });

      // Retry loop — maps to Codex streamWithRetry
      for (
        let attempt = 0;
        attempt <= retryPolicy.maxRetries;
        attempt++
      ) {
        streamErrored = false;
        let deferredStreamError: ProviderError | undefined;
        toolUseBuffer.length = 0;
        assistantContent.length = 0;
        turnUsage = { inputTokens: 0, outputTokens: 0 };
        stopReason = "end_turn";
        // Reset eager dispatch state so stale promises from a failed
        // attempt are not drained after a successful retry.
        inFlight = new Map<string, Promise<ToolResult>>();
        if (eagerDispatch) {
          eagerScheduler = new ToolScheduler<ToolResult>();
        }

        try {
          for await (const ev of this.provider.stream(buildRequest())) {
            if (config.abort !== undefined && config.abort.aborted) return;

            switch (ev.type) {
              case "text-delta":
                yield { type: "text_delta", text: ev.text };
                assistantContent.push({ type: "text", text: ev.text });
                break;

              case "reasoning-delta":
                break;

              case "reasoning":
                // Persist reasoning state on the assistant message so it is
                // replayed next turn (reasoning continuity) and snapshotted.
                assistantContent.push({ type: "reasoning", signature: ev.signature });
                break;

              case "tool-input-start":
                yield { type: "tool_use_start", id: ev.id, name: ev.name };
                break;

              case "tool-input-delta":
                yield {
                  type: "tool_use_input",
                  id: ev.id,
                  jsonDelta: ev.delta,
                };
                break;

              case "tool-call": {
                yield { type: "tool_use_end", id: ev.id };
                assistantContent.push({
                  type: "tool_use",
                  id: ev.id,
                  name: ev.name,
                  input: ev.input,
                });
                toolUseBuffer.push({
                  id: ev.id,
                  name: ev.name,
                  input: ev.input,
                });

                // Eager dispatch — start tool execution during streaming.
                // Maps to Codex handle_tool_call_with_source (parallel.rs:81-178).
                if (eagerDispatch) {
                  const decision = await config.canUseTool(
                    ev.name,
                    ev.input,
                  );
                  if (decision.allow) {
                    const dispatchInput =
                      decision.updatedInput !== undefined
                        ? decision.updatedInput
                        : ev.input;
                    const ctx = {
                      cwd: process.cwd(),
                      abort: config.abort,
                      ...(config.host !== undefined
                        ? { host: config.host }
                        : {}),
                    };

                    // Compute accesses for ToolScheduler conflict detection.
                    let accesses: ToolAccessesType = ToolAccesses.none();
                    const toolImpl =
                      typeof config.dispatcher!.get === "function"
                        ? config.dispatcher!.get(ev.name)
                        : undefined;
                    if (toolImpl !== undefined) {
                      if (toolImpl.accesses !== undefined) {
                        try {
                          accesses = toolImpl.accesses(dispatchInput, ctx);
                        } catch {
                          accesses = ToolAccesses.all();
                        }
                      } else if (toolImpl.spec.concurrencySafe === false) {
                        accesses = ToolAccesses.all();
                      }
                    }

                    inFlight.set(
                      ev.id,
                      eagerScheduler!.add({
                        accesses,
                        start: async () => ({
                          result: config.dispatcher!.dispatch(
                            ev.name,
                            dispatchInput,
                            ctx,
                          ),
                        }),
                      }),
                    );
                  } else {
                    inFlight.set(
                      ev.id,
                      Promise.resolve({
                        status: "error" as const,
                        message: decision.reason,
                      }),
                    );
                  }
                }
                break;
              }

              case "finish":
                stopReason = ev.stopReason;
                turnUsage = ev.usage;
                // L1 trigger signal: real context occupancy for the next
                // pre-turn compaction check.
                recordTurnUsage(
                  this.compactionState,
                  ev.usage,
                  messages.length,
                );
                break;

              case "error": {
                const providerError = {
                  code: (ev.code as
                    | "auth"
                    | "rate_limit"
                    | "context_overflow"
                    | "invalid_request"
                    | "provider_unavailable"
                    | "transport"
                    | "structured_output_parse_failed"
                    | "prompt_cache_unavailable"
                    | "unknown") ?? "unknown",
                  message: ev.message,
                  retryable: ev.retryable,
                };
                // Defer context_overflow errors — recovery via compaction
                // is attempted after the stream ends.
                if (providerError.code !== "context_overflow") {
                  yield { type: "error", error: providerError };
                }
                deferredStreamError = providerError;
                streamErrored = true;
                break;
              }
            }

            if (streamErrored) break;
          }

          // Stream completed without throw — break retry loop.
          if (!streamErrored) break;

          // In-stream context_overflow recovery — same path as thrown
          // context_overflow (compact + retry without backoff).
          // Emergency config ignores token threshold — the server has
          // already told us the context is too large.
          if (
            deferredStreamError !== undefined &&
            deferredStreamError.code === "context_overflow"
          ) {
            const recovered = await this.recoverFromOverflow(
              messages,
              config.abort,
            );
            if (recovered !== null) {
              yield {
                type: "compaction",
                payload: {
                  phase: "begin",
                  trigger: "auto" as const,
                  compact_metadata: { contextOverflowRecovery: true },
                },
              };
              messages = recovered.messages;
              yield {
                type: "compaction",
                payload: {
                  phase: "end",
                  trigger: "auto" as const,
                  compact_metadata: {
                    contextOverflowRecovery: true,
                    removedMessageCount: recovered.removed,
                    boundaryWalkedBack: recovered.walkedBack,
                  },
                },
              };
              compactionCount++;
              this.retryStats.totalRetries++;
              this.retryStats.retriesThisTurn++;
              yield {
                type: "retry",
                attempt: attempt + 1,
                maxRetries: retryPolicy.maxRetries,
                error: deferredStreamError,
                delayMs: 0,
              };
              continue;
            }
            // Can't compact — yield deferred error.
            yield { type: "error", error: deferredStreamError };
          }

          fatalError = true;
          break;
        } catch (err) {
          const providerError = classifyProviderError(err, { fallbackCode: "transport" });
          const classifier = retryPolicy.isRetryable ?? isRetryableError;

          // Context overflow recovery — maps to Codex's emergency
          // compaction path (turn.rs:862-917). Compact and retry once
          // without backoff instead of failing immediately.
          // Emergency config ignores token threshold — the server has
          // already told us the context is too large.
          if (providerError.code === "context_overflow") {
            const recovered = await this.recoverFromOverflow(
              messages,
              config.abort,
            );
            if (recovered !== null) {
              yield {
                type: "compaction",
                payload: {
                  phase: "begin",
                  trigger: "auto" as const,
                  compact_metadata: { contextOverflowRecovery: true },
                },
              };
              messages = recovered.messages;
              yield {
                type: "compaction",
                payload: {
                  phase: "end",
                  trigger: "auto" as const,
                  compact_metadata: {
                    contextOverflowRecovery: true,
                    removedMessageCount: recovered.removed,
                    boundaryWalkedBack: recovered.walkedBack,
                  },
                },
              };
              compactionCount++;
              this.retryStats.totalRetries++;
              this.retryStats.retriesThisTurn++;
              yield {
                type: "retry",
                attempt: attempt + 1,
                maxRetries: retryPolicy.maxRetries,
                error: providerError,
                delayMs: 0,
              };
              continue;
            }
            // Can't compact — fall through to fatal error.
          }

          if (!classifier(providerError) || attempt >= retryPolicy.maxRetries) {
            yield {
              type: "error",
              error: {
                code: providerError.code,
                message: providerError.message,
                retryable: false,
              },
            };
            fatalError = true;
            break;
          }

          // Retryable error — backoff and retry.
          const delayMs =
            retryPolicy.backoffBaseMs * Math.pow(2, attempt);
          this.retryStats.totalRetries++;
          this.retryStats.retriesThisTurn++;

          yield {
            type: "retry",
            attempt: attempt + 1,
            maxRetries: retryPolicy.maxRetries,
            error: providerError,
            delayMs,
          };

          const sleptFull = await abortableSleep(delayMs, config.abort);
          if (!sleptFull) return;
        }
      }

      if (fatalError) return;
      if (streamErrored) return;

      // 3c. Post-turn bookkeeping. Accumulate the cache fields too — dropping them
      // here made the headless `message_stop` usage (the only ledger eval harnesses
      // see) structurally report 0 cache reads, so the TE-16 prompt-cache fix was
      // unverifiable from eval telemetry (docs/53 TE-17).
      this.cumulativeUsage = {
        inputTokens:
          this.cumulativeUsage.inputTokens + turnUsage.inputTokens,
        outputTokens:
          this.cumulativeUsage.outputTokens + turnUsage.outputTokens,
        cacheReadInputTokens:
          (this.cumulativeUsage.cacheReadInputTokens ?? 0) +
          (turnUsage.cacheReadInputTokens ?? 0),
        cacheWriteInputTokens:
          (this.cumulativeUsage.cacheWriteInputTokens ?? 0) +
          (turnUsage.cacheWriteInputTokens ?? 0),
      };

      const mergedContent: AssistantBlock[] = [];
      for (const block of assistantContent) {
        const tail = mergedContent[mergedContent.length - 1];
        if (
          block.type === "text" &&
          tail !== undefined &&
          tail.type === "text"
        ) {
          mergedContent[mergedContent.length - 1] = {
            type: "text",
            text: tail.text + block.text,
          };
        } else {
          mergedContent.push(block);
        }
      }

      messages.push({ role: "assistant", content: mergedContent });

      // 3d. Tool dispatch — eager or batch path.
      if (toolUseBuffer.length > 0) {
        // Resolve all tool results into an ordered array for unified
        // event emission below.
        const resolvedResults: Array<{
          id: string;
          content: string;
          isError: boolean;
        }> = [];

        if (
          eagerDispatch &&
          config.dispatcher !== undefined &&
          inFlight.size > 0
        ) {
          // ── Eager path: drain in-flight promises ──
          // Maps to Codex drain_in_flight (turn.rs:1739-1763).
          // inFlight is insertion-ordered (ES2015 Map guarantee) so results
          // are emitted in the order the model produced tool_use blocks,
          // regardless of completion order.
          for (const [id, promise] of inFlight) {
            let r: ToolResult;
            try {
              r = await promise;
            } catch {
              r = { status: "error", message: "tool execution aborted" };
            }
            const content =
              r.status === "ok" ? r.output : r.message;
            resolvedResults.push({
              id,
              content,
              isError: r.status !== "ok",
            });
          }
        } else {
          // ── Batch path: gate + dispatch after stream ──
          const allowedRequests: ToolRequest[] = [];
          const allowedIds: string[] = [];
          const decisions = new Map<string, PermissionDecision>();

          for (const req of toolUseBuffer) {
            const decision = await config.canUseTool(req.name, req.input);
            decisions.set(req.id, decision);
            if (decision.allow) {
              allowedRequests.push({
                name: req.name,
                input:
                  decision.updatedInput !== undefined
                    ? decision.updatedInput
                    : req.input,
                ctx: {
                  cwd: process.cwd(),
                  ...(config.host !== undefined ? { host: config.host } : {}),
                },
              });
              allowedIds.push(req.id);
            }
          }

          const batchResults =
            allowedRequests.length > 0 && config.dispatcher !== undefined
              ? await config.dispatcher.dispatchBatch(allowedRequests)
              : [];

          const resultById = new Map<string, (typeof batchResults)[number]>();
          for (let i = 0; i < allowedIds.length; i++) {
            const id = allowedIds[i]!;
            const res = batchResults[i];
            if (res !== undefined) resultById.set(id, res);
          }

          for (const req of toolUseBuffer) {
            const decision = decisions.get(req.id)!;
            if (!decision.allow) {
              resolvedResults.push({
                id: req.id,
                content: decision.reason,
                isError: true,
              });
              continue;
            }
            const r = resultById.get(req.id);
            const content =
              r !== undefined
                ? r.status === "ok"
                  ? r.output
                  : r.message
                : "tool failed";
            resolvedResults.push({
              id: req.id,
              content,
              isError: r === undefined || r.status !== "ok",
            });
          }
        }

        // Emit tool_result events + append to messages (unified for both paths).
        for (const { id, content, isError } of resolvedResults) {
          yield {
            type: "tool_result",
            toolUseId: id,
            content,
            isError,
          };
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: id,
                content,
                is_error: isError,
              },
            ],
          });
        }

        // 3e. Mid-turn compaction — maps to Codex turn.rs:268-321. Runs the
        // same pipeline as the pre-turn site (trigger + micro + full).
        if (this.midTurnCompaction) {
          const outcome = yield* preTurnCompaction(
            this.compactionState,
            messages,
            turn,
            {
              compactionConfig: this.compactionConfig,
              contextWindow: this.capabilities.maxContextTokens,
              extraMetadata: { midTurn: true },
              ...(this.sessionDir !== undefined
                ? { sessionDir: this.sessionDir }
                : {}),
              ...(config.abort !== undefined ? { abort: config.abort } : {}),
              ...(this.recontextualize !== undefined
                ? { recontextualize: this.recontextualize }
                : {}),
            },
          );
          messages = outcome.messages;
          if (outcome.compacted) compactionCount++;
        }

        turnCount++;
        await this.persistSnapshot(messages, turnCount, compactionCount);
        continue;
      }

      // 3f. Terminal turn — no tool calls. Report the run's cumulative usage
      // (not just this turn's), since tool-calling turns never emit a
      // message_stop — so this single terminal event is the only usage signal
      // headless/eval consumers get. cumulativeUsage already includes this turn
      // (updated in step 3c above).
      yield { type: "message_stop", stopReason, usage: this.cumulativeUsage };
      turnCount++;
      await this.persistSnapshot(messages, turnCount, compactionCount);
      terminated = true;
      break;
    }

    // 4. Explicit maxTurns budget exhausted without a natural stop — soft stop
    // (not an error), mirroring the native engine. Only reachable when maxTurns
    // is finite (explicitly set).
    if (!terminated) {
      yield {
        type: "message_stop",
        stopReason: "max_turns",
        usage: this.cumulativeUsage,
      };
      await this.persistSnapshot(messages, turnCount, compactionCount);
    }
  }

  private async persistSnapshot(
    messages: readonly ProviderMessage[],
    turnCount: number,
    compactionCount: number,
  ): Promise<void> {
    if (this.sessionDir === undefined) return;
    const snap = makeHardenedSnapshot(
      messages,
      turnCount,
      compactionCount,
      this.cumulativeUsage,
      this.retryStats,
      persistCompactionState(this.compactionState),
    );
    const snapPath = path.join(
      this.sessionDir,
      "hardened-native-snapshot.json",
    );
    const tmp = snapPath + ".tmp";
    try {
      await fs.writeFile(tmp, JSON.stringify(snap));
    } catch (err) {
      if (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code?: string }).code === "ENOENT"
      ) {
        await fs.mkdir(this.sessionDir, { recursive: true });
        await fs.writeFile(tmp, JSON.stringify(snap));
      } else {
        throw err;
      }
    }
    await fs.rename(tmp, snapPath);
  }
}
