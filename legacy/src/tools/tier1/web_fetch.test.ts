import { describe, it, expect, vi, afterEach } from "vitest";
import { webFetchTool, upgradeToHttps, extractTitle, findInContent } from "./web_fetch.js";
import type { ToolExecutionContext } from "../types.js";
import {
  NetworkPolicy,
  setNetworkPolicy,
  resetNetworkPolicy,
} from "../tier0/network-policy.js";

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
  resetNetworkPolicy();
});

// ---------------------------------------------------------------------------
// Core fetch behavior (existing tests)
// ---------------------------------------------------------------------------

describe("webFetchTool", () => {
  it("fetches HTML and converts to Markdown", async () => {
    mockFetch(200, "OK", "text/html; charset=utf-8", "<h1>Hello</h1><p>World</p>");
    const result = await webFetchTool.execute({ url: "https://example.com" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("Hello");
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

// ---------------------------------------------------------------------------
// HTTP → HTTPS auto-upgrade
// ---------------------------------------------------------------------------

describe("upgradeToHttps", () => {
  it("upgrades http to https for non-localhost", () => {
    const url = new URL("http://example.com/page");
    const result = upgradeToHttps(url);
    expect(result.protocol).toBe("https:");
    expect(result.hostname).toBe("example.com");
    expect(result.pathname).toBe("/page");
  });

  it("preserves https URLs", () => {
    const url = new URL("https://example.com/page");
    const result = upgradeToHttps(url);
    expect(result.protocol).toBe("https:");
  });

  it("does not upgrade localhost", () => {
    const url = new URL("http://localhost:3000/api");
    const result = upgradeToHttps(url);
    expect(result.protocol).toBe("http:");
  });

  it("does not upgrade 127.0.0.1", () => {
    const url = new URL("http://127.0.0.1:8080/api");
    const result = upgradeToHttps(url);
    expect(result.protocol).toBe("http:");
  });

  it("does not upgrade ::1", () => {
    const url = new URL("http://[::1]:8080/api");
    const result = upgradeToHttps(url);
    expect(result.protocol).toBe("http:");
  });

  it("preserves query parameters and fragments", () => {
    const url = new URL("http://example.com/path?q=test#section");
    const result = upgradeToHttps(url);
    expect(result.href).toBe("https://example.com/path?q=test#section");
  });
});

describe("webFetchTool HTTP upgrade integration", () => {
  it("upgrades http URL to https before fetching", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/plain" }),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode("ok").buffer),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await webFetchTool.execute({ url: "http://example.com/page" }, ctx());

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://example.com/page",
      expect.anything(),
    );
  });

  it("does not upgrade localhost http URLs", async () => {
    setNetworkPolicy(
      new NetworkPolicy({
        mode: "full",
        allow: ["*"],
        deny: [],
        blockPrivateAddresses: false,
      }),
    );
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/plain" }),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode("ok").buffer),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await webFetchTool.execute({ url: "http://localhost:3000/api" }, ctx());

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3000/api",
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// Title extraction
// ---------------------------------------------------------------------------

describe("extractTitle", () => {
  it("extracts title from HTML", () => {
    expect(extractTitle("<html><head><title>My Page</title></head></html>")).toBe(
      "My Page",
    );
  });

  it("decodes HTML entities", () => {
    expect(extractTitle("<title>A &amp; B &lt;C&gt;</title>")).toBe("A & B <C>");
  });

  it("returns null when no title tag", () => {
    expect(extractTitle("<html><body>No title here</body></html>")).toBeNull();
  });

  it("trims whitespace", () => {
    expect(extractTitle("<title>  Spaced  </title>")).toBe("Spaced");
  });

  it("handles multiline title", () => {
    expect(extractTitle("<title>\n  Line One\n  Line Two\n</title>")).toBe(
      "Line One\n  Line Two",
    );
  });
});

// ---------------------------------------------------------------------------
// Prompt-driven extraction
// ---------------------------------------------------------------------------

describe("webFetchTool prompt-driven extraction", () => {
  it('extracts only title when prompt is "title"', async () => {
    mockFetch(
      200,
      "OK",
      "text/html",
      "<html><head><title>My Page Title</title></head><body><p>Lots of content</p></body></html>",
    );
    const result = await webFetchTool.execute(
      { url: "https://example.com", prompt: "title" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toBe("Title: My Page Title");
      expect(result.output).not.toContain("Lots of content");
    }
  });

  it("returns message when no title found", async () => {
    mockFetch(200, "OK", "text/html", "<html><body>No head</body></html>");
    const result = await webFetchTool.execute(
      { url: "https://example.com", prompt: "title" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toBe("No <title> tag found");
    }
  });

  it('returns summary when prompt is "summary"', async () => {
    const longContent = "<p>" + "Word ".repeat(500) + "</p>";
    mockFetch(
      200,
      "OK",
      "text/html",
      `<html><head><title>Test</title></head><body>${longContent}</body></html>`,
    );
    const result = await webFetchTool.execute(
      { url: "https://example.com", prompt: "summary" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("Title: Test");
      expect(result.output).toContain("...");
      expect(result.output.length).toBeLessThan(1200);
    }
  });

  it('returns summary when prompt is "summarize"', async () => {
    mockFetch(
      200,
      "OK",
      "text/html",
      "<html><head><title>Page</title></head><body><p>Short content</p></body></html>",
    );
    const result = await webFetchTool.execute(
      { url: "https://example.com", prompt: "summarize" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("Title: Page");
      expect(result.output).toContain("Short content");
    }
  });

  it("is case-insensitive for prompt matching", async () => {
    mockFetch(
      200,
      "OK",
      "text/html",
      "<html><head><title>Test</title></head><body></body></html>",
    );
    const result = await webFetchTool.execute(
      { url: "https://example.com", prompt: "TITLE" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toBe("Title: Test");
    }
  });

  it("includes prompt context for other prompt values", async () => {
    mockFetch(
      200,
      "OK",
      "text/html",
      "<html><body><p>Page content here</p></body></html>",
    );
    const result = await webFetchTool.execute(
      { url: "https://example.com", prompt: "find the API docs" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("Prompt: find the API docs");
      expect(result.output).toContain("Content:");
      expect(result.output).toContain("Page content here");
    }
  });
});

// ---------------------------------------------------------------------------
// Find in page
// ---------------------------------------------------------------------------

describe("findInContent", () => {
  const testContent = [
    "Line 1: Introduction",
    "Line 2: Background",
    "Line 3: The API endpoint is /api/v1/users",
    "Line 4: Authentication required",
    "Line 5: Rate limiting",
    "Line 6: Response format",
    "Line 7: Another mention of API here",
    "Line 8: Conclusion",
    "Line 9: References",
    "Line 10: End",
  ].join("\n");

  it("finds matching lines with context", () => {
    const result = findInContent(testContent, "API");
    expect(result).toContain("Found 2 matches for: API");
    expect(result).toContain(">>> 3:");
    expect(result).toContain(">>> 7:");
  });

  it("is case insensitive", () => {
    const result = findInContent(testContent, "api");
    expect(result).toContain("Found 2 matches");
  });

  it("returns no-matches message when not found", () => {
    const result = findInContent(testContent, "nonexistent");
    expect(result).toContain("No matches found for: nonexistent");
  });

  it("marks matching lines with >>> and context with spaces", () => {
    const result = findInContent(testContent, "Rate limiting");
    expect(result).toContain(">>> 5:");
    expect(result).toContain("   ");
  });

  it("shows separator between non-adjacent matches", () => {
    const result = findInContent(
      "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nMATCH1\nline10\nline11\nline12\nline13\nline14\nline15\nline16\nMATCH2",
      "MATCH",
    );
    expect(result).toContain("---");
  });
});

describe("webFetchTool find integration", () => {
  it("searches within HTML page content", async () => {
    mockFetch(
      200,
      "OK",
      "text/html",
      "<html><body><p>Line one</p><p>The secret API key is here</p><p>Line three</p></body></html>",
    );
    const result = await webFetchTool.execute(
      { url: "https://example.com", find: "API key" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("Found 1 match");
      expect(result.output).toContain("API key");
    }
  });

  it("searches within plain text content", async () => {
    mockFetch(200, "OK", "text/plain", "alpha\nbeta\ngamma\ndelta");
    const result = await webFetchTool.execute(
      { url: "https://example.com/text", find: "gamma" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("Found 1 match");
      expect(result.output).toContain("gamma");
    }
  });

  it("find takes precedence over prompt for HTML", async () => {
    mockFetch(
      200,
      "OK",
      "text/html",
      "<html><head><title>Test</title></head><body><p>Find me here</p></body></html>",
    );
    const result = await webFetchTool.execute(
      { url: "https://example.com", prompt: "summary", find: "Find me" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("Found 1 match");
      expect(result.output).not.toContain("Title:");
    }
  });
});

// ---------------------------------------------------------------------------
// Tool spec
// ---------------------------------------------------------------------------

describe("webFetchTool spec", () => {
  it("has correct name and tier", () => {
    expect(webFetchTool.spec.name).toBe("web_fetch");
    expect(webFetchTool.spec.tier).toBe(1);
    expect(webFetchTool.spec.requiredPermission).toBe("network");
  });

  it("has prompt and find fields in schema", () => {
    const schema = webFetchTool.spec.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("url");
    expect(props).toHaveProperty("prompt");
    expect(props).toHaveProperty("find");
    expect(props).toHaveProperty("maxBytes");
  });
});
