/**
 * CodexFrameworkEngine — AgentEngine that delegates to CodexAppServerProvider.
 *
 * Wraps a long-lived CodexAppServerProvider (spawned lazily on first run())
 * and a single thread (started lazily on first run(), reused across calls).
 *
 * See docs/24-phase-6-codex-app-server-plan.md §Stage 3C.
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
} from "../providers/codex-app-server.js";
import { CodexAppServerProvider } from "../providers/codex-app-server.js";

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
   * Injectable provider factory for testing. When omitted the real
   * CodexAppServerProvider is constructed from the other options.
   */
  readonly providerFactory?: () => CodexAppServerProvider;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Default model used when --framework codex-chatgpt is selected without a
 * Codex-compatible --model. Per Stage 3.0 spike (test/fixtures/codex-app-server/
 * SPIKE-NOTES.md), `gpt-5.4` is verified to work on ChatGPT subscriptions.
 * The codex CLI's own default `gpt-5.2-codex` is rejected on non-Pro accounts.
 */
const CODEX_CHATGPT_DEFAULT_MODEL = "gpt-5.4";

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
 * which Codex would reject), substitute the spike-verified default `gpt-5.4`
 * so users running `swarm-harness --framework codex-chatgpt "say hi"` without
 * `--model` get a working session instead of a silent provider_unavailable.
 */
function resolveCodexModel(model: string | undefined): string {
  return isCodexCompatibleModel(model) ? model : CODEX_CHATGPT_DEFAULT_MODEL;
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

  constructor(opts: CodexFrameworkEngineOptions = {}) {
    if (opts.providerFactory !== undefined) {
      this.provider = opts.providerFactory();
    } else {
      this.provider = new CodexAppServerProvider({
        codexBinary: opts.codexBinary,
        cwd: opts.cwd,
        sandbox: opts.sandbox,
        approvalPolicy: opts.approvalPolicy,
      });
    }
  }

  getCumulativeUsage(): Usage {
    return this.cumulativeUsage;
  }

  async *run(config: RunConfig): AsyncIterable<NormalizedEvent> {
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
        yield event;
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
