/**
 * Hooks config loader (rev-2 Major M8 discovery hierarchy).
 *
 * First-match-wins:
 *   1. `$OPENSWARM_CONFIG_DIR/hooks.json`
 *   2. `<cwd>/.openswarm/hooks.json`
 *   3. `<cwd>/.claude/settings.json`  (Claude Code compat — `.hooks` field)
 *   4. `$HOME/.claude/settings.json`  (Claude Code compat — `.hooks` field)
 *
 * Two JSON shapes are accepted:
 *
 * A) Dedicated `hooks.json` (simple):
 *    {
 *      "PreToolUse":  [{ "matcher": "bash", "command": "./log.sh" }],
 *      "PostToolUse": [{ "matcher": "*",    "command": "./audit.sh", "timeoutMs": 5000 }]
 *    }
 *
 * B) Claude Code `settings.json` `hooks` field (the field itself is the map
 *    of event → HookConfig[]). We extract `settings.hooks` and validate
 *    against the same schema.
 *
 * Malformed JSON / schema mismatch at the first matched path → throws a clean
 * error. Missing config at every location → empty result.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { z } from "zod";
import type { HookConfig } from "./index.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const HookConfigSchema = z.object({
  matcher: z.string(),
  command: z.string(),
  timeoutMs: z.number().int().positive().optional(),
  contentHash: z.string().optional(),
});

const HooksMapSchema = z.object({
  PreToolUse: z.array(HookConfigSchema).optional(),
  PostToolUse: z.array(HookConfigSchema).optional(),
  SessionStart: z.array(HookConfigSchema).optional(),
  SessionEnd: z.array(HookConfigSchema).optional(),
  UserPromptSubmit: z.array(HookConfigSchema).optional(),
  Stop: z.array(HookConfigSchema).optional(),
  PermissionRequest: z.array(HookConfigSchema).optional(),
  SubagentStart: z.array(HookConfigSchema).optional(),
  SubagentStop: z.array(HookConfigSchema).optional(),
  PreCompact: z.array(HookConfigSchema).optional(),
  PostCompact: z.array(HookConfigSchema).optional(),
});

// Claude Code `settings.json` — passthrough other keys, pluck `.hooks`.
const SettingsFileSchema = z
  .object({
    hooks: HooksMapSchema.optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HooksConfigFile {
  readonly PreToolUse?: readonly HookConfig[];
  readonly PostToolUse?: readonly HookConfig[];
  readonly SessionStart?: readonly HookConfig[];
  readonly SessionEnd?: readonly HookConfig[];
  readonly UserPromptSubmit?: readonly HookConfig[];
  readonly Stop?: readonly HookConfig[];
  readonly PermissionRequest?: readonly HookConfig[];
  readonly SubagentStart?: readonly HookConfig[];
  readonly SubagentStop?: readonly HookConfig[];
  readonly PreCompact?: readonly HookConfig[];
  readonly PostCompact?: readonly HookConfig[];
}

export interface LoadHooksConfigOptions {
  readonly cwd?: string;
  readonly homedir?: string;
  readonly envOverrides?: NodeJS.ProcessEnv;
}

export interface LoadedHooksConfig {
  readonly config: HooksConfigFile;
  readonly resolvedPath?: string;
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

/**
 * Collapse a Zod validation failure for a hooks config file into a concise,
 * human-readable warning instead of dumping the raw `ZodError` blob.
 *
 * Example:
 *   Ignoring invalid hooks config at /path/hooks.json: 2 problem(s)
 *     - PreToolUse.0.command: Invalid input: expected string, received number
 *     - PostToolUse: Invalid input: expected array, received string
 */
export function formatHooksConfigError(
  configPath: string,
  error: z.ZodError,
): string {
  const issues = error.issues;
  const bullets = issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${field}: ${issue.message}`;
    })
    .join("\n");
  return `Ignoring invalid hooks config at ${configPath}: ${issues.length} problem(s)\n${bullets}`;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

interface Candidate {
  readonly path: string;
  /** true when the file is a Claude Code settings.json (extract `.hooks`). */
  readonly isSettingsJson: boolean;
}

function resolveCandidates(opts: LoadHooksConfigOptions): Candidate[] {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.homedir ?? os.homedir();
  const env = opts.envOverrides ?? process.env;

  const candidates: Candidate[] = [];
  const envDir = env.OPENSWARM_CONFIG_DIR;
  if (envDir !== undefined && envDir.length > 0) {
    candidates.push({
      path: path.join(envDir, "hooks.json"),
      isSettingsJson: false,
    });
  }
  candidates.push({
    path: path.join(cwd, ".openswarm", "hooks.json"),
    isSettingsJson: false,
  });
  candidates.push({
    path: path.join(cwd, ".claude", "settings.json"),
    isSettingsJson: true,
  });
  candidates.push({
    path: path.join(home, ".claude", "settings.json"),
    isSettingsJson: true,
  });
  return candidates;
}

function firstExisting(candidates: readonly Candidate[]): Candidate | undefined {
  for (const c of candidates) {
    try {
      if (fs.existsSync(c.path)) return c;
    } catch {
      // ignore fs errors — treat as non-existent
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loadHooksConfig(
  opts: LoadHooksConfigOptions = {},
): Promise<LoadedHooksConfig> {
  const candidate = firstExisting(resolveCandidates(opts));
  if (candidate === undefined) {
    return { config: {} };
  }

  let raw: string;
  try {
    raw = await fs.promises.readFile(candidate.path, "utf8");
  } catch (err) {
    throw new Error(
      `hooks config: failed to read ${candidate.path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `hooks config: ${candidate.path} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (candidate.isSettingsJson) {
    const result = SettingsFileSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(formatHooksConfigError(candidate.path, result.error));
    }
    const hooks = result.data.hooks ?? {};
    return { config: hooks as HooksConfigFile, resolvedPath: candidate.path };
  }

  const result = HooksMapSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(formatHooksConfigError(candidate.path, result.error));
  }
  return { config: result.data as HooksConfigFile, resolvedPath: candidate.path };
}

/**
 * Total number of hook matchers across all events. Useful for startup logging.
 */
export function countMatchers(config: HooksConfigFile): number {
  return (
    (config.PreToolUse?.length ?? 0) +
    (config.PostToolUse?.length ?? 0) +
    (config.SessionStart?.length ?? 0) +
    (config.SessionEnd?.length ?? 0) +
    (config.UserPromptSubmit?.length ?? 0)
  );
}

/** Number of distinct events that carry at least one matcher. */
export function countEvents(config: HooksConfigFile): number {
  let n = 0;
  if ((config.PreToolUse?.length ?? 0) > 0) n++;
  if ((config.PostToolUse?.length ?? 0) > 0) n++;
  if ((config.SessionStart?.length ?? 0) > 0) n++;
  if ((config.SessionEnd?.length ?? 0) > 0) n++;
  if ((config.UserPromptSubmit?.length ?? 0) > 0) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Hook trust model — content hash verification (H5)
// ---------------------------------------------------------------------------

export function computeHookHash(scriptPath: string): string | null {
  try {
    const content = fs.readFileSync(scriptPath, "utf8");
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

export interface HookVerificationResult {
  readonly trusted: boolean;
  readonly reason: string;
}

export function verifyHookTrust(hook: HookConfig): HookVerificationResult {
  if (!hook.contentHash) {
    return { trusted: true, reason: "no hash configured — trust by default" };
  }

  const command = hook.command.trim();
  const scriptPath = command.split(/\s+/)[0];
  if (!scriptPath) {
    return { trusted: false, reason: "empty command" };
  }

  const actualHash = computeHookHash(scriptPath);
  if (actualHash === null) {
    return { trusted: false, reason: `cannot read script: ${scriptPath}` };
  }

  if (actualHash === hook.contentHash) {
    return { trusted: true, reason: "hash matches" };
  }

  return {
    trusted: false,
    reason: `hash mismatch: expected ${hook.contentHash.slice(0, 12)}…, got ${actualHash.slice(0, 12)}…`,
  };
}

export function verifyAllHooks(
  config: HooksConfigFile,
): Map<string, HookVerificationResult[]> {
  const results = new Map<string, HookVerificationResult[]>();
  const events = Object.keys(config) as (keyof HooksConfigFile)[];

  for (const event of events) {
    const hooks = config[event];
    if (!hooks || hooks.length === 0) continue;
    results.set(event, hooks.map(verifyHookTrust));
  }

  return results;
}
