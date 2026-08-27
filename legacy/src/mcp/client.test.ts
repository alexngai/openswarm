import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import * as url from "node:url";
import { McpStdioClient, type McpServerConfig } from "./client.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(
  __dirname,
  "../../test/fixtures/mcp-mock-server/index.mjs",
);

function makeClient(overrides: Partial<McpServerConfig> = {}): McpStdioClient {
  return new McpStdioClient({
    name: "mock-mcp",
    command: process.execPath,
    args: [FIXTURE_PATH],
    ...overrides,
  });
}

describe("McpStdioClient", () => {
  const clients: McpStdioClient[] = [];

  afterEach(async () => {
    while (clients.length > 0) {
      const c = clients.pop();
      if (c) {
        try {
          await c.close();
        } catch {
          // ignore
        }
      }
    }
  });

  it("starts disconnected, flips to connected after connect()", async () => {
    const client = makeClient();
    clients.push(client);

    expect(client.isConnected).toBe(false);
    expect(client.serverName).toBe("mock-mcp");

    await client.connect();
    expect(client.isConnected).toBe(true);
  });

  it("listTools() returns the mock server's declared tools", async () => {
    const client = makeClient();
    clients.push(client);
    await client.connect();

    const tools = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain("get_time");
    expect(names).toContain("echo");
    expect(names).toContain("boom");
  });

  it("callTool(get_time) returns an ISO timestamp", async () => {
    const client = makeClient();
    clients.push(client);
    await client.connect();

    const result = (await client.callTool("get_time", {})) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(Array.isArray(result.content)).toBe(true);
    const text = result.content[0]?.text ?? "";
    // ISO 8601 regex (lightweight).
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("callTool(echo) round-trips its input", async () => {
    const client = makeClient();
    clients.push(client);
    await client.connect();

    const result = (await client.callTool("echo", { message: "hello" })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0]?.text).toBe("hello");
  });

  it("callTool on tool that reports error sets isError=true", async () => {
    const client = makeClient();
    clients.push(client);
    await client.connect();

    const result = (await client.callTool("boom", {})) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it("connect() times out cleanly for an unresponsive command", async () => {
    // `sleep 60` will not complete the MCP handshake — we should bail via the
    // connect-timeout path. Lower the wait by monkey-patching nothing and just
    // waiting on reject; the internal timeout is 10s.
    const client = new McpStdioClient({
      name: "hang",
      command: "sleep",
      args: ["60"],
    });

    // We don't want the test to wait 10 full seconds in the happy CI path —
    // but connect() has a fixed 10s internal budget. Accept anything up to 12s
    // as "timed out". This only fires when the SDK cannot handshake.
    const start = Date.now();
    await expect(client.connect()).rejects.toThrow(/connect timed out/);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(9_500);
    expect(elapsed).toBeLessThan(15_000);
    expect(client.isConnected).toBe(false);

    // cleanup — subprocess should already be killed by connect()'s catch
    await client.close();
  }, 20_000);

  it("close() resets isConnected and is idempotent", async () => {
    const client = makeClient();
    clients.push(client);
    await client.connect();
    expect(client.isConnected).toBe(true);

    await client.close();
    expect(client.isConnected).toBe(false);

    // Second close is a no-op.
    await client.close();
    expect(client.isConnected).toBe(false);
  });

  it("throws when listTools is called before connect()", async () => {
    const client = makeClient();
    await expect(client.listTools()).rejects.toThrow(/not connected/);
  });
});
