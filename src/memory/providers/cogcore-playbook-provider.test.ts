/**
 * Tests for CogcorePlaybookProvider — reading cognitive-core's canonical
 * `<storage>/playbooks/<slug>/SKILL.md` procedural-memory store.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CogcorePlaybookProvider,
  loadCogcorePlaybooks,
  parseCanonicalSkillMd,
  resolveCogcorePlaybooksDir,
  scorePlaybook,
} from "./cogcore-playbook-provider.js";

const SKILL_MD = `---
name: verify-before-completion
version: 3
description: Always verify changes before declaring a task complete.
status: active
tags:
  - verification
  - testing
ccore:
  schemaVersion: 1
  kind: procedural
  id: pb-verify-1
---

## Strategy
Run the test suite and confirm the diff before claiming completion.
`;

let tmp: string;

function writeSkill(dir: string, slug: string, content: string): void {
  const skillDir = path.join(dir, slug);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), content, "utf8");
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cogcore-pb-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.OPENSWARM_COGCORE_PLAYBOOKS_DIR;
});

describe("parseCanonicalSkillMd", () => {
  it("parses a canonical procedural SKILL.md", () => {
    const parsed = parseCanonicalSkillMd(SKILL_MD);
    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe("pb-verify-1");
    expect(parsed!.name).toBe("verify-before-completion");
    expect(parsed!.tags).toEqual(["verification", "testing"]);
    expect(parsed!.body).toContain("Run the test suite");
  });

  it("rejects files without frontmatter", () => {
    expect(parseCanonicalSkillMd("just a body")).toBeNull();
  });

  it("rejects files without a procedural ccore block", () => {
    expect(parseCanonicalSkillMd("---\nname: x\n---\nbody")).toBeNull();
    expect(
      parseCanonicalSkillMd("---\nname: x\nccore:\n  kind: knowledge\n---\nbody"),
    ).toBeNull();
  });

  it("falls back to the name when ccore.id is missing", () => {
    const parsed = parseCanonicalSkillMd(
      "---\nname: my-skill\nccore:\n  kind: procedural\n---\nbody",
    );
    expect(parsed!.id).toBe("my-skill");
  });
});

describe("resolveCogcorePlaybooksDir", () => {
  it("prefers the explicit override when it exists", () => {
    const dir = path.join(tmp, "custom");
    fs.mkdirSync(dir, { recursive: true });
    expect(
      resolveCogcorePlaybooksDir("/nowhere", { OPENSWARM_COGCORE_PLAYBOOKS_DIR: dir }),
    ).toBe(dir);
  });

  it("checks namespaced dirs in order: .openswarm, .swarm, standalone", () => {
    for (const ns of [".openswarm/cognitive-core", ".swarm/cognitive-core", ".cognitive-core"]) {
      fs.mkdirSync(path.join(tmp, ns, "playbooks"), { recursive: true });
    }
    expect(resolveCogcorePlaybooksDir(tmp, {})).toBe(
      path.join(tmp, ".openswarm", "cognitive-core", "playbooks"),
    );

    fs.rmSync(path.join(tmp, ".openswarm"), { recursive: true });
    expect(resolveCogcorePlaybooksDir(tmp, {})).toBe(
      path.join(tmp, ".swarm", "cognitive-core", "playbooks"),
    );

    fs.rmSync(path.join(tmp, ".swarm"), { recursive: true });
    expect(resolveCogcorePlaybooksDir(tmp, {})).toBe(
      path.join(tmp, ".cognitive-core", "playbooks"),
    );
  });

  it("honors COGNITIVE_CORE_HOME", () => {
    const home = path.join(tmp, "cogcore-home");
    fs.mkdirSync(path.join(home, "playbooks"), { recursive: true });
    expect(resolveCogcorePlaybooksDir("/nowhere", { COGNITIVE_CORE_HOME: home })).toBe(
      path.join(home, "playbooks"),
    );
  });

  it("returns null when no store exists", () => {
    expect(resolveCogcorePlaybooksDir(tmp, {})).toBeNull();
  });
});

describe("loadCogcorePlaybooks", () => {
  it("loads playbooks and skips malformed / hidden entries", () => {
    writeSkill(tmp, "verify-before-completion", SKILL_MD);
    writeSkill(tmp, "broken", "no frontmatter here");
    writeSkill(tmp, ".candidates", SKILL_MD);
    fs.mkdirSync(path.join(tmp, "empty-dir"));

    const playbooks = loadCogcorePlaybooks(tmp);
    expect(playbooks).toHaveLength(1);
    expect(playbooks[0].id).toBe("pb-verify-1");
  });
});

describe("scorePlaybook", () => {
  const playbook = parseCanonicalSkillMd(SKILL_MD)!;

  it("weights name matches over body matches", () => {
    const nameScore = scorePlaybook(playbook, ["verify"]);
    const bodyScore = scorePlaybook(playbook, ["diff"]);
    expect(nameScore).toBeGreaterThan(bodyScore);
    expect(bodyScore).toBeGreaterThan(0);
  });

  it("scores zero for unrelated queries", () => {
    expect(scorePlaybook(playbook, ["kubernetes"])).toBe(0);
  });
});

describe("CogcorePlaybookProvider", () => {
  it("is unavailable when no store exists", async () => {
    const provider = new CogcorePlaybookProvider();
    await provider.initialize({ playbooksDir: path.join(tmp, "nope") });
    expect(await provider.isAvailable()).toBe(false);
  });

  it("surfaces matching playbooks with skill identity for exposure declaration", async () => {
    writeSkill(tmp, "verify-before-completion", SKILL_MD);
    const provider = new CogcorePlaybookProvider();
    await provider.initialize({ playbooksDir: tmp });
    expect(await provider.isAvailable()).toBe(true);

    const fragments = await provider.enrichTurn({ query: "verify the testing changes" });
    expect(fragments).toHaveLength(1);
    expect(fragments[0].source).toBe("cogcore-playbook:pb-verify-1");
    expect(fragments[0].content).toContain("## Playbook: verify-before-completion");
    expect(fragments[0].skill).toEqual({
      id: "pb-verify-1",
      name: "verify-before-completion",
      sourceType: "cognitive-core",
    });
  });

  it("returns nothing for unrelated queries", async () => {
    writeSkill(tmp, "verify-before-completion", SKILL_MD);
    const provider = new CogcorePlaybookProvider();
    await provider.initialize({ playbooksDir: tmp });
    expect(await provider.enrichTurn({ query: "deploy kubernetes ingress" })).toEqual([]);
  });

  it("supports explicit search with a limit", async () => {
    writeSkill(tmp, "verify-before-completion", SKILL_MD);
    writeSkill(
      tmp,
      "another-verify",
      SKILL_MD.replace("verify-before-completion", "another-verify").replace(
        "pb-verify-1",
        "pb-verify-2",
      ),
    );
    const provider = new CogcorePlaybookProvider();
    await provider.initialize({ playbooksDir: tmp });
    const results = await provider.search("verify", { limit: 1 });
    expect(results).toHaveLength(1);
  });
});
