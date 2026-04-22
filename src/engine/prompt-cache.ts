import type { ToolSpec } from "../core/types.js";

export interface PromptCacheFingerprint {
  readonly hash: string;
  readonly version: "v1";
}

/**
 * Stable fingerprint of the cacheable system-prompt prefix + tool surface.
 * Used in cache_hit / cache_miss lane events for analytics.
 *
 * FNV-1a over JSON.stringify({ prefix, tools: [{name, schema}...] }).
 * Deterministic across runs when inputs are identical.
 */
export function fingerprintSystemPrompt(
  prefix: string,
  tools: readonly ToolSpec[],
): PromptCacheFingerprint {
  // Normalize: extract {name, schema} sorted by name for determinism.
  const normalizedTools = tools
    .map((t) => ({ name: t.name, schema: t.inputSchema }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const payload = JSON.stringify({ prefix, tools: normalizedTools });

  // FNV-1a 32-bit hash, output as 16-char hex (zero-padded to 8 chars then doubled for uniqueness).
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    // Multiply by FNV prime (32-bit: 0x01000193), keep lower 32 bits.
    hash = Math.imul(hash, 0x01000193);
  }
  // Convert to unsigned 32-bit then hex, pad to 8 chars.
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  // Return 16-char hex by hashing the hex string itself for extra bits.
  let hash2 = 0x811c9dc5;
  for (let i = 0; i < hex.length; i++) {
    hash2 ^= hex.charCodeAt(i);
    hash2 = Math.imul(hash2, 0x01000193);
  }
  const hex2 = (hash2 >>> 0).toString(16).padStart(8, "0");

  return { hash: hex + hex2, version: "v1" };
}
