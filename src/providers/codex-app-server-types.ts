/**
 * Codex App Server — minimal type definitions for Stage 3A + 3B.
 *
 * Extracted from codex 0.98.0 generated bindings; see
 * test/fixtures/codex-app-server/ for the full set.
 *
 * Only the types needed for spawn + handshake + lifecycle + agent-turn
 * execution are included here so production code never reaches into test
 * fixtures.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Standard JSON-RPC 2.0 shapes
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface JsonRpcResponse {
  readonly id: number;
  readonly result: unknown;
}

export interface JsonRpcNotification {
  readonly method: string;
  readonly params: unknown;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcError {
  readonly id: number;
  readonly error: JsonRpcErrorObject;
}

/**
 * A line parsed from the server's stdout. Discriminated by the presence of
 * `method` (notification) vs `id` + `result` (response) vs `id` + `error`.
 */
export type JsonRpcServerFrame =
  | JsonRpcResponse
  | JsonRpcError
  | JsonRpcNotification;

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

/**
 * Capabilities the host advertises during the initialize handshake.
 * `experimentalApi: true` is required to opt into experimental features such
 * as dynamicTools (Stage 4H).
 */
export interface InitializeCapabilities {
  readonly experimentalApi?: boolean;
}

export interface InitializeParams {
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
  };
  readonly capabilities: InitializeCapabilities | null;
}

export interface InitializeResult {
  readonly userAgent: string;
}

// ---------------------------------------------------------------------------
// getAuthStatus
// ---------------------------------------------------------------------------

export interface GetAuthStatusParams {
  readonly includeToken: boolean | null;
  readonly refreshToken: boolean | null;
}

export interface GetAuthStatusResult {
  /** "apikey" | "chatgpt" | "chatgptAuthTokens" | null */
  readonly authMethod: string | null;
  readonly authToken: string | null;
  readonly requiresOpenaiAuth: boolean | null;
}

// ---------------------------------------------------------------------------
// Stage 3B — thread/start, turn/start, turn/interrupt, thread/archive
// ---------------------------------------------------------------------------

export interface ThreadStartParams {
  readonly model?: string;
  readonly cwd?: string;
  readonly sandbox?: string;
  readonly approvalPolicy?: string;
  readonly experimentalRawEvents: boolean;
  /**
   * Host tools registered for this thread. Each entry becomes callable by
   * the agent via `item/tool/call` requests. Requires
   * `capabilities.experimentalApi: true` in the initialize handshake.
   * (Stage 4H)
   */
  readonly dynamicTools?: readonly unknown[];
}

export interface ThreadStartResult {
  readonly thread: {
    readonly id: string;
    readonly preview: string;
    readonly modelProvider: string;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly cwd: string;
  };
  readonly model: string;
  readonly modelProvider: string;
  readonly cwd: string;
  readonly approvalPolicy: string;
  readonly sandbox: { readonly type: string };
  readonly reasoningEffort: string | null;
}

export interface TurnStartParams {
  readonly threadId: string;
  readonly input: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly model?: string;
}

export interface TurnStartResult {
  readonly turn: {
    readonly id: string;
    readonly items: unknown[];
    readonly status: string;
    readonly error: unknown | null;
  };
}

export interface TurnInterruptParams {
  readonly threadId: string;
  readonly turnId: string;
}

export interface TurnInterruptResult {
  readonly ok: boolean;
}

export interface ThreadArchiveParams {
  readonly threadId: string;
}

export interface ThreadArchiveResult {
  readonly ok?: boolean;
}

// ---------------------------------------------------------------------------
// Stage 3B — server→client notification payload types
// ---------------------------------------------------------------------------

export interface ThreadStartedNotification {
  readonly thread: {
    readonly id: string;
    readonly preview: string;
    readonly modelProvider: string;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly cwd: string;
    readonly turns: unknown[];
  };
}

export interface TurnStartedNotification {
  readonly threadId: string;
  readonly turn: {
    readonly id: string;
    readonly items: unknown[];
    readonly status: string;
    readonly error: unknown | null;
  };
}

/** turn.status values: "completed" | "failed" | "inProgress" */
export interface TurnCompletedNotification {
  readonly threadId: string;
  readonly turn: {
    readonly id: string;
    readonly items: unknown[];
    readonly status: "completed" | "failed" | "inProgress";
    readonly error: { readonly message: string } | null;
  };
}

export interface UserMessageItem {
  readonly type: "userMessage";
  readonly id: string;
  readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
}

export interface AgentMessageItem {
  readonly type: "agentMessage";
  readonly id: string;
  readonly text: string;
}

export interface ReasoningItem {
  readonly type: "reasoning";
  readonly id: string;
  readonly summary: unknown[];
  readonly content: unknown[];
}

export interface CommandExecutionItem {
  readonly type: "commandExecution";
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly processId?: string | null;
  readonly status: "inProgress" | "completed" | "failed";
  readonly commandActions: readonly unknown[];
  readonly aggregatedOutput: string | null;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
}

export type KnownItem = UserMessageItem | AgentMessageItem | ReasoningItem | CommandExecutionItem;

export interface ItemStartedNotification {
  readonly item: KnownItem;
  readonly threadId: string;
  readonly turnId: string;
}

export interface ItemCompletedNotification {
  readonly item: KnownItem;
  readonly threadId: string;
  readonly turnId: string;
}

export interface ItemAgentMessageDeltaNotification {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly delta: string;
}

export interface ThreadTokenUsageNotification {
  readonly threadId: string;
  readonly turnId: string;
  readonly tokenUsage: {
    readonly total: {
      readonly totalTokens: number;
      readonly inputTokens: number;
      readonly cachedInputTokens: number;
      readonly outputTokens: number;
      readonly reasoningOutputTokens?: number;
    };
    readonly last: {
      readonly totalTokens: number;
      readonly inputTokens: number;
      readonly cachedInputTokens: number;
      readonly outputTokens: number;
      readonly reasoningOutputTokens?: number;
    };
    readonly modelContextWindow: number;
  };
}

export interface RateLimitsUpdatedNotification {
  readonly rateLimits: unknown;
}

export interface ErrorNotification {
  readonly message: string;
  readonly code?: number;
  readonly data?: unknown;
}

// ---------------------------------------------------------------------------
// Stage 4H — DynamicTools (host tools registered at thread/start)
// ---------------------------------------------------------------------------

/**
 * Tool descriptor passed into thread/start.dynamicTools. Each entry registers
 * a host-side tool that the Codex agent can call via item/tool/call.
 *
 * Shape mirrors codex 0.98.0 ts-rs binding (test/fixtures/codex-app-server/Tool.ts).
 * `inputSchema` / `outputSchema` are JSON Schema objects — passed through
 * without parsing so callers can supply tool-defined shapes.
 */
export const ToolSchema = z.object({
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.unknown(),
  outputSchema: z.unknown().optional(),
  annotations: z.unknown().optional(),
  icons: z.array(z.unknown()).optional(),
  _meta: z.unknown().optional(),
});

export type Tool = z.infer<typeof ToolSchema>;

/**
 * Params on the `item/tool/call` request the server sends when the agent
 * calls a registered dynamic tool. Shape from
 * test/fixtures/codex-app-server/DynamicToolCallParams.json.
 */
export const DynamicToolCallParamsSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  callId: z.string(),
  tool: z.string().min(1),
  arguments: z.unknown(),
});

export type DynamicToolCallParams = z.infer<typeof DynamicToolCallParamsSchema>;

/**
 * Discriminated union of content items the host returns to the server.
 * Shape from test/fixtures/codex-app-server/DynamicToolCallResponse.json.
 */
export const DynamicToolCallOutputContentItemSchema = z.discriminatedUnion(
  "type",
  [
    z.object({ type: z.literal("inputText"), text: z.string() }),
    z.object({ type: z.literal("inputImage"), imageUrl: z.string() }),
  ],
);

export type DynamicToolCallOutputContentItem = z.infer<
  typeof DynamicToolCallOutputContentItemSchema
>;

/**
 * Response shape the host returns for an item/tool/call request.
 * Sent back as the `result` field of the JSON-RPC response.
 */
export const DynamicToolCallResponseSchema = z.object({
  contentItems: z.array(DynamicToolCallOutputContentItemSchema),
  success: z.boolean(),
});

export type DynamicToolCallResponse = z.infer<
  typeof DynamicToolCallResponseSchema
>;

/**
 * Context handed to the host's onDynamicToolCall handler so it knows which
 * thread/turn/call this invocation belongs to.
 */
export interface DynamicToolCallContext {
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
}
