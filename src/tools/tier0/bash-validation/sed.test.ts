/**
 * Tests for the sed in-place validation submodule.
 *
 * Ported from claw's bash_validation.rs tests + openswarm-specific cases.
 */

import { describe, it, expect } from "vitest";
import { validateSed } from "./sed.js";

describe("validateSed", () => {
  // --- warns on in-place ---

  it("warns on sed -i (GNU in-place without backup)", () => {
    const result = validateSed("sed -i 's/a/b/' foo");
    expect(result.kind).toBe("warn");
    expect(result.kind === "warn" && result.message).toMatch(/in-place/i);
  });

  it("warns on sed --in-place", () => {
    const result = validateSed("sed --in-place 's/a/b/' foo");
    expect(result.kind).toBe("warn");
  });

  it("warns on sed -i with -e flag", () => {
    const result = validateSed("sed -i -e 's/a/b/' foo");
    expect(result.kind).toBe("warn");
  });

  // --- allows with backup extension ---

  it("allows sed -i.bak (has backup extension)", () => {
    expect(validateSed("sed -i.bak 's/a/b/' foo").kind).toBe("allow");
  });

  it("allows sed -i~ (tilde backup extension)", () => {
    expect(validateSed("sed -i~ 's/a/b/' foo").kind).toBe("allow");
  });

  // --- allows non-in-place sed ---

  it("allows sed without -i (stdout only)", () => {
    expect(validateSed("sed 's/a/b/' foo").kind).toBe("allow");
  });

  it("allows sed 's/old/new/' file.txt", () => {
    expect(validateSed("sed 's/old/new/' file.txt").kind).toBe("allow");
  });

  // --- non-sed commands ---

  it("allows non-sed commands", () => {
    expect(validateSed("grep pattern file").kind).toBe("allow");
  });

  it("allows rm (not sed)", () => {
    expect(validateSed("rm -rf /tmp").kind).toBe("allow");
  });
});
