/**
 * CogcorePlaybookProvider — read-only memory provider that surfaces
 * cognitive-core's canonical procedural playbooks.
 *
 * Post-walkback, cognitive-core's stable procedural memory is
 * filesystem-first: `<storage>/playbooks/<slug>/SKILL.md` files with YAML
 * frontmatter (generic `name`/`description`/`tags` plus a namespaced `ccore`
 * block). This provider reads that store directly, closing the local learning
 * loop: openswarm records sessions → `cogcore run --once` (auto-consolidate)
 * extracts playbooks → this provider surfaces them at the next turn. It does
 * NOT replace the SkillProvider (the shared `~/.skill-tree` ecosystem store);
 * the two stores have different layouts and provenance.
 *
 * Read-only, best-effort: never throws, never blocks the turn, no writes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  MemoryProvider,
  MemoryCapabilities,
  ProviderConfig,
  MemoryFragment,
  TurnContext,
} from "../types.js";

const SKILL_FILE = "SKILL.md";
const IGNORED_DIRS = new Set(["node_modules", ".git", ".candidates"]);
const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const MAX_BODY_CHARS = 4_000;

export interface CogcorePlaybook {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly body: string;
}

/**
 * Resolve the cognitive-core canonical playbooks directory for a repo.
 * Mirrors cogcore's own storage resolution (`resolveStorageDir` in
 * cli-utils.ts): COGNITIVE_CORE_HOME, then the per-repo namespaced dirs
 * (`.openswarm`/`.swarm` during the namespace migration), then the
 * standalone `.cognitive-core`. Returns null when no store exists.
 */
export function resolveCogcorePlaybooksDir(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const override = env.OPENSWARM_COGCORE_PLAYBOOKS_DIR;
  if (override && override.length > 0) {
    return fs.existsSync(override) ? override : null;
  }

  const roots: string[] = [];
  if (env.COGNITIVE_CORE_HOME && env.COGNITIVE_CORE_HOME.length > 0) {
    roots.push(env.COGNITIVE_CORE_HOME);
  }
  roots.push(
    path.join(cwd, ".openswarm", "cognitive-core"),
    path.join(cwd, ".swarm", "cognitive-core"),
    path.join(cwd, ".cognitive-core"),
  );

  for (const root of roots) {
    const dir = path.join(root, "playbooks");
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

/** Parse one canonical SKILL.md; returns null when malformed or non-procedural. */
export function parseCanonicalSkillMd(markdown: string): CogcorePlaybook | null {
  const match = markdown.match(FRONTMATTER_REGEX);
  if (!match) return null;

  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(match[1]);
  } catch {
    return null;
  }
  if (typeof frontmatter !== "object" || frontmatter === null) return null;
  const fm = frontmatter as Record<string, unknown>;

  const ccore = fm.ccore;
  if (typeof ccore !== "object" || ccore === null) return null;
  const cc = ccore as Record<string, unknown>;
  if (cc.kind !== "procedural") return null;

  const name = typeof fm.name === "string" ? fm.name : "";
  if (name.length === 0) return null;
  const id = typeof cc.id === "string" && cc.id.length > 0 ? cc.id : name;

  return {
    id,
    name,
    description: typeof fm.description === "string" ? fm.description : "",
    tags: Array.isArray(fm.tags)
      ? fm.tags.filter((t): t is string => typeof t === "string")
      : [],
    body: match[2].trim(),
  };
}

/** Scan `<dir>/<slug>/SKILL.md` files (one level, matching cogcore's layout). */
export function loadCogcorePlaybooks(dir: string): CogcorePlaybook[] {
  const playbooks: CogcorePlaybook[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return playbooks;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
    const file = path.join(dir, entry.name, SKILL_FILE);
    try {
      const parsed = parseCanonicalSkillMd(fs.readFileSync(file, "utf8"));
      if (parsed) playbooks.push(parsed);
    } catch {
      // missing/unreadable SKILL.md — skip
    }
  }
  return playbooks;
}

// ---------------------------------------------------------------------------
// Scoring — lightweight lexical relevance, no deps
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

/** Distinct-term overlap with field weighting (name 3x, tags/description 2x, body 1x). */
export function scorePlaybook(playbook: CogcorePlaybook, queryTokens: readonly string[]): number {
  if (queryTokens.length === 0) return 0;
  const name = new Set(tokenize(playbook.name));
  const meta = new Set([...tokenize(playbook.description), ...playbook.tags.flatMap(tokenize)]);
  const body = new Set(tokenize(playbook.body));

  let score = 0;
  for (const token of new Set(queryTokens)) {
    if (name.has(token)) score += 3;
    else if (meta.has(token)) score += 2;
    else if (body.has(token)) score += 1;
  }
  return score;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface CogcorePlaybookProviderConfig {
  /** Override the playbooks directory. */
  playbooksDir?: string;
  /** Max playbooks to surface per turn (default 2). */
  maxResults?: number;
}

export class CogcorePlaybookProvider implements MemoryProvider {
  readonly name = "cogcore-playbooks";
  readonly capabilities: MemoryCapabilities = {
    enrichment: true,
    persistence: false,
    search: true,
    graph: false,
  };

  private playbooks: CogcorePlaybook[] = [];
  private config: CogcorePlaybookProviderConfig = {};

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config as CogcorePlaybookProviderConfig;
    const dir =
      this.config.playbooksDir !== undefined && this.config.playbooksDir.length > 0
        ? this.config.playbooksDir
        : resolveCogcorePlaybooksDir(process.cwd());
    if (dir === null || !fs.existsSync(dir)) return;
    this.playbooks = loadCogcorePlaybooks(dir);
  }

  async shutdown(): Promise<void> {
    this.playbooks = [];
  }

  async isAvailable(): Promise<boolean> {
    return this.playbooks.length > 0;
  }

  async enrichTurn(context: TurnContext): Promise<MemoryFragment[]> {
    if (!context.query) return [];
    return this.rank(context.query, this.config.maxResults ?? 2);
  }

  async search(query: string, opts?: { readonly limit?: number }): Promise<MemoryFragment[]> {
    return this.rank(query, opts?.limit ?? 5);
  }

  // Read-only: learning happens out-of-band (cogcore run/dream).
  async onMemoryWrite(): Promise<void> {}
  async onTurnComplete(): Promise<void> {}
  async onCompress(): Promise<void> {}

  private rank(query: string, limit: number): MemoryFragment[] {
    const queryTokens = tokenize(query);
    return this.playbooks
      .map((p) => ({ playbook: p, score: scorePlaybook(p, queryTokens) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => ({
        source: `cogcore-playbook:${r.playbook.id}`,
        content: formatPlaybook(r.playbook),
        relevance: r.score,
        skill: {
          id: r.playbook.id,
          name: r.playbook.name,
          sourceType: "cognitive-core",
        },
      }));
  }
}

function formatPlaybook(p: CogcorePlaybook): string {
  const tagLine = p.tags.length > 0 ? ` [${p.tags.join(", ")}]` : "";
  const body = p.body.length > MAX_BODY_CHARS ? `${p.body.slice(0, MAX_BODY_CHARS)}\n…` : p.body;
  const text = body.length > 0 ? body : p.description;
  return `## Playbook: ${p.name}${tagLine}\n${text}`;
}
