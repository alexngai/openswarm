/**
 * Tests for OpenTasksClient + findOpenTasksSocket (Phase 4.2 — previously only
 * exercised via mocks). Uses a real in-process Unix-socket JSON-RPC server so
 * the wire framing + never-throw semantics are covered end to end.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { OpenTasksClient, findOpenTasksSocket } from "./opentasks-client.js";

interface RpcReply {
  result?: unknown;
  error?: { code: number; message: string };
}

interface TestServer {
  sockPath: string;
  close: () => Promise<void>;
}

const servers: TestServer[] = [];

async function startServer(
  handler: (method: string, params: unknown) => RpcReply | "silent",
): Promise<TestServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opentasks-client-"));
  const sockPath = path.join(dir, "daemon.sock");
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl)) as { id: string; method: string; params: unknown };
      const reply = handler(req.method, req.params);
      if (reply === "silent") return; // simulate a hung daemon
      socket.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, ...reply }) + "\n");
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(sockPath, resolve));
  const ts: TestServer = {
    sockPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
  servers.push(ts);
  return ts;
}

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!.close().catch(() => {});
  }
});

describe("OpenTasksClient — happy paths", () => {
  it("ping resolves true on { pong: true }", async () => {
    const s = await startServer((m) => (m === "ping" ? { result: { pong: true } } : { result: null }));
    const client = new OpenTasksClient(s.sockPath, 500);
    expect(await client.ping()).toBe(true);
  });

  it("ping resolves false when pong is not true", async () => {
    const s = await startServer(() => ({ result: {} }));
    const client = new OpenTasksClient(s.sockPath, 500);
    expect(await client.ping()).toBe(false);
  });

  it("create returns the created node", async () => {
    const s = await startServer((m, p) => {
      expect(m).toBe("graph.create");
      const params = p as { title: string };
      return { result: { id: "n1", type: "task", title: params.title } };
    });
    const client = new OpenTasksClient(s.sockPath, 500);
    const node = await client.create({ type: "task", title: "do it" });
    expect(node).toMatchObject({ id: "n1", title: "do it" });
  });

  it("update passes id + patch and returns the node", async () => {
    const s = await startServer((m, p) => {
      expect(m).toBe("graph.update");
      expect(p).toMatchObject({ id: "n1", status: "done" });
      return { result: { id: "n1", type: "task", title: "x", status: "done" } };
    });
    const client = new OpenTasksClient(s.sockPath, 500);
    const node = await client.update("n1", { status: "done" });
    expect(node?.status).toBe("done");
  });

  it("query returns an array of nodes", async () => {
    const s = await startServer(() => ({ result: [{ id: "a", type: "task", title: "t" }] }));
    const client = new OpenTasksClient(s.sockPath, 500);
    const nodes = await client.query({ type: "tasks" });
    expect(nodes).toHaveLength(1);
  });

  it("link returns { ok: true }", async () => {
    const s = await startServer(() => ({ result: { ok: true } }));
    const client = new OpenTasksClient(s.sockPath, 500);
    expect(await client.link({ fromId: "a", toId: "b", type: "blocks" })).toEqual({ ok: true });
  });
});

describe("OpenTasksClient — never-throw failure modes", () => {
  it("returns null on an RPC error response", async () => {
    const s = await startServer(() => ({ error: { code: -32000, message: "boom" } }));
    const client = new OpenTasksClient(s.sockPath, 500);
    expect(await client.get("n1")).toBeNull();
  });

  it("returns null on timeout (daemon never replies)", async () => {
    const s = await startServer(() => "silent");
    const client = new OpenTasksClient(s.sockPath, 60);
    expect(await client.ping()).toBe(false); // ping folds null → false
    expect(await client.get("n1")).toBeNull();
  });

  it("returns null on transport error (no such socket)", async () => {
    const client = new OpenTasksClient(
      path.join(os.tmpdir(), "does-not-exist-" + Date.now(), "daemon.sock"),
      100,
    );
    expect(await client.get("n1")).toBeNull();
  });

  it("returns null on a malformed (non-JSON) reply", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opentasks-bad-"));
    const sockPath = path.join(dir, "daemon.sock");
    const server = net.createServer((socket) => {
      socket.on("data", () => socket.write("not json\n"));
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    servers.push({ sockPath, close: () => new Promise((r) => server.close(() => r())) });
    const client = new OpenTasksClient(sockPath, 500);
    expect(await client.get("n1")).toBeNull();
  });
});

describe("findOpenTasksSocket", () => {
  it("discovers a .opentasks/daemon.sock walking up from cwd", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ot-discover-"));
    const sockDir = path.join(root, ".opentasks");
    fs.mkdirSync(sockDir, { recursive: true });
    fs.writeFileSync(path.join(sockDir, "daemon.sock"), "");
    const nested = path.join(root, "a", "b");
    fs.mkdirSync(nested, { recursive: true });
    expect(findOpenTasksSocket(nested)).toBe(path.join(sockDir, "daemon.sock"));
  });

  it("returns null when no socket exists in any ancestor", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ot-none-"));
    expect(findOpenTasksSocket(root)).toBeNull();
  });

  it("prefers .openswarm/opentasks over legacy .swarm/opentasks", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ot-pref-"));
    const legacy = path.join(root, ".swarm", "opentasks");
    const migrated = path.join(root, ".openswarm", "opentasks");
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(migrated, { recursive: true });
    fs.writeFileSync(path.join(legacy, "daemon.sock"), "");
    fs.writeFileSync(path.join(migrated, "daemon.sock"), "");
    expect(findOpenTasksSocket(root)).toBe(path.join(migrated, "daemon.sock"));
  });

  it("falls back to legacy .swarm/opentasks when .openswarm is absent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ot-legacy-"));
    const legacy = path.join(root, ".swarm", "opentasks");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "daemon.sock"), "");
    expect(findOpenTasksSocket(root)).toBe(path.join(legacy, "daemon.sock"));
  });
});
