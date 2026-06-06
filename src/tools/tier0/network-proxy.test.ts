import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { NetworkPolicy } from "./network-policy.js";
import { startProxy, type ProxyServer } from "./network-proxy.js";

let proxy: ProxyServer | undefined;
let targetServer: http.Server | undefined;

afterEach(async () => {
  if (proxy) {
    await proxy.close();
    proxy = undefined;
  }
  if (targetServer) {
    await new Promise<void>((resolve) => {
      targetServer!.close(() => resolve());
    });
    targetServer = undefined;
  }
});

function startTarget(handler: http.RequestListener): Promise<{ port: number }> {
  return new Promise((resolve) => {
    targetServer = http.createServer(handler);
    targetServer.listen(0, "127.0.0.1", () => {
      const addr = targetServer!.address() as { port: number };
      resolve({ port: addr.port });
    });
  });
}

function proxyFetch(
  proxyUrl: string,
  targetUrl: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(proxyUrl);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parseInt(parsed.port),
        path: targetUrl,
        method: "GET",
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("startProxy", () => {
  it("starts and reports address", async () => {
    const policy = NetworkPolicy.fullAccess();
    proxy = await startProxy({ policy });
    expect(proxy.port).toBeGreaterThan(0);
    expect(proxy.host).toBe("127.0.0.1");
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe("HTTP proxying", () => {
  it("forwards allowed requests", async () => {
    const { port: targetPort } = await startTarget((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hello from target");
    });

    const policy = new NetworkPolicy({
      mode: "full",
      allow: ["*"],
      deny: [],
      blockPrivateAddresses: false,
    });
    proxy = await startProxy({ policy });

    const result = await proxyFetch(
      proxy.url,
      `http://127.0.0.1:${targetPort}/test`,
    );
    expect(result.status).toBe(200);
    expect(result.body).toBe("hello from target");
  });

  it("blocks denied domains", async () => {
    const policy = new NetworkPolicy({
      mode: "full",
      allow: ["*"],
      deny: ["evil.example.com"],
      blockPrivateAddresses: false,
    });
    proxy = await startProxy({ policy });

    const result = await proxyFetch(
      proxy.url,
      "http://evil.example.com/hack",
    );
    expect(result.status).toBe(403);
    expect(result.body).toContain("Blocked by network policy");
  });

  it("blocks when no allow rules match", async () => {
    const policy = new NetworkPolicy({
      mode: "full",
      allow: ["only-this.com"],
      deny: [],
      blockPrivateAddresses: false,
    });
    proxy = await startProxy({ policy });

    const result = await proxyFetch(
      proxy.url,
      "http://other.com/test",
    );
    expect(result.status).toBe(403);
    expect(result.body).toContain("not matched");
  });

  it("blocks everything when mode is none", async () => {
    const policy = NetworkPolicy.noAccess();
    proxy = await startProxy({ policy });

    const result = await proxyFetch(
      proxy.url,
      "http://example.com/test",
    );
    expect(result.status).toBe(403);
    expect(result.body).toContain("network access disabled");
  });

  it("blocks private addresses with SSRF protection", async () => {
    const policy = NetworkPolicy.fullAccess();
    proxy = await startProxy({ policy });

    const result = await proxyFetch(
      proxy.url,
      "http://127.0.0.1:9999/internal",
    );
    expect(result.status).toBe(403);
    expect(result.body).toContain("private");
  });

  it("returns 400 for missing URL", async () => {
    const policy = NetworkPolicy.fullAccess();
    proxy = await startProxy({ policy });

    const result = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const parsed = new URL(proxy!.url);
        const req = http.request(
          {
            hostname: parsed.hostname,
            port: parseInt(parsed.port),
            method: "GET",
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              });
            });
          },
        );
        // Send request with no path (which sends undefined url)
        req.end();
      },
    );
    // Node sets a default path of "/" so this tests the URL parsing path
    expect(result.status).toBe(400);
  });
});

describe("CONNECT tunneling", () => {
  it("blocks denied CONNECT targets", async () => {
    const policy = new NetworkPolicy({
      mode: "full",
      allow: ["*"],
      deny: ["evil.com"],
      blockPrivateAddresses: false,
    });
    proxy = await startProxy({ policy });

    const status = await new Promise<number>((resolve) => {
      const parsed = new URL(proxy!.url);
      const req = http.request({
        hostname: parsed.hostname,
        port: parseInt(parsed.port),
        method: "CONNECT",
        path: "evil.com:443",
      });

      req.on("connect", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 0);
      });

      req.end();
    });
    expect(status).toBe(403);
  });

  it("blocks CONNECT to private IPs", async () => {
    const policy = NetworkPolicy.fullAccess();
    proxy = await startProxy({ policy });

    const status = await new Promise<number>((resolve) => {
      const parsed = new URL(proxy!.url);
      const req = http.request({
        hostname: parsed.hostname,
        port: parseInt(parsed.port),
        method: "CONNECT",
        path: "10.0.0.1:443",
      });

      req.on("connect", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 0);
      });

      req.end();
    });
    expect(status).toBe(403);
  });
});
