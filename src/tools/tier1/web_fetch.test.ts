import { describe, it, expect, vi, afterEach } from "vitest";
import { webFetchTool } from "./web_fetch.js";
import type { ToolExecutionContext } from "../types.js";

function ctx(): ToolExecutionContext {
  return { cwd: "/tmp" };
}

function mockFetch(
  status: number,
  statusText: string,
  contentType: string,
  body: string | Uint8Array,
) {
  const bodyBytes =
    typeof body === "string" ? new TextEncoder().encode(body) : body;
  const arrayBuffer = bodyBytes.buffer;
  const headers = new Headers({ "content-type": contentType });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText,
      headers,
      arrayBuffer: () => Promise.resolve(arrayBuffer),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("webFetchTool", () => {
  it("fetches HTML and converts to Markdown", async () => {
    mockFetch(200, "OK", "text/html; charset=utf-8", "<h1>Hello</h1><p>World</p>");
    const result = await webFetchTool.execute({ url: "https://example.com" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("Hello");
      // Turndown converts <h1> to # heading
      expect(result.output).toMatch(/^#\s+Hello/m);
    }
  });

  it("returns plain text as-is", async () => {
    const body = "hello world\nline two";
    mockFetch(200, "OK", "text/plain", body);
    const result = await webFetchTool.execute({ url: "https://example.com/text" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("hello world");
      expect(result.output).toContain("line two");
    }
  });

  it("returns error on non-2xx status", async () => {
    mockFetch(404, "Not Found", "text/html", "<h1>Not Found</h1>");
    const result = await webFetchTool.execute({ url: "https://example.com/missing" }, ctx());
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("404");
      expect(result.message).toContain("Not Found");
    }
  });

  it("rejects binary content (image/png)", async () => {
    const bin = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    mockFetch(200, "OK", "image/png", bin);
    const result = await webFetchTool.execute({ url: "https://example.com/img.png" }, ctx());
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("binary content");
      expect(result.message).toContain("image/png");
    }
  });

  it("truncates response at maxBytes and appends truncation notice", async () => {
    const body = "A".repeat(1000);
    mockFetch(200, "OK", "text/plain", body);
    const result = await webFetchTool.execute(
      { url: "https://example.com/big", maxBytes: 100 },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("[truncated at 100 bytes]");
      // Should only have 100 'A' chars before the truncation notice
      expect(result.output.startsWith("A".repeat(100))).toBe(true);
    }
  });

  it("returns JSON content as-is", async () => {
    const body = '{"key":"value"}';
    mockFetch(200, "OK", "application/json", body);
    const result = await webFetchTool.execute({ url: "https://example.com/data.json" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain('"key":"value"');
    }
  });

  it("returns error on network/fetch failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );
    const result = await webFetchTool.execute({ url: "https://example.com" }, ctx());
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("fetch failed");
      expect(result.message).toContain("network error");
    }
  });

  it("returns error for invalid URL schema input", async () => {
    const result = await webFetchTool.execute({ url: "not-a-url" }, ctx());
    expect(result.status).toBe("error");
  });
});
