import type { ToolSpec } from "../core/types.js";

export interface PromptCacheFingerprint {
  readonly hash: string;
  readonly version: "v1";
}

/**
 * Per-component hashes of the cacheable request prefix, so a cache miss can be
 * attributed to what actually changed instead of one opaque hash rotating
 * (docs/55 TE-21; modeled on DeepSeek-Reasonix's PrefixShape/CompareShape).
 * `hash` is the combined fingerprint — byte-identical to
 * `fingerprintSystemPrompt().hash` for the same inputs.
 */
export interface PrefixShape {
  readonly systemHash: string;
  readonly toolsHash: string;
  readonly hash: string;
  readonly version: "v1";
}

/** A prefix component that can be named as a cache-miss cause. */
export type PrefixComponent = "system" | "tools";

/** FNV-1a 32-bit over the payload, extended to 16 hex chars by re-hashing. */
function fnv1a16(payload: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    // Multiply by FNV prime (32-bit: 0x01000193), keep lower 32 bits.
    hash = Math.imul(hash, 0x01000193);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  let hash2 = 0x811c9dc5;
  for (let i = 0; i < hex.length; i++) {
    hash2 ^= hex.charCodeAt(i);
    hash2 = Math.imul(hash2, 0x01000193);
  }
  const hex2 = (hash2 >>> 0).toString(16).padStart(8, "0");
  return hex + hex2;
}

/**
 * Normalize the tool surface for hashing: {name, description} sorted by name.
 * Schema is intentionally excluded — Zod-produced JSON schemas can have
 * non-deterministic key ordering under certain inputs, causing the fingerprint
 * to rotate uselessly. The fingerprint is analytics-only (cache_hit/cache_miss
 * lane events); tool schema changes already invalidate the SDK's own cache.
 * A fingerprint stable on {name, description} is sufficient.
 */
function normalizeTools(
  tools: readonly ToolSpec[],
): readonly { name: string; description: string }[] {
  return tools
    .map((t) => ({ name: t.name, description: t.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Capture per-component hashes of the prefix (system prompt, tool surface). */
export function capturePrefixShape(
  prefix: string,
  tools: readonly ToolSpec[],
): PrefixShape {
  const normalizedTools = normalizeTools(tools);
  return {
    systemHash: fnv1a16(JSON.stringify({ prefix })),
    toolsHash: fnv1a16(JSON.stringify({ tools: normalizedTools })),
    // Combined payload matches fingerprintSystemPrompt exactly (byte-compat).
    hash: fnv1a16(JSON.stringify({ prefix, tools: normalizedTools })),
    version: "v1",
  };
}

/**
 * Name the components that differ between two shapes. Empty means the prefix
 * is byte-stable on the hashed surface — a provider-side miss then points at
 * something *outside* the fingerprint (message history rewrite, provider
 * routing, TTL expiry), which is itself diagnostic signal.
 */
export function comparePrefixShapes(
  prev: PrefixShape,
  cur: PrefixShape,
): readonly PrefixComponent[] {
  const changed: PrefixComponent[] = [];
  if (prev.systemHash !== cur.systemHash) changed.push("system");
  if (prev.toolsHash !== cur.toolsHash) changed.push("tools");
  return changed;
}

/**
 * Stable fingerprint of the cacheable system-prompt prefix + tool surface.
 * Used in cache_hit / cache_miss lane events for analytics.
 *
 * FNV-1a over JSON.stringify({ prefix, tools: [{name, description}...] }).
 * Deterministic across runs when inputs are identical. The combined hash of
 * `capturePrefixShape` with the same inputs — kept as the compact form for
 * callers that don't need attribution.
 */
export function fingerprintSystemPrompt(
  prefix: string,
  tools: readonly ToolSpec[],
): PromptCacheFingerprint {
  const payload = JSON.stringify({ prefix, tools: normalizeTools(tools) });
  return { hash: fnv1a16(payload), version: "v1" };
}
