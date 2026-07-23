import { describe, it, expect } from "vitest";
import {
  CONSTRAINT_FIXTURES,
  HARD_CONSTRAINT_FIXTURES,
  FIXTURE_SETS,
  selectFixtureSet,
  gradeConstraintRetention,
  summarizeArm,
  renderRetentionReport,
  type ConstraintFixture,
} from "./constraint-retention.js";

function fixtureById(id: string): ConstraintFixture {
  const f = CONSTRAINT_FIXTURES.find((x) => x.id === id);
  if (f === undefined) throw new Error(`no fixture ${id}`);
  return f;
}

function allText(f: ConstraintFixture): string {
  return f.messages
    .flatMap((m) => m.content.map((b) => ("text" in b ? b.text : "")))
    .join(" ")
    .toLowerCase();
}

describe("fixtures", () => {
  it("state each constraint's identifier in an early message (before filler)", () => {
    for (const f of CONSTRAINT_FIXTURES) {
      const firstUser = f.messages.find((m) => m.role === "user");
      expect(firstUser).toBeDefined();
      const text = firstUser!.content.map((b) => ("text" in b ? b.text : "")).join(" ");
      for (const c of f.constraints) {
        for (const tok of c.mustContain) {
          expect(text.toLowerCase()).toContain(tok.toLowerCase());
        }
      }
    }
  });

  it("bury the constraint under later turns so a fold must preserve it", () => {
    for (const f of CONSTRAINT_FIXTURES) {
      expect(f.messages.length).toBeGreaterThan(10);
    }
  });
});

describe("hard fixtures (discriminating set)", () => {
  // Well-formedness across BOTH sets: a mustContain token the fixture never
  // states is un-gradeable (the grader could never pass), silently zeroing the
  // arm. This guards every set the runner can select.
  it("state every mustContain token verbatim somewhere in their own messages", () => {
    for (const f of [...CONSTRAINT_FIXTURES, ...HARD_CONSTRAINT_FIXTURES]) {
      const hay = allText(f);
      for (const c of f.constraints) {
        for (const tok of c.mustContain) {
          expect(hay, `${f.id}/${c.id} missing "${tok}"`).toContain(tok.toLowerCase());
        }
      }
    }
  });

  it("state the constraint in passing — NOT in the first user turn (unlike the default set)", () => {
    // At least one hard fixture must bury its identifier past the opening turn;
    // that's the property the default set lacks and this set exists to test.
    const buriedPastFirstTurn = HARD_CONSTRAINT_FIXTURES.some((f) => {
      const firstUser = f.messages.find((m) => m.role === "user");
      const firstText = (firstUser?.content ?? [])
        .map((b) => ("text" in b ? b.text : ""))
        .join(" ")
        .toLowerCase();
      return f.constraints.some((c) => c.mustContain.some((t) => !firstText.includes(t.toLowerCase())));
    });
    expect(buriedPastFirstTurn).toBe(true);
  });

  it("include at least one fixture with multiple constraints", () => {
    expect(HARD_CONSTRAINT_FIXTURES.some((f) => f.constraints.length > 1)).toBe(true);
  });

  it("are all non-security (they isolate the non-security retention gap)", () => {
    for (const f of HARD_CONSTRAINT_FIXTURES) {
      for (const c of f.constraints) expect(c.securityCovered ?? false).toBe(false);
    }
  });
});

describe("selectFixtureSet", () => {
  it("resolves named sets", () => {
    expect(selectFixtureSet("default")).toBe(FIXTURE_SETS.default);
    expect(selectFixtureSet("hard")).toBe(FIXTURE_SETS.hard);
    expect(selectFixtureSet("all")).toBe(FIXTURE_SETS.all);
  });
  it("is case/space-insensitive and defaults on unknown/empty", () => {
    expect(selectFixtureSet("  HARD ")).toBe(FIXTURE_SETS.hard);
    expect(selectFixtureSet("bogus")).toBe(CONSTRAINT_FIXTURES);
    expect(selectFixtureSet(undefined)).toBe(CONSTRAINT_FIXTURES);
  });
});

describe("gradeConstraintRetention", () => {
  const fixture = fixtureById("never-touch-path");

  it("marks a constraint retained when its identifier survives (any casing/spacing)", () => {
    const summary = "Standing facts: do NOT edit anything in   SRC/LEGACY/ — vendored.";
    const grade = gradeConstraintRetention(summary, fixture);
    expect(grade.retainedFraction).toBe(1);
    expect(grade.constraints[0]!.retained).toBe(true);
    expect(grade.constraints[0]!.missing).toEqual([]);
  });

  it("marks a constraint lost when the identifier is dropped (paraphrase w/o the path)", () => {
    const summary = "The user asked us to avoid touching some vendored directory.";
    const grade = gradeConstraintRetention(summary, fixture);
    expect(grade.retainedFraction).toBe(0);
    expect(grade.constraints[0]!.retained).toBe(false);
    expect(grade.constraints[0]!.missing).toEqual(["src/legacy/"]);
  });

  it("requires ALL mustContain tokens for multi-identifier constraints", () => {
    const multi: ConstraintFixture = {
      id: "multi",
      messages: fixture.messages,
      constraints: [
        { id: "two", description: "two ids", mustContain: ["audit_events", "18.2.0"] },
      ],
    };
    expect(gradeConstraintRetention("keep audit_events", multi).constraints[0]!.retained).toBe(false);
    expect(
      gradeConstraintRetention("audit_events pinned at 18.2.0", multi).constraints[0]!.retained,
    ).toBe(true);
  });
});

describe("summarizeArm", () => {
  it("separates overall from non-security retention (TE-25's gap)", () => {
    // Simulate a baseline that keeps the security constraint but drops the rest.
    const grades = CONSTRAINT_FIXTURES.map((f) => {
      const summary = f.constraints.some((c) => c.securityCovered)
        ? f.constraints.flatMap((c) => c.mustContain).join(" ") // security fixture: retained
        : "vague paraphrase with no identifiers"; // others: lost
      return gradeConstraintRetention(summary, f);
    });
    const arm = summarizeArm({ label: "baseline", grades });
    // Exactly the one security-covered constraint retained.
    expect(arm.retainedConstraints).toBe(1);
    // Non-security retention is 0 — the gap TE-25 addresses.
    expect(arm.nonSecurity).toBe(0);
    expect(arm.overall).toBeGreaterThan(0);
    expect(arm.overall).toBeLessThan(1);
  });

  it("reports full retention when every constraint survives", () => {
    const grades = CONSTRAINT_FIXTURES.map((f) =>
      gradeConstraintRetention(f.constraints.flatMap((c) => c.mustContain).join(" "), f),
    );
    const arm = summarizeArm({ label: "ideal", grades });
    expect(arm.overall).toBe(1);
    expect(arm.nonSecurity).toBe(1);
  });
});

describe("renderRetentionReport", () => {
  it("renders a comparison table and lists losses", () => {
    const lost = CONSTRAINT_FIXTURES.map((f) =>
      gradeConstraintRetention("nothing useful here", f),
    );
    const kept = CONSTRAINT_FIXTURES.map((f) =>
      gradeConstraintRetention(f.constraints.flatMap((c) => c.mustContain).join(" "), f),
    );
    const report = renderRetentionReport([
      { label: "baseline", grades: lost },
      { label: "section", grades: kept },
    ]);
    expect(report).toContain("| arm | overall retention");
    expect(report).toContain("| baseline |");
    expect(report).toContain("| section |");
    expect(report).toContain("losses (baseline):");
  });
});
