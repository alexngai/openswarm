/**
 * SkillBankStore — a {@link SkillStore} backed by the `skill-tree` library.
 *
 * This is the durable, cross-runtime skill backend: skill-tree persists to
 * SQLite via its `NodeSqliteStorageAdapter` (`node:sqlite`), which works under
 * Node, Bun, and compiled single-file binaries with no native addon. It also
 * unlocks skill-tree's lifecycle features (versioning, lineage, namespaces)
 * that later phases build on.
 *
 * The store maps swarm-harness's lightweight {@link Skill} ({name, tags,
 * content}) onto skill-tree's richer model: `name` → slugified `id`, `content`
 * → `instructions`, with a derived `description` and sensible version/status
 * defaults. See docs/40-memory-system-design.md (Layer 2).
 */

import {
  createSkillBank,
  NodeSqliteStorageAdapter,
  type SkillBank,
  type Skill as SkillTreeSkill,
} from "skill-tree";
import type { Skill, SkillStore } from "./skills.js";

export interface SkillBankStoreOptions {
  /** Absolute path to the SQLite database file backing the skill store. */
  dbPath: string;
  /** Author recorded on saved skills (typically the agent id). */
  author?: string;
  /** Owning agent id — enables swarm-scoped skills (groundwork for later phases). */
  agentId?: string;
  /** Team the agent belongs to (for team-scoped skills). */
  team?: string;
}

/** Slugify a skill name into a stable, skill-tree-compatible id. */
function toId(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "skill"
  );
}

/** First non-empty line of the content, used as a short description. */
function deriveDescription(content: string): string {
  const firstLine =
    content
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return firstLine.slice(0, 200);
}

/**
 * Turn a free-form query into a safe FTS5 MATCH expression.
 *
 * skill-tree searches via SQLite FTS5, whose query syntax treats `-`, `*`,
 * `"`, `:`, etc. as operators (e.g. `run-tests` parses as `run NOT tests`).
 * We extract alphanumeric tokens, quote each, and OR them together — robust
 * recall that mirrors the legacy substring-any-field behavior. Returns "" when
 * the query has no usable tokens.
 */
function toFtsQuery(raw: string): string {
  const tokens = raw.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

export class SkillBankStore implements SkillStore {
  constructor(
    private readonly bank: SkillBank,
    private readonly author: string,
  ) {}

  async save(skill: Skill): Promise<void> {
    const id = toId(skill.name);
    const existing = await this.bank.getSkill(id);

    // Guard against silent data loss: distinct names can slugify to the same
    // id (e.g. "Deploy", "deploy", "deploy_"). Saving would otherwise
    // INSERT-OR-REPLACE over an unrelated skill. Re-saving the SAME name
    // (an update) is fine — only a different name on the same id is rejected.
    if (existing && existing.name !== skill.name) {
      throw new Error(
        `skill name "${skill.name}" collides with existing skill "${existing.name}" ` +
          `(both map to id "${id}") — choose a distinct name`,
      );
    }

    const now = new Date();
    const createdAt =
      existing?.createdAt ??
      (skill.createdAt ? new Date(skill.createdAt) : now);

    await this.bank.saveSkill({
      id,
      name: skill.name,
      // Preserve the current version on update; new skills start at 1.0.0.
      // Explicit version bumps are a later-phase concern.
      version: existing?.version ?? "1.0.0",
      description: deriveDescription(skill.content),
      instructions: skill.content,
      author: this.author,
      tags: [...skill.tags],
      status: "active",
      createdAt,
      updatedAt: now,
    });
  }

  async get(name: string): Promise<Skill | null> {
    const st = await this.bank.getSkill(toId(name));
    return st ? this.toSkill(st) : null;
  }

  async list(): Promise<Skill[]> {
    const skills = await this.bank.listSkills();
    return skills.map((s) => this.toSkill(s));
  }

  async search(query: string, limit = 5): Promise<Skill[]> {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    let results: SkillTreeSkill[];
    try {
      results = await this.bank.searchSkills(fts);
    } catch {
      // A malformed FTS expression should degrade to "no results", not throw.
      return [];
    }
    return results.slice(0, limit).map((s) => this.toSkill(s));
  }

  async remove(name: string): Promise<boolean> {
    return this.bank.deleteSkill(toId(name));
  }

  private toSkill(st: SkillTreeSkill): Skill {
    const createdAt =
      st.createdAt instanceof Date
        ? st.createdAt.toISOString().split("T")[0]
        : String(st.createdAt);
    return {
      name: st.name,
      tags: [...st.tags],
      content: st.instructions,
      createdAt,
    };
  }
}

/**
 * Build a SkillBankStore backed by an on-disk SQLite database via skill-tree's
 * cross-runtime `node:sqlite` adapter. Requires Node >= 22.5 (or Bun).
 */
export async function createSkillBankStore(
  options: SkillBankStoreOptions,
): Promise<SkillBankStore> {
  const storage = new NodeSqliteStorageAdapter({ dbPath: options.dbPath });
  const bank = createSkillBank({
    storage,
    ...(options.agentId
      ? {
          namespace: {
            agentId: options.agentId,
            ...(options.team ? { team: options.team } : {}),
          },
        }
      : {}),
  });
  await bank.initialize();
  return new SkillBankStore(
    bank,
    options.author ?? options.agentId ?? "swarm-harness",
  );
}
