/**
 * Model aliases — user-friendly short names that resolve to concrete model ids.
 *
 * M4a Phase 0.4 + Phase 4.2 (full impl lands in Phase 4).
 *
 * Precedence: user aliases in `~/.swarm-coder/settings.json` (`aliases: {...}`)
 * override built-in defaults. When a user alias shadows a built-in, consumers
 * emit a one-time `alias_shadowed` lane event.
 *
 * Resolution: one level of indirection — an alias whose value is itself an
 * alias throws with a clear cycle-detection error.
 */

export interface AliasTable {
  readonly [alias: string]: string;
}

/**
 * Built-in aliases shipped with swarm-coder. Values are pinned to model ids
 * that the live API currently accepts. User aliases override these.
 *
 * NOTE: Phase 4.2 verifies these ids against live model lists at impl time.
 * Users can always override via `~/.swarm-coder/settings.json`.
 */
export const BUILTIN_ALIASES: AliasTable = {
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
  opus: "claude-opus-4-7",
  "gpt-4o": "gpt-4o-2024-11-20",
  "gpt-5": "gpt-5-2025-08-07",
  o3: "o3-mini-2025-01-31",
};

/**
 * Load user aliases from settings.json and merge with built-ins.
 * User aliases win on name collision. Defaults to built-ins only if the
 * settings file is missing or has no `aliases` field.
 *
 * Full implementation lands in Phase 4.2.
 */
export declare function loadAliases(settingsPath?: string): Promise<AliasTable>;

/**
 * Resolve an alias-or-id to a concrete model id. One level of indirection:
 * if `aliases[nameOrId]` exists, return its value (unless the value is itself
 * a key in `aliases` — that's a cycle, throw).
 *
 * If `nameOrId` is not in the table, return it unchanged (treat as a direct
 * model id).
 *
 * Full implementation lands in Phase 4.2.
 */
export declare function resolveAlias(nameOrId: string, aliases: AliasTable): string;
