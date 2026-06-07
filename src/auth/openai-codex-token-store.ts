/**
 * Persistent store for codex (ChatGPT-subscription) OAuth tokens.
 *
 * OAuth yields a short-lived access token, a long-lived refresh token, and the
 * account id — each `swarm-harness` run is a fresh process, so these must
 * persist to disk and be silent-refreshed when the access token expires
 * (docs/42 §6 / Q6). Posture: a single `0600` JSON file under
 * `~/.swarm-harness/auth.json`, provider-namespaced so other providers can
 * coexist. Never logged.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface CodexTokens {
  readonly access: string;
  readonly refresh: string;
  readonly accountId: string;
  /** Epoch ms; access token is considered expired at/after this. */
  readonly expiresAt: number;
}

const PROVIDER_KEY = "openai-codex";

function authFilePath(baseDir?: string): string {
  return path.join(baseDir ?? path.join(os.homedir(), ".swarm-harness"), "auth.json");
}

function readAll(baseDir?: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(authFilePath(baseDir), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readCodexTokens(baseDir?: string): CodexTokens | null {
  const entry = readAll(baseDir)[PROVIDER_KEY];
  if (entry === null || typeof entry !== "object") return null;
  const e = entry as Partial<CodexTokens>;
  if (
    typeof e.access === "string" &&
    typeof e.refresh === "string" &&
    typeof e.accountId === "string" &&
    typeof e.expiresAt === "number"
  ) {
    return { access: e.access, refresh: e.refresh, accountId: e.accountId, expiresAt: e.expiresAt };
  }
  return null;
}

export function writeCodexTokens(tokens: CodexTokens, baseDir?: string): void {
  const file = authFilePath(baseDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const all = readAll(baseDir);
  all[PROVIDER_KEY] = tokens;
  // Atomic write: temp + rename so a crash never leaves a half-written file.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  // Re-assert perms in case the file pre-existed with looser bits.
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort (e.g. unsupported FS)
  }
}

export function clearCodexTokens(baseDir?: string): void {
  const all = readAll(baseDir);
  if (!(PROVIDER_KEY in all)) return;
  delete all[PROVIDER_KEY];
  const file = authFilePath(baseDir);
  try {
    fs.writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
  } catch {
    // file may not exist — nothing to clear
  }
}
