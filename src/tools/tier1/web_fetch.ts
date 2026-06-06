import { z } from "zod";
import TurndownService from "turndown";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { getNetworkPolicy } from "../tier0/network-policy.js";

const MAX_BYTES_DEFAULT = 262144;

const inputSchema = z.object({
  url: z.string().url(),
  prompt: z
    .string()
    .optional()
    .describe(
      'Optional prompt to guide extraction. Use "title" to extract just the page title, ' +
        '"summary" or "summarize" to get a short preview. Omit for full content.',
    ),
  find: z
    .string()
    .optional()
    .describe(
      "Search within the fetched page content for this pattern (case-insensitive substring match). " +
        "Returns matching lines with surrounding context. Useful for finding specific information in long pages.",
    ),
  maxBytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum response size in bytes (default 262144 / 256 KiB)."),
});

type Input = z.infer<typeof inputSchema>;

const spec: ToolSpec = {
  name: "web_fetch",
  description:
    "Fetch a URL and return its content as text. HTML pages are converted to Markdown. " +
    "Plain text and JSON are returned as-is. Binary content (images, octet-stream) is rejected. " +
    'Use prompt="title" to extract just the page title, or prompt="summary" for a short preview. ' +
    "Use find to search within the page content for specific text. " +
    "Responses are truncated at maxBytes (default 256 KiB). Requires network permission.",
  inputSchema: z.toJSONSchema(inputSchema) as JsonSchema,
  requiredPermission: "network",
  tier: 1,
};

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const PREVIEW_LENGTH = 900;
const FIND_CONTEXT_LINES = 3;

function upgradeToHttps(url: URL): URL {
  if (url.protocol === "http:" && !LOCALHOST_HOSTS.has(url.hostname)) {
    const upgraded = new URL(url.href);
    upgraded.protocol = "https:";
    return upgraded;
  }
  return url;
}

function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return null;
  return match[1]!
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function findInContent(content: string, pattern: string): string {
  const lines = content.split("\n");
  const lowerPattern = pattern.toLowerCase();
  const matchingIndices: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.toLowerCase().includes(lowerPattern)) {
      matchingIndices.push(i);
    }
  }

  if (matchingIndices.length === 0) {
    return `No matches found for: ${pattern}`;
  }

  const included = new Set<number>();
  for (const idx of matchingIndices) {
    for (
      let j = Math.max(0, idx - FIND_CONTEXT_LINES);
      j <= Math.min(lines.length - 1, idx + FIND_CONTEXT_LINES);
      j++
    ) {
      included.add(j);
    }
  }

  const result: string[] = [
    `Found ${matchingIndices.length} match${matchingIndices.length === 1 ? "" : "es"} for: ${pattern}`,
    "",
  ];

  let lastLine = -2;
  for (const idx of [...included].sort((a, b) => a - b)) {
    if (idx > lastLine + 1) {
      result.push("---");
    }
    const marker = matchingIndices.includes(idx) ? ">>>" : "   ";
    result.push(`${marker} ${idx + 1}: ${lines[idx]}`);
    lastLine = idx;
  }

  return result.join("\n");
}

async function execute(raw: unknown, _ctx: ToolExecutionContext): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: Input = parsed.data;
  const maxBytes = input.maxBytes ?? MAX_BYTES_DEFAULT;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(input.url);
  } catch {
    return { status: "error", message: "invalid URL" };
  }

  parsedUrl = upgradeToHttps(parsedUrl);

  const policy = getNetworkPolicy();
  const decision = await policy.checkHostname(parsedUrl.hostname);
  if (!decision.allowed) {
    return { status: "error", message: `blocked by network policy: ${decision.reason}` };
  }

  let resp: Response;
  try {
    resp = await fetch(parsedUrl.href, { signal: AbortSignal.timeout(30_000) });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `fetch failed: ${msg}` };
  }

  if (!resp.ok) {
    return { status: "error", message: `HTTP ${resp.status}: ${resp.statusText}` };
  }

  let bytes: Uint8Array;
  try {
    const arrayBuf = await resp.arrayBuffer();
    bytes = new Uint8Array(arrayBuf);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `fetch failed: ${msg}` };
  }

  let truncated = false;
  let content = bytes;
  if (content.length > maxBytes) {
    content = content.slice(0, maxBytes);
    truncated = true;
  }

  const contentType = resp.headers.get("content-type") ?? "";
  const mime = contentType.split(";")[0].trim().toLowerCase();

  if (
    mime.startsWith("image/") ||
    mime === "application/octet-stream" ||
    mime.startsWith("audio/") ||
    mime.startsWith("video/") ||
    mime === "application/pdf" ||
    mime === "application/zip"
  ) {
    return { status: "error", message: `binary content (${mime}) not supported` };
  }

  const rawText =
    Buffer.from(content).toString("utf8") +
    (truncated ? ` [truncated at ${maxBytes} bytes]` : "");

  if (mime === "text/html") {
    const markdown = turndown.turndown(rawText);

    if (input.find) {
      return { status: "ok", output: findInContent(markdown, input.find) };
    }

    const promptLower = input.prompt?.toLowerCase() ?? "";

    if (promptLower === "title") {
      const title = extractTitle(rawText);
      return {
        status: "ok",
        output: title ? `Title: ${title}` : "No <title> tag found",
      };
    }

    if (promptLower === "summary" || promptLower === "summarize") {
      const title = extractTitle(rawText);
      const preview = markdown.slice(0, PREVIEW_LENGTH);
      const header = title ? `Title: ${title}\n\n` : "";
      return {
        status: "ok",
        output:
          header +
          preview +
          (markdown.length > PREVIEW_LENGTH ? "..." : ""),
      };
    }

    if (promptLower) {
      return {
        status: "ok",
        output: `Prompt: ${input.prompt}\n\nContent:\n${markdown}`,
      };
    }

    return { status: "ok", output: markdown };
  }

  const text = rawText;

  if (input.find) {
    return { status: "ok", output: findInContent(text, input.find) };
  }

  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/javascript" ||
    mime === "application/ld+json"
  ) {
    return { status: "ok", output: text };
  }

  return { status: "ok", output: text };
}

export const webFetchTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};

export { upgradeToHttps, extractTitle, findInContent };
