/**
 * Tests for shared bash-validation utilities.
 */

import { describe, it, expect } from "vitest";
import { extractFirstCommand } from "./utils.js";

describe("extractFirstCommand", () => {
  it("returns the first command from a simple invocation", () => {
    expect(extractFirstCommand("ls -la /tmp")).toBe("ls");
  });

  it("skips env-var prefix (FOO=bar cmd → cmd)", () => {
    expect(extractFirstCommand("FOO=bar ls -la")).toBe("ls");
  });

  it("handles multiple env-var assignments (FOO=bar BAZ=qux cmd → cmd)", () => {
    expect(extractFirstCommand("FOO=bar BAZ=qux rm -rf /")).toBe("rm");
  });

  it("returns empty string for empty input", () => {
    expect(extractFirstCommand("")).toBe("");
  });

  it("returns empty string for env-var-only input (no command)", () => {
    expect(extractFirstCommand("FOO=bar")).toBe("");
  });

  it("trims leading whitespace", () => {
    expect(extractFirstCommand("   git status")).toBe("git");
  });
});
