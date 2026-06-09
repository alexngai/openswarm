/**
 * NativeEngine — composes Provider + Compactor + ToolDispatcher + our
 * own turn loop into an AgentEngine.
 *
 * Contrast with ClaudeAgentSdkEngine which delegates the loop to the SDK.
 * NativeEngine declares `capabilities.mcp: false, compaction: false` — it
 * owns compaction internally, and MCP (when wired in Phase 6+) is composed
 * externally.
 *
 * See docs/13-m4a-plan.md §5 for the full specification.
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
  compactSessionRemote,
  isRemoteCompactionConfig,
} from "./compact-remote.js";
import {
  makeSnapshot,
  extractNativeSnapshot,
} from "./native-snapshot.js";
import type { ToolRequest } from "../tools/dispatcher.js";

// ---------------------------------------------------------------------------
// Internal buffers
// ---------------------------------------------------------------------------

/**
 * Per-turn tool-use buffer entry. Keeps the tool_use id alongside the
 * request — ToolRequest itself carries no id (see docs/13-m4a-plan.md §5.2
 * / src/tools/dispatcher.ts), so we correlate positionally through a
 * parallel `allowedIds` array and then merge results back in original
 * order via this map.
 */
interface PendingToolUse {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

// Assistant content block shape (matches ProviderMessage assistant content).
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
// NativeEngine
// ---------------------------------------------------------------------------

export interface NativeEngineOptions {
  readonly provider: Provider;
  readonly compactionConfig?: CompactionConfig;
  /**
   * When set, the engine writes `<sessionDir>/native-snapshot.json`
   * atomically after each turn boundary. The directory is created
   * on demand.
   */
  readonly sessionDir?: string;
  /**
   * Stable per-session identifier. Forwarded to the provider via
   * `ProviderRequest.sessionId`; OpenAI uses it as a prompt-cache
   * eviction hint so cache entries stay warm across turns. Opaque,
   * stable for the lifetime of the session.
   */
  readonly sessionId?: string;
}

export class NativeEngine implements AgentEngine {
  readonly id = "native" as const;
  readonly capabilities: EngineCapabilities;

  private readonly provider: Provider;
  private readonly compactionConfig: CompactionConfig;
  private readonly sessionDir?: string;
  private readonly sessionId?: string;
  private cumulativeUsage: Usage = { inputTokens: 0, outputTokens: 0 };

  constructor(opts: NativeEngineOptions) {
    this.provider = opts.provider;
    this.compactionConfig = opts.compactionConfig ?? DEFAULT_COMPACTION;
    if (opts.sessionDir !== undefined) this.sessionDir = opts.sessionDir;
    if (opts.sessionId !== undefined) this.sessionId = opts.sessionId;

    const pcap = opts.provider.capabilities;
    this.capabilities = {
      streaming: pcap.streaming,
      promptCache: pcap.promptCache,
      parallelToolUse: pcap.parallelToolUse,
      mcp: false, // composed externally
      compaction: false, // engine owns compaction; outer code does not drive
      resume: true,
      maxContextTokens: pcap.maxContextTokens,
      maxOutputTokens: pcap.maxOutputTokens,
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
      if (config.resumeFrom.engineId !== "native") {
        yield {
          type: "error",
          error: {
            code: "invalid_request",
            message:
              "native engine cannot resume snapshots produced by another engine",
            retryable: false,
          },
        };
        return;
      }
      const snap = extractNativeSnapshot(config.resumeFrom);
      messages = snap.messages.slice();
      turnCount = snap.turnCount;
      compactionCount = snap.compactionCount;
      this.cumulativeUsage = snap.cumulativeUsage;
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

    // -----------------------------------------------------------------
    // 3. Turn loop
    // -----------------------------------------------------------------

    for (let turn = 0; turn < maxTurns; turn++) {
      // Honour abort between turns.
      if (config.abort !== undefined && config.abort.aborted) return;

      // 3a. Compaction check + execution.
      if (shouldCompact({ messages }, this.compactionConfig)) {
        yield {
          type: "compaction",
          payload: { phase: "begin", trigger: "auto" },
        };
        const result = isRemoteCompactionConfig(this.compactionConfig)
            ? await compactSessionRemote(
                { messages },
                this.compactionConfig,
                config.abort,
              )
            : compactSession({ messages }, this.compactionConfig);
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

        // Post-compaction health probe — mirror ClaudeAgentSdkEngine.
        // Skip silently when no dispatcher is wired.
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
            // Continue the loop — probe failure is observational.
          }
        }
      }

      // 3b. Stream one provider turn.
      const toolUseBuffer: PendingToolUse[] = [];
      const assistantContent: AssistantBlock[] = [];
      let turnUsage: Usage = { inputTokens: 0, outputTokens: 0 };
      let stopReason: StopReason = "end_turn";
      let streamErrored = false;

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

      try {
        for await (const ev of this.provider.stream(request)) {
          // Abort observability — if the stream keeps yielding past abort,
          // stop consuming and exit.
          if (config.abort !== undefined && config.abort.aborted) return;

          switch (ev.type) {
            case "text-delta":
              yield { type: "text_delta", text: ev.text };
              assistantContent.push({ type: "text", text: ev.text });
              break;

            case "reasoning-delta":
              // Dropped in M4a — NormalizedEvent has no reasoning variant.
              // TODO(M4b): extend NormalizedEvent with reasoning_delta.
              break;

            case "reasoning":
              // Persist reasoning state for replay-based continuity + snapshots.
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

            case "error":
              yield {
                type: "error",
                error: {
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
                },
              };
              streamErrored = true;
              break;
          }

          if (streamErrored) break;
        }
      } catch (err) {
        yield {
          type: "error",
          error: {
            code: "transport",
            message: err instanceof Error ? err.message : String(err),
            retryable: false,
          },
        };
        return;
      }

      if (streamErrored) return;

      // 3c. Post-turn bookkeeping.
      this.cumulativeUsage = {
        inputTokens:
          this.cumulativeUsage.inputTokens + turnUsage.inputTokens,
        outputTokens:
          this.cumulativeUsage.outputTokens + turnUsage.outputTokens,
      };

      // Merge consecutive text blocks for a tidy assistant message.
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

      // 3d. Tool dispatch (canUseTool gate + dispatchBatch).
      if (toolUseBuffer.length > 0) {
        const allowedRequests: ToolRequest[] = [];
        // Parallel array — same length as allowedRequests, keeps the
        // tool_use id so we can correlate positional dispatchBatch
        // results back to the original request.
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

        // Build id → result map (positional: allowedIds[i] ↔ results[i]).
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

        // Turn complete (with tool calls) — persist snapshot, then next turn.
        turnCount++;
        await this.persistSnapshot(messages, turnCount, compactionCount);
        continue;
      }

      // 3e. Terminal turn — no tool calls.
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

  /**
   * Write `<sessionDir>/native-snapshot.json` atomically (temp + rename).
   * Creates the directory on demand. No-op when sessionDir is unset.
   */
  private async persistSnapshot(
    messages: readonly ProviderMessage[],
    turnCount: number,
    compactionCount: number,
  ): Promise<void> {
    if (this.sessionDir === undefined) return;
    const snap = makeSnapshot(
      messages,
      turnCount,
      compactionCount,
      this.cumulativeUsage,
    );
    const snapPath = path.join(this.sessionDir, "native-snapshot.json");
    const tmp = snapPath + ".tmp";
    try {
      await fs.writeFile(tmp, JSON.stringify(snap));
    } catch (err) {
      // ENOENT on the directory — create it and retry once.
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
