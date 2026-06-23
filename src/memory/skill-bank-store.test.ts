import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSkillBankStore } from "./skill-bank-store.js";

let tmpDir: string | undefined;

function newDbPath(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-bank-test-"));
  return path.join(tmpDir, "skills.db");
}

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe("SkillBankStore", () => {
  it("saves and retrieves a skill", async () => {
    const store = await createSkillBankStore({ dbPath: newDbPath() });
    await store.save({
      name: "deploy-staging",
      tags: ["deploy", "staging"],
      content: "1. Build\n2. Push\n3. Verify",
    });

    const skill = await store.get("deploy-staging");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("deploy-staging");
    expect(skill!.tags).toEqual(["deploy", "staging"]);
    expect(skill!.content).toContain("Build");
  });

  it("returns null for missing skill", async () => {
    const store = await createSkillBankStore({ dbPath: newDbPath() });
    expect(await store.get("nope")).toBeNull();
  });

  it("lists all skills", async () => {
    const store = await createSkillBankStore({ dbPath: newDbPath() });
    await store.save({ name: "a", tags: [], content: "Alpha" });
    await store.save({ name: "b", tags: [], content: "Beta" });
    expect(await store.list()).toHaveLength(2);
  });

  it("updates existing skill in place", async () => {
    const store = await createSkillBankStore({ dbPath: newDbPath() });
    await store.save({ name: "s1", tags: ["v1"], content: "Version one" });
    await store.save({ name: "s1", tags: ["v2"], content: "Version two" });

    const skill = await store.get("s1");
    expect(skill!.content).toBe("Version two");
    expect(skill!.tags).toEqual(["v2"]);
    expect(await store.list()).toHaveLength(1);
  });

  it("removes a skill", async () => {
    const store = await createSkillBankStore({ dbPath: newDbPath() });
    await store.save({ name: "temp", tags: [], content: "temporary" });
    expect(await store.remove("temp")).toBe(true);
    expect(await store.get("temp")).toBeNull();
  });

  it("remove returns false for missing skill", async () => {
    const store = await createSkillBankStore({ dbPath: newDbPath() });
    expect(await store.remove("nonexistent")).toBe(false);
  });

  it("rejects a different name that collides with an existing skill's id", async () => {
    const store = await createSkillBankStore({ dbPath: newDbPath() });
    await store.save({ name: "deploy", tags: [], content: "first" });

    // "Deploy" slugifies to the same id "deploy" but is a distinct name —
    // saving it must not silently clobber the original.
    await expect(
      store.save({ name: "Deploy", tags: [], content: "second" }),
    ).rejects.toThrow(/collide/i);
    expect((await store.get("deploy"))!.content).toBe("first");

    // Re-saving the SAME name is an update, not a collision.
    await store.save({ name: "deploy", tags: [], content: "updated" });
    expect((await store.get("deploy"))!.content).toBe("updated");
  });

  it("searches by tag, name, and content", async () => {
    const store = await createSkillBankStore({ dbPath: newDbPath() });
    await store.save({ name: "deploy", tags: ["deploy", "ci"], content: "ship it" });
    await store.save({ name: "db-migrate", tags: ["database"], content: "run prisma migrate" });

    expect((await store.search("deploy")).map((s) => s.name)).toEqual(["deploy"]);
    expect((await store.search("prisma")).map((s) => s.name)).toEqual(["db-migrate"]);
    expect((await store.search("database")).map((s) => s.name)).toEqual(["db-migrate"]);
  });

  it("tolerates FTS operator characters in the query", async () => {
    const store = await createSkillBankStore({ dbPath: newDbPath() });
    await store.save({ name: "run-tests", tags: [], content: "npm test" });

    // Hyphen is a NOT operator in raw FTS5; the store must sanitize it.
    const results = await store.search("run-tests");
    expect(results.map((s) => s.name)).toContain("run-tests");
  });

  it("respects search limit", async () => {
    const store = await createSkillBankStore({ dbPath: newDbPath() });
    for (let i = 0; i < 10; i++) {
      await store.save({ name: `skill-${i}`, tags: ["common"], content: "procedure" });
    }
    expect(await store.search("common", 3)).toHaveLength(3);
  });

  it("persists across a store reopen (durable)", async () => {
    const dbPath = newDbPath();

    const first = await createSkillBankStore({ dbPath });
    await first.save({ name: "persisted", tags: ["keep"], content: "still here" });

    // A fresh store over the same file must see the saved skill.
    const second = await createSkillBankStore({ dbPath });
    const skill = await second.get("persisted");
    expect(skill).not.toBeNull();
    expect(skill!.content).toBe("still here");
    expect(skill!.tags).toEqual(["keep"]);
  });
});
