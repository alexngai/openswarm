/**
 * ClaudeCodeSource — discovers and loads skills from the local filesystem.
 *
 * Path priority order (first-match-wins per skill id):
 *
 *  1. $CODEX_HOME/skills                          (if CODEX_HOME is set)
 *  2. $CLAUDE_CONFIG_DIR/skills                   (if CLAUDE_CONFIG_DIR is set)
 *  3. For each ancestor of cwd (bounded by maxAncestorDepth, default 10):
 *       <dir>/.claude/skills
 *       <dir>/.codex/skills
 *       <dir>/.claw/skills
 *       <dir>/.omc/skills
 *  4. $HOME/.claude/skills
 *  5. $HOME/.codex/skills
 *  6. $HOME/.claw/skills
 *  7. $HOME/.omc/skills
 *
 * Skill layout:
 *   Canonical:  <root>/<skill-id>/SKILL.md
 *   Legacy:     <root>/<skill-id>.md
 *
 * Frontmatter: hand-rolled inline parser (no YAML dep). Supports strings,
 * arrays of strings, and booleans. Multi-line block scalar values (|, >) are
 * NOT supported — description must be single-line. Limitation documented here.
 *
 * De-dup: first path-wins per skill id across all roots.
 * Safety cap: per-directory scan capped at 500 entries (warns on cap hit).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { SkillSource, SkillManifest, LoadedSkill } from "./index.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ClaudeCodeSkillSourceOptions {
  /** Default: process.cwd() */
  readonly cwd?: string;
  /** Default: os.homedir() — injectable for tests */
  readonly homedir?: string;
  /** Injectable env for tests */
  readonly envOverrides?: NodeJS.ProcessEnv;
  /** Max ancestor directories to walk (default 10) */
  readonly maxAncestorDepth?: number;
}

// ---------------------------------------------------------------------------
// Inline frontmatter parser
// ---------------------------------------------------------------------------

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  triggers?: string[];
  [key: string]: unknown;
}

/**
 * Parse YAML-like frontmatter. Supports:
 *   - string scalars:  key: value
 *   - boolean:         key: true / false
 *   - arrays:          key:\n  - item1\n  - item2
 *
 * Does NOT support multi-line block scalars (| or >). Returns null if
 * parsing fails.
 */
function parseFrontmatter(raw: string): ParsedFrontmatter | null {
  const result: ParsedFrontmatter = {};
  const lines = raw.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Skip blank lines at top level.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Top-level key: value
    const kvMatch = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!kvMatch) {
      // Unrecognized line structure — skip.
      i++;
      continue;
    }

    const key = kvMatch[1]!;
    const rest = kvMatch[2]!.trim();

    // Array value: key with empty rest, followed by "  - item" lines.
    if (rest === "") {
      const items: string[] = [];
      i++;
      while (i < lines.length) {
        const itemLine = lines[i]!;
        const itemMatch = itemLine.match(/^\s+-\s+(.+)$/);
        if (itemMatch) {
          items.push(itemMatch[1]!.replace(/^["']|["']$/g, ""));
          i++;
        } else {
          break;
        }
      }
      result[key] = items;
      continue;
    }

    // Block scalar indicators are unsupported — skip key.
    if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-") {
      // Skip the block — advance past indented continuation lines.
      i++;
      while (i < lines.length && /^\s/.test(lines[i]!)) {
        i++;
      }
      continue;
    }

    // Boolean.
    if (rest === "true") {
      result[key] = true;
      i++;
      continue;
    }
    if (rest === "false") {
      result[key] = false;
      i++;
      continue;
    }

    // Plain string (strip optional surrounding quotes).
    result[key] = rest.replace(/^["']|["']$/g, "");
    i++;
  }

  return result;
}

/**
 * Split raw file content into frontmatter block and body.
 * Returns null if the file does not start with `---`.
 */
function splitFrontmatter(content: string): { fm: string; body: string } | null {
  if (!content.startsWith("---")) {
    return null;
  }
  const afterOpen = content.slice(3);
  // Find closing ---
  const closeIdx = afterOpen.indexOf("\n---");
  if (closeIdx === -1) {
    return null;
  }
  const fm = afterOpen.slice(0, closeIdx).trim();
  let body = afterOpen.slice(closeIdx + 4); // skip "\n---"
  // Skip a single trailing newline after the closing ---
  if (body.startsWith("\n")) {
    body = body.slice(1);
  }
  // Strip exactly one leading blank line from body (per LoadedSkill JSDoc).
  if (body.startsWith("\n")) {
    body = body.slice(1);
  }
  return { fm, body };
}

// ---------------------------------------------------------------------------
// ClaudeCodeSource
// ---------------------------------------------------------------------------

const MAX_DIR_ENTRIES = 500;
const SOURCE_ID = "claude-code";

export class ClaudeCodeSource implements SkillSource {
  readonly id = SOURCE_ID;

  private readonly cwd: string;
  private readonly homedir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly maxAncestorDepth: number;

  constructor(opts?: ClaudeCodeSkillSourceOptions) {
    this.cwd = opts?.cwd ?? process.cwd();
    this.homedir = opts?.homedir ?? os.homedir();
    this.env = opts?.envOverrides ?? process.env;
    this.maxAncestorDepth = opts?.maxAncestorDepth ?? 10;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async discover(): Promise<readonly SkillManifest[]> {
    const roots = this._buildRoots();
    // De-dup: first-wins by skill id.
    const seen = new Map<string, SkillManifest>();

    for (const root of roots) {
      const manifests = await this._scanRoot(root);
      for (const m of manifests) {
        if (!seen.has(m.id)) {
          seen.set(m.id, m);
        }
      }
    }

    return Array.from(seen.values());
  }

  async load(skillId: string): Promise<LoadedSkill | undefined> {
    const roots = this._buildRoots();

    for (const root of roots) {
      const result = await this._tryLoadFromRoot(root, skillId);
      if (result !== undefined) {
        return result;
      }
    }

    return undefined;
  }

  // -------------------------------------------------------------------------
  // Path hierarchy
  // -------------------------------------------------------------------------

  private _buildRoots(): string[] {
    const roots: string[] = [];

    // 1. $CODEX_HOME/skills
    const codexHome = this.env["CODEX_HOME"];
    if (codexHome) {
      roots.push(path.join(codexHome, "skills"));
    }

    // 2. $CLAUDE_CONFIG_DIR/skills
    const claudeConfigDir = this.env["CLAUDE_CONFIG_DIR"];
    if (claudeConfigDir) {
      roots.push(path.join(claudeConfigDir, "skills"));
    }

    // 3. Ancestor walk from cwd.
    const ancestors = this._ancestors();
    for (const dir of ancestors) {
      roots.push(path.join(dir, ".claude", "skills"));
      roots.push(path.join(dir, ".codex", "skills"));
      roots.push(path.join(dir, ".claw", "skills"));
      roots.push(path.join(dir, ".omc", "skills"));
    }

    // 4-7. Home directory roots.
    roots.push(path.join(this.homedir, ".claude", "skills"));
    roots.push(path.join(this.homedir, ".codex", "skills"));
    roots.push(path.join(this.homedir, ".claw", "skills"));
    roots.push(path.join(this.homedir, ".omc", "skills"));

    return roots;
  }

  /**
   * Walk ancestors of cwd up to maxAncestorDepth levels above cwd.
   * Always includes cwd itself (depth=0). Walks up maxAncestorDepth
   * additional ancestor directories.
   */
  private _ancestors(): string[] {
    const dirs: string[] = [];
    let current = path.resolve(this.cwd);

    // Always include cwd itself.
    dirs.push(current);

    // Walk up to maxAncestorDepth ancestor directories.
    for (let depth = 0; depth < this.maxAncestorDepth; depth++) {
      const parent = path.dirname(current);
      if (parent === current) break; // filesystem root
      dirs.push(parent);
      current = parent;
    }

    return dirs;
  }

  // -------------------------------------------------------------------------
  // Scanning
  // -------------------------------------------------------------------------

  /**
   * Scan a single root directory for skills. Returns manifests found.
   * Silently skips unreadable directories.
   */
  private async _scanRoot(root: string): Promise<SkillManifest[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }

    if (entries.length > MAX_DIR_ENTRIES) {
      process.stderr.write(
        `[openswarm] skills: directory entry cap (${MAX_DIR_ENTRIES}) hit in ${root} — some skills may be hidden\n`,
      );
      entries = entries.slice(0, MAX_DIR_ENTRIES);
    }

    const manifests: SkillManifest[] = [];

    for (const entry of entries) {
      // Canonical layout: <id>/SKILL.md
      if (entry.isDirectory()) {
        const skillId = entry.name;
        const filePath = path.join(root, skillId, "SKILL.md");
        const manifest = await this._tryParseFile(skillId, filePath);
        if (manifest !== undefined) {
          manifests.push(manifest);
        }
        continue;
      }

      // Legacy flat layout: <id>.md
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const skillId = entry.name.slice(0, -3); // strip .md
        const filePath = path.join(root, entry.name);
        const manifest = await this._tryParseFile(skillId, filePath);
        if (manifest !== undefined) {
          manifests.push(manifest);
        }
      }
    }

    return manifests;
  }

  /** Try to load and parse a skill file into a manifest. Returns undefined on failure. */
  private async _tryParseFile(
    skillId: string,
    filePath: string,
  ): Promise<SkillManifest | undefined> {
    let content: string;
    try {
      content = await fs.promises.readFile(filePath, "utf8");
    } catch {
      return undefined;
    }

    return this._parseManifest(skillId, filePath, content);
  }

  /** Parse raw file content into a SkillManifest. Warns and returns undefined on error. */
  private _parseManifest(
    skillId: string,
    filePath: string,
    content: string,
  ): SkillManifest | undefined {
    const split = splitFrontmatter(content);
    if (split === null) {
      process.stderr.write(
        `[openswarm] skills: ${filePath} has no valid frontmatter delimiters — skipping\n`,
      );
      return undefined;
    }

    const fm = parseFrontmatter(split.fm);
    if (fm === null) {
      process.stderr.write(
        `[openswarm] skills: ${filePath} frontmatter parse failed — skipping\n`,
      );
      return undefined;
    }

    // description is required (or we warn and skip).
    if (typeof fm["description"] !== "string" || fm["description"].trim() === "") {
      process.stderr.write(
        `[openswarm] skills: ${filePath} missing required frontmatter field 'description' — skipping\n`,
      );
      return undefined;
    }

    const name = typeof fm["name"] === "string" ? fm["name"] : skillId;
    const description = fm["description"] as string;

    let triggers: readonly string[] | undefined;
    if (Array.isArray(fm["triggers"])) {
      triggers = (fm["triggers"] as unknown[])
        .filter((t): t is string => typeof t === "string");
    }

    // Collect remaining frontmatter keys.
    const frontmatter: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fm)) {
      if (k !== "name" && k !== "description" && k !== "triggers") {
        frontmatter[k] = v;
      }
    }

    return {
      id: skillId,
      name,
      description,
      sourceId: SOURCE_ID,
      filePath,
      triggers,
      frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  private async _tryLoadFromRoot(
    root: string,
    skillId: string,
  ): Promise<LoadedSkill | undefined> {
    // Try canonical layout first.
    const canonicalPath = path.join(root, skillId, "SKILL.md");
    const legacyPath = path.join(root, `${skillId}.md`);

    for (const filePath of [canonicalPath, legacyPath]) {
      let content: string;
      try {
        content = await fs.promises.readFile(filePath, "utf8");
      } catch {
        continue;
      }

      const manifest = this._parseManifest(skillId, filePath, content);
      if (manifest === undefined) continue;

      const split = splitFrontmatter(content);
      if (split === null) continue;

      return { manifest, body: split.body };
    }

    return undefined;
  }
}
