/**
 * Local HTTP/CONNECT proxy server (S2 Phase 2).
 *
 * Intercepts all outbound HTTP(S) from sandboxed processes:
 *   - HTTP requests: policy-checked, then forwarded
 *   - CONNECT tunnels (HTTPS): policy-checked by hostname, then piped
 *
 * SSRF protection: DNS resolution + private IP blocking happens before
 * any connection is made to the target.
 *
 * The proxy binds to 127.0.0.1 on a random port. Sandboxed processes
 * reach it via HTTP_PROXY / HTTPS_PROXY env vars.
 */

import * as http from "node:http";
import * as net from "node:net";
import { URL } from "node:url";
import {
  NetworkPolicy,
  type NetworkPolicyDecision,
} from "../../../src/tools/tier0/network-policy.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProxyServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export interface ProxyOptions {
  readonly policy: NetworkPolicy;
  readonly host?: string;
  readonly port?: number;
  readonly connectTimeout?: number;
}

// ---------------------------------------------------------------------------
// Proxy implementation
// ---------------------------------------------------------------------------

const DEFAULT_CONNECT_TIMEOUT = 10_000;

export async function startProxy(opts: ProxyOptions): Promise<ProxyServer> {
  const policy = opts.policy;
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;
  const connectTimeout = opts.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;

  const server = http.createServer();

  server.on("request", async (req, res) => {
    await handleHttpRequest(req, res, policy, connectTimeout);
  });

  server.on("connect", async (req, clientSocket: net.Socket, head) => {
    await handleConnect(req, clientSocket, head, policy, connectTimeout);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => resolve());
    server.on("error", reject);
  });

  const addr = server.address() as net.AddressInfo;

  return {
    host: addr.address,
    port: addr.port,
    url: `http://${addr.address}:${addr.port}`,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP request handler (plain HTTP proxying)
// ---------------------------------------------------------------------------

async function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  policy: NetworkPolicy,
  connectTimeout: number,
): Promise<void> {
  const urlStr = req.url;
  if (!urlStr) {
    res.writeHead(400);
    res.end("Bad Request: missing URL");
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    res.writeHead(400);
    res.end("Bad Request: invalid URL");
    return;
  }

  const hostname = parsed.hostname;
  const decision = await policy.checkHostname(hostname);

  if (!decision.allowed) {
    res.writeHead(403);
    res.end(`Blocked by network policy: ${decision.reason}`);
    return;
  }

  const targetPort = parseInt(parsed.port, 10) || 80;

  const proxyReq = http.request(
    {
      hostname,
      port: targetPort,
      path: parsed.pathname + parsed.search,
      method: req.method,
      headers: { ...req.headers, host: parsed.host },
      timeout: connectTimeout,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (err) => {
    res.writeHead(502);
    res.end(`Proxy error: ${err.message}`);
  });

  proxyReq.on("timeout", () => {
    proxyReq.destroy();
    res.writeHead(504);
    res.end("Gateway Timeout");
  });

  req.pipe(proxyReq);
}

// ---------------------------------------------------------------------------
// CONNECT handler (HTTPS tunneling)
// ---------------------------------------------------------------------------

async function handleConnect(
  req: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
  policy: NetworkPolicy,
  connectTimeout: number,
): Promise<void> {
  const target = req.url;
  if (!target) {
    clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }

  const [hostname, portStr] = target.split(":");
  if (!hostname) {
    clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const port = parseInt(portStr ?? "443", 10);

  const decision = await policy.checkHostname(hostname);

  if (!decision.allowed) {
    clientSocket.end(
      `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nBlocked by network policy: ${decision.reason}`,
    );
    return;
  }

  const serverSocket = net.connect(
    { host: hostname, port, timeout: connectTimeout },
    () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    },
  );

  serverSocket.on("error", (err) => {
    clientSocket.end(
      `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\nProxy connect error: ${err.message}`,
    );
  });

  serverSocket.on("timeout", () => {
    serverSocket.destroy();
    clientSocket.end("HTTP/1.1 504 Gateway Timeout\r\n\r\n");
  });

  clientSocket.on("error", () => {
    serverSocket.destroy();
  });
}
