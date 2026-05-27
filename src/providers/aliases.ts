/**
 * Model aliases — user-friendly short names that resolve to concrete model ids.
 *
 * M4a Phase 0.4 + Phase 4.2 (full impl lands in Phase 4).
 *
 * Precedence: user aliases in `~/.swarm-harness/settings.json` (`aliases: {...}`)
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
 * Built-in aliases shipped with swarm-harness. Values are pinned to model ids
 * that the live API currently accepts. User aliases override these.
 *
 * NOTE: Phase 4.2 verifies these ids against live model lists at impl time.
 * Users can always override via `~/.swarm-harness/settings.json`.
 */
export const BUILTIN_ALIASES: AliasTable = {
  // Anthropic — canonical ids as of 2026-04-22.
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
  opus: "claude-opus-4-7",
  // OpenAI
  "gpt-4o": "gpt-4o-2024-11-20",
  "gpt-5": "gpt-5-2025-08-07",
  o3: "o3-mini-2025-01-31",
  // xAI — doc 17 Q9 ports claw's short aliases. Identity alias for `grok-2`
  // is omitted: unaliased ids already route via `^grok/i` prefix in routing.ts
  // and resolveAlias() rejects `target === nameOrId` as a cycle.
  grok: "grok-3",
  "grok-mini": "grok-3-mini",
  // DashScope (Kimi) — canonical id per doc 17 Q9 claw reference.
  kimi: "kimi-k2.5",
};

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * Load user aliases from settings.json and merge with built-ins.
 * User aliases win on name collision. Defaults to built-ins only if the
 * settings file is missing or has no `aliases` field.
 */
export async function loadAliases(settingsPath?: string): Promise<AliasTable> {
  const resolved = settingsPath ?? path.join(os.homedir(), ".swarm-harness", "settings.json");
  let userAliases: AliasTable = {};
  try {
    const raw = await fs.readFile(resolved, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "aliases" in parsed &&
      parsed.aliases !== null &&
      typeof parsed.aliases === "object"
    ) {
      userAliases = parsed.aliases as AliasTable;
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...BUILTIN_ALIASES };
    }
    throw new Error(
      `Failed to load aliases from ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { ...BUILTIN_ALIASES, ...userAliases };
}

/**
 * Resolve an alias to a concrete model id. One level of indirection only.
 *
 * - If `nameOrId` is in `aliases`, return its value, unless that value is
 *   itself a key in `aliases` (a cycle of length 2+) — throw with a clear
 *   message listing both names.
 * - If `nameOrId` is not in `aliases`, return it unchanged.
 */
export function resolveAlias(nameOrId: string, aliases: AliasTable): string {
  if (!(nameOrId in aliases)) return nameOrId;
  const target = aliases[nameOrId];
  if (target in aliases) {
    throw new Error(
      `alias cycle detected: "${nameOrId}" → "${target}" → "${aliases[target]}". Remove the indirection.`,
    );
  }
  return target;
}

/**
 * Detect shadowing — user aliases that override a built-in.
 * Returns array of AliasShadowedPayload-compatible objects for consumers
 * to emit as lane events.
 */
export interface AliasShadowing {
  readonly alias: string;
  readonly builtInTarget: string;
  readonly userTarget: string;
}

export function detectShadowing(userAliases: AliasTable): AliasShadowing[] {
  const out: AliasShadowing[] = [];
  for (const [alias, userTarget] of Object.entries(userAliases)) {
    if (alias in BUILTIN_ALIASES && BUILTIN_ALIASES[alias] !== userTarget) {
      out.push({ alias, builtInTarget: BUILTIN_ALIASES[alias], userTarget });
    }
  }
  return out;
}
