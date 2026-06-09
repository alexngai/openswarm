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
  // SWARM_HARNESS_AUTH_DIR relocates the credential store (used by the live
  // e2e to point a spawned CLI at a seeded temp store; mirrors
  // SWARM_HARNESS_HISTORY_PATH / SWARM_HARNESS_WORKERS_DIR).
  const dir = baseDir ?? process.env["SWARM_HARNESS_AUTH_DIR"] ?? path.join(os.homedir(), ".swarm-harness");
  return path.join(dir, "auth.json");
}

/** Sync sleep without busy-spinning the CPU (token writes are sync). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Serialize read-modify-write of the shared auth.json across processes via an
 * O_EXCL lockfile. The swarm orchestrator runs many processes that may refresh
 * concurrently; without this, last-writer-wins can drop a rotated refresh token
 * or another provider's entry. Bounded wait with stale-lock recovery.
 */
function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 5000;
  let fd: number | undefined;
  for (;;) {
    try {
      fd = fs.openSync(lock, "wx");
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() > deadline) {
        // Assume a crashed holder; reclaim and try once more.
        try {
          fs.unlinkSync(lock);
        } catch {
          /* raced — loop */
        }
      }
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(lock);
    } catch {
      /* ignore */
    }
  }
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

/** Atomically persist `all` to `file` as a 0600 file (temp + rename). */
function writeAllAtomic(file: string, all: Record<string, unknown>): void {
  // Dir holds secrets — keep it private (0700), even if it pre-existed.
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(file), 0o700);
  } catch {
    /* best effort */
  }
  const tmp = `${file}.${process.pid}.tmp`;
  // Clear any leftover temp from a crashed same-PID run; the dir is 0700 (ours),
  // so this can't remove an attacker-planted file.
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* not present */
  }
  // flag "wx" → O_EXCL: never follow/overwrite a pre-planted symlink at tmp.
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort (e.g. unsupported FS) */
  }
}

export function writeCodexTokens(tokens: CodexTokens, baseDir?: string): void {
  const file = authFilePath(baseDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  withLock(file, () => {
    const all = readAll(baseDir); // re-read inside the lock to avoid lost updates
    all[PROVIDER_KEY] = tokens;
    writeAllAtomic(file, all);
  });
}

export function clearCodexTokens(baseDir?: string): void {
  const file = authFilePath(baseDir);
  if (!fs.existsSync(path.dirname(file))) return;
  withLock(file, () => {
    const all = readAll(baseDir);
    if (!(PROVIDER_KEY in all)) return;
    delete all[PROVIDER_KEY];
    writeAllAtomic(file, all);
  });
}
