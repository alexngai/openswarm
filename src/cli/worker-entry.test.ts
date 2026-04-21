import { describe, it, expect } from "vitest";
import { composeSystemPrompt } from "./worker-entry.js";

// M1 regression: the previous implementation did
//   `roleSuffix.length > 0 ? roleSuffix : ""`
// which REPLACED the parent's base prompt. Plan §6.6 mandates append
// semantics: base first, role suffix appended so it wins on conflicts.

describe("composeSystemPrompt (M1 regression)", () => {
  it("returns empty string when both inputs are empty", () => {
    expect(composeSystemPrompt("", "")).toBe("");
    expect(composeSystemPrompt(undefined, undefined)).toBe("");
  });

  it("returns the role suffix alone when base is empty", () => {
    expect(composeSystemPrompt("", "You are an architect.")).toBe(
      "You are an architect.",
    );
  });

  it("returns the base alone when role suffix is empty", () => {
    expect(composeSystemPrompt("You are a coder.", "")).toBe(
      "You are a coder.",
    );
  });

  it("places base first, role suffix second, separated by a blank line", () => {
    const base = "Base directives: be concise.";
    const suffix = "Role overlay: only edit tests.";
    const combined = composeSystemPrompt(base, suffix);
    // Both present.
    expect(combined).toContain(base);
    expect(combined).toContain(suffix);
    // Base appears before suffix (role wins on conflicts → lands last).
    expect(combined.indexOf(base)).toBeLessThan(combined.indexOf(suffix));
    // Joined with a blank-line separator.
    expect(combined).toBe(`${base}\n\n${suffix}`);
  });
});
