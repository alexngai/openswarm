/**
 * opentasks-client.ts — minimal JSON-RPC 2.0 client for the opentasks daemon.
 *
 * v0.5 stage 5B. Speaks JSON-RPC 2.0 over the daemon's Unix socket. Never
 * throws — every method returns `null` on transport failure / RPC error so
 * the caller can apply best-effort semantics (mirror to opentasks; fall
 * through to local on failure).
 *
 * Method names mirror the daemon's surface:
 *   - ping → liveness check
 *   - graph.create → create a task/node
 *   - graph.update → patch fields on an existing node
 *   - graph.get → fetch a node by id
 *   - graph.query → query nodes (limited to `type: "tasks"` filter for now)
 *   - tools.link → create an edge between two nodes
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 2000;

export interface OpenTasksNode {
  readonly id: string;
  readonly uuid?: string;
  readonly type: string;
  readonly title: string;
  readonly status?: string;
  readonly content?: string;
  readonly assignee?: string;
  readonly metadata?: Record<string, unknown>;
  readonly created_at?: string;
  readonly updated_at?: string;
}

export interface CreateNodeParams {
  readonly type: "task" | "external" | string;
  readonly title: string;
  readonly status?: string;
  readonly content?: string;
  readonly assignee?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface UpdateNodeParams {
  readonly status?: string;
  readonly title?: string;
  readonly assignee?: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Walk-up socket discovery — the daemon's lifecycle layer follows the
 * priority `.swarm/opentasks/` → `.opentasks/` → `.git/opentasks/` from cwd
 * upward. Returns the first existing path, or `null` if none found.
 */
export function findOpenTasksSocket(cwd: string = process.cwd()): string | null {
  let dir = cwd;
  for (;;) {
    for (const sub of [".swarm/opentasks", ".opentasks", ".git/opentasks"]) {
      const candidate = path.join(dir, sub, "daemon.sock");
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export class OpenTasksClient {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async ping(): Promise<boolean> {
    const result = await this.rpc<{ pong?: boolean }>("ping", {});
    return result?.pong === true;
  }

  async create(params: CreateNodeParams): Promise<OpenTasksNode | null> {
    return await this.rpc<OpenTasksNode>("graph.create", params);
  }

  async update(
    id: string,
    updates: UpdateNodeParams,
  ): Promise<OpenTasksNode | null> {
    return await this.rpc<OpenTasksNode>("graph.update", { id, ...updates });
  }

  async get(id: string): Promise<OpenTasksNode | null> {
    return await this.rpc<OpenTasksNode>("graph.get", { id });
  }

  async query(params: {
    type: string;
    status?: string;
    limit?: number;
  }): Promise<readonly OpenTasksNode[] | null> {
    return await this.rpc<readonly OpenTasksNode[]>("graph.query", params);
  }

  async link(params: {
    fromId: string;
    toId: string;
    type: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ ok: boolean } | null> {
    return await this.rpc<{ ok: boolean }>("tools.link", params);
  }

  /**
   * Send a JSON-RPC 2.0 request. Returns null on timeout, transport error,
   * or RPC error response. Never throws.
   */
  private rpc<T>(method: string, params: unknown): Promise<T | null> {
    return new Promise((resolve) => {
      const id = randomUUID();
      const request =
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

      const client = net.createConnection(this.socketPath, () => {
        client.write(request);
      });

      let buffer = "";
      const timer = setTimeout(() => {
        client.destroy();
        resolve(null);
      }, this.timeoutMs);
      timer.unref();

      client.on("data", (data) => {
        buffer += data.toString();
        const nl = buffer.indexOf("\n");
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        clearTimeout(timer);
        client.destroy();
        try {
          const response = JSON.parse(line) as {
            id?: string;
            result?: T;
            error?: { code: number; message: string };
          };
          if (response.error !== undefined) {
            resolve(null);
            return;
          }
          resolve((response.result ?? null) as T | null);
        } catch {
          resolve(null);
        }
      });
      client.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }
}
