/**
 * HookRuntime — wraps user-authored shell commands (from hooks.json) in JS
 * async callbacks suitable for both:
 *
 *   1. The Claude Agent SDK's `query({ options: { hooks } })` field, which
 *      expects `Partial<Record<HookEvent, HookCallbackMatcher[]>>` where each
 *      HookCallback is `(input, toolUseId, { signal }) => Promise<HookJSONOutput>`.
 *      See node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
 *      lines 692 (HookCallback), 699 (HookCallbackMatcher), 1250
 *      (options.hooks), 1819 (PreToolUseHookSpecificOutput).
 *
 *   2. Our dispatcher (`invoke()`), which fires for all tool tiers —
 *      including Tier 2 tools that bypass the SDK's tool path. This closes
 *      rev-2 Major M6.
 */

import { spawn } from "node:child_process";
import { getHardenedEnv } from "../tools/tier0/process-hardening.js";
import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent as SdkHookEvent,
  HookJSONOutput,
  HookInput as SdkHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  HookConfig,
  HookEvent,
  HookResult,
  ToolHookPayload,
  ToolInput,
} from "./index.js";
import type { HooksConfigFile } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Optional fields the user's shell command may emit on stdout. */
interface HookStdoutPayload {
  readonly updatedInput?: unknown;
  readonly systemMessage?: string;
  readonly additionalContext?: string;
  readonly permissionDecision?: "allow" | "deny";
}

/** SDK hooks map — keyed by SDK event name. */
export type SdkHooksMap = Partial<Record<SdkHookEvent, HookCallbackMatcher[]>>;

const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Matcher logic
// ---------------------------------------------------------------------------

/**
 * Check whether `cfg.matcher` matches `toolName`.
 *
 * Rules (documented in hooks.json schema):
 *  - `*`               → matches everything
 *  - `"/pat/"` or `"/pat/i"` → parsed as RegExp
 *  - otherwise          → literal string with `*` as wildcard (glob-lite),
 *                          matched case-sensitively against `toolName`.
 */
export function matcherMatches(matcher: string, toolName: string): boolean {
  if (matcher === "*" || matcher === "") return true;

  // /pattern/flags regex form
  const reMatch = /^\/(.+)\/([a-z]*)$/.exec(matcher);
  if (reMatch !== null) {
    try {
      const re = new RegExp(reMatch[1]!, reMatch[2]);
      return re.test(toolName);
    } catch {
      return false;
    }
  }

  // Literal glob: translate `*` → `.*`, escape other regex metachars.
  if (matcher.includes("*")) {
    const pattern = matcher
      .split("*")
      .map(escapeRegex)
      .join(".*");
    try {
      return new RegExp(`^${pattern}$`).test(toolName);
    } catch {
      return false;
    }
  }

  return matcher === toolName;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/**
 * HookRuntime is REENTRANCY-SAFE.
 *
 * invoke() creates all per-call state inside the function body: a fresh
 * AbortController, fresh child process, fresh stdout/stderr buffers, and
 * a fresh timeout. No shared mutable state is mutated across concurrent
 * invocations. Parallel tool dispatch (M3b Phase 4) may call invoke()
 * from multiple Promise.all branches simultaneously; each branch sees
 * its own isolated state.
 *
 * Shared reads (the config passed at construction) are immutable after
 * constructor and safe to read concurrently.
 */
export class HookRuntime {
  constructor(private readonly config: HooksConfigFile) {}

  /**
   * Build the SDK-shaped hooks map. The SDK's type
   * (`Partial<Record<HookEvent, HookCallbackMatcher[]>>`, sdk.d.ts:1250) wants
   * `{ matcher?: string; hooks: HookCallback[]; timeout?: number }` entries.
   *
   * We produce ONE HookCallbackMatcher per configured HookConfig so the SDK's
   * own matcher-filter path does a first-pass toolName comparison before
   * calling our JS wrapper (cheap optimization; the wrapper also re-checks
   * for the dispatcher-level `invoke()` path).
   */
  buildSdkHooks(): SdkHooksMap {
    const out: SdkHooksMap = {};
    for (const evt of HOOK_EVENTS) {
      const configs = this.configsForEvent(evt);
      if (configs.length === 0) continue;
      out[evt] = configs.map((cfg) => {
        const matcher: HookCallbackMatcher = {
          hooks: [this.wrapAsSdkCallback(cfg)],
        };
        if (cfg.matcher.length > 0) matcher.matcher = cfg.matcher;
        if (cfg.timeoutMs !== undefined) {
          // SDK accepts `timeout` in seconds (sdk.d.ts:702-703).
          matcher.timeout = Math.max(1, Math.round(cfg.timeoutMs / 1000));
        }
        return matcher;
      });
    }
    return out;
  }

  /**
   * Dispatcher-level invocation — fires for ALL tools regardless of tier.
   * Used by ToolDispatcher before executing any tool. Runs every configured
   * hook whose matcher matches, in declaration order. First deny/fail short-
   * circuits; otherwise merges `updatedInput` from the last allow.
   */
  async invoke(event: HookEvent, payload: ToolHookPayload | { toolName: string; [k: string]: unknown }): Promise<HookResult> {
    const configs = this.configsForEvent(event);
    if (configs.length === 0) {
      return { decision: "allow" };
    }
    const toolName = payload.toolName;
    let last: HookResult = { decision: "allow" };
    for (const cfg of configs) {
      if (!matcherMatches(cfg.matcher, toolName)) continue;
      const wrapped = this.wrapCommand(cfg);
      const result = await wrapped(payload);
      if (result.decision === "deny" || result.decision === "fail") {
        return result;
      }
      // merge updatedInput from this hook into accumulated result
      last = {
        decision: "allow",
        ...(result.updatedInput !== undefined
          ? { updatedInput: result.updatedInput }
          : last.updatedInput !== undefined
            ? { updatedInput: last.updatedInput }
            : {}),
        ...(result.systemMessage !== undefined
          ? { systemMessage: result.systemMessage }
          : {}),
        ...(result.additionalContext !== undefined
          ? { additionalContext: result.additionalContext }
          : last.additionalContext !== undefined
            ? { additionalContext: last.additionalContext }
            : {}),
        ...(result.permissionDecision !== undefined
          ? { permissionDecision: result.permissionDecision }
          : {}),
      };
    }
    return last;
  }

  private configsForEvent(event: HookEvent): readonly HookConfig[] {
    switch (event) {
      case "PreToolUse":
        return this.config.PreToolUse ?? [];
      case "PostToolUse":
        return this.config.PostToolUse ?? [];
      case "SessionStart":
        return this.config.SessionStart ?? [];
      case "SessionEnd":
        return this.config.SessionEnd ?? [];
      case "UserPromptSubmit":
        return this.config.UserPromptSubmit ?? [];
      case "Stop":
        return this.config.Stop ?? [];
    }
  }

  /**
   * Wrap one HookConfig into a JS callback suitable for direct invocation
   * with our ToolHookPayload (internal / dispatcher path).
   */
  private wrapCommand(
    cfg: HookConfig,
  ): (payload: unknown) => Promise<HookResult> {
    return (payload: unknown) => runShellHook(cfg, payload);
  }

  /**
   * Wrap one HookConfig into the SDK's HookCallback shape.
   * SDK passes a BaseHookInput-derived object; we forward it as-is to stdin.
   */
  private wrapAsSdkCallback(cfg: HookConfig): HookCallback {
    const runtime = this;
    return async (
      input: SdkHookInput,
      _toolUseId: string | undefined,
      _options: { signal: AbortSignal },
    ): Promise<HookJSONOutput> => {
      // SDK already matches on `matcher` (HookCallbackMatcher.matcher), but
      // guard here too so the same wrapper works for non-filtered dispatches.
      const toolName =
        (input as unknown as { tool_name?: string }).tool_name ?? "";
      if (!matcherMatches(cfg.matcher, toolName)) {
        return {};
      }
      const result = await runShellHook(cfg, input);
      return toSdkOutput(result, runtime.inputEventName(input));
    };
  }

  private inputEventName(input: SdkHookInput): HookEvent {
    const name = (input as unknown as { hook_event_name?: string })
      .hook_event_name;
    switch (name) {
      case "PreToolUse":
      case "PostToolUse":
      case "SessionStart":
      case "SessionEnd":
      case "UserPromptSubmit":
      case "Stop":
        return name;
      default:
        return "PreToolUse";
    }
  }

  /**
   * Invoke Stop hooks (H6). Returns true if the agent should continue
   * (hook denied the stop), false if the stop is allowed to proceed.
   */
  async invokeStop(payload: {
    stopReason: string;
    turnIndex: number;
    sessionId?: string;
    agentId?: string;
  }): Promise<{ forceContinue: boolean; additionalContext?: string }> {
    const configs = this.configsForEvent("Stop");
    if (configs.length === 0) {
      return { forceContinue: false };
    }

    const hookPayload = {
      event: "Stop" as const,
      toolName: "",
      toolInput: payload,
      ...payload,
    };

    const result = await this.invoke("Stop", hookPayload);

    if (result.decision === "deny" || result.decision === "fail") {
      return {
        forceContinue: true,
        additionalContext: result.additionalContext ?? result.systemMessage,
      };
    }

    return {
      forceContinue: false,
      additionalContext: result.additionalContext,
    };
  }
}

// ---------------------------------------------------------------------------
// Shell execution — shared by both wrappers
// ---------------------------------------------------------------------------

const HOOK_EVENTS: readonly HookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Stop",
];

/**
 * Spawn `bash -c "<command>"`, write JSON payload on stdin, read stdout JSON,
 * and translate exit codes (0 → allow, 2 → deny, other → fail). Timeouts
 * surface as `{ decision: "fail", error: "hook timed out after <ms>ms" }`.
 */
function runShellHook(
  cfg: HookConfig,
  payload: unknown,
): Promise<HookResult> {
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  timer.unref?.();
  let stdout = "";
  let stderr = "";

  return new Promise<HookResult>((resolve) => {
    let settled = false;
    const settle = (r: HookResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("bash", ["-c", cfg.command], {
        signal: ac.signal,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...getHardenedEnv() },
      });
    } catch (err) {
      settle({
        decision: "fail",
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    child.stdout?.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
    });
    child.stderr?.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
    });

    try {
      child.stdin?.end(JSON.stringify(payload) + "\n");
    } catch {
      // stdin pipe closed — command may have already exited; that's fine.
    }

    child.once("error", (err: Error & { code?: string }) => {
      // AbortController-triggered kills surface as ERR_ABORTED; translate.
      if (ac.signal.aborted) {
        settle({
          decision: "fail",
          error: `hook timed out after ${timeoutMs}ms`,
          stdout,
          stderr,
        });
      } else {
        settle({
          decision: "fail",
          error: err.message,
          stdout,
          stderr,
        });
      }
    });

    child.once("close", (code: number | null) => {
      if (ac.signal.aborted) {
        settle({
          decision: "fail",
          error: `hook timed out after ${timeoutMs}ms`,
          stdout,
          stderr,
        });
        return;
      }

      let parsed: HookStdoutPayload = {};
      const trimmed = stdout.trim();
      if (trimmed.length > 0) {
        try {
          const obj = JSON.parse(trimmed) as unknown;
          if (obj !== null && typeof obj === "object") {
            parsed = obj as HookStdoutPayload;
          }
        } catch {
          // tolerate malformed stdout — fall back to exit-code-only decision
        }
      }

      if (code === 0) {
        const out: HookResult = {
          decision: "allow",
          stdout,
          stderr,
        };
        if (parsed.updatedInput !== undefined) {
          (out as { updatedInput?: ToolInput }).updatedInput =
            parsed.updatedInput as ToolInput;
        }
        if (parsed.systemMessage !== undefined) {
          (out as { systemMessage?: string }).systemMessage =
            parsed.systemMessage;
        }
        if (parsed.permissionDecision !== undefined) {
          (out as { permissionDecision?: "allow" | "deny" }).permissionDecision =
            parsed.permissionDecision;
        }
        if (parsed.additionalContext !== undefined) {
          (out as { additionalContext?: string }).additionalContext =
            parsed.additionalContext;
        }
        settle(out);
      } else if (code === 2) {
        const out: HookResult = {
          decision: "deny",
          permissionDecision: "deny",
          stdout,
          stderr,
        };
        if (parsed.systemMessage !== undefined) {
          (out as { systemMessage?: string }).systemMessage =
            parsed.systemMessage;
        }
        if (parsed.additionalContext !== undefined) {
          (out as { additionalContext?: string }).additionalContext =
            parsed.additionalContext;
        }
        settle(out);
      } else {
        settle({
          decision: "fail",
          error: `hook exited ${code}: ${stderr.slice(0, 500)}`,
          stdout,
          stderr,
        });
      }
    });
  });
}

/**
 * Translate our internal HookResult into the SDK's HookJSONOutput shape.
 * See sdk.d.ts:4947 (SyncHookJSONOutput) and :1819 (PreToolUseHookSpecificOutput).
 */
function toSdkOutput(result: HookResult, event: HookEvent): HookJSONOutput {
  if (result.decision === "allow") {
    const out: HookJSONOutput = {};
    if (result.systemMessage !== undefined) {
      (out as { systemMessage?: string }).systemMessage = result.systemMessage;
    }
    if (result.additionalContext !== undefined) {
      (out as { additionalContext?: string }).additionalContext =
        result.additionalContext;
    }
    if (event === "PreToolUse" && result.updatedInput !== undefined) {
      (out as {
        hookSpecificOutput?: {
          hookEventName: "PreToolUse";
          updatedInput?: Record<string, unknown>;
          permissionDecision?: "allow" | "deny";
        };
      }).hookSpecificOutput = {
        hookEventName: "PreToolUse",
        updatedInput: result.updatedInput as Record<string, unknown>,
      };
    }
    return out;
  }

  if (result.decision === "deny") {
    const base: HookJSONOutput = {
      decision: "block",
    };
    if (result.systemMessage !== undefined) {
      (base as { systemMessage?: string }).systemMessage = result.systemMessage;
    }
    if (event === "PreToolUse") {
      (base as {
        hookSpecificOutput?: {
          hookEventName: "PreToolUse";
          permissionDecision?: "allow" | "deny";
          permissionDecisionReason?: string;
        };
      }).hookSpecificOutput = {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        ...(result.systemMessage !== undefined
          ? { permissionDecisionReason: result.systemMessage }
          : {}),
      };
    }
    return base;
  }

  // fail
  return {
    decision: "block",
    reason: result.error ?? "hook failed",
    continue: false,
  };
}
