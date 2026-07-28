/**
 * NativeEngine — composes Provider + Compactor + ToolDispatcher + our
 * own turn loop into an AgentEngine.
 *
 * Contrast with ClaudeAgentSdkEngine which delegates the loop to the SDK.
 * NativeEngine declares `capabilities.mcp: false, compaction: false` — it
 * owns compaction internally, and MCP (when wired in Phase 6+) is composed
 * externally.
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
  DEFAULT_COMPACTION,
  type CompactionConfig,
} from "./compactor.js";
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
  makeSnapshot,
  extractNativeSnapshot,
} from "./native-snapshot.js";
import type { RecontextualizeFn } from "./compact-rebuild.js";
import {
  applyRecovery,
  createToolCallRecovery,
  resolveEscalationBudget,
  toolCallRepairedEvent,
  ToolChoiceEscalation,
} from "./tool-call-recovery.js";
import type { ToolRequest } from "../tools/dispatcher.js";

// ---------------------------------------------------------------------------
// Internal buffers
// ---------------------------------------------------------------------------

/**
 * Per-turn tool-use buffer entry. Keeps the tool_use id alongside the
 * request — ToolRequest itself carries no id (see src/tools/dispatcher.ts),
 * so we correlate positionally through a
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
  /**
   * F1 hook: returns project-instruction attachments (CLAUDE.md/AGENTS.md) to
   * re-inject after a full remote compaction. See
   * makeProjectInstructionsRecontextualizer.
   */
  readonly recontextualize?: RecontextualizeFn;
}

export class NativeEngine implements AgentEngine {
  readonly id = "native" as const;
  readonly capabilities: EngineCapabilities;

  private readonly provider: Provider;
  private readonly compactionConfig: CompactionConfig;
  private readonly sessionDir?: string;
  private readonly sessionId?: string;
  private readonly recontextualize?: RecontextualizeFn;
  private cumulativeUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  private compactionState: CompactionState = initialCompactionState();

  constructor(opts: NativeEngineOptions) {
    this.provider = opts.provider;
    this.compactionConfig = opts.compactionConfig ?? DEFAULT_COMPACTION;
    if (opts.sessionDir !== undefined) this.sessionDir = opts.sessionDir;
    if (opts.sessionId !== undefined) this.sessionId = opts.sessionId;
    if (opts.recontextualize !== undefined)
      this.recontextualize = opts.recontextualize;

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
      this.compactionState = restoreCompactionState(snap.compaction);
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

    // Malformed-tool-call recovery (docs/63). Resolves against the tool surface
    // actually advertised this run, so a repair can only ever land on a
    // registered tool.
    const recovery = createToolCallRecovery(
      config.tools.map((t) => t.spec.name),
      config.toolCallRepair,
    );
    // One-shot toolChoice escalation (docs/63 F5). Disabled when the caller
    // pinned toolChoice — their choice wins over ours.
    const escalation = new ToolChoiceEscalation(
      recovery.enabled ? resolveEscalationBudget() : 0,
      config.toolChoice !== undefined,
    );

    // -----------------------------------------------------------------
    // 3. Turn loop
    // -----------------------------------------------------------------

    for (let turn = 0; turn < maxTurns; turn++) {
      // Honour abort between turns.
      if (config.abort !== undefined && config.abort.aborted) return;

      // Wall-clock budget — soft stop at the turn boundary (docs 48 budgets).
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

      // 3a. Compaction pipeline (L1 trigger → L2 micro → L3–L5 full).
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
      }

      // 3b. Stream one provider turn.
      const toolUseBuffer: PendingToolUse[] = [];
      const assistantContent: AssistantBlock[] = [];
      let turnUsage: Usage = { inputTokens: 0, outputTokens: 0 };
      let stopReason: StopReason = "end_turn";
      let streamErrored = false;
      const forcedToolChoice = escalation.consume();

      const request: ProviderRequest = {
        messages,
        tools: config.tools.map((t) => t.spec),
        systemPrompt: config.systemPrompt,
        model: config.model,
        ...(config.abort !== undefined ? { abort: config.abort } : {}),
        ...(config.maxOutputTokens !== undefined
          ? { maxOutputTokens: config.maxOutputTokens }
          : {}),
        // Sampling + tool-choice levers (docs/63 F2/F3). Omitted when unset so
        // the provider's own defaults still apply.
        ...(config.temperature !== undefined
          ? { temperature: config.temperature }
          : {}),
        ...(config.topP !== undefined ? { topP: config.topP } : {}),
        ...(config.topK !== undefined ? { topK: config.topK } : {}),
        // A pending escalation outranks the caller's default for this one turn;
        // consume() disarms it so the forced turn cannot force itself again.
        ...(forcedToolChoice !== undefined
          ? { toolChoice: forcedToolChoice }
          : config.toolChoice !== undefined
            ? { toolChoice: config.toolChoice }
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
              recovery.noteInputStart(ev.id, ev.name);
              break;

            case "tool-input-delta":
              yield {
                type: "tool_use_input",
                id: ev.id,
                jsonDelta: ev.delta,
              };
              recovery.noteInputDelta(ev.id, ev.delta);
              break;

            case "tool-call": {
              yield { type: "tool_use_end", id: ev.id };
              recovery.noteDelivered(ev.id);
              // Aliased name / enveloped or string-encoded arguments are fixed
              // here so the call reaches the dispatcher instead of burning a
              // turn on an invalid_tool_name round trip.
              const repaired = recovery.repairDelivered(ev.id, ev.name, ev.input);
              if (repaired !== undefined) yield toolCallRepairedEvent(repaired);
              const name = repaired?.name ?? ev.name;
              const input = repaired !== undefined ? repaired.input : ev.input;
              assistantContent.push({
                type: "tool_use",
                id: ev.id,
                name,
                input,
              });
              toolUseBuffer.push({ id: ev.id, name, input });
              break;
            }

            case "finish":
              stopReason = ev.stopReason;
              turnUsage = ev.usage;
              // L1 trigger signal: real context occupancy for the next
              // pre-turn compaction check.
              recordTurnUsage(this.compactionState, ev.usage, messages.length);
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

      // 3b-bis. Recover tool calls the transport dropped mid-stream, or that
      // the model wrote as text because the serving layer has no tool-call
      // parser configured (docs/63). Runs before the assistant message is
      // committed so recovered calls appear as real tool_use blocks on it.
      const recoveryOutcome = yield* applyRecovery({
        recovery,
        assistantContent,
        toolUseBuffer,
        turnId: `t${turn}`,
        escalation,
      });

      // 3c. Post-turn bookkeeping. Sum ALL four token categories — dropping the
      // cache fields here made the final `message_stop` usage (the only ledger
      // subprocess workers forward) structurally report 0 cache reads, hiding
      // real provider cache hits from eval telemetry (docs/53 TE-17; mirrors
      // the hardened engine's tally).
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

      // 3c-bis. Escalation armed (docs/63 F5): re-run this turn with tool use
      // forced. The assistant message is deliberately NOT committed — the
      // model is about to produce a replacement for it. Usage is already
      // tallied above, so the extra round trip stays visible in the ledger.
      if (recoveryOutcome.escalated) continue;

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
              ctx: {
                cwd: process.cwd(),
                ...(config.host !== undefined ? { host: config.host } : {}),
              },
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

      // 3e. Terminal turn — no tool calls. Emit the run's cumulative usage
      // (not just this turn's): tool-calling turns never emit a message_stop, so
      // this single terminal event is the only usage signal headless/eval
      // consumers receive. cumulativeUsage already includes this turn.
      yield { type: "message_stop", stopReason, usage: this.cumulativeUsage };
      turnCount++;
      await this.persistSnapshot(messages, turnCount, compactionCount);
      terminated = true;
      break;
    }

    // 4. Explicit maxTurns budget exhausted without a natural stop — soft stop
    // (not an error), so the work so far is preserved and callers can treat it
    // as a budget limit. Only reachable when maxTurns is finite (explicitly set).
    if (!terminated) {
      yield {
        type: "message_stop",
        stopReason: "max_turns",
        usage: this.cumulativeUsage,
      };
      await this.persistSnapshot(messages, turnCount, compactionCount);
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
      persistCompactionState(this.compactionState),
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
