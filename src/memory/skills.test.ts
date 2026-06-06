import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  getSkillStore,
  resetSkillStore,
  FileSkillStore,
  parseSkillContent,
  formatSkill,
  formatSkillList,
} from "./skills.js";

afterEach(() => {
  resetSkillStore();
});

// ---------------------------------------------------------------------------
// In-memory store (default)
// ---------------------------------------------------------------------------

describe("SkillStore (in-memory)", () => {
  it("saves and retrieves a skill", () => {
    const store = getSkillStore();
    store.save({
      name: "deploy-staging",
      tags: ["deploy", "staging"],
      content: "1. Build\n2. Push\n3. Verify",
    });

    const skill = store.get("deploy-staging");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("deploy-staging");
    expect(skill!.tags).toEqual(["deploy", "staging"]);
    expect(skill!.content).toContain("Build");
  });

  it("returns null for missing skill", () => {
    expect(getSkillStore().get("nope")).toBeNull();
  });

  it("lists all skills", () => {
    const store = getSkillStore();
    store.save({ name: "a", tags: [], content: "A" });
    store.save({ name: "b", tags: [], content: "B" });
    expect(store.list()).toHaveLength(2);
  });

  it("searches by tag", () => {
    const store = getSkillStore();
    store.save({ name: "deploy", tags: ["deploy", "ci"], content: "Steps" });
    store.save({ name: "test", tags: ["testing"], content: "Run tests" });

    const results = store.search("deploy");
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("deploy");
  });

  it("searches by name", () => {
    const store = getSkillStore();
    store.save({ name: "run-tests", tags: [], content: "npm test" });

    const results = store.search("run-tests");
    expect(results).toHaveLength(1);
  });

  it("searches by content", () => {
    const store = getSkillStore();
    store.save({ name: "db-migrate", tags: [], content: "Run npx prisma migrate" });

    const results = store.search("prisma");
    expect(results).toHaveLength(1);
  });

  it("respects search limit", () => {
    const store = getSkillStore();
    for (let i = 0; i < 10; i++) {
      store.save({ name: `skill-${i}`, tags: ["common"], content: "procedure" });
    }

    expect(store.search("common", 3)).toHaveLength(3);
  });

  it("removes a skill", () => {
    const store = getSkillStore();
    store.save({ name: "temp", tags: [], content: "temporary" });
    expect(store.remove("temp")).toBe(true);
    expect(store.get("temp")).toBeNull();
  });

  it("remove returns false for missing skill", () => {
    expect(getSkillStore().remove("nonexistent")).toBe(false);
  });

  it("updates existing skill", () => {
    const store = getSkillStore();
    store.save({ name: "s1", tags: ["v1"], content: "Version 1" });
    store.save({ name: "s1", tags: ["v2"], content: "Version 2" });

    const skill = store.get("s1");
    expect(skill!.content).toBe("Version 2");
    expect(skill!.tags).toEqual(["v2"]);
  });
});

// ---------------------------------------------------------------------------
// File-based store
// ---------------------------------------------------------------------------

describe("FileSkillStore", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates directory if needed", () => {
    tmpDir = path.join(os.tmpdir(), `skills-test-${Date.now()}`);
    const store = new FileSkillStore(tmpDir);
    expect(fs.existsSync(tmpDir)).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it("saves and retrieves a skill from files", () => {
    tmpDir = path.join(os.tmpdir(), `skills-test-${Date.now()}`);
    const store = new FileSkillStore(tmpDir);

    store.save({
      name: "deploy-staging",
      tags: ["deploy", "staging"],
      content: "1. Build\n2. Push\n3. Verify",
    });

    const skill = store.get("deploy-staging");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("deploy-staging");
    expect(skill!.tags).toEqual(["deploy", "staging"]);
    expect(skill!.content).toContain("Build");

    // Verify file exists
    const filePath = path.join(tmpDir, "deploy-staging.md");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("lists skills from directory", () => {
    tmpDir = path.join(os.tmpdir(), `skills-test-${Date.now()}`);
    const store = new FileSkillStore(tmpDir);

    store.save({ name: "a", tags: [], content: "A" });
    store.save({ name: "b", tags: [], content: "B" });

    expect(store.list()).toHaveLength(2);
  });

  it("removes skill file", () => {
    tmpDir = path.join(os.tmpdir(), `skills-test-${Date.now()}`);
    const store = new FileSkillStore(tmpDir);

    store.save({ name: "temp", tags: [], content: "temp" });
    expect(store.remove("temp")).toBe(true);
    expect(store.get("temp")).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, "temp.md"))).toBe(false);
  });

  it("searches across files", () => {
    tmpDir = path.join(os.tmpdir(), `skills-test-${Date.now()}`);
    const store = new FileSkillStore(tmpDir);

    store.save({ name: "deploy", tags: ["ci"], content: "deploy steps" });
    store.save({ name: "test", tags: ["testing"], content: "test steps" });

    const results = store.search("ci");
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("deploy");
  });
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe("parseSkillContent", () => {
  it("parses YAML frontmatter", () => {
    const raw = `---
name: deploy-staging
tags: [deploy, staging, ci]
created: 2026-06-01
---
1. Build the project
2. Push to staging`;

    const skill = parseSkillContent(raw, "fallback");
    expect(skill.name).toBe("deploy-staging");
    expect(skill.tags).toEqual(["deploy", "staging", "ci"]);
    expect(skill.createdAt).toBe("2026-06-01");
    expect(skill.content).toBe("1. Build the project\n2. Push to staging");
  });

  it("uses fallback name when no frontmatter", () => {
    const skill = parseSkillContent("Just content", "my-skill");
    expect(skill.name).toBe("my-skill");
    expect(skill.tags).toEqual([]);
    expect(skill.content).toBe("Just content");
  });

  it("handles empty tags", () => {
    const raw = `---
name: empty-tags
tags: []
---
Content`;
    const skill = parseSkillContent(raw, "fallback");
    expect(skill.tags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

describe("formatSkill", () => {
  it("formats with tags", () => {
    const result = formatSkill({
      name: "deploy",
      tags: ["ci", "staging"],
      content: "Step 1\nStep 2",
    });
    expect(result).toContain("## Skill: deploy");
    expect(result).toContain("Tags: ci, staging");
    expect(result).toContain("Step 1");
  });

  it("formats without tags", () => {
    const result = formatSkill({
      name: "simple",
      tags: [],
      content: "Just do it",
    });
    expect(result).toContain("## Skill: simple");
    expect(result).not.toContain("Tags:");
    expect(result).toContain("Just do it");
  });
});

describe("formatSkillList", () => {
  it("shows no-skills message when empty", () => {
    expect(formatSkillList([])).toBe("No skills saved.");
  });

  it("lists skills with numbers and tags", () => {
    const result = formatSkillList([
      { name: "deploy", tags: ["ci"], content: "" },
      { name: "test", tags: [], content: "" },
    ]);
    expect(result).toContain("1. **deploy** [ci]");
    expect(result).toContain("2. **test**");
  });
});
