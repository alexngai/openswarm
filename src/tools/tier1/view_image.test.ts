import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { viewImageTool } from "./view_image.js";
import type { ToolExecutionContext } from "../types.js";

const ctx = (): ToolExecutionContext => ({ cwd: os.tmpdir() });

describe("view_image", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("has correct spec", () => {
    expect(viewImageTool.spec.name).toBe("view_image");
    expect(viewImageTool.spec.requiredPermission).toBe("read");
    expect(viewImageTool.spec.tier).toBe(1);
  });

  it("reads a PNG file and returns base64 data URI", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "viewimg-"));
    const imgPath = path.join(tmpDir, "test.png");
    // 1x1 red PNG
    const pngData = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    fs.writeFileSync(imgPath, pngData);

    const result = await viewImageTool.execute({ path: imgPath }, ctx());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.output).toContain("data:image/png;base64,");
    expect(result.output).toContain("test.png");
  });

  it("rejects unsupported format", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "viewimg-"));
    const txtPath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(txtPath, "not an image");

    const result = await viewImageTool.execute({ path: txtPath }, ctx());
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.message).toContain("unsupported");
  });

  it("rejects non-existent file", async () => {
    const result = await viewImageTool.execute(
      { path: "/nonexistent/image.png" },
      ctx(),
    );
    expect(result.status).toBe("error");
  });

  it("resolves relative paths against cwd", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "viewimg-"));
    const imgPath = path.join(tmpDir, "relative.jpg");
    fs.writeFileSync(imgPath, Buffer.from([0xff, 0xd8, 0xff]));

    const result = await viewImageTool.execute(
      { path: "relative.jpg" },
      { cwd: tmpDir },
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.output).toContain("data:image/jpeg;base64,");
  });

  it("rejects invalid input", async () => {
    const result = await viewImageTool.execute({}, ctx());
    expect(result.status).toBe("error");
  });
});
