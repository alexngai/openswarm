/**
 * filetype.test.ts — node-safe path → filetype resolution (doc 49 Phase A1).
 * Runs under vitest (no @opentui/core dependency).
 */

import { describe, it, expect } from "vitest";
import { filetypeFromPath } from "./filetype.js";

describe("filetypeFromPath", () => {
  it("returns undefined for empty / undefined input", () => {
    expect(filetypeFromPath(undefined)).toBeUndefined();
    expect(filetypeFromPath("")).toBeUndefined();
  });

  it("resolves known extensions", () => {
    expect(filetypeFromPath("src/foo.ts")).toBe("typescript");
    expect(filetypeFromPath("a/b/c.py")).toBe("python");
    expect(filetypeFromPath("main.go")).toBe("go");
    expect(filetypeFromPath("Cargo/lib.rs")).toBe("rust");
    expect(filetypeFromPath("config.YAML")).toBe("yaml");
  });

  it("resolves special basenames", () => {
    expect(filetypeFromPath("deploy/Dockerfile")).toBe("dockerfile");
    expect(filetypeFromPath("Makefile")).toBe("make");
  });

  it("returns undefined for unknown / extensionless paths", () => {
    expect(filetypeFromPath("some/random-file-noext")).toBeUndefined();
    expect(filetypeFromPath("foo.")).toBeUndefined();
    expect(filetypeFromPath("foo.unknownext")).toBeUndefined();
  });

  it("handles Windows-style separators", () => {
    expect(filetypeFromPath("src\\foo.ts")).toBe("typescript");
  });
});
