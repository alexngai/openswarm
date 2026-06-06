/**
 * Curated bounded memory (Layer 1).
 *
 * Agent-managed, numbered-entry documents with hard size caps.
 * Two scopes: project (persists across sessions in the same repo)
 * and user (persists across all sessions for a user).
 */

import type { CuratedScope, CuratedMemoryRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Storage backend interface
// ---------------------------------------------------------------------------

export interface CuratedMemoryStore {
  get(scopeKey: string): CuratedMemoryRecord | null;
  set(scopeKey: string, content: string): void;
}

// ---------------------------------------------------------------------------
// In-memory store (default, replaced by StateDB adapter in production)
// ---------------------------------------------------------------------------

class InMemoryStore implements CuratedMemoryStore {
  private data = new Map<string, CuratedMemoryRecord>();

  get(scopeKey: string): CuratedMemoryRecord | null {
    return this.data.get(scopeKey) ?? null;
  }

  set(scopeKey: string, content: string): void {
    this.data.set(scopeKey, {
      scopeKey,
      content,
      updatedAt: new Date().toISOString(),
    });
  }
}

// ---------------------------------------------------------------------------
// Singleton store
// ---------------------------------------------------------------------------

let _store: CuratedMemoryStore = new InMemoryStore();

export function getCuratedMemoryStore(): CuratedMemoryStore {
  return _store;
}

export function setCuratedMemoryStore(store: CuratedMemoryStore): void {
  _store = store;
}

export function resetCuratedMemoryStore(): void {
  _store = new InMemoryStore();
}

// ---------------------------------------------------------------------------
// Size limits
// ---------------------------------------------------------------------------

const DEFAULT_PROJECT_MAX_CHARS = 2500;
const DEFAULT_USER_MAX_CHARS = 1500;

export interface CuratedMemoryLimits {
  projectMaxChars: number;
  userMaxChars: number;
}

let _limits: CuratedMemoryLimits = {
  projectMaxChars: DEFAULT_PROJECT_MAX_CHARS,
  userMaxChars: DEFAULT_USER_MAX_CHARS,
};

export function getCuratedMemoryLimits(): CuratedMemoryLimits {
  return { ..._limits };
}

export function setCuratedMemoryLimits(limits: Partial<CuratedMemoryLimits>): void {
  _limits = { ..._limits, ...limits };
}

export function resetCuratedMemoryLimits(): void {
  _limits = {
    projectMaxChars: DEFAULT_PROJECT_MAX_CHARS,
    userMaxChars: DEFAULT_USER_MAX_CHARS,
  };
}

// ---------------------------------------------------------------------------
// Scope key helpers
// ---------------------------------------------------------------------------

export function scopeKey(scope: CuratedScope, identifier: string): string {
  return `${scope}:${identifier}`;
}

// ---------------------------------------------------------------------------
// Entry parsing / formatting
// ---------------------------------------------------------------------------

export function parseEntries(content: string): string[] {
  if (!content.trim()) return [];
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

export function formatEntries(entries: string[]): string {
  return entries
    .map((entry, i) => `${i + 1}. ${entry}`)
    .join("\n");
}

function maxCharsForScope(scope: CuratedScope): number {
  return scope === "project" ? _limits.projectMaxChars : _limits.userMaxChars;
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

export interface CuratedMemoryAction {
  action: "add" | "replace" | "remove";
  scope: CuratedScope;
  scopeIdentifier: string;
  entry?: string;
  index?: number;
  replacement?: string;
}

export type CuratedMemoryResult =
  | { ok: true; entries: string[]; formatted: string }
  | { ok: false; error: string };

export function executeCuratedAction(action: CuratedMemoryAction): CuratedMemoryResult {
  const key = scopeKey(action.scope, action.scopeIdentifier);
  const store = getCuratedMemoryStore();
  const existing = store.get(key);
  let entries = existing ? parseEntries(existing.content) : [];
  const maxChars = maxCharsForScope(action.scope);

  switch (action.action) {
    case "add": {
      if (!action.entry || !action.entry.trim()) {
        return { ok: false, error: "entry text is required for add action" };
      }
      const newEntry = action.entry.trim();
      entries.push(newEntry);

      const formatted = formatEntries(entries);
      if (formatted.length > maxChars) {
        entries.pop();
        return {
          ok: false,
          error: `adding this entry would exceed the ${maxChars}-character limit for ${action.scope} memory. Current size: ${formatEntries(entries).length}. Try removing old entries first.`,
        };
      }

      store.set(key, entries.join("\n"));
      return { ok: true, entries, formatted };
    }

    case "replace": {
      if (action.index === undefined || action.index === null) {
        return { ok: false, error: "index is required for replace action" };
      }
      if (!action.replacement || !action.replacement.trim()) {
        return { ok: false, error: "replacement text is required for replace action" };
      }
      const idx = action.index - 1;
      if (idx < 0 || idx >= entries.length) {
        return {
          ok: false,
          error: `index ${action.index} is out of range (1-${entries.length})`,
        };
      }

      const old = entries[idx];
      entries[idx] = action.replacement.trim();

      const formatted = formatEntries(entries);
      if (formatted.length > maxChars) {
        entries[idx] = old!;
        return {
          ok: false,
          error: `replacement would exceed the ${maxChars}-character limit for ${action.scope} memory`,
        };
      }

      store.set(key, entries.join("\n"));
      return { ok: true, entries, formatted };
    }

    case "remove": {
      if (action.index === undefined || action.index === null) {
        return { ok: false, error: "index is required for remove action" };
      }
      const idx = action.index - 1;
      if (idx < 0 || idx >= entries.length) {
        return {
          ok: false,
          error: `index ${action.index} is out of range (1-${entries.length})`,
        };
      }

      entries.splice(idx, 1);
      store.set(key, entries.join("\n"));
      return { ok: true, entries, formatted: formatEntries(entries) };
    }

    default:
      return { ok: false, error: `unknown action: ${(action as never satisfies never)}` };
  }
}

export function getCuratedMemory(key: string): string | null {
  const record = getCuratedMemoryStore().get(key);
  if (!record || !record.content.trim()) return null;
  return formatEntries(parseEntries(record.content));
}
