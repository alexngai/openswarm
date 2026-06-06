import { describe, it, expect, afterEach, vi } from "vitest";
import {
  webSearchTool,
  DuckDuckGoBackend,
  hostMatchesList,
  setSearchBackend,
  resetSearchBackend,
  type SearchBackend,
  type SearchHit,
  type SearchOptions,
} from "./web_search.js";
import type { ToolExecutionContext } from "../types.js";
import {
  NetworkPolicy,
  setNetworkPolicy,
  resetNetworkPolicy,
} from "../tier0/network-policy.js";

afterEach(() => {
  resetSearchBackend();
  resetNetworkPolicy();
});

function ctx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return { cwd: "/tmp", ...overrides };
}

// ---------------------------------------------------------------------------
// Mock backend
// ---------------------------------------------------------------------------

function mockBackend(hits: SearchHit[]): SearchBackend {
  return {
    name: "mock",
    search: async (_query: string, options: SearchOptions) => {
      return hits.slice(0, options.maxResults);
    },
  };
}

function errorBackend(msg: string): SearchBackend {
  return {
    name: "error",
    search: async () => {
      throw new Error(msg);
    },
  };
}

const SAMPLE_HITS: SearchHit[] = [
  {
    title: "TypeScript Handbook",
    url: "https://www.typescriptlang.org/docs/handbook/intro.html",
    snippet: "The TypeScript Handbook is a comprehensive guide to TypeScript.",
  },
  {
    title: "TypeScript GitHub",
    url: "https://github.com/microsoft/TypeScript",
    snippet: "TypeScript is a typed superset of JavaScript.",
  },
  {
    title: "MDN TypeScript",
    url: "https://developer.mozilla.org/en-US/docs/Glossary/TypeScript",
    snippet: "TypeScript is a programming language developed by Microsoft.",
  },
];

// ---------------------------------------------------------------------------
// hostMatchesList
// ---------------------------------------------------------------------------

describe("hostMatchesList", () => {
  it("matches exact domain", () => {
    expect(hostMatchesList("example.com", ["example.com"])).toBe(true);
  });

  it("matches subdomain", () => {
    expect(hostMatchesList("sub.example.com", ["example.com"])).toBe(true);
  });

  it("matches deep subdomain", () => {
    expect(hostMatchesList("a.b.example.com", ["example.com"])).toBe(true);
  });

  it("does not match unrelated domain", () => {
    expect(hostMatchesList("other.com", ["example.com"])).toBe(false);
  });

  it("does not match partial suffix", () => {
    expect(hostMatchesList("notexample.com", ["example.com"])).toBe(false);
  });

  it("is case insensitive", () => {
    expect(hostMatchesList("Sub.Example.COM", ["example.com"])).toBe(true);
  });

  it("matches against multiple patterns", () => {
    expect(
      hostMatchesList("github.com", ["example.com", "github.com"]),
    ).toBe(true);
  });

  it("returns false for empty list", () => {
    expect(hostMatchesList("example.com", [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tool execute — with mock backend
// ---------------------------------------------------------------------------

describe("webSearchTool.execute", () => {
  it("returns formatted results from backend", async () => {
    setSearchBackend(mockBackend(SAMPLE_HITS));
    const result = await webSearchTool.execute(
      { query: "typescript" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("Search results for: typescript");
      expect(result.output).toContain("TypeScript Handbook");
      expect(result.output).toContain(
        "https://www.typescriptlang.org/docs/handbook/intro.html",
      );
      expect(result.output).toContain("TypeScript GitHub");
      expect(result.output).toContain("MDN TypeScript");
    }
  });

  it("respects num_results", async () => {
    setSearchBackend(mockBackend(SAMPLE_HITS));
    const result = await webSearchTool.execute(
      { query: "typescript", num_results: 1 },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("TypeScript Handbook");
      expect(result.output).not.toContain("TypeScript GitHub");
    }
  });

  it("returns no-results message for empty results", async () => {
    setSearchBackend(mockBackend([]));
    const result = await webSearchTool.execute(
      { query: "xyznonexistent" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("No results found");
    }
  });

  it("returns error for invalid input", async () => {
    setSearchBackend(mockBackend(SAMPLE_HITS));
    const result = await webSearchTool.execute({ query: "" }, ctx());
    expect(result.status).toBe("error");
  });

  it("returns error for missing query", async () => {
    setSearchBackend(mockBackend(SAMPLE_HITS));
    const result = await webSearchTool.execute({ num_results: 5 }, ctx());
    expect(result.status).toBe("error");
  });

  it("returns error when backend throws", async () => {
    setSearchBackend(errorBackend("connection refused"));
    const result = await webSearchTool.execute(
      { query: "test" },
      ctx(),
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("search failed");
      expect(result.message).toContain("connection refused");
    }
  });

  it("passes allowed_domains to backend", async () => {
    const backend: SearchBackend = {
      name: "spy",
      search: async (_query: string, options: SearchOptions) => {
        expect(options.allowedDomains).toEqual(["example.com"]);
        return SAMPLE_HITS;
      },
    };
    setSearchBackend(backend);
    await webSearchTool.execute(
      { query: "test", allowed_domains: ["example.com"] },
      ctx(),
    );
  });

  it("passes blocked_domains to backend", async () => {
    const backend: SearchBackend = {
      name: "spy",
      search: async (_query: string, options: SearchOptions) => {
        expect(options.blockedDomains).toEqual(["spam.com"]);
        return SAMPLE_HITS;
      },
    };
    setSearchBackend(backend);
    await webSearchTool.execute(
      { query: "test", blocked_domains: ["spam.com"] },
      ctx(),
    );
  });
});

// ---------------------------------------------------------------------------
// Network policy integration
// ---------------------------------------------------------------------------

describe("webSearchTool network policy", () => {
  it("blocks search when network policy denies the search host", async () => {
    setSearchBackend(new DuckDuckGoBackend("https://search.example.com/"));
    setNetworkPolicy(
      new NetworkPolicy({
        mode: "full",
        allow: ["*.github.com"],
        deny: [],
        blockPrivateAddresses: false,
      }),
    );

    const result = await webSearchTool.execute(
      { query: "test" },
      ctx(),
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("blocked by network policy");
    }
  });

  it("skips policy check for non-DDG backends", async () => {
    setNetworkPolicy(NetworkPolicy.noAccess());
    setSearchBackend(mockBackend(SAMPLE_HITS));

    const result = await webSearchTool.execute(
      { query: "test" },
      ctx(),
    );
    expect(result.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// DuckDuckGo backend — domain filtering
// ---------------------------------------------------------------------------

describe("DuckDuckGoBackend domain filtering", () => {
  const mockFetch = vi.fn();

  function ddgHtml(results: { href: string; title: string; snippet: string }[]): string {
    return results
      .map(
        (r) =>
          `<a class="result__a" href="${r.href}">${r.title}</a>` +
          `<a class="result__snippet" href="#">${r.snippet}</a>`,
      )
      .join("\n");
  }

  it("filters by allowed_domains", async () => {
    const html = ddgHtml([
      {
        href: "/l/?uddg=https%3A%2F%2Fexample.com%2Fpage",
        title: "Example Page",
        snippet: "An example page",
      },
      {
        href: "/l/?uddg=https%3A%2F%2Fother.com%2Fpage",
        title: "Other Page",
        snippet: "Another page",
      },
    ]);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })) as typeof fetch;

    try {
      const backend = new DuckDuckGoBackend("https://html.duckduckgo.com/html/");
      const hits = await backend.search("test", {
        maxResults: 8,
        allowedDomains: ["example.com"],
      });

      expect(hits).toHaveLength(1);
      expect(hits[0]!.url).toBe("https://example.com/page");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("filters by blocked_domains", async () => {
    const html = ddgHtml([
      {
        href: "/l/?uddg=https%3A%2F%2Fexample.com%2Fpage",
        title: "Example Page",
        snippet: "An example page",
      },
      {
        href: "/l/?uddg=https%3A%2F%2Fspam.com%2Fpage",
        title: "Spam Page",
        snippet: "Spam content",
      },
    ]);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })) as typeof fetch;

    try {
      const backend = new DuckDuckGoBackend("https://html.duckduckgo.com/html/");
      const hits = await backend.search("test", {
        maxResults: 8,
        blockedDomains: ["spam.com"],
      });

      expect(hits).toHaveLength(1);
      expect(hits[0]!.url).toBe("https://example.com/page");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("deduplicates results by URL", async () => {
    const html = ddgHtml([
      {
        href: "/l/?uddg=https%3A%2F%2Fexample.com%2Fpage",
        title: "Page 1",
        snippet: "First hit",
      },
      {
        href: "/l/?uddg=https%3A%2F%2Fexample.com%2Fpage",
        title: "Page 1 Duplicate",
        snippet: "Duplicate hit",
      },
    ]);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })) as typeof fetch;

    try {
      const backend = new DuckDuckGoBackend("https://html.duckduckgo.com/html/");
      const hits = await backend.search("test", { maxResults: 8 });
      expect(hits).toHaveLength(1);
      expect(hits[0]!.title).toBe("Page 1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("caps results at 8", async () => {
    const results = Array.from({ length: 12 }, (_, i) => ({
      href: `/l/?uddg=https%3A%2F%2Fexample.com%2Fpage${i}`,
      title: `Page ${i}`,
      snippet: `Snippet ${i}`,
    }));
    const html = ddgHtml(results);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })) as typeof fetch;

    try {
      const backend = new DuckDuckGoBackend("https://html.duckduckgo.com/html/");
      const hits = await backend.search("test", { maxResults: 10 });
      expect(hits).toHaveLength(8);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("decodes DDG redirect URLs", async () => {
    const html = ddgHtml([
      {
        href: "/l/?uddg=https%3A%2F%2Freal-site.com%2Fpath%3Ffoo%3Dbar&rut=abc123",
        title: "Real Site",
        snippet: "The real destination",
      },
    ]);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })) as typeof fetch;

    try {
      const backend = new DuckDuckGoBackend("https://html.duckduckgo.com/html/");
      const hits = await backend.search("test", { maxResults: 8 });
      expect(hits).toHaveLength(1);
      expect(hits[0]!.url).toBe("https://real-site.com/path?foo=bar");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws on HTTP error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("Service Unavailable", {
        status: 503,
        statusText: "Service Unavailable",
      })) as typeof fetch;

    try {
      const backend = new DuckDuckGoBackend("https://html.duckduckgo.com/html/");
      await expect(
        backend.search("test", { maxResults: 8 }),
      ).rejects.toThrow("HTTP 503");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("skips non-http/https results", async () => {
    const html = ddgHtml([
      {
        href: "/l/?uddg=ftp%3A%2F%2Fexample.com%2Ffile",
        title: "FTP Site",
        snippet: "An FTP link",
      },
      {
        href: "/l/?uddg=https%3A%2F%2Fexample.com%2Fpage",
        title: "HTTPS Site",
        snippet: "A normal page",
      },
    ]);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })) as typeof fetch;

    try {
      const backend = new DuckDuckGoBackend("https://html.duckduckgo.com/html/");
      const hits = await backend.search("test", { maxResults: 8 });
      expect(hits).toHaveLength(1);
      expect(hits[0]!.url).toBe("https://example.com/page");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Batch queries
// ---------------------------------------------------------------------------

describe("webSearchTool batch queries", () => {
  it("executes primary + additional queries and returns combined results", async () => {
    const queryResults: Record<string, SearchHit[]> = {
      typescript: [SAMPLE_HITS[0]!],
      javascript: [
        {
          title: "JavaScript MDN",
          url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript",
          snippet: "JavaScript is a programming language.",
        },
      ],
    };

    const backend: SearchBackend = {
      name: "multi-mock",
      search: async (query: string, options: SearchOptions) => {
        return (queryResults[query] ?? []).slice(0, options.maxResults);
      },
    };
    setSearchBackend(backend);

    const result = await webSearchTool.execute(
      { query: "typescript", queries: ["javascript"] },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("Search results for: typescript");
      expect(result.output).toContain("TypeScript Handbook");
      expect(result.output).toContain("Search results for: javascript");
      expect(result.output).toContain("JavaScript MDN");
      expect(result.output).toContain("---");
    }
  });

  it("deduplicates across batch queries", async () => {
    const sharedHit: SearchHit = {
      title: "Shared Result",
      url: "https://shared.example.com/page",
      snippet: "Appears in both queries",
    };

    const backend: SearchBackend = {
      name: "dedup-mock",
      search: async () => [sharedHit],
    };
    setSearchBackend(backend);

    const result = await webSearchTool.execute(
      { query: "query1", queries: ["query2"] },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("Search results for: query1");
      expect(result.output).toContain("Shared Result");
      expect(result.output).toContain("No results found for: query2");
    }
  });

  it("handles errors in individual queries gracefully", async () => {
    const backend: SearchBackend = {
      name: "partial-error",
      search: async (query: string) => {
        if (query === "bad") throw new Error("search engine down");
        return [SAMPLE_HITS[0]!];
      },
    };
    setSearchBackend(backend);

    const result = await webSearchTool.execute(
      { query: "good", queries: ["bad"] },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("TypeScript Handbook");
      expect(result.output).toContain("Error: search engine down");
    }
  });

  it("works with query only (no queries)", async () => {
    setSearchBackend(mockBackend(SAMPLE_HITS));
    const result = await webSearchTool.execute(
      { query: "typescript" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("Search results for: typescript");
      expect(result.output).not.toContain("---");
    }
  });
});

// ---------------------------------------------------------------------------
// Tool spec
// ---------------------------------------------------------------------------

describe("webSearchTool spec", () => {
  it("has correct name and tier", () => {
    expect(webSearchTool.spec.name).toBe("web_search");
    expect(webSearchTool.spec.tier).toBe(1);
    expect(webSearchTool.spec.requiredPermission).toBe("network");
  });

  it("has inputSchema with query required and queries optional", () => {
    const schema = webSearchTool.spec.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    const required = schema.required as string[];
    expect(props).toHaveProperty("query");
    expect(props).toHaveProperty("queries");
    expect(props).toHaveProperty("num_results");
    expect(props).toHaveProperty("allowed_domains");
    expect(props).toHaveProperty("blocked_domains");
    expect(required).toContain("query");
    expect(required).not.toContain("queries");
    expect(required).not.toContain("num_results");
  });
});
