/**
 * Skills (Layer 2) — procedural memory as reusable "how-to" files.
 *
 * Skills are stored in a directory as small Markdown files with YAML-like
 * headers. They capture processes and procedures the agent has learned.
 * Retrieved by tag/keyword matching during enrichTurn.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Skill {
  readonly name: string;
  readonly tags: readonly string[];
  readonly content: string;
  readonly createdAt?: string;
}

// ---------------------------------------------------------------------------
// Skill store interface
// ---------------------------------------------------------------------------

export interface SkillStore {
  save(skill: Skill): void;
  get(name: string): Skill | null;
  list(): Skill[];
  search(query: string, limit?: number): Skill[];
  remove(name: string): boolean;
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

class InMemorySkillStore implements SkillStore {
  private data = new Map<string, Skill>();

  save(skill: Skill): void {
    this.data.set(skill.name, skill);
  }

  get(name: string): Skill | null {
    return this.data.get(name) ?? null;
  }

  list(): Skill[] {
    return [...this.data.values()];
  }

  search(query: string, limit = 5): Skill[] {
    const lower = query.toLowerCase();
    const results: Skill[] = [];

    for (const skill of this.data.values()) {
      const matchesTag = skill.tags.some((t) =>
        t.toLowerCase().includes(lower),
      );
      const matchesName = skill.name.toLowerCase().includes(lower);
      const matchesContent = skill.content.toLowerCase().includes(lower);

      if (matchesTag || matchesName || matchesContent) {
        results.push(skill);
        if (results.length >= limit) break;
      }
    }

    return results;
  }

  remove(name: string): boolean {
    return this.data.delete(name);
  }
}

// ---------------------------------------------------------------------------
// File-based store
// ---------------------------------------------------------------------------

export class FileSkillStore implements SkillStore {
  constructor(private directory: string) {
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }
  }

  save(skill: Skill): void {
    const filePath = this.skillPath(skill.name);
    const header = [
      "---",
      `name: ${skill.name}`,
      `tags: [${skill.tags.join(", ")}]`,
      `created: ${skill.createdAt ?? new Date().toISOString().split("T")[0]}`,
      "---",
    ].join("\n");
    fs.writeFileSync(filePath, `${header}\n${skill.content}\n`, "utf8");
  }

  get(name: string): Skill | null {
    const filePath = this.skillPath(name);
    if (!fs.existsSync(filePath)) return null;
    return this.parseSkillFile(filePath, name);
  }

  list(): Skill[] {
    if (!fs.existsSync(this.directory)) return [];
    const files = fs.readdirSync(this.directory).filter((f) => f.endsWith(".md"));
    return files
      .map((f) => this.parseSkillFile(path.join(this.directory, f), f.replace(/\.md$/, "")))
      .filter((s): s is Skill => s !== null);
  }

  search(query: string, limit = 5): Skill[] {
    const lower = query.toLowerCase();
    const results: Skill[] = [];

    for (const skill of this.list()) {
      const matchesTag = skill.tags.some((t) =>
        t.toLowerCase().includes(lower),
      );
      const matchesName = skill.name.toLowerCase().includes(lower);
      const matchesContent = skill.content.toLowerCase().includes(lower);

      if (matchesTag || matchesName || matchesContent) {
        results.push(skill);
        if (results.length >= limit) break;
      }
    }

    return results;
  }

  remove(name: string): boolean {
    const filePath = this.skillPath(name);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }

  private skillPath(name: string): string {
    const safeName = name.replace(/[^a-z0-9_-]/gi, "-");
    return path.join(this.directory, `${safeName}.md`);
  }

  private parseSkillFile(filePath: string, fallbackName: string): Skill | null {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      return parseSkillContent(raw, fallbackName);
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseSkillContent(raw: string, fallbackName: string): Skill {
  const lines = raw.split("\n");
  let name = fallbackName;
  let tags: string[] = [];
  let createdAt: string | undefined;
  let contentStart = 0;

  if (lines[0]?.trim() === "---") {
    let endIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === "---") {
        endIdx = i;
        break;
      }
    }

    if (endIdx > 0) {
      contentStart = endIdx + 1;
      for (let i = 1; i < endIdx; i++) {
        const line = lines[i]!.trim();
        if (line.startsWith("name:")) {
          name = line.slice(5).trim();
        } else if (line.startsWith("tags:")) {
          const tagStr = line.slice(5).trim();
          const match = tagStr.match(/\[([^\]]*)\]/);
          if (match) {
            tags = match[1]!
              .split(",")
              .map((t) => t.trim())
              .filter((t) => t.length > 0);
          }
        } else if (line.startsWith("created:")) {
          createdAt = line.slice(8).trim();
        }
      }
    }
  }

  const content = lines
    .slice(contentStart)
    .join("\n")
    .trim();

  return { name, tags, content, createdAt };
}

// ---------------------------------------------------------------------------
// Skill formatting
// ---------------------------------------------------------------------------

export function formatSkill(skill: Skill): string {
  const tagLine = skill.tags.length > 0 ? `Tags: ${skill.tags.join(", ")}` : "";
  const lines = [`## Skill: ${skill.name}`];
  if (tagLine) lines.push(tagLine);
  lines.push("", skill.content);
  return lines.join("\n");
}

export function formatSkillList(skills: Skill[]): string {
  if (skills.length === 0) return "No skills saved.";
  return skills
    .map(
      (s, i) =>
        `${i + 1}. **${s.name}**${s.tags.length > 0 ? ` [${s.tags.join(", ")}]` : ""}`,
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _store: SkillStore = new InMemorySkillStore();

export function getSkillStore(): SkillStore {
  return _store;
}

export function setSkillStore(store: SkillStore): void {
  _store = store;
}

export function resetSkillStore(): void {
  _store = new InMemorySkillStore();
}
