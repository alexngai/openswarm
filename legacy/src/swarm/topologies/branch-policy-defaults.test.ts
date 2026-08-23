/**
 * Unit tests for applyDefaultBranchPolicy — v0.7 stage 7D.
 */
import { describe, it, expect } from "vitest";
import { applyDefaultBranchPolicy } from "./branch-policy-defaults.js";
import type { TeamSpec, MemberSpec } from "../team-spec.js";

function spec(members: readonly MemberSpec[], coordinationExtra?: Partial<TeamSpec["coordination"]>): TeamSpec {
  return {
    name: "t",
    topology: "peer-team",
    members,
    coordination: { completion: { kind: "all" }, ...coordinationExtra },
  };
}

describe("applyDefaultBranchPolicy (v0.7 stage 7D)", () => {
  it("fills in fallback for members with no branchPolicy", () => {
    const out = applyDefaultBranchPolicy(
      spec([{ role: "x", prompt: "p" }, { role: "y", prompt: "p" }]),
      { kind: "stream" },
    );
    expect(out.members[0]?.branchPolicy).toEqual({ kind: "stream" });
    expect(out.members[1]?.branchPolicy).toEqual({ kind: "stream" });
  });

  it("preserves explicit member.branchPolicy (no overwrite)", () => {
    const out = applyDefaultBranchPolicy(
      spec([
        { role: "x", prompt: "p", branchPolicy: { kind: "none" } },
        { role: "y", prompt: "p" },
      ]),
      { kind: "stream" },
    );
    expect(out.members[0]?.branchPolicy).toEqual({ kind: "none" });
    expect(out.members[1]?.branchPolicy).toEqual({ kind: "stream" });
  });

  it("coordination.defaultBranchPolicy wins over fallback", () => {
    const out = applyDefaultBranchPolicy(
      spec([{ role: "x", prompt: "p" }], {
        defaultBranchPolicy: { kind: "fork", parentStreamId: "s-base" },
      }),
      { kind: "stream" },
    );
    expect(out.members[0]?.branchPolicy).toEqual({
      kind: "fork",
      parentStreamId: "s-base",
    });
  });

  it("returns the same reference when every member is already set", () => {
    const original = spec([
      { role: "x", prompt: "p", branchPolicy: { kind: "none" } },
    ]);
    const out = applyDefaultBranchPolicy(original, { kind: "stream" });
    expect(out).toBe(original);
  });
});
