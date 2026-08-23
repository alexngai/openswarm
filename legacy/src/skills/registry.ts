/**
 * SkillRegistry — aggregates multiple SkillSources with first-wins semantics.
 *
 * - registerSource() adds a source (order matters: earlier sources win on conflict).
 * - discover() unions manifests across all sources, de-duped by skill id.
 * - load() delegates to the first source that can satisfy the id.
 * - list() returns a UI-friendly summary of discovered skills.
 */

import type { SkillSource, SkillManifest, LoadedSkill } from "./index.js";

export class SkillRegistry {
  private readonly sources: SkillSource[] = [];

  /** Match the interface expected by buildSkillTool — named `register`. */
  register(source: SkillSource): void {
    this.sources.push(source);
  }

  /** Alias for register — satisfies specs that use registerSource. */
  registerSource(source: SkillSource): void {
    this.register(source);
  }

  async discover(): Promise<readonly SkillManifest[]> {
    const seen = new Map<string, SkillManifest>();

    for (const source of this.sources) {
      let manifests: readonly SkillManifest[];
      try {
        manifests = await source.discover();
      } catch {
        // Source errors are non-fatal.
        continue;
      }
      for (const m of manifests) {
        if (!seen.has(m.id)) {
          seen.set(m.id, m);
        }
      }
    }

    return Array.from(seen.values());
  }

  async load(skillId: string): Promise<LoadedSkill> {
    for (const source of this.sources) {
      let result: LoadedSkill | undefined;
      try {
        result = await source.load(skillId);
      } catch {
        continue;
      }
      if (result !== undefined) {
        return result;
      }
    }
    throw new Error(`skill '${skillId}' not found`);
  }

  async list(): Promise<ReadonlyArray<{ id: string; description?: string; triggers?: readonly string[] }>> {
    const manifests = await this.discover();
    return manifests.map((m) => ({
      id: m.id,
      description: m.description,
      triggers: m.triggers,
    }));
  }
}
