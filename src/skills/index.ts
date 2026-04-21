/**
 * SkillSource — where skills come from.
 *
 * Skills in claw/Claude Code are `SKILL.md` files with optional YAML
 * frontmatter (docs/research/04-integrations.md §3). Invocation is not
 * subprocess execution — it returns the skill's prompt text so the model
 * can apply its instructions in-turn.
 *
 * Discovery is a tiered path walk. v0 ships the `claude-code` source:
 *   $CODEX_HOME /.claude /.codex /.claw /.omc  and their ancestor walks
 *   with CWD → home fallback.
 *
 * Separate from PluginSource — manifest shape is Markdown + frontmatter,
 * invocation returns prompt text, no lifecycle beyond load.
 */

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

export interface SkillSource {
  /** Stable source id — "claude-code" | "claw" | … */
  readonly id: string;

  /** Enumerate available skills without reading their bodies. */
  discover(): Promise<readonly SkillManifest[]>;

  /** Load a skill by id. Resolves with the parsed prompt body. */
  load(skillId: string): Promise<LoadedSkill>;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface SkillManifest {
  /** Stable id, typically the skill's directory name. */
  readonly id: string;
  readonly name: string;
  readonly description?: string;

  /** Which source produced this manifest. */
  readonly sourceId: string;
  /** Absolute path to the SKILL.md file. */
  readonly filePath: string;

  /** Trigger patterns declared in frontmatter, if any. */
  readonly triggers?: readonly string[];

  /** Arbitrary frontmatter keys beyond our known schema. */
  readonly frontmatter?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Loaded skill
// ---------------------------------------------------------------------------

export interface LoadedSkill {
  readonly manifest: SkillManifest;

  /**
   * Parsed skill body — the Markdown after the frontmatter, ready to be
   * injected into a system prompt or returned as a tool result.
   */
  readonly body: string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Multiple sources can be registered. Discovery unions across all; load
 * resolves first-match by source order. Collisions are surfaced via the
 * `sourceId` field on the manifest.
 */
export interface SkillRegistry {
  register(source: SkillSource): void;
  discover(): Promise<readonly SkillManifest[]>;
  load(skillId: string): Promise<LoadedSkill>;
}
