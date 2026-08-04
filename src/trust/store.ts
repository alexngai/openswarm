/**
 * TrustStore — remembers which workspaces the user has trusted.
 *
 * Records live at `~/.openswarm/trust.json`, outside every workspace, because
 * a trust record inside the repository would be a repository asserting its own
 * trustworthiness. Writes are serialized with the same `proper-lockfile`
 * discipline as `PluginStateStore`, so concurrent sessions in different
 * workspaces cannot lose each other's grants.
 *
 * A record binds a workspace root to one of two scopes:
 *   - `config`: trusted while the executable configuration hashes to `digest`.
 *     Editing `.openswarm/hooks.json` re-prompts; editing source does not.
 *   - `directory`: trusted regardless of later configuration changes.
 *
 * `directory` is deliberately available. Requiring a fresh decision on every
 * config edit in a repository someone works in daily produces reflexive
 * approval, which is worse than an honest broad grant.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import lockfile from "proper-lockfile";
import { canonicalRoot } from "../kernel/workspace-authority.js";

export const TRUST_SCHEMA_VERSION = 1;

export type TrustScope = "config" | "directory";

export interface TrustRecord {
  readonly root: string;
  readonly scope: TrustScope;
  /** Provenance digest at the time of the decision; absent for `directory`. */
  readonly digest?: string;
  /** ISO-8601. Recorded for `openswarm trust --list`, not for expiry. */
  readonly grantedAt: string;
}

interface TrustFile {
  readonly schemaVersion: number;
  readonly workspaces: Readonly<Record<string, TrustRecord>>;
}

const EMPTY: TrustFile = { schemaVersion: TRUST_SCHEMA_VERSION, workspaces: {} };

function defaultRoot(): string {
  const env = process.env.OPENSWARM_CONFIG_DIR;
  return env !== undefined && env.length > 0 ? env : path.join(os.homedir(), ".openswarm");
}

/**
 * Why a workspace is or is not trusted. `stale` is distinct from `untrusted`
 * so the prompt can say what changed rather than asking from scratch.
 */
export type TrustLookup =
  | { readonly state: "trusted"; readonly record: TrustRecord }
  | { readonly state: "stale"; readonly record: TrustRecord }
  | { readonly state: "unknown" };

export class TrustStore {
  private readonly file: string;
  private readonly dir: string;

  constructor(rootDir?: string) {
    this.dir = rootDir ?? defaultRoot();
    this.file = path.join(this.dir, "trust.json");
  }

  private async read(): Promise<TrustFile> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch {
      return EMPTY;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A corrupt store must not authorize anything, and must not crash the
      // CLI either. Forgetting grants re-prompts; guessing at them does not.
      return EMPTY;
    }
    if (typeof parsed !== "object" || parsed === null) return EMPTY;
    const obj = parsed as Partial<TrustFile>;
    // A newer on-disk schema may encode conditions this build cannot evaluate,
    // so it is ignored rather than misread as a grant.
    if (obj.schemaVersion !== TRUST_SCHEMA_VERSION) return EMPTY;
    const workspaces = obj.workspaces;
    if (typeof workspaces !== "object" || workspaces === null) return EMPTY;
    return { schemaVersion: TRUST_SCHEMA_VERSION, workspaces };
  }

  /** Whether `root` is trusted for a workspace currently hashing to `digest`. */
  async lookup(root: string, digest: string): Promise<TrustLookup> {
    const resolved = await canonicalRoot(root);
    const file = await this.read();
    const record = file.workspaces[resolved];
    if (record === undefined) return { state: "unknown" };
    if (record.scope === "directory") return { state: "trusted", record };
    if (record.digest === digest) return { state: "trusted", record };
    return { state: "stale", record };
  }

  async grant(root: string, scope: TrustScope, digest: string): Promise<TrustRecord> {
    const resolved = await canonicalRoot(root);
    const record: TrustRecord = {
      root: resolved,
      scope,
      ...(scope === "config" && { digest }),
      grantedAt: new Date().toISOString(),
    };
    await this.mutate((current) => ({
      ...current,
      workspaces: { ...current.workspaces, [resolved]: record },
    }));
    return record;
  }

  async revoke(root: string): Promise<boolean> {
    // Both spellings, because a store written before grants were canonicalized
    // still holds keys that `path.resolve` produced. Those are unreachable by
    // `lookup` — which fails closed and re-prompts — but they are still listed,
    // and a revoke that reported success while `trust --list` kept showing the
    // record would be worse than the stale entry.
    const keys = new Set([await canonicalRoot(root), path.resolve(root)]);
    let existed = false;
    await this.mutate((current) => {
      const next = { ...current.workspaces };
      for (const key of keys) {
        if (next[key] !== undefined) existed = true;
        delete next[key];
      }
      return { ...current, workspaces: next };
    });
    return existed;
  }

  async list(): Promise<readonly TrustRecord[]> {
    const file = await this.read();
    return Object.values(file.workspaces).sort((a, b) => a.root.localeCompare(b.root));
  }

  /** Read-modify-write under an exclusive lock. */
  private async mutate(fn: (current: TrustFile) => TrustFile): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    // proper-lockfile requires the target to exist before it can be locked.
    try {
      await fs.writeFile(this.file, JSON.stringify(EMPTY, null, 2), { flag: "wx" });
    } catch {
      // Already there — expected on every call but the first.
    }
    const release = await lockfile.lock(this.file, {
      retries: { retries: 10, minTimeout: 20, maxTimeout: 200 },
      stale: 10_000,
    });
    try {
      const next = fn(await this.read());
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
      await fs.rename(tmp, this.file);
    } finally {
      await release();
    }
  }
}
