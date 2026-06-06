/**
 * View image tool (F2): allows the agent to view/analyze image files.
 *
 * Reads an image from the filesystem and returns it as a base64-encoded
 * data URI that vision-capable models can analyze. Supports common image
 * formats: PNG, JPEG, GIF, WebP, SVG.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";

const inputSchema = z.object({
  path: z.string().describe("Absolute or relative path to the image file"),
});

type Input = z.infer<typeof inputSchema>;

const SUPPORTED_EXTENSIONS = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".bmp", "image/bmp"],
  [".ico", "image/x-icon"],
]);

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MiB

const spec: ToolSpec = {
  name: "view_image",
  description:
    "View an image file from the filesystem. Returns the image as a base64 data URI " +
    "for analysis by vision-capable models. Supports PNG, JPEG, GIF, WebP, SVG, BMP. " +
    "Maximum file size: 20 MiB.",
  inputSchema: z.toJSONSchema(inputSchema) as JsonSchema,
  requiredPermission: "read",
  tier: 1,
};

async function execute(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: Input = parsed.data;

  const resolved = path.isAbsolute(input.path)
    ? input.path
    : path.resolve(ctx.cwd, input.path);

  const ext = path.extname(resolved).toLowerCase();
  const mime = SUPPORTED_EXTENSIONS.get(ext);
  if (!mime) {
    return {
      status: "error",
      message: `unsupported image format: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS.keys()].join(", ")}`,
    };
  }

  try {
    const stat = fs.statSync(resolved);
    if (stat.size > MAX_FILE_SIZE) {
      return {
        status: "error",
        message: `image too large: ${(stat.size / 1024 / 1024).toFixed(1)} MiB (max ${MAX_FILE_SIZE / 1024 / 1024} MiB)`,
      };
    }

    const data = fs.readFileSync(resolved);
    const base64 = data.toString("base64");

    return {
      status: "ok",
      output: `![${path.basename(resolved)}](data:${mime};base64,${base64})`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `failed to read image: ${msg}` };
  }
}

export const viewImageTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
