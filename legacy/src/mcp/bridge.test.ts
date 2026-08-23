import { describe, it, expect } from "vitest";
import { buildMcpToolImpl, isReadOnlyMcpTool } from "./bridge.js";
import type { McpStdioClient, McpToolDescriptor } from "./client.js";

// ---------------------------------------------------------------------------
// Fake client — no subprocess, no SDK.
// ---------------------------------------------------------------------------

interface FakeCall {
  name: string;
  args: unknown;
}

function makeFakeClient(opts: {
  serverName?: string;
  onCall?: (name: string, args: unknown) => unknown;
} = {}): McpStdioClient & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fake = {
    serverName: opts.serverName ?? "mock-mcp",
    isConnected: true,
    calls,
    async connect() {},
    async listTools() {
      return [];
    },
    async listResources() {
      return [];
    },
    async readResource() {
      return {};
    },
    async callTool(name: string, args: unknown) {
      calls.push({ name, args });
      if (opts.onCall) return opts.onCall(name, args);
      return { content: [{ type: "text", text: "ok" }] };
    },
    async close() {},
  };
  return fake as unknown as McpStdioClient & { calls: FakeCall[] };
}

function desc(name: string, extra: Partial<McpToolDescriptor> = {}): McpToolDescriptor {
  return {
    name,
    description: extra.description ?? `${name} tool`,
    inputSchema: extra.inputSchema ?? { type: "object" },
  };
}

// ---------------------------------------------------------------------------
// isReadOnlyMcpTool
// ---------------------------------------------------------------------------

describe("isReadOnlyMcpTool", () => {
  it("matches list_*, get_*, read_*, search_* prefixes", () => {
    expect(isReadOnlyMcpTool("list_files")).toBe(true);
    expect(isReadOnlyMcpTool("get_user")).toBe(true);
    expect(isReadOnlyMcpTool("read_file")).toBe(true);
    expect(isReadOnlyMcpTool("search_codebase")).toBe(true);
  });

  it("matches camelCase listFoo, getFoo, readFoo, searchFoo", () => {
    expect(isReadOnlyMcpTool("listFiles")).toBe(true);
    expect(isReadOnlyMcpTool("getUser")).toBe(true);
    expect(isReadOnlyMcpTool("readFile")).toBe(true);
    expect(isReadOnlyMcpTool("searchCodebase")).toBe(true);
  });

  it("matches 'describe', 'discover', 'inspect' substrings", () => {
    expect(isReadOnlyMcpTool("describe_table")).toBe(true);
    expect(isReadOnlyMcpTool("discover_endpoints")).toBe(true);
    expect(isReadOnlyMcpTool("inspect_object")).toBe(true);
    expect(isReadOnlyMcpTool("tableDescribe")).toBe(true);
  });

  it("rejects mutating verbs", () => {
    expect(isReadOnlyMcpTool("write_file")).toBe(false);
    expect(isReadOnlyMcpTool("delete_resource")).toBe(false);
    expect(isReadOnlyMcpTool("create_user")).toBe(false);
    expect(isReadOnlyMcpTool("update_record")).toBe(false);
    expect(isReadOnlyMcpTool("exec")).toBe(false);
    expect(isReadOnlyMcpTool("runCommand")).toBe(false);
  });

  it("rejects names that merely contain 'get' but don't start with it", () => {
    expect(isReadOnlyMcpTool("forget_cache")).toBe(false);
    expect(isReadOnlyMcpTool("target_kill")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildMcpToolImpl
// ---------------------------------------------------------------------------

describe("buildMcpToolImpl", () => {
  it("sets the prefixed tool name `mcp__<server>__<tool>`", () => {
    const client = makeFakeClient({ serverName: "files" });
    const impl = buildMcpToolImpl(client, desc("list_dir"));
    expect(impl.spec.name).toBe("mcp__files__list_dir");
  });

  it("sets tier=4 and inherits description + inputSchema", () => {
    const client = makeFakeClient();
    const impl = buildMcpToolImpl(
      client,
      desc("echo", {
        description: "echo tool",
        inputSchema: { type: "object", properties: { message: { type: "string" } } },
      }),
    );
    expect(impl.spec.tier).toBe(4);
    expect(impl.spec.description).toBe("echo tool");
    expect(impl.spec.inputSchema).toEqual({
      type: "object",
      properties: { message: { type: "string" } },
    });
  });

  it("requiredPermission=none for read-only names, write for others", () => {
    const client = makeFakeClient();
    const readImpl = buildMcpToolImpl(client, desc("get_time"));
    expect(readImpl.spec.requiredPermission).toBe("none");
    const writeImpl = buildMcpToolImpl(client, desc("delete_file"));
    expect(writeImpl.spec.requiredPermission).toBe("write");
  });

  it("execute() forwards to client.callTool with the un-prefixed name", async () => {
    const client = makeFakeClient();
    const impl = buildMcpToolImpl(client, desc("echo"));
    const result = await impl.execute({ message: "hi" }, { cwd: "/" });
    expect(client.calls).toEqual([{ name: "echo", args: { message: "hi" } }]);
    expect(result).toEqual({ status: "ok", output: "ok" });
  });

  it("execute() maps CallToolResult content array to a text payload", async () => {
    const client = makeFakeClient({
      onCall: () => ({
        content: [
          { type: "text", text: "line1" },
          { type: "text", text: "line2" },
        ],
      }),
    });
    const impl = buildMcpToolImpl(client, desc("get_log"));
    const result = await impl.execute({}, { cwd: "/" });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toBe("line1\nline2");
    }
  });

  it("execute() maps isError=true to status=error", async () => {
    const client = makeFakeClient({
      onCall: () => ({
        content: [{ type: "text", text: "bad input" }],
        isError: true,
      }),
    });
    const impl = buildMcpToolImpl(client, desc("get_thing"));
    const result = await impl.execute({}, { cwd: "/" });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("bad input");
    }
  });

  it("execute() wraps thrown errors into status=error (never throws)", async () => {
    const client = makeFakeClient({
      onCall: () => {
        throw new Error("transport lost");
      },
    });
    const impl = buildMcpToolImpl(client, desc("list_files"));
    const result = await impl.execute({}, { cwd: "/" });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBe("transport lost");
    }
  });
});
