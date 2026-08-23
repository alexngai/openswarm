import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ClaudeCodeSource } from "./claude-code-source.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skills-test-"));
}

function writeSkill(dir: string, id: string, content: string, canonical = true): void {
  if (canonical) {
    const skillDir = path.join(dir, id);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), content, "utf8");
  } else {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.md`), content, "utf8");
  }
}

const BASIC_FM = `---
name: my-skill
description: My skill description
triggers:
  - foo
  - bar
---

Skill body here.
`;

const LEGACY_FM = `---
name: legacy-skill
description: A legacy skill
---

Legacy body.
`;

const NO_DESC_FM = `---
name: bad-skill
---

Body.
`;

const NO_FM = `Just a plain markdown file without frontmatter.`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ClaudeCodeSource", () => {
  let root: string;

  beforeEach(() => {
    root = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns empty array for an empty skills directory", async () => {
    const skillsDir = path.join(root, "skills");
    fs.mkdirSync(skillsDir);
    const src = new ClaudeCodeSource({
      cwd: root,
      homedir: root,
      envOverrides: {},
      maxAncestorDepth: 0,
    });
    // Put skills dir at .claude/skills so it's discovered via cwd.
    fs.mkdirSync(path.join(root, ".claude", "skills"), { recursive: true });
    const manifests = await src.discover();
    expect(manifests).toHaveLength(0);
  });

  it("discovers a canonical layout skill (<id>/SKILL.md)", async () => {
    const skillsDir = path.join(root, ".claude", "skills");
    writeSkill(skillsDir, "my-skill", BASIC_FM, true);

    const src = new ClaudeCodeSource({
      cwd: root,
      homedir: root,
      envOverrides: {},
      maxAncestorDepth: 0,
    });

    const manifests = await src.discover();
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.id).toBe("my-skill");
    expect(manifests[0]!.name).toBe("my-skill");
    expect(manifests[0]!.description).toBe("My skill description");
    expect(manifests[0]!.triggers).toEqual(["foo", "bar"]);
    expect(manifests[0]!.sourceId).toBe("claude-code");
  });

  it("discovers a legacy flat layout skill (<id>.md)", async () => {
    const skillsDir = path.join(root, ".claude", "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    writeSkill(skillsDir, "legacy-skill", LEGACY_FM, false);

    const src = new ClaudeCodeSource({
      cwd: root,
      homedir: root,
      envOverrides: {},
      maxAncestorDepth: 0,
    });

    const manifests = await src.discover();
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.id).toBe("legacy-skill");
    expect(manifests[0]!.description).toBe("A legacy skill");
  });

  it("de-duplicates across multiple roots (first-wins by id)", async () => {
    // cwd .claude/skills has skill with description A
    const cwdSkillsDir = path.join(root, ".claude", "skills");
    writeSkill(cwdSkillsDir, "shared-skill", `---
name: shared-skill
description: From cwd root
---

CWD body.
`, true);

    // Separate home dir has same skill with description B
    const homeDir = path.join(root, "fakehome");
    fs.mkdirSync(homeDir);
    const homeSkillsDir = path.join(homeDir, ".claude", "skills");
    writeSkill(homeSkillsDir, "shared-skill", `---
name: shared-skill
description: From home root
---

Home body.
`, true);

    const src = new ClaudeCodeSource({
      cwd: root,
      homedir: homeDir,
      envOverrides: {},
      maxAncestorDepth: 0,
    });

    const manifests = await src.discover();
    const sharedManifests = manifests.filter((m) => m.id === "shared-skill");
    expect(sharedManifests).toHaveLength(1);
    // First-wins: cwd root should be picked over home root.
    expect(sharedManifests[0]!.description).toBe("From cwd root");
  });

  it("respects maxAncestorDepth and does not walk too far up", async () => {
    // Place a skill 2 levels up from cwd — with depth=1 it should not be found.
    const grandparent = path.join(root, "a", "b");
    fs.mkdirSync(grandparent, { recursive: true });
    const skillsDir = path.join(root, ".claude", "skills");
    writeSkill(skillsDir, "deep-skill", BASIC_FM, true);

    // With maxAncestorDepth=0 only cwd is checked, not parent.
    const src = new ClaudeCodeSource({
      cwd: grandparent,
      homedir: path.join(root, "fakehome"),
      envOverrides: {},
      maxAncestorDepth: 0,
    });

    const manifests = await src.discover();
    expect(manifests.map((m) => m.id)).not.toContain("deep-skill");
  });

  it("warns and skips skill with missing description", async () => {
    const skillsDir = path.join(root, ".claude", "skills");
    writeSkill(skillsDir, "bad-skill", NO_DESC_FM, true);

    const src = new ClaudeCodeSource({
      cwd: root,
      homedir: root,
      envOverrides: {},
      maxAncestorDepth: 0,
    });

    const manifests = await src.discover();
    expect(manifests.map((m) => m.id)).not.toContain("bad-skill");
  });

  it("warns and skips file with no frontmatter delimiters", async () => {
    const skillsDir = path.join(root, ".claude", "skills");
    writeSkill(skillsDir, "plain-skill", NO_FM, false);

    const src = new ClaudeCodeSource({
      cwd: root,
      homedir: root,
      envOverrides: {},
      maxAncestorDepth: 0,
    });

    const manifests = await src.discover();
    expect(manifests.map((m) => m.id)).not.toContain("plain-skill");
  });

  it("load() returns body without leading blank line", async () => {
    const skillsDir = path.join(root, ".claude", "skills");
    // Body has a leading blank line after frontmatter close.
    const content = `---
name: my-skill
description: Test skill
---

This is the body.
`;
    writeSkill(skillsDir, "my-skill", content, true);

    const src = new ClaudeCodeSource({
      cwd: root,
      homedir: root,
      envOverrides: {},
      maxAncestorDepth: 0,
    });

    const loaded = await src.load("my-skill");
    expect(loaded).toBeDefined();
    expect(loaded!.body).toBe("This is the body.\n");
    expect(loaded!.body.startsWith("\n")).toBe(false);
  });

  it("parses literal block-scalar descriptions (skill-tree style)", async () => {
    const skillsDir = path.join(root, ".claude", "skills");
    // Exactly what skill-tree's serializer writes for mirrored skills.
    const content = `---
name: reuse-existing-helpers
description: |
  Adding a function variant that transforms existing output.
  Use when "uppercase", "reuse", "wrapper function".
version: 1.0.0
tags:
  - javascript
---

Body.
`;
    writeSkill(skillsDir, "reuse-existing-helpers", content, true);

    const src = new ClaudeCodeSource({
      cwd: root,
      homedir: root,
      envOverrides: {},
      maxAncestorDepth: 0,
    });

    const manifests = await src.discover();
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.description).toBe(
      'Adding a function variant that transforms existing output.\nUse when "uppercase", "reuse", "wrapper function".',
    );
    // Keys after the block still parse.
    expect(manifests[0]!.triggers).toBeUndefined();
  });

  it("parses folded block scalars and chomping variants", async () => {
    const skillsDir = path.join(root, ".claude", "skills");
    const content = `---
name: folded-skill
description: >-
  A folded description
  that spans lines.

  Second paragraph.
---

Body.
`;
    writeSkill(skillsDir, "folded-skill", content, true);

    const src = new ClaudeCodeSource({
      cwd: root,
      homedir: root,
      envOverrides: {},
      maxAncestorDepth: 0,
    });

    const manifests = await src.discover();
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.description).toBe(
      "A folded description that spans lines.\nSecond paragraph.",
    );
  });

  it("load() returns undefined for unknown skill id", async () => {
    const src = new ClaudeCodeSource({
      cwd: root,
      homedir: root,
      envOverrides: {},
      maxAncestorDepth: 0,
    });

    const loaded = await src.load("nonexistent");
    expect(loaded).toBeUndefined();
  });

  it("env override CODEX_HOME takes priority over cwd", async () => {
    // Skill in CODEX_HOME/skills.
    const codexHome = path.join(root, "codex-home");
    const codexSkillsDir = path.join(codexHome, "skills");
    writeSkill(codexSkillsDir, "env-skill", `---
name: env-skill
description: From CODEX_HOME
---

CODEX_HOME body.
`, true);

    // Same skill in cwd .claude/skills with different description.
    const cwdSkillsDir = path.join(root, ".claude", "skills");
    writeSkill(cwdSkillsDir, "env-skill", `---
name: env-skill
description: From cwd
---

CWD body.
`, true);

    const src = new ClaudeCodeSource({
      cwd: root,
      homedir: root,
      envOverrides: { CODEX_HOME: codexHome },
      maxAncestorDepth: 0,
    });

    const manifests = await src.discover();
    const envSkill = manifests.find((m) => m.id === "env-skill");
    expect(envSkill).toBeDefined();
    // CODEX_HOME wins.
    expect(envSkill!.description).toBe("From CODEX_HOME");
  });

  it("ancestor walk finds skill in parent directory", async () => {
    // Place skill in parent's .claude/skills.
    const parentDir = root;
    const childDir = path.join(root, "child");
    fs.mkdirSync(childDir);

    const skillsDir = path.join(parentDir, ".claude", "skills");
    writeSkill(skillsDir, "ancestor-skill", BASIC_FM, true);

    const src = new ClaudeCodeSource({
      cwd: childDir,
      homedir: path.join(root, "fakehome"),
      envOverrides: {},
      maxAncestorDepth: 2,
    });

    const manifests = await src.discover();
    expect(manifests.map((m) => m.id)).toContain("ancestor-skill");
  });

  it("silently skips unreadable directories", async () => {
    // Use a path that doesn't exist — should not throw.
    const src = new ClaudeCodeSource({
      cwd: path.join(root, "nonexistent-cwd"),
      homedir: path.join(root, "nonexistent-home"),
      envOverrides: {},
      maxAncestorDepth: 0,
    });

    const manifests = await src.discover();
    expect(Array.isArray(manifests)).toBe(true);
  });
});
