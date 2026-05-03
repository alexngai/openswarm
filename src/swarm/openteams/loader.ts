/**
 * loader.ts — openteams template loader.
 *
 * v0.4 stage 4F. Resolves an openteams template name to a parsed
 * `OpenteamsConfig` (the openteams YAML shape). Two paths:
 *
 *   - Production: shell out to `openteams generate all <template> --out <tmp>`
 *     per V0.4.Q6 (CLI shell-out fallback). Library-mode swap is v0.5+.
 *   - Test: `fixtureDir` option bypasses the shell-out and reads a captured
 *     fixture directory directly. Tests use this to stay deterministic.
 *
 * The shape returned here is intentionally permissive — full strict mapping
 * + zod validation lives in mapping.ts (and lands fully in stage 4K when the
 * topology + communication blocks become load-bearing for `team send`).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import * as yaml from "yaml";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Raw openteams template config — the YAML shape that openteams emits.
 * Stage 4F is permissive: we admit shapes we don't fully validate yet.
 */
export interface OpenteamsConfig {
  readonly name: string;
  readonly description?: string;
  readonly version?: number;
  readonly roles?: readonly string[];
  readonly topology?: {
    readonly root?: { readonly role: string };
    readonly spawn_rules?: Record<string, readonly string[]>;
  };
  readonly communication?: {
    readonly enforcement?: "permissive" | "strict";
    readonly channels?: Record<string, { readonly signals: readonly string[] }>;
    readonly subscriptions?: Record<
      string,
      readonly { readonly channel: string }[]
    >;
    readonly emissions?: Record<string, readonly string[]>;
  };
  /**
   * Per-role agent prompts loaded from disk. Format depends on what
   * `openteams generate all` produces (we look in agents/, roles/, or the
   * fixture root). Roles without a prompt are absent from this map.
   */
  readonly rolePrompts?: Record<string, string>;
  /** swarm-harness extension block — overrides default mappings. */
  readonly "x-swarm-harness"?: {
    readonly topology?:
      | "fanout"
      | "pipeline"
      | "coordinator"
      | "peer-team"
      | "committee"
      | "critic-loop";
    readonly coordination?: unknown; // TeamCoordination-shaped; mapped in mapping.ts
  };
}

export interface LoadOptions {
  /** Override openteams CLI binary for tests. Default: "openteams" via PATH. */
  readonly openteamsBinary?: string;
  /** Skip the live shell-out and read from a fixture path instead (tests). */
  readonly fixtureDir?: string;
  /** Override the working directory when running openteams. */
  readonly cwd?: string;
}

// ---------------------------------------------------------------------------
// loadTemplate
// ---------------------------------------------------------------------------

/**
 * Resolve a template by name, fetch its config + per-role prompts.
 *
 * Resolution order (delegated to the openteams CLI itself):
 *   1. Direct path (./team.yaml or absolute path).
 *   2. Project ./.openteams/templates/<name>/team.yaml
 *   3. Global ~/.openteams/templates/<name>/team.yaml
 *   4. openteams built-in registry.
 *
 * For v0.4 we shell out to `openteams generate package <template-or-path>
 * --output <tmpdir>` (V0.4.Q6), read team.yaml + per-role prompts from the
 * tmpdir, and parse. We use `generate package` (not `generate all`) because
 * only `package` emits a `team.yaml` manifest alongside the role prompts;
 * `all` emits SKILL.md + agents/ but no manifest.
 *
 * Tests pass `fixtureDir` to skip the shell-out entirely.
 */
export async function loadTemplate(
  templateName: string,
  opts: LoadOptions = {},
): Promise<OpenteamsConfig> {
  // Test path: read from a captured fixture (no shell-out).
  if (opts.fixtureDir !== undefined) {
    return loadFromFixture(opts.fixtureDir);
  }

  // Production path: shell out to openteams.
  const binary = opts.openteamsBinary ?? "openteams";
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "swarm-harness-openteams-"),
  );
  try {
    const result = spawnSync(
      binary,
      ["generate", "package", templateName, "--output", tmpDir],
      {
        cwd: opts.cwd ?? process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (result.error !== undefined) {
      throw new Error(
        `openteams binary "${binary}" not runnable: ${result.error.message}`,
      );
    }
    if (result.status !== 0) {
      const stderr = result.stderr ?? "";
      throw new Error(
        `openteams generate failed (exit ${result.status ?? "null"}): ${
          stderr.trim().length > 0 ? stderr.trim() : "(no stderr)"
        }`,
      );
    }
    return await loadFromFixture(tmpDir);
  } finally {
    // Best-effort cleanup. Don't fail the load if rm fails.
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// loadFromFixture
// ---------------------------------------------------------------------------

async function loadFromFixture(dir: string): Promise<OpenteamsConfig> {
  // Read team.yaml.
  const teamYamlPath = path.join(dir, "team.yaml");
  let yamlSource: string;
  try {
    yamlSource = await fs.readFile(teamYamlPath, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read team.yaml at ${teamYamlPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = yaml.parse(yamlSource);
  } catch (err) {
    throw new Error(
      `team.yaml at ${teamYamlPath} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`team.yaml at ${teamYamlPath} is not an object`);
  }

  const config = parsed as Partial<OpenteamsConfig> & {
    roles?: readonly string[];
  };
  if (typeof config.name !== "string" || config.name.length === 0) {
    throw new Error(`team.yaml at ${teamYamlPath} is missing a "name" field`);
  }

  // Look for per-role prompts. `openteams generate package` emits the
  // canonical location as `roles/<role>/SKILL.md`; `openteams generate all`
  // emits `agents/<role>.md`. Stage 4F walks both formats plus a flat root
  // fallback; first hit wins per role, missing roles fall through silently
  // (caller / mapping handles fallback prompt).
  const rolePrompts: Record<string, string> = {};
  if (Array.isArray(config.roles)) {
    for (const role of config.roles) {
      if (typeof role !== "string" || role.length === 0) continue;
      const candidates = [
        path.join(dir, "roles", role, "SKILL.md"),
        path.join(dir, "agents", `${role}.md`),
        path.join(dir, "roles", `${role}.md`),
        path.join(dir, `${role}.md`),
      ];
      for (const candidate of candidates) {
        try {
          rolePrompts[role] = await fs.readFile(candidate, "utf8");
          break;
        } catch {
          // try next
        }
      }
    }
  }

  return {
    ...(parsed as OpenteamsConfig),
    rolePrompts,
  };
}
