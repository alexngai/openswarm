/**
 * Codex App Server — minimal type definitions for Stage 3A.
 *
 * Extracted from codex 0.98.0 generated bindings; see
 * test/fixtures/codex-app-server/ for the full set.
 *
 * Only the ~10 types needed for spawn + handshake + lifecycle are included
 * here so production code never reaches into test fixtures.
 */

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

export interface InitializeParams {
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
  };
  readonly capabilities: null;
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
