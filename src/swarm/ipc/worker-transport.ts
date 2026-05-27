import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
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

export interface WorkerTransportOptions {
  /** Default per-request timeout in milliseconds. */
  readonly defaultTimeoutMs?: number; // default 60_000
}

export interface SendOptions {
  readonly timeoutMs?: number;
}

export class WorkerTransport extends EventEmitter {
  // Emitted events:
  //   "worker_ready"   (params)
  //   "lane_event"     (params)
  //   "heartbeat"      (params)
  //   "task_result"    (params)
  //   "request"        (frame: IpcRequest) — raw request from worker (spawn, task.*)
  //   "error"          (err: Error)
  //   "close"          (exit: { code, signal })

  private readonly pending = new Map<
    string,
    {
      resolve: (result: unknown) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout | null;
    }
  >();
  private readonly splitter = new LineSplitter();
  private readonly defaultTimeoutMs: number;
  private closed = false;

  constructor(
    private readonly child: ChildProcess,
    opts: WorkerTransportOptions = {},
  ) {
    super();
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 60_000;

    // Wire stdout.
    if (!child.stdout) {
      throw new Error("WorkerTransport: child process has no stdout pipe");
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleBytes(chunk));
    child.stdout.on("error", (err) => this.emit("error", err));

    // Wire close.
    child.on("close", (code, signal) => {
      this.closed = true;
      this.rejectAllPending(
        IPC_ERROR_CODES.TRANSPORT_CLOSED,
        "worker exited before response",
      );
      this.emit("close", { code, signal });
    });

    child.on("error", (err) => this.emit("error", err));
  }

  /**
   * Send a request, await the response. Auto-rejects on timeout or
   * transport close.
   */
  async send<T = unknown>(
    method: IpcRequestMethod,
    params: unknown,
    opts: SendOptions = {},
  ): Promise<T> {
    if (this.closed) {
      throw Object.assign(new Error("transport closed"), {
        code: IPC_ERROR_CODES.TRANSPORT_CLOSED,
      });
    }
    const id = makeCorrelationId();
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<T>((resolve, reject) => {
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
      this.writeFrame({ kind: "request", id, method, params });
    });
  }

  /**
   * Reply to a request the worker sent us (spawn, task.*). Use the
   * correlation id from the incoming request. Response is fire-and-forget.
   */
  respond(requestId: string, result: unknown): void {
    this.writeFrame({ kind: "response", id: requestId, ok: true, result });
  }

  /** Reply with an error. */
  respondError(requestId: string, code: string, message: string): void {
    this.writeFrame({
      kind: "response",
      id: requestId,
      ok: false,
      error: { code, message },
    });
  }

  /** Send a one-way notification (rare from orchestrator side — sub_agent_*). */
  notify(method: IpcNotificationMethod, params: unknown): void {
    this.writeFrame({ kind: "notification", method, params });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    try {
      this.child.kill(signal);
    } catch {
      /* already dead */
    }
  }

  waitForExit(): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }> {
    return new Promise((resolve) => {
      if (
        this.child.exitCode !== null ||
        this.child.signalCode !== null
      ) {
        resolve({
          code: this.child.exitCode,
          signal: this.child.signalCode as NodeJS.Signals | null,
        });
        return;
      }
      this.child.once("close", (code, signal) =>
        resolve({ code, signal: signal as NodeJS.Signals | null }),
      );
    });
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
        // Malformed — log to stderr and skip (don't crash transport).
        process.stderr.write(
          `[swarm-harness/WorkerTransport] malformed frame: ${decoded.error}\n`,
        );
        continue;
      }
      this.dispatchFrame(decoded.frame);
    }
  }

  private dispatchFrame(frame: IpcFrame): void {
    if (isResponse(frame)) {
      const entry = this.pending.get(frame.id);
      if (!entry) return; // stale or duplicate response
      this.pending.delete(frame.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (frame.ok) entry.resolve(frame.result);
      else {
        entry.reject(
          Object.assign(new Error(frame.error.message), {
            code: frame.error.code,
          }),
        );
      }
      return;
    }
    if (isNotification(frame)) {
      this.emit(frame.method, frame.params);
      return;
    }
    if (isRequest(frame)) {
      // Worker initiated a request (spawn, task.*). Caller subscribes via
      // on("request", ...) and must respond() / respondError().
      this.emit("request", frame);
      return;
    }
  }

  private writeFrame(frame: IpcFrame): void {
    if (this.closed) return;
    const line = encodeFrame(frame);
    if (!this.child.stdin) {
      this.emit(
        "error",
        new Error("WorkerTransport: child process has no stdin pipe"),
      );
      return;
    }
    this.child.stdin.write(line);
  }

  private rejectAllPending(code: string, message: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(Object.assign(new Error(message), { code }));
      this.pending.delete(id);
    }
  }
}
