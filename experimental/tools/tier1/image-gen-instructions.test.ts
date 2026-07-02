import { describe, it, expect } from "vitest";
import {
  buildImageGenContext,
  resolveImagePath,
} from "./image-gen-instructions.js";

describe("buildImageGenContext", () => {
  it("returns default context", () => {
    const ctx = buildImageGenContext();
    expect(ctx).toContain("./generated-images");
    expect(ctx).toContain("png, jpeg, webp, svg");
    expect(ctx).toContain("4096x4096");
  });

  it("uses custom config", () => {
    const ctx = buildImageGenContext({
      outputDir: "/tmp/images",
      maxWidth: 1024,
      maxHeight: 768,
    });
    expect(ctx).toContain("/tmp/images");
    expect(ctx).toContain("1024x768");
  });
});

describe("resolveImagePath", () => {
  it("generates a path with timestamp and description", () => {
    const result = resolveImagePath("hero banner", "png");
    expect(result).toContain("./generated-images/");
    expect(result).toContain("hero-banner");
    expect(result).toContain(".png");
  });

  it("sanitizes description", () => {
    const result = resolveImagePath("My @#$% Image!!!", "jpg");
    expect(result).toContain("my-image");
    expect(result).toContain(".jpg");
  });

  it("uses custom output dir", () => {
    const result = resolveImagePath("test", "webp", {
      outputDir: "/custom/path",
    });
    expect(result.startsWith("/custom/path/")).toBe(true);
  });

  it("strips leading dot from extension", () => {
    const result = resolveImagePath("test", ".png");
    expect(result).toMatch(/\.png$/);
    expect(result).not.toContain("..png");
  });

  it("truncates long descriptions", () => {
    const long = "a".repeat(200);
    const result = resolveImagePath(long, "png");
    expect(result.length).toBeLessThan(200);
  });
});
