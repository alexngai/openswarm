/**
 * CodexFrameworkEngine — AgentEngine that delegates to CodexAppServerProvider.
 *
 * Wraps a long-lived CodexAppServerProvider (spawned lazily on first run())
 * and a single thread (started lazily on first run(), reused across calls).
 */

import type {
  AgentEngine,
  EngineCapabilities,
  RunConfig,
} from "./index.js";
import type { NormalizedEvent, Usage } from "../core/types.js";
import type {
  SandboxMode,
  AskForApproval,
  DynamicToolCallHandler,
} from "../providers/codex-app-server.js";
import { CodexAppServerProvider } from "../providers/codex-app-server.js";
import type {
  Tool,
  DynamicToolCallContext,
  DynamicToolCallResponse,
} from "../providers/codex-app-server-types.js";
import type { ToolImpl, ToolExecutionContext } from "../tools/types.js";
import type { SwarmHost } from "../swarm/host.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CodexFrameworkEngineOptions {
  /** Path to the codex binary. Defaults to "codex" (PATH lookup). */
  readonly codexBinary?: string;
  /** Working directory forwarded to the App Server subprocess. */
  readonly cwd?: string;
  /** Sandbox policy. Defaults to "danger-full-access". */
  readonly sandbox?: SandboxMode;
  /** Approval policy. Defaults to "never". */
  readonly approvalPolicy?: AskForApproval;
  /**
   * Tier 2 tool implementations to register with the codex agent as host
   * dynamicTools. Each tool's spec is converted to a Codex `Tool` descriptor
   * sent at thread/start; calls dispatch back through the openswarm
   * tool implementation. (Stage 4H — V0.4.Q11)
   */
  readonly tools?: readonly ToolImpl[];
  /**
   * SwarmHost that backs Tier 2 tool calls. Required when `tools` includes
   * any Tier 2 tools (which is the V0.4.Q11 case — all 8 codex peer tools
   * are Tier 2). Forwarded into each tool's ToolExecutionContext.
   */
  readonly host?: SwarmHost;
  /**
   * Injectable provider factory for testing. When omitted the real
   * CodexAppServerProvider is constructed from the other options.
   *
   * Receives the resolved `dynamicTools` + `onDynamicToolCall` so factories
   * can wire the same dynamic-tools pipeline as the production path.
   */
  readonly providerFactory?: (args: {
    dynamicTools: readonly Tool[];
    onDynamicToolCall: DynamicToolCallHandler | undefined;
  }) => CodexAppServerProvider;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Default model used when --framework codex-chatgpt is selected without a
 * Codex-compatible --model. The ChatGPT-account model allowlist is enforced
 * server-side and drifts: as of the 2026-06 live spike (docs/42), the backend
 * rejects `gpt-5.4` and ALL `-codex` variants on a ChatGPT plan with HTTP 400
 * ("not supported when using Codex with a ChatGPT account"); `gpt-5.5` is the
 * working default. The set is plan-dependent, so this is a best-effort default —
 * an explicit unsupported --model still surfaces the backend's 400.
 */
const CODEX_CHATGPT_DEFAULT_MODEL = "gpt-5.5";

/**
 * Returns true only for model ids that Codex App Server accepts (GPT / o-series).
 */
function isCodexCompatibleModel(model: string | undefined): model is string {
  if (!model) return false;
  return /^(gpt|o[1-9]|codex)/i.test(model);
}

/**
 * Resolve the model to send to Codex. If the caller passed a Codex-compatible
 * model, use it. Otherwise (including the CLI default `claude-sonnet-4-6`,
 * which Codex would reject), substitute the spike-verified default `gpt-5.5`
 * so users running `openswarm --framework codex-chatgpt "say hi"` without
 * `--model` get a working session instead of a silent provider_unavailable.
 */
function resolveCodexModel(model: string | undefined): string {
  return isCodexCompatibleModel(model) ? model : CODEX_CHATGPT_DEFAULT_MODEL;
}

/**
 * Convert a openswarm ToolImpl to the Codex `Tool` descriptor passed in
 * `thread/start.dynamicTools`. The ToolSpec.inputSchema is already a JSON
 * Schema (built via `zodToJsonSchema` in each tier-2 tool definition).
 */
function toolImplToCodexTool(impl: ToolImpl): Tool {
  return {
    name: impl.spec.name,
    description: impl.spec.description,
    inputSchema: impl.spec.inputSchema,
  };
}

/**
 * Build the onDynamicToolCall handler that routes codex agent tool calls
 * back to the openswarm tool implementations.
 *
 * Unknown-tool requests, validation errors, and execution exceptions are
 * all wrapped into a `{success: false}` response — the handler never throws.
 * The returned tool's text output is sent verbatim as `inputText` content.
 */
function buildDynamicToolCallHandler(
  tools: readonly ToolImpl[],
  cwd: string,
  host: SwarmHost | undefined,
): DynamicToolCallHandler {
  const byName = new Map<string, ToolImpl>(tools.map((t) => [t.spec.name, t]));
  return async (
    toolName: string,
    args: unknown,
    _context: DynamicToolCallContext,
  ): Promise<DynamicToolCallResponse> => {
    const impl = byName.get(toolName);
    if (impl === undefined) {
      return {
        contentItems: [
          { type: "inputText", text: `unknown tool: ${toolName}` },
        ],
        success: false,
      };
    }
    const ctx: ToolExecutionContext = {
      cwd,
      ...(host !== undefined && { host }),
    };
    try {
      const result = await impl.execute(args, ctx);
      if (result.status === "ok") {
        return {
          contentItems: [{ type: "inputText", text: result.output }],
          success: true,
        };
      }
      return {
        contentItems: [{ type: "inputText", text: result.message }],
        success: false,
      };
    } catch (err) {
      return {
        contentItems: [
          {
            type: "inputText",
            text: err instanceof Error ? err.message : String(err),
          },
        ],
        success: false,
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class CodexFrameworkEngine implements AgentEngine {
  readonly id = "codex-framework" as const;

  readonly capabilities: EngineCapabilities = {
    streaming: true,
    promptCache: true,
    parallelToolUse: false,
    mcp: false,
    compaction: true,
    resume: false,
    maxContextTokens: 258_400,
    maxOutputTokens: 16_384,
  };

  private readonly provider: CodexAppServerProvider;
  private started = false;
  private threadId: string | undefined;
  private cumulativeUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  /** Set to true when any error event is yielded. Subsequent run() calls fail fast (Defect 4). */
  private dead = false;

  constructor(opts: CodexFrameworkEngineOptions = {}) {
    const tools = opts.tools ?? [];
    const dynamicTools = tools.map(toolImplToCodexTool);
    const onDynamicToolCall =
      tools.length > 0
        ? buildDynamicToolCallHandler(tools, opts.cwd ?? process.cwd(), opts.host)
        : undefined;

    if (opts.providerFactory !== undefined) {
      this.provider = opts.providerFactory({ dynamicTools, onDynamicToolCall });
    } else {
      this.provider = new CodexAppServerProvider({
        codexBinary: opts.codexBinary,
        cwd: opts.cwd,
        sandbox: opts.sandbox,
        approvalPolicy: opts.approvalPolicy,
        ...(dynamicTools.length > 0 && { dynamicTools }),
        ...(onDynamicToolCall !== undefined && { onDynamicToolCall }),
      });
    }
  }

  getCumulativeUsage(): Usage {
    return this.cumulativeUsage;
  }

  async *run(config: RunConfig): AsyncIterable<NormalizedEvent> {
    // Fail fast if a previous turn errored — the engine is in a failed state
    // and the Codex thread may be unusable (Defect 4).
    if (this.dead) {
      yield {
        type: "error",
        error: {
          code: "invalid_request",
          message:
            "engine is in a failed state — dispose and create a new CodexFrameworkEngine to continue",
          retryable: false,
        },
      };
      return;
    }

    if (config.resumeFrom !== undefined) {
      yield {
        type: "error",
        error: {
          code: "invalid_request",
          message: "resume is not supported in codex-framework mode",
          retryable: false,
        },
      };
      return;
    }

    // Lazy start: initialize provider + thread on first run() call.
    if (!this.started) {
      try {
        await this.provider.start();
        const { threadId } = await this.provider.startThread({
          model: resolveCodexModel(config.model),
        });
        this.threadId = threadId;
        this.started = true;
      } catch (err) {
        this.dead = true;
        yield {
          type: "error",
          error: {
            code: "transport",
            message: `CodexFrameworkEngine: failed to start — ${err instanceof Error ? err.message : String(err)}`,
            retryable: false,
          },
        };
        return;
      }
    }

    const threadId = this.threadId!;

    try {
      for await (const event of this.provider.runTurn(threadId, config.prompt, {
        signal: config.abort,
        // Per-turn model override only when caller passed something compatible;
        // the thread's startup model (resolved via resolveCodexModel) is the
        // sticky default otherwise.
        ...(isCodexCompatibleModel(config.model) ? { model: config.model } : {}),
      })) {
        if (event.type === "error") {
          this.dead = true;
        }
        yield event;
      }
    } catch (err) {
      this.dead = true;
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

    // Sync cumulative usage from provider after each turn.
    const providerUsage = this.provider.getCumulativeUsage();
    this.cumulativeUsage = {
      inputTokens: providerUsage.inputTokens,
      outputTokens: providerUsage.outputTokens,
    };
  }

  /**
   * Clean up: archive the thread and dispose the provider subprocess.
   */
  async dispose(): Promise<void> {
    if (this.started && this.threadId !== undefined) {
      await this.provider.archiveThread(this.threadId);
    }
    await this.provider.dispose();
  }
}
