import { z } from "zod";
import TurndownService from "turndown";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import { ToolAccesses } from "../access.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { getNetworkPolicy } from "../tier0/network-policy.js";

// ---------------------------------------------------------------------------
// Search backend interface
// ---------------------------------------------------------------------------

export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface SearchOptions {
  readonly maxResults: number;
  readonly allowedDomains?: readonly string[];
  readonly blockedDomains?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface SearchBackend {
  readonly name: string;
  search(query: string, options: SearchOptions): Promise<SearchHit[]>;
}

// ---------------------------------------------------------------------------
// DuckDuckGo HTML backend (matches Codex web-search crate)
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://html.duckduckgo.com/html/";
const MAX_HITS = 8;

/**
 * The endpoint a search will actually hit. The access declaration and the
 * backend both read it, so an approval is bound to the host that gets
 * contacted rather than to the compiled-in default.
 */
function defaultSearchEndpoint(): string {
  return process.env.OPENSWARM_WEB_SEARCH_BASE_URL ?? DEFAULT_BASE_URL;
}

function decodeDuckDuckGoRedirect(href: string): string | null {
  if (!href.startsWith("/l/?")) return null;
  try {
    const params = new URLSearchParams(href.slice(3));
    const uddg = params.get("uddg");
    return uddg ?? null;
  } catch {
    return null;
  }
}

export function hostMatchesList(
  hostname: string,
  patterns: readonly string[],
): boolean {
  const h = hostname.toLowerCase();
  for (const pattern of patterns) {
    const p = pattern.toLowerCase();
    if (h === p) return true;
    if (h.endsWith("." + p)) return true;
  }
  return false;
}

function deduplicateByUrl(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const result: SearchHit[] = [];
  for (const hit of hits) {
    if (!seen.has(hit.url)) {
      seen.add(hit.url);
      result.push(hit);
    }
  }
  return result;
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

function extractHitsFromHtml(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const resultPattern =
    /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = resultPattern.exec(html)) !== null) {
    const rawHref = match[1]!;
    const rawTitle = match[2]!;
    const rawSnippet = match[3]!;

    const resolvedUrl = decodeDuckDuckGoRedirect(rawHref) ?? rawHref;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(resolvedUrl);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        continue;
      }
    } catch {
      continue;
    }

    const title = turndown
      .turndown(rawTitle)
      .replace(/\n/g, " ")
      .trim();
    const snippet = turndown
      .turndown(rawSnippet)
      .replace(/\n/g, " ")
      .trim();

    if (title && resolvedUrl) {
      hits.push({ title, url: parsedUrl.href, snippet });
    }
  }

  return hits;
}

export class DuckDuckGoBackend implements SearchBackend {
  readonly name = "duckduckgo";
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? defaultSearchEndpoint();
  }

  async search(query: string, options: SearchOptions): Promise<SearchHit[]> {
    const url = new URL(this.baseUrl);
    url.searchParams.set("q", query);

    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; SwarmHarness/1.0; +https://github.com/anthropics/openswarm)",
        Accept: "text/html",
      },
      signal: options.signal ?? AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      throw new Error(`search request failed: HTTP ${resp.status}`);
    }

    const html = await resp.text();
    let hits = extractHitsFromHtml(html);

    hits = deduplicateByUrl(hits);

    if (options.allowedDomains && options.allowedDomains.length > 0) {
      hits = hits.filter((hit) => {
        try {
          const hostname = new URL(hit.url).hostname;
          return hostMatchesList(hostname, options.allowedDomains!);
        } catch {
          return false;
        }
      });
    }

    if (options.blockedDomains && options.blockedDomains.length > 0) {
      hits = hits.filter((hit) => {
        try {
          const hostname = new URL(hit.url).hostname;
          return !hostMatchesList(hostname, options.blockedDomains!);
        } catch {
          return true;
        }
      });
    }

    return hits.slice(0, Math.min(options.maxResults, MAX_HITS));
  }
}

// ---------------------------------------------------------------------------
// Backend registry
// ---------------------------------------------------------------------------

let _backend: SearchBackend | null = null;

export function getSearchBackend(): SearchBackend {
  if (_backend === null) {
    _backend = new DuckDuckGoBackend();
  }
  return _backend;
}

export function setSearchBackend(backend: SearchBackend): void {
  _backend = backend;
}

export function resetSearchBackend(): void {
  _backend = null;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const NUM_RESULTS_DEFAULT = 5;

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("The search query string."),
  queries: z
    .array(z.string().min(1))
    .min(1)
    .max(5)
    .optional()
    .describe(
      "Additional search queries to execute in batch. Results are merged and deduplicated across all queries (including query). Max 5.",
    ),
  num_results: z
    .number()
    .int()
    .min(1)
    .max(8)
    .optional()
    .describe("Maximum number of results to return per query (1-8, default 5)."),
  allowed_domains: z
    .array(z.string())
    .optional()
    .describe(
      "Only include results from these domains. Supports subdomain matching (e.g. 'example.com' matches 'sub.example.com').",
    ),
  blocked_domains: z
    .array(z.string())
    .optional()
    .describe(
      "Exclude results from these domains. Supports subdomain matching.",
    ),
});

type Input = z.infer<typeof inputSchema>;

const spec: ToolSpec = {
  name: "web_search",
  description:
    "Search the web for information. Returns ranked results with titles, URLs, and snippets. " +
    "Supports single query or batch queries (up to 5). Results are deduplicated across batch queries. " +
    "Use allowed_domains/blocked_domains to filter results by domain. " +
    "For reading full page content, use web_fetch with a result URL.",
  inputSchema: z.toJSONSchema(inputSchema) as JsonSchema,
  requiredPermission: "network",
  tier: 1,
};

function formatResults(hits: SearchHit[], queryLabel: string): string {
  if (hits.length === 0) {
    return `No results found for: ${queryLabel}`;
  }

  const lines: string[] = [`Search results for: ${queryLabel}`, ""];
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    lines.push(`${i + 1}. ${hit.title}`);
    lines.push(`   URL: ${hit.url}`);
    if (hit.snippet) {
      lines.push(`   ${hit.snippet}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

async function executeQuery(
  query: string,
  opts: { numResults: number; allowedDomains?: readonly string[]; blockedDomains?: readonly string[] },
  backend: SearchBackend,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  return backend.search(query, {
    maxResults: opts.numResults,
    allowedDomains: opts.allowedDomains,
    blockedDomains: opts.blockedDomains,
    signal,
  });
}

async function execute(
  raw: unknown,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: Input = parsed.data;
  const numResults = input.num_results ?? NUM_RESULTS_DEFAULT;

  const queries: string[] = input.queries
    ? [input.query, ...input.queries]
    : [input.query];

  const policy = getNetworkPolicy();
  const backend = getSearchBackend();

  if (backend instanceof DuckDuckGoBackend) {
    let searchHost: string;
    try {
      searchHost = new URL(
        process.env.OPENSWARM_WEB_SEARCH_BASE_URL ?? DEFAULT_BASE_URL,
      ).hostname;
    } catch {
      searchHost = "html.duckduckgo.com";
    }
    const decision = await policy.checkHostname(searchHost);
    if (!decision.allowed) {
      return {
        status: "error",
        message: `blocked by network policy: ${decision.reason}`,
      };
    }
  }

  const searchOpts = {
    numResults,
    allowedDomains: input.allowed_domains,
    blockedDomains: input.blocked_domains,
  };

  if (queries.length === 1) {
    let hits: SearchHit[];
    try {
      hits = await executeQuery(queries[0]!, searchOpts, backend, ctx.abort);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: "error", message: `search failed: ${msg}` };
    }

    return { status: "ok", output: formatResults(hits, queries[0]!) };
  }

  const sections: string[] = [];
  const seenUrls = new Set<string>();

  for (const query of queries) {
    let hits: SearchHit[];
    try {
      hits = await executeQuery(query, searchOpts, backend, ctx.abort);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sections.push(`Search results for: ${query}\n\nError: ${msg}`);
      continue;
    }

    const deduped = hits.filter((hit) => {
      if (seenUrls.has(hit.url)) return false;
      seenUrls.add(hit.url);
      return true;
    });

    sections.push(formatResults(deduped, query));
  }

  return { status: "ok", output: sections.join("\n\n---\n\n") };
}

export const webSearchTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
  // Only the search endpoint is contacted here. Result pages are returned as
  // links for the model to fetch separately, and each of those fetches is
  // authorized against its own host when it happens.
  accesses: () => ToolAccesses.network(defaultSearchEndpoint(), "GET"),
};
