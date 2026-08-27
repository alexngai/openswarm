/**
 * A stdio transport for MCP servers whose child process the broker owns.
 *
 * The SDK's own StdioClientTransport calls `spawn` internally, with no seam to
 * supply a process or to influence how it is launched. That makes every MCP
 * server a child outside openswarm's isolation, cancellation, and registry —
 * a category the process broker exists to eliminate. Since the SDK exports its
 * framing helpers for exactly this purpose, reimplementing the transport over
 * a brokered child is cheaper than the alternatives and leaves no bypass.
 *
 * Only the process's provenance differs. Framing is the SDK's own
 * newline-delimited JSON, via the SDK's ReadBuffer and serializeMessage.
 */

import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { getProcessBroker, type BrokeredProcess, type ProcessBroker } from "../process/broker.js";

export interface BrokeredStdioTransportOptions {
  readonly serverName: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly broker?: ProcessBroker;
}

export class BrokeredStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly opts: BrokeredStdioTransportOptions;
  private readonly readBuffer = new ReadBuffer();
  private proc: BrokeredProcess | undefined;

  constructor(opts: BrokeredStdioTransportOptions) {
    this.opts = opts;
  }

  /** The server's pid once started, for diagnostics. */
  get pid(): number | undefined {
    return this.proc?.child.pid;
  }

  async start(): Promise<void> {
    if (this.proc !== undefined) {
      throw new Error("BrokeredStdioTransport already started");
    }

    const broker = this.opts.broker ?? getProcessBroker();
    const proc = await broker.spawn({
      kind: "mcp",
      command: this.opts.command,
      args: this.opts.args ?? [],
      cwd: this.opts.cwd ?? process.cwd(),
      // stderr is inherited so a failing server's diagnostics reach the user
      // rather than filling a pipe nobody reads.
      stdio: ["pipe", "pipe", "inherit"],
      label: `mcp server '${this.opts.serverName}'`,
      ...(this.opts.env !== undefined && { env: this.opts.env }),
    });
    this.proc = proc;

    proc.child.stdout?.on("data", (chunk: Buffer) => {
      this.readBuffer.append(chunk);
      this.drain();
    });
    proc.child.stdout?.on("error", (err: Error) => this.onerror?.(err));
    proc.child.stdin?.on("error", (err: Error) => this.onerror?.(err));
    proc.child.on("error", (err: Error) => this.onerror?.(err));
    proc.child.on("close", () => {
      this.proc = undefined;
      this.onclose?.();
    });
  }

  private drain(): void {
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.readBuffer.readMessage();
      } catch (err) {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (message === null) return;
      this.onmessage?.(message);
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.proc?.child.stdin;
    if (!stdin) throw new Error("BrokeredStdioTransport is not connected");

    return new Promise<void>((resolve, reject) => {
      stdin.write(serializeMessage(message), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    this.readBuffer.clear();
    if (proc === undefined) return;

    // Signal the tree rather than closing stdin and hoping: a server that
    // ignores EOF, or that forked, would otherwise survive its own client.
    proc.kill("SIGTERM");
  }
}
