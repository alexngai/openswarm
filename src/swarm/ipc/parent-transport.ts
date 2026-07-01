import { EventEmitter } from "node:events";
import type { Writable, Readable } from "node:stream";
import { decodeFrame, encodeFrame, LineSplitter } from "./framing.js";
import {
  IPC_ERROR_CODES,
  isNotification,
  isRequest,
  isResponse,
  type IpcFrame,
  type IpcNotificationMethod,
  type IpcRequestMethod,
} from "./protocol.js";
import { makeCorrelationId } from "./correlation.js";

const HIGH_PRIORITY_NOTIFICATIONS = new Set<IpcNotificationMethod>([
  "worker_ready",
  "task_result",
]);
const HEARTBEAT_INTERVAL_MS = 30_000;
const OUTBOUND_QUEUE_MAX_BYTES = 1024 * 1024; // 1 MiB

export interface ParentTransportOptions {
  readonly defaultTimeoutMs?: number; // default 60_000
  readonly stdin?: Readable; // override for tests
  readonly stdout?: Writable; // override for tests
  readonly heartbeatIntervalMs?: number; // override for tests
  readonly agentId?: string; // for heartbeat payloads
}

export class ParentTransport extends EventEmitter {
  // Emitted events:
  //   "run"           (frame: IpcRequest) — run request from orchestrator
  //   "shutdown"      (frame: IpcRequest)
  //   "request"       (frame: IpcRequest) — fallback for any other request method
  //   "notification"  (frame: IpcNotification) — parent→worker notifications (sub_agent_*)
  //   "error"         (err: Error)
  //   "close"         (void) — stdin ended

  private readonly pending = new Map<
    string,
    {
      resolve: (r: unknown) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout | null;
    }
  >();
  private readonly splitter = new LineSplitter();
  private readonly defaultTimeoutMs: number;
  private readonly stdin: Readable;
  private readonly stdout: Writable;
  private readonly heartbeatIntervalMs: number;
  private readonly agentId: string | undefined;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private closed = false;

  // Backpressure state.
  private outboundBufferedBytes = 0;
  private drainWaiters: Array<() => void> = [];

  constructor(opts: ParentTransportOptions = {}) {
    super();
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 60_000;
    this.stdin = opts.stdin ?? (process.stdin as unknown as Readable);
    this.stdout = opts.stdout ?? (process.stdout as unknown as Writable);
    this.heartbeatIntervalMs =
      opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.agentId = opts.agentId;

    if (typeof (this.stdin as { setEncoding?: unknown }).setEncoding === "function") {
      (this.stdin as { setEncoding: (enc: string) => void }).setEncoding("utf8");
    }
    this.stdin.on("data", (chunk: string | Buffer) => {
      this.handleBytes(
        typeof chunk === "string" ? chunk : chunk.toString("utf8"),
      );
    });
    this.stdin.on("end", () => {
      this.closed = true;
      this.rejectAllPending(
        IPC_ERROR_CODES.TRANSPORT_CLOSED,
        "parent closed stdin",
      );
      this.emit("close");
    });
    this.stdin.on("error", (err) => this.emit("error", err));

    this.stdout.on("drain", () => {
      // Resolve all drain waiters FIFO.
      const waiters = this.drainWaiters;
      this.drainWaiters = [];
      for (const w of waiters) w();
    });
    this.stdout.on("error", (err) => this.emit("error", err));
  }

  /** Send a request to the parent, await response. */
  async send<T = unknown>(
    method: IpcRequestMethod,
    params: unknown,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.closed) {
      throw Object.assign(new Error("transport closed"), {
        code: IPC_ERROR_CODES.TRANSPORT_CLOSED,
      });
    }
    const id = makeCorrelationId();
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;

    const resultPromise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          entry.reject(
            Object.assign(
              new Error(`request ${method} timed out after ${timeoutMs}ms`),
              { code: IPC_ERROR_CODES.REQUEST_TIMEOUT },
            ),
          );
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => resolve(r as T),
        reject,
        timer,
      });
    });

    // Requests are high-priority — always block on drain if needed.
    await this.writeFrameHighPriority({ kind: "request", id, method, params });
    return resultPromise;
  }

  /**
   * One-way notification. Low-priority methods (lane_event, heartbeat)
   * are DROPPED with a stderr warning when the outbound queue is full.
   * High-priority (worker_ready, task_result) block on drain.
   */
  async notify(method: IpcNotificationMethod, params: unknown): Promise<void> {
    const frame: IpcFrame = { kind: "notification", method, params };
    if (HIGH_PRIORITY_NOTIFICATIONS.has(method)) {
      await this.writeFrameHighPriority(frame);
    } else {
      this.writeFrameLowPriority(frame, method);
    }
  }

  respond(requestId: string, result: unknown): void {
    this.writeFrameLowPriority(
      { kind: "response", id: requestId, ok: true, result } as IpcFrame,
      "response",
    );
  }

  respondError(requestId: string, code: string, message: string): void {
    this.writeFrameLowPriority(
      {
        kind: "response",
        id: requestId,
        ok: false,
        error: { code, message },
      } as IpcFrame,
      "response",
    );
  }

  /** Start periodic heartbeat notifications. */
  startHeartbeat(): void {
    if (this.heartbeatTimer !== null) return;
    this.heartbeatTimer = setInterval(() => {
      this.notify("heartbeat", { agentId: this.agentId, ts: Date.now() }).catch(
        () => {
          /* drop silently — heartbeat failures are not worth surfacing */
        },
      );
    }, this.heartbeatIntervalMs);
    // Don't hold the event loop open for the heartbeat alone.
    if (typeof this.heartbeatTimer.unref === "function") {
      this.heartbeatTimer.unref();
    }
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Force-close the transport from the worker side (clean shutdown path). */
  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    this.rejectAllPending(
      IPC_ERROR_CODES.TRANSPORT_CLOSED,
      "transport closed by worker",
    );
  }

  // ---- private ----

  private handleBytes(chunk: string): void {
    let lines: string[];
    try {
      lines = this.splitter.push(chunk);
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      return;
    }
    for (const line of lines) {
      const decoded = decodeFrame(line);
      if (!decoded.ok) {
        process.stderr.write(
          `[swarm-harness/ParentTransport] malformed frame: ${decoded.error}\n`,
        );
        continue;
      }
      this.dispatchFrame(decoded.frame);
    }
  }

  private dispatchFrame(frame: IpcFrame): void {
    if (isResponse(frame)) {
      const entry = this.pending.get(frame.id);
      if (!entry) return;
      this.pending.delete(frame.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (frame.ok) entry.resolve(frame.result);
      else
        entry.reject(
          Object.assign(new Error(frame.error.message), {
            code: frame.error.code,
          }),
        );
      return;
    }
    if (isRequest(frame)) {
      // Named events for "run" and "shutdown"; everything else → "request".
      if (frame.method === "run") {
        this.emit("run", frame);
      } else if (frame.method === "shutdown") {
        this.emit("shutdown", frame);
      } else {
        this.emit("request", frame);
      }
      return;
    }
    if (isNotification(frame)) {
      this.emit("notification", frame);
      return;
    }
  }

  private async writeFrameHighPriority(frame: IpcFrame): Promise<void> {
    const line = encodeFrame(frame);
    const bytes = Buffer.byteLength(line, "utf8");

    // Block on drain if we're over the cap, no matter the priority.
    while (this.outboundBufferedBytes + bytes > OUTBOUND_QUEUE_MAX_BYTES) {
      await new Promise<void>((r) => this.drainWaiters.push(r));
    }

    this.outboundBufferedBytes += bytes;
    const flushed = this.stdout.write(line, () => {
      this.outboundBufferedBytes -= bytes;
    });
    if (!flushed) {
      // Writer couldn't fully flush — wait for drain before returning.
      await new Promise<void>((r) => this.drainWaiters.push(r));
    }
  }

  private writeFrameLowPriority(frame: IpcFrame, typeLabel: string): void {
    const line = encodeFrame(frame);
    const bytes = Buffer.byteLength(line, "utf8");

    if (this.outboundBufferedBytes + bytes > OUTBOUND_QUEUE_MAX_BYTES) {
      process.stderr.write(
        `[openswarm] worker outbound queue full; dropping ${typeLabel}\n`,
      );
      return;
    }

    this.outboundBufferedBytes += bytes;
    this.stdout.write(line, () => {
      this.outboundBufferedBytes -= bytes;
    });
  }

  private rejectAllPending(code: string, message: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(Object.assign(new Error(message), { code }));
      this.pending.delete(id);
    }
  }
}
