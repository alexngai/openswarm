import { describe, expect, it } from "vitest";
import {
  GuardRegistry,
  evaluatePredicate,
  guardId,
  resolveField,
  touchedFields,
  type HarnessGuard,
} from "./guards.js";

function guard(overrides: Partial<HarnessGuard> = {}): HarnessGuard {
  const targetTool = overrides.targetTool ?? "edit_file";
  const predicate = overrides.predicate ?? {
    kind: "field_length_lt" as const,
    field: "old_string",
    length: 10,
  };
  return {
    id: overrides.id ?? guardId(targetTool, predicate),
    targetTool,
    predicate,
    message: overrides.message ?? "old_string must include surrounding context",
    failureSignature: overrides.failureSignature ?? "ambiguous-old-string",
    effect: "restrictive",
  };
}

describe("resolveField", () => {
  it("resolves dot paths", () => {
    expect(resolveField({ a: { b: { c: 1 } } }, "a.b.c")).toBe(1);
  });

  it("returns undefined for missing paths without throwing", () => {
    expect(resolveField({ a: 1 }, "a.b.c")).toBeUndefined();
    expect(resolveField(null, "a")).toBeUndefined();
    expect(resolveField(undefined, "a")).toBeUndefined();
  });
});

describe("evaluatePredicate", () => {
  it("field_absent matches missing, null, and empty string", () => {
    const p = { kind: "field_absent" as const, field: "x" };
    expect(evaluatePredicate(p, {})).toBe(true);
    expect(evaluatePredicate(p, { x: null })).toBe(true);
    expect(evaluatePredicate(p, { x: "" })).toBe(true);
    expect(evaluatePredicate(p, { x: "v" })).toBe(false);
  });

  it("field_matches applies a regex to the stringified field", () => {
    const p = { kind: "field_matches" as const, field: "path", pattern: "\\.generated\\.ts$" };
    expect(evaluatePredicate(p, { path: "src/a.generated.ts" })).toBe(true);
    expect(evaluatePredicate(p, { path: "src/a.ts" })).toBe(false);
  });

  it("field_matches does not fire on an absent field", () => {
    const p = { kind: "field_matches" as const, field: "path", pattern: ".*" };
    expect(evaluatePredicate(p, {})).toBe(false);
  });

  it("field_length_lt compares string length", () => {
    const p = { kind: "field_length_lt" as const, field: "s", length: 5 };
    expect(evaluatePredicate(p, { s: "abc" })).toBe(true);
    expect(evaluatePredicate(p, { s: "abcdef" })).toBe(false);
  });

  it("composes with all / any / not", () => {
    const input = { a: "xx", b: "" };
    expect(
      evaluatePredicate(
        {
          kind: "all",
          of: [
            { kind: "field_length_lt", field: "a", length: 5 },
            { kind: "field_absent", field: "b" },
          ],
        },
        input,
      ),
    ).toBe(true);
    expect(
      evaluatePredicate(
        {
          kind: "all",
          of: [
            { kind: "field_length_lt", field: "a", length: 5 },
            { kind: "field_absent", field: "a" },
          ],
        },
        input,
      ),
    ).toBe(false);
    expect(
      evaluatePredicate(
        { kind: "any", of: [{ kind: "field_absent", field: "a" }, { kind: "field_absent", field: "b" }] },
        input,
      ),
    ).toBe(true);
    expect(evaluatePredicate({ kind: "not", of: { kind: "field_absent", field: "a" } }, input)).toBe(
      true,
    );
  });

  it("fails open on an invalid regex rather than throwing", () => {
    const p = { kind: "field_matches" as const, field: "x", pattern: "([" };
    expect(evaluatePredicate(p, { x: "anything" })).toBe(false);
  });
});

describe("touchedFields", () => {
  it("derives the read set statically, sorted and deduped", () => {
    expect(
      touchedFields({
        kind: "all",
        of: [
          { kind: "field_absent", field: "b" },
          { kind: "not", of: { kind: "field_length_lt", field: "a", length: 2 } },
          { kind: "field_matches", field: "b", pattern: "x" },
        ],
      }),
    ).toEqual(["a", "b"]);
  });
});

describe("guardId", () => {
  it("is content-addressed and stable", () => {
    const p = { kind: "field_absent" as const, field: "x" };
    expect(guardId("t", p)).toBe(guardId("t", p));
  });

  it("differs across tools and predicates", () => {
    const p = { kind: "field_absent" as const, field: "x" };
    expect(guardId("a", p)).not.toBe(guardId("b", p));
    expect(guardId("a", p)).not.toBe(guardId("a", { kind: "field_absent", field: "y" }));
  });
});

describe("GuardRegistry", () => {
  it("blocks a matching call and reports the message", () => {
    const reg = new GuardRegistry();
    const g = guard();
    expect(reg.register(g)).toBe(true);

    const verdict = reg.evaluate("edit_file", { old_string: "short" });
    expect(verdict.blocked).toBe(true);
    expect(verdict.guardId).toBe(g.id);
    expect(verdict.message).toContain("surrounding context");
  });

  it("allows a non-matching call", () => {
    const reg = new GuardRegistry();
    reg.register(guard());
    expect(reg.evaluate("edit_file", { old_string: "a much longer string" }).blocked).toBe(false);
  });

  it("only applies guards to their target tool", () => {
    const reg = new GuardRegistry();
    reg.register(guard());
    expect(reg.evaluate("write_file", { old_string: "short" }).blocked).toBe(false);
  });

  it("is a no-op for tools with no guards", () => {
    const reg = new GuardRegistry();
    expect(reg.evaluate("bash", { command: "ls" }).blocked).toBe(false);
  });

  it("re-registering the same guard preserves evidence", () => {
    const reg = new GuardRegistry();
    const g = guard();
    reg.register(g);
    reg.evaluate("edit_file", { old_string: "short" });
    expect(reg.evidenceFor(g.id)?.fired).toBe(1);

    expect(reg.register(guard())).toBe(false);
    expect(reg.evidenceFor(g.id)?.fired).toBe(1);
  });

  it("counts evaluations and firings for the LH1 metric", () => {
    const reg = new GuardRegistry();
    const g = guard();
    reg.register(g);

    reg.evaluate("edit_file", { old_string: "short" }); // fires
    reg.evaluate("edit_file", { old_string: "long enough not to fire" }); // does not

    const summary = reg.summary();
    expect(summary.guardCount).toBe(1);
    expect(summary.totalEvaluated).toBe(2);
    expect(summary.totalFired).toBe(1);
    expect(summary.perGuard[0]?.failureSignature).toBe("ambiguous-old-string");
  });

  it("removes guards and stops enforcing them", () => {
    const reg = new GuardRegistry();
    const g = guard();
    reg.register(g);
    expect(reg.remove(g.id)).toBe(true);
    expect(reg.evaluate("edit_file", { old_string: "short" }).blocked).toBe(false);
    expect(reg.remove(g.id)).toBe(false);
  });

  it("returns the first firing guard when several are registered", () => {
    const reg = new GuardRegistry();
    const first = guard({ message: "first" });
    const second = guard({
      predicate: { kind: "field_absent", field: "file_path" },
      message: "second",
    });
    reg.register(first);
    reg.register(second);

    const verdict = reg.evaluate("edit_file", { old_string: "short" });
    expect(verdict.message).toBe("first");
    // The second guard was never reached, so its counters stay clean.
    expect(reg.evidenceFor(second.id)?.evaluated).toBe(0);
  });
});
