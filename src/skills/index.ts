/**
 * SkillSource — where skills come from.
 *
 * Skills in Claude Code are `SKILL.md` files with optional YAML
 * frontmatter. Invocation is not
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
  /** Stable source id — "claude-code" | … */
  readonly id: string;

  /** Enumerate available skills without reading their bodies. */
  discover(): Promise<readonly SkillManifest[]>;

  /** Load a skill by id. Resolves undefined if not found. */
  load(skillId: string): Promise<LoadedSkill | undefined>;
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
   * Raw Markdown body (post-frontmatter, no YAML header, no leading blank line).
   * Ready to be injected into a system prompt or returned as a tool result.
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
