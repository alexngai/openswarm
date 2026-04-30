import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import TurndownService from "turndown";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";

const inputSchema = z.object({
  url: z.string().url(),
  maxBytes: z.number().int().positive().optional().default(262144),
});

type Input = z.infer<typeof inputSchema>;

const spec: ToolSpec = {
  name: "web_fetch",
  description:
    "Fetch a URL and return its content as text. HTML pages are converted to Markdown. " +
    "Plain text and JSON are returned as-is. Binary content (images, octet-stream) is rejected. " +
    "Responses are truncated at maxBytes (default 256 KiB). Requires network permission.",
  inputSchema: zodToJsonSchema(inputSchema as never) as JsonSchema,
  requiredPermission: "network",
  tier: 1,
};

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

async function execute(raw: unknown, _ctx: ToolExecutionContext): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: Input = parsed.data;

  let resp: Response;
  try {
    resp = await fetch(input.url, { signal: AbortSignal.timeout(30_000) });
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
  if (content.length > input.maxBytes) {
    content = content.slice(0, input.maxBytes);
    truncated = true;
  }

  const contentType = resp.headers.get("content-type") ?? "";
  const mime = contentType.split(";")[0].trim().toLowerCase();

  // Binary types — reject
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

  const text = Buffer.from(content).toString("utf8") + (truncated ? ` [truncated at ${input.maxBytes} bytes]` : "");

  if (mime === "text/html") {
    const markdown = turndown.turndown(text);
    return { status: "ok", output: markdown };
  }

  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/javascript" ||
    mime === "application/ld+json"
  ) {
    return { status: "ok", output: text };
  }

  // Unknown mime — return as text with a note
  return { status: "ok", output: text };
}

export const webFetchTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
