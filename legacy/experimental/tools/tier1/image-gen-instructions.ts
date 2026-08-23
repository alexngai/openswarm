/**
 * Image generation instructions (R2): output directory/path instructions
 * for generated images.
 *
 * Provides a context fragment that tells the model where to save generated
 * images and what naming conventions to follow.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImageGenConfig {
  readonly outputDir: string;
  readonly namingPattern?: string;
  readonly allowedFormats?: readonly string[];
  readonly maxWidth?: number;
  readonly maxHeight?: number;
}

const DEFAULT_CONFIG: ImageGenConfig = {
  outputDir: "./generated-images",
  namingPattern: "{timestamp}-{description}.{ext}",
  allowedFormats: ["png", "jpeg", "webp", "svg"],
  maxWidth: 4096,
  maxHeight: 4096,
};

// ---------------------------------------------------------------------------
// Context fragment
// ---------------------------------------------------------------------------

export function buildImageGenContext(config?: Partial<ImageGenConfig>): string {
  const c = { ...DEFAULT_CONFIG, ...config };

  return [
    `Image output directory: ${c.outputDir}`,
    `Naming pattern: ${c.namingPattern}`,
    `Allowed formats: ${(c.allowedFormats ?? []).join(", ")}`,
    `Max dimensions: ${c.maxWidth}x${c.maxHeight}`,
  ].join("\n");
}

export function resolveImagePath(
  description: string,
  ext: string,
  config?: Partial<ImageGenConfig>,
): string {
  const c = { ...DEFAULT_CONFIG, ...config };
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safeDesc = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  const safeExt = ext.replace(/^\./, "");

  const filename = (c.namingPattern ?? "{timestamp}-{description}.{ext}")
    .replace("{timestamp}", timestamp)
    .replace("{description}", safeDesc)
    .replace("{ext}", safeExt);

  return `${c.outputDir}/${filename}`;
}
