/**
 * HardenedNativeEngine — production-hardened variant of NativeEngine.
 *
 * Ports Codex-grade resilience into swarm-harness's composable architecture:
 *   - Retry with exponential backoff (Codex: responses_retry.rs:22-79)
 *   - Eager tool dispatch during streaming (Codex: turn.rs:1830-2214)
 *   - Mid-turn compaction (Codex: turn.rs:268-321)
 *
 * NativeEngine stays as the reference/test baseline (simple, predictable).
 * HardenedNativeEngine replaces it for production use.
 *
 * See docs/37-hardened-engine-design.md and docs/38-hardened-engine-implementation-plan.md.
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
  makeHardenedSnapshot,
  extractHardenedNativeSnapshot,
} from "./hardened-native-snapshot.js";
import {
  type RetryPolicy,
  DEFAULT_RETRY_POLICY,
  isRetryableError,
  classifyProviderError,
} from "./retry-policy.js";
import type { ToolRequest } from "../tools/dispatcher.js";

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
    };

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
  private cumulativeUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  private retryStats = { totalRetries: 0, retriesThisTurn: 0 };

  constructor(opts: HardenedNativeEngineOptions) {
    this.provider = opts.provider;
    this.compactionConfig = opts.compactionConfig ?? DEFAULT_COMPACTION;
    if (opts.sessionDir !== undefined) this.sessionDir = opts.sessionDir;
    if (opts.sessionId !== undefined) this.sessionId = opts.sessionId;
    this.retryPolicy = opts.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.eagerToolDispatch = opts.eagerToolDispatch ?? false;
    this.midTurnCompaction = opts.midTurnCompaction ?? false;

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

    const maxTurns = config.maxTurns ?? 100;
    let terminated = false;

    // Merge retry policy from RunConfig if provided.
    const retryPolicy = config.retryPolicy ?? this.retryPolicy;

    // -----------------------------------------------------------------
    // 3. Turn loop — maps to Codex run_turn (turn.rs:136-422)
    // -----------------------------------------------------------------

    for (let turn = 0; turn < maxTurns; turn++) {
      if (config.abort !== undefined && config.abort.aborted) return;

      this.retryStats.retriesThisTurn = 0;

      // 3a. Pre-turn compaction check.
      if (shouldCompact({ messages }, this.compactionConfig)) {
        yield {
          type: "compaction",
          payload: { phase: "begin", trigger: "auto" },
        };
        const result = compactSession({ messages }, this.compactionConfig);
        messages = result.compactedSession.messages.slice();
        yield {
          type: "compaction",
          payload: {
            phase: "end",
            trigger: "auto",
            compact_metadata: {
              removedMessageCount: result.removedMessageCount,
              boundaryWalkedBack: result.boundaryWalkedBack,
            },
          },
        };
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

      // 3b. Stream provider turn with retry — maps to Codex
      //     run_sampling_request (turn.rs:999-1087)
      const toolUseBuffer: PendingToolUse[] = [];
      const assistantContent: AssistantBlock[] = [];
      let turnUsage: Usage = { inputTokens: 0, outputTokens: 0 };
      let stopReason: StopReason = "end_turn";
      let streamErrored = false;
      let fatalError = false;

      const request: ProviderRequest = {
        messages,
        tools: config.tools.map((t) => t.spec),
        systemPrompt: config.systemPrompt,
        model: config.model,
        ...(config.abort !== undefined ? { abort: config.abort } : {}),
        ...(config.maxOutputTokens !== undefined
          ? { maxOutputTokens: config.maxOutputTokens }
          : {}),
        ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
      };

      // Retry loop — maps to Codex streamWithRetry
      for (
        let attempt = 0;
        attempt <= retryPolicy.maxRetries;
        attempt++
      ) {
        streamErrored = false;
        toolUseBuffer.length = 0;
        assistantContent.length = 0;
        turnUsage = { inputTokens: 0, outputTokens: 0 };
        stopReason = "end_turn";

        try {
          for await (const ev of this.provider.stream(request)) {
            if (config.abort !== undefined && config.abort.aborted) return;

            switch (ev.type) {
              case "text-delta":
                yield { type: "text_delta", text: ev.text };
                assistantContent.push({ type: "text", text: ev.text });
                break;

              case "reasoning-delta":
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

              case "tool-call":
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
                break;

              case "finish":
                stopReason = ev.stopReason;
                turnUsage = ev.usage;
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
                yield { type: "error", error: providerError };
                streamErrored = true;
                break;
              }
            }

            if (streamErrored) break;
          }

          // Stream completed without throw — break retry loop.
          if (!streamErrored) break;

          // In-stream error events are not retried (provider signaled the
          // error through the event protocol, not a thrown exception).
          fatalError = true;
          break;
        } catch (err) {
          const providerError = classifyProviderError(err);
          const classifier = retryPolicy.isRetryable ?? isRetryableError;

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

      // 3c. Post-turn bookkeeping.
      this.cumulativeUsage = {
        inputTokens:
          this.cumulativeUsage.inputTokens + turnUsage.inputTokens,
        outputTokens:
          this.cumulativeUsage.outputTokens + turnUsage.outputTokens,
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

      // 3d. Tool dispatch.
      if (toolUseBuffer.length > 0) {
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
              ctx: { cwd: process.cwd() },
            });
            allowedIds.push(req.id);
          }
        }

        const results =
          allowedRequests.length > 0 && config.dispatcher !== undefined
            ? await config.dispatcher.dispatchBatch(allowedRequests)
            : [];

        const resultById = new Map<string, (typeof results)[number]>();
        for (let i = 0; i < allowedIds.length; i++) {
          const id = allowedIds[i]!;
          const res = results[i];
          if (res !== undefined) resultById.set(id, res);
        }

        for (const req of toolUseBuffer) {
          const decision = decisions.get(req.id)!;
          if (!decision.allow) {
            yield {
              type: "tool_result",
              toolUseId: req.id,
              content: decision.reason,
              isError: true,
            };
            messages.push({
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: req.id,
                  content: decision.reason,
                  is_error: true,
                },
              ],
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
          const isError = r === undefined || r.status !== "ok";

          yield {
            type: "tool_result",
            toolUseId: req.id,
            content,
            isError,
          };
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: req.id,
                content,
                is_error: isError,
              },
            ],
          });
        }

        // 3e. Mid-turn compaction — maps to Codex turn.rs:268-321
        if (
          this.midTurnCompaction &&
          shouldCompact({ messages }, this.compactionConfig)
        ) {
          yield {
            type: "compaction",
            payload: { phase: "begin", trigger: "auto" as const,
              compact_metadata: { midTurn: true } },
          };
          const result = compactSession({ messages }, this.compactionConfig);
          messages = result.compactedSession.messages.slice();
          yield {
            type: "compaction",
            payload: {
              phase: "end",
              trigger: "auto" as const,
              compact_metadata: {
                midTurn: true,
                removedMessageCount: result.removedMessageCount,
                boundaryWalkedBack: result.boundaryWalkedBack,
              },
            },
          };
          compactionCount++;
        }

        turnCount++;
        await this.persistSnapshot(messages, turnCount, compactionCount);
        continue;
      }

      // 3f. Terminal turn — no tool calls.
      yield { type: "message_stop", stopReason, usage: turnUsage };
      turnCount++;
      await this.persistSnapshot(messages, turnCount, compactionCount);
      terminated = true;
      break;
    }

    // 4. maxTurns exceeded without message_stop.
    if (!terminated) {
      yield {
        type: "error",
        error: {
          code: "invalid_request",
          message: "maxTurns exceeded without end_turn",
          retryable: false,
        },
      };
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
