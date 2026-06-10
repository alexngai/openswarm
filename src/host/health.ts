/**
 * health.ts — docs/44 P5 (H3/H4). A tiny HTTP health server bound on the
 * gateway port (`base + 1`).
 *
 * OpenHive's hosting manager probes this endpoint to decide a hosted swarm is
 * live (see `references/openhive` `deriveHealthUrls` + the local provider's
 * 3-port stride for the macro-agent-style adapter). It is deliberately NOT a
 * REST CRUD surface (docs/44 D2) — just liveness + a point-in-time snapshot.
 */

import * as http from "node:http";

/** Point-in-time status payload merged into the `/health` response body. */
export type HealthStatusProvider = () => Record<string, unknown>;

export interface HealthServer {
  /** `http://<host>:<port>` */
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface CreateHealthServerOptions {
  readonly port: number;
  readonly host?: string;
  /** Extra fields merged into the JSON body (e.g. swarmId, uptime, ports). */
  readonly getStatus?: HealthStatusProvider;
}

/**
 * Stand up the health server and resolve once it is listening. Rejects if the
 * port is already bound (the caller surfaces this to OpenHive, which falls back
 * to a fresh port allocation).
 */
export async function createHealthServer(
  opts: CreateHealthServerOptions,
): Promise<HealthServer> {
  const host = opts.host ?? "127.0.0.1";
  const getStatus = opts.getStatus ?? (() => ({}));

  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && (url === "/health" || url === "/healthz")) {
      const body = JSON.stringify({ status: "ok", ...getStatus() });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(opts.port, host);
  });

  // NOTE: deliberately NOT unref()'d. For a long-running host the health
  // server is the keep-alive handle — unref'ing it lets Node's event loop
  // drain and exit the daemon the instant nothing else is ref'd. Teardown is
  // explicit via close().

  return {
    url: `http://${host}:${opts.port}`,
    port: opts.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
