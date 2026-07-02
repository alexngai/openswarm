/**
 * loader.test.ts — tests for the openteams template loader.
 *
 * Uses captured fixtures under test/fixtures/openteams/ — never shells out
 * to live openteams. The fixtureDir option is the test seam.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as url from "node:url";
import { loadTemplate } from "./loader.js";

// ESM-friendly resolution of the fixtures dir.
const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// fixtures live at <repo>/test/fixtures/openteams/<name>/
const FIXTURES_ROOT = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "test",
  "fixtures",
  "openteams",
);

describe("loadTemplate (fixture mode)", () => {
  it("loads team.yaml fields from the fixture dir", async () => {
    const config = await loadTemplate("gsd-style", {
      fixtureDir: path.join(FIXTURES_ROOT, "gsd-style"),
    });
    expect(config.name).toBe("gsd-style-fixture");
    expect(config.roles).toEqual(["lead", "researcher", "implementer"]);
    expect(config.topology?.root).toEqual({ role: "lead" });
    expect(config.topology?.spawn_rules).toEqual({
      lead: ["researcher", "implementer"],
      researcher: [],
      implementer: [],
    });
    expect(config.communication?.enforcement).toBe("permissive");
    expect(config.communication?.channels?.workflow?.signals).toEqual([
      "DONE",
      "BLOCKED",
    ]);
  });

  it("populates rolePrompts from agents/<role>.md files", async () => {
    const config = await loadTemplate("gsd-style", {
      fixtureDir: path.join(FIXTURES_ROOT, "gsd-style"),
    });
    expect(config.rolePrompts?.lead).toContain("You are the lead.");
    expect(config.rolePrompts?.researcher).toContain("You are the researcher.");
  });

  it("leaves rolePrompts entry undefined for roles without an agents/<role>.md file", async () => {
    // The gsd-style fixture intentionally omits agents/implementer.md.
    const config = await loadTemplate("gsd-style", {
      fixtureDir: path.join(FIXTURES_ROOT, "gsd-style"),
    });
    expect(config.rolePrompts?.implementer).toBeUndefined();
  });

  it("rejects malformed YAML with a helpful error message", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openswarm-test-loader-bad-yaml-"),
    );
    try {
      await fs.writeFile(
        path.join(tmpDir, "team.yaml"),
        // Indentation that yaml-parses but would fail object check
        // would be too forgiving; use deliberately broken YAML instead.
        "name: test\n  bad: : :\nroles:\n  - [unclosed",
        "utf8",
      );
      await expect(
        loadTemplate("ignored", { fixtureDir: tmpDir }),
      ).rejects.toThrow(/not valid YAML/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects YAML that parses to a non-object root", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openswarm-test-loader-not-object-"),
    );
    try {
      await fs.writeFile(
        path.join(tmpDir, "team.yaml"),
        "- just\n- a\n- list\n",
        "utf8",
      );
      await expect(
        loadTemplate("ignored", { fixtureDir: tmpDir }),
      ).rejects.toThrow(/not an object/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects a fixture dir without team.yaml", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openswarm-test-loader-empty-"),
    );
    try {
      await expect(
        loadTemplate("ignored", { fixtureDir: tmpDir }),
      ).rejects.toThrow(/cannot read team\.yaml/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects team.yaml missing a name field", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openswarm-test-loader-no-name-"),
    );
    try {
      await fs.writeFile(
        path.join(tmpDir, "team.yaml"),
        "roles:\n  - a\n",
        "utf8",
      );
      await expect(
        loadTemplate("ignored", { fixtureDir: tmpDir }),
      ).rejects.toThrow(/missing a "name" field/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
