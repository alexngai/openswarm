/**
 * presets.test.ts — built-in team presets + name→preset resolution.
 *
 * Covers:
 *   (a) every preset resolves and validates against TeamSpecSchema;
 *   (b) name→preset resolution (bare name → bundled spec);
 *   (c) local-file-takes-precedence over a same-named built-in.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  BUILTIN_PRESETS,
  getPreset,
  isPresetName,
  presetNames,
} from "./presets.js";
import { TeamSpecSchema } from "../team-spec.js";
import { resolveTeamPreset } from "../../cli/team.js";

// Roles that are read-only (no write tools) per ../roles.ts.
const READ_ONLY_ROLES = new Set(["reviewer", "architect"]);

describe("built-in presets", () => {
  it("ships exactly review, fix, refactor", () => {
    expect(presetNames()).toEqual(["fix", "refactor", "review"]);
  });

  // (a) each preset resolves and validates.
  for (const name of Object.keys(BUILTIN_PRESETS)) {
    it(`preset "${name}" resolves and validates against TeamSpecSchema`, () => {
      const spec = getPreset(name);
      expect(spec).toBeDefined();
      const parsed = TeamSpecSchema.safeParse(spec);
      expect(parsed.success).toBe(true);
      // Preset name/templateName agree with the registry key.
      expect(spec!.name).toBe(name);
      expect(spec!.templateName).toBe(name);
      // Every member has a non-empty role + prompt (MemberSpec invariant).
      expect(spec!.members.length).toBeGreaterThanOrEqual(2);
      for (const m of spec!.members) {
        expect(m.role.length).toBeGreaterThan(0);
        expect(m.prompt.length).toBeGreaterThan(0);
      }
    });
  }

  it("review is read-only (all members use read-only roles)", () => {
    const spec = getPreset("review")!;
    expect(spec.topology).toBe("fanout");
    for (const m of spec.members) {
      expect(READ_ONLY_ROLES.has(m.role)).toBe(true);
    }
  });

  it("fix + refactor pair a write-capable implementer with a read-only reviewer", () => {
    for (const name of ["fix", "refactor"]) {
      const spec = getPreset(name)!;
      expect(spec.topology).toBe("pipeline");
      expect(spec.members[0]!.role).toBe("executor");
      expect(READ_ONLY_ROLES.has(spec.members[1]!.role)).toBe(true);
    }
  });

  it("isPresetName / getPreset return falsy for unknown names", () => {
    expect(isPresetName("nope")).toBe(false);
    expect(getPreset("nope")).toBeUndefined();
  });
});

describe("resolveTeamPreset", () => {
  let tmpCwd: string;

  beforeEach(async () => {
    tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "preset-resolve-"));
  });

  afterEach(async () => {
    await fs.rm(tmpCwd, { recursive: true, force: true });
  });

  // (b) name→preset resolution.
  it("resolves a bare preset name to the bundled spec", () => {
    const spec = resolveTeamPreset("review", { cwd: tmpCwd });
    expect(spec).toBeDefined();
    expect(spec!.name).toBe("review");
    expect(spec!.topology).toBe("fanout");
  });

  it("returns undefined (defer to loader) for an unknown name", () => {
    expect(resolveTeamPreset("gsd-style", { cwd: tmpCwd })).toBeUndefined();
  });

  it("returns undefined for path-like / .yaml names even if the stem matches", () => {
    expect(resolveTeamPreset("./review", { cwd: tmpCwd })).toBeUndefined();
    expect(resolveTeamPreset("teams/review", { cwd: tmpCwd })).toBeUndefined();
    expect(resolveTeamPreset("review.yaml", { cwd: tmpCwd })).toBeUndefined();
  });

  it("defers to the loader when an explicit fixtureDir is supplied", () => {
    expect(
      resolveTeamPreset("review", { cwd: tmpCwd, hasFixtureDir: true }),
    ).toBeUndefined();
  });

  // (c) local-file-takes-precedence.
  it("prefers a same-named project-local template over the built-in", async () => {
    const dir = path.join(tmpCwd, ".openteams", "templates", "review");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "team.yaml"),
      "name: review\nroles:\n  - lead\n",
      "utf8",
    );
    // Local file exists → resolveTeamPreset defers to the openteams loader.
    expect(resolveTeamPreset("review", { cwd: tmpCwd })).toBeUndefined();
    // A different preset with no local file still resolves to the built-in.
    expect(resolveTeamPreset("fix", { cwd: tmpCwd })).toBeDefined();
  });
});
