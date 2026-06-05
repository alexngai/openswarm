import type { ToolResult } from "../tools/types.js";

/**
 * ToolInput — the raw (pre-validation) input object passed to a tool.
 * Kept as `unknown` here; the dispatcher validates against the tool's Zod
 * schema before calling `execute`.
 */
export type ToolInput = unknown;

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "Stop";

/**
 * Hook config as declared by the user in .swarm-harness/hooks.json
 * (claude-code compatible format).
 */
export interface HookConfig {
  /** Glob/regex pattern matched against tool name (for PreToolUse/PostToolUse) or event name. */
  readonly matcher: string;
  /** Shell command to spawn. JSON payload is written to stdin; command should write JSON to stdout. */
  readonly command: string;
  /** Optional timeout in ms. Defaults to 30_000. */
  readonly timeoutMs?: number;
}

/**
 * Hook invocation result. Produced by our JS-callback wrapper around
 * the user's shell command.
 */
export interface HookResult {
  /** "allow" (exit 0) | "deny" (exit 2) | "fail" (any other non-zero) */
  readonly decision: "allow" | "deny" | "fail";
  /** Replacement input to forward to the tool (PreToolUse only). */
  readonly updatedInput?: ToolInput;
  /** System message to inject into the conversation. */
  readonly systemMessage?: string;
  /**
   * Context to inject into the model's conversation as a system message (H4).
   * Unlike systemMessage (which is for display), this is injected into the
   * actual message array so the model sees it.
   */
  readonly additionalContext?: string;
  /** Explicit permission override (takes precedence over decision when present). */
  readonly permissionDecision?: "allow" | "deny";
  /** Raw stdout from the hook command, for debugging. */
  readonly stdout?: string;
  /** Raw stderr from the hook command. */
  readonly stderr?: string;
  /** Error message when decision === "fail". */
  readonly error?: string;
}

/**
 * Payload for Stop hooks (H6). Fired when the agent wants to end its turn.
 * If the hook returns a non-zero exit (deny/fail), the engine forces continuation.
 */
export interface StopHookPayload {
  readonly event: "Stop";
  readonly stopReason: string;
  readonly turnIndex: number;
  readonly sessionId?: string;
  readonly agentId?: string;
}

/**
 * Hook payload shape passed to PreToolUse/PostToolUse hooks.
 * Matches claude-code's documented hook stdin JSON.
 */
export interface ToolHookPayload {
  readonly event: "PreToolUse" | "PostToolUse";
  readonly toolName: string;
  readonly toolInput: ToolInput;
  /** PostToolUse only. */
  readonly toolResult?: ToolResult;
  readonly sessionId?: string;
  readonly agentId?: string;
}
