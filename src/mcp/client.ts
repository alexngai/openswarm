/**
 * McpStdioClient — wraps @modelcontextprotocol/sdk's Client + StdioClientTransport.
 *
 * Responsibilities:
 *   - Spawn a subprocess (via StdioClientTransport) for a configured MCP server.
 *   - Perform the initialize handshake with a 10s timeout.
 *   - Expose listTools / callTool / listResources / readResource.
 *   - Graceful close: close transport, then best-effort terminate.
 *
 * Shape intentionally small — the SDK does the JSON-RPC heavy lifting. We add:
 *   - A typed McpServerConfig surface.
 *   - A bounded connect() with cleanup on timeout.
 *   - `isConnected` state flip only on successful handshake.
 *   - Uniform McpToolDescriptor output.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface McpServerConfig {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  /** JSON Schema describing the tool input. */
  readonly inputSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONNECT_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 2_000;

// ---------------------------------------------------------------------------
// McpStdioClient
// ---------------------------------------------------------------------------

export class McpStdioClient {
  readonly serverName: string;

  private readonly _config: McpServerConfig;
  private _client: Client | undefined;
  private _transport: StdioClientTransport | undefined;
  private _connected = false;

  constructor(config: McpServerConfig) {
    this._config = config;
    this.serverName = config.name;
  }

  get isConnected(): boolean {
    return this._connected;
  }

  /**
   * Spawn the server subprocess and perform the initialize handshake.
   * Rejects with a clean error (and tears down the subprocess) on 10s timeout.
   */
  async connect(): Promise<void> {
    if (this._connected) return;

    const transport = new StdioClientTransport({
      command: this._config.command,
      args: this._config.args ? Array.from(this._config.args) : undefined,
      env: this._config.env ? { ...this._config.env } : undefined,
      cwd: this._config.cwd,
      // Inherit stderr so server error messages surface to the parent.
      stderr: "inherit",
    });

    const client = new Client(
      { name: "openswarm", version: "0.0.1" },
      { capabilities: {} },
    );

    this._transport = transport;
    this._client = client;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `mcp server '${this.serverName}' connect timed out after ${CONNECT_TIMEOUT_MS}ms`,
          ),
        );
      }, CONNECT_TIMEOUT_MS);
    });

    try {
      await Promise.race([client.connect(transport), timeoutPromise]);
      this._connected = true;
    } catch (err) {
      // Cleanup: close the transport (which kills the subprocess) on any
      // failure so we never leak a subprocess.
      try {
        await transport.close();
      } catch {
        // ignore cleanup errors
      }
      this._client = undefined;
      this._transport = undefined;
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * List the server's tools. Call after connect().
   * Normalizes into McpToolDescriptor[].
   */
  async listTools(): Promise<McpToolDescriptor[]> {
    const client = this._requireClient();
    const result = await client.listTools();
    return (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
    }));
  }

  /** List MCP resources (minimal wrapper — returns raw array for now). */
  async listResources(): Promise<unknown[]> {
    const client = this._requireClient();
    const result = await client.listResources();
    return (result.resources ?? []) as unknown[];
  }

  /** Read a single MCP resource by URI. */
  async readResource(uri: string): Promise<unknown> {
    const client = this._requireClient();
    return client.readResource({ uri });
  }

  /**
   * Invoke a tool via JSON-RPC. Callers should wrap this for ToolImpl semantics
   * (see `buildMcpToolImpl` in `./bridge.ts`).
   */
  async callTool(name: string, args: unknown): Promise<unknown> {
    const client = this._requireClient();
    const params =
      args !== undefined && args !== null && typeof args === "object"
        ? (args as Record<string, unknown>)
        : {};
    return client.callTool({ name, arguments: params });
  }

  /**
   * Graceful shutdown. Closes the transport (which sends SIGTERM after
   * closing stdin); waits up to 2s; if still alive, best-effort nothing
   * more (SDK handles the kill).
   */
  async close(): Promise<void> {
    if (!this._transport) return;

    const closePromise = this._transport.close();
    const timeout = new Promise<void>((resolve) =>
      setTimeout(resolve, CLOSE_TIMEOUT_MS),
    );

    try {
      await Promise.race([closePromise, timeout]);
    } catch {
      // ignore
    } finally {
      this._connected = false;
      this._client = undefined;
      this._transport = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private _requireClient(): Client {
    if (!this._client || !this._connected) {
      throw new Error(
        `mcp server '${this.serverName}' is not connected; call connect() first`,
      );
    }
    return this._client;
  }
}
