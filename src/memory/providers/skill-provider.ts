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

    // Only activate when the skills directory exists — otherwise the
    // coordinator skips us (isAvailable() === false). We never create it.
    if (!fs.existsSync(skillsDir)) return;

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
      const results = await this.reader.searchSkills(context.query);
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
