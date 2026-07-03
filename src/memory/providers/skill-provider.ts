/**
 * SkillProvider — read-only memory provider that surfaces skill-tree skills.
 *
 * Reads skill-tree's FILESYSTEM skill store (SKILL.md files) — the ecosystem's
 * canonical source of truth, written out-of-band by openhive / cognitive-core /
 * the indexer. It uses skill-tree's `FilesystemStorageAdapter`, which is pure
 * filesystem (no SQLite, no native addon), so it is safe inside the Bun binary.
 *
 * Consumption only: ingest and learning happen elsewhere (sessionlog +
 * cognitive-core, async). At each turn we surface the most relevant skills via
 * BM25 search over the store. Best-effort — never throws, never blocks the turn.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import type {
  MemoryProvider,
  MemoryCapabilities,
  ProviderConfig,
  MemoryFragment,
  TurnContext,
} from "../types.js";

// ---------------------------------------------------------------------------
// Dynamic import wrapper — skill-tree's filesystem adapter (pure JS)
// ---------------------------------------------------------------------------

interface SkillRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly tags: readonly string[];
}

interface FilesystemSkillReader {
  initialize(): Promise<void>;
  searchSkills(query: string): Promise<SkillRecord[]>;
  listSkills(): Promise<SkillRecord[]>;
}

interface SkillTreeModule {
  FilesystemStorageAdapter: new (config: { basePath: string }) => FilesystemSkillReader;
}

async function tryLoadSkillTree(): Promise<SkillTreeModule | null> {
  try {
    return (await import("skill-tree")) as unknown as SkillTreeModule;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Store-path resolution — supports BOTH swarmkit-shared and standalone
// ---------------------------------------------------------------------------

/**
 * Resolve the skills directory — the skill-tree filesystem `basePath`.
 *
 * skill-tree's FilesystemStorageAdapter stores skills under
 * `<basePath>/.skilltree/skills`, and openhive/cognitive-core write the shared
 * ecosystem store the same way with a default basePath of `~/.skill-tree`
 * (openhive `skill-management.ts`: `skilltreeDir = join(localPath, '.skilltree')`).
 * To read that store, openswarm must point at the same basePath:
 *   1. Explicit override — config or `OPENSWARM_SKILLS_DIR`.
 *   2. Ecosystem default — `~/.skill-tree`.
 *
 * (openhive can be configured with additional `globalSkillPaths`, e.g.
 * `~/.claude/skills`; those use a different on-disk layout and would need
 * multi-store support here, so they are out of scope — use the override to
 * point at a specific store.)
 */
export function resolveSkillsDir(override?: string): string {
  if (override && override.length > 0) return override;

  const env = process.env.OPENSWARM_SKILLS_DIR;
  if (env && env.length > 0) return env;

  return path.join(os.homedir(), ".skill-tree");
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface SkillProviderConfig {
  /** Override the skills directory (skill-tree filesystem basePath). */
  skillsDir?: string;
  /** Max skills to surface per turn (default 3). */
  maxResults?: number;
}

export class SkillProvider implements MemoryProvider {
  readonly name = "skills";
  readonly capabilities: MemoryCapabilities = {
    enrichment: true,
    persistence: false,
    search: true,
    graph: false,
  };

  private reader: FilesystemSkillReader | null = null;
  private config: SkillProviderConfig = {};

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config as SkillProviderConfig;
    const skillsDir = resolveSkillsDir(this.config.skillsDir);

    // Only activate when the directory is actually a skill-tree bank
    // (`<basePath>/.skilltree` exists). Existence of the basePath alone is
    // not enough: the adapter's initialize() would mkdir `.skilltree/` inside
    // it, so activating on a non-bank directory (e.g. OPENSWARM_SKILLS_DIR
    // mispointed at ~/.claude/skills, which uses a different layout) would
    // read zero skills AND drop clutter into a user-managed directory.
    // We never create the bank — publishing (cogcore/openhive) does.
    if (!fs.existsSync(path.join(skillsDir, ".skilltree"))) return;

    const mod = await tryLoadSkillTree();
    if (!mod) return;

    try {
      const reader = new mod.FilesystemStorageAdapter({ basePath: skillsDir });
      await reader.initialize();
      this.reader = reader;
    } catch {
      this.reader = null;
    }
  }

  async shutdown(): Promise<void> {
    this.reader = null;
  }

  async isAvailable(): Promise<boolean> {
    return this.reader !== null;
  }

  async enrichTurn(context: TurnContext): Promise<MemoryFragment[]> {
    if (!this.reader || !context.query) return [];
    const maxResults = this.config.maxResults ?? 3;

    try {
      // skill-tree's BM25 requires every corpus-present query term to appear
      // in the same skill (AND semantics). Task prompts are long natural-
      // language sentences, so as the bank grows past one skill this yields
      // zero hits (live-validated). Try it first (precise when it hits), then
      // fall back to local OR-style lexical overlap ranking.
      let results = await this.reader.searchSkills(context.query);
      if (results.length === 0) {
        results = rankByTokenOverlap(await this.reader.listSkills(), context.query);
      }
      return results.slice(0, maxResults).map((s) => ({
        source: `skill:${s.id}`,
        content: formatSkill(s),
        skill: { id: s.id, name: s.name, sourceType: "skill-tree" },
      }));
    } catch {
      return [];
    }
  }

  // Read-only: writes/learning happen out-of-band (sessionlog + cognitive-core).
  async onMemoryWrite(): Promise<void> {}
  async onTurnComplete(): Promise<void> {}
  async onCompress(): Promise<void> {}
}

function formatSkill(s: SkillRecord): string {
  const tagLine = s.tags.length > 0 ? ` [${s.tags.join(", ")}]` : "";
  const body = s.instructions.trim() || s.description.trim();
  return `## Skill: ${s.name}${tagLine}\n${body}`;
}

// ---------------------------------------------------------------------------
// OR-style fallback ranking (distinct-token overlap, field-weighted)
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

/**
 * Rank skills by distinct-token overlap with the query — any shared term
 * counts (OR semantics), weighted name/tags 3x, description 2x,
 * instructions 1x. Zero-score skills are dropped.
 */
export function rankByTokenOverlap(
  skills: readonly SkillRecord[],
  query: string,
): SkillRecord[] {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return [];

  return skills
    .map((s) => {
      const strong = new Set([...tokenize(s.name), ...s.tags.flatMap(tokenize)]);
      const meta = new Set(tokenize(s.description));
      const body = new Set(tokenize(s.instructions));
      let score = 0;
      for (const token of queryTokens) {
        if (strong.has(token)) score += 3;
        else if (meta.has(token)) score += 2;
        else if (body.has(token)) score += 1;
      }
      return { skill: s, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.skill);
}
