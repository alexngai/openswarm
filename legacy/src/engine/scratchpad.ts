/**
 * Session scratchpad directory (Claude Code parity).
 *
 * A session-scoped temp directory the agent is steered toward (via a system
 * prompt section) for throwaway files — intermediate results, scratch
 * scripts, outputs that don't belong in the user's project — instead of
 * littering `/tmp` or the workspace.
 *
 * Layout mirrors Claude Code's:
 *
 *   <tmp>/openswarm-<uid>/<cwd-slug>/<session-id>/scratchpad
 *
 * The resolved path is exported as `OPENSWARM_SCRATCHPAD_DIR` so that
 * (a) bash validation exempts commands touching it from outside-workspace
 * warnings (see tools/tier0/bash-validation/scratchpad.ts), and (b) spawned
 * workers inherit the session root and carve out per-agent subdirectories.
 *
 * Overrides:
 *   - `OPENSWARM_SCRATCHPAD_DIR`      — exact directory (also the worker
 *                                       inheritance channel).
 *   - `OPENSWARM_SCRATCHPAD_BASE_DIR` — alternate base for the standard
 *                                       layout (containers / volatile /tmp).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const SCRATCHPAD_ENV_VAR = "OPENSWARM_SCRATCHPAD_DIR";
export const SCRATCHPAD_BASE_ENV_VAR = "OPENSWARM_SCRATCHPAD_BASE_DIR";

/** Flatten an absolute path into a single directory name (`/a/b` → `-a-b`). */
function slugify(p: string): string {
  return p.replace(/[/\\:]/g, "-");
}

/** Keep agent/session ids filesystem-safe when used as path segments. */
function safeSegment(id: string): string {
  // Dots are allowed in ids, but runs of them are collapsed so a hostile id
  // can't smuggle a ".." traversal into the resolved path.
  return id.replace(/[^A-Za-z0-9._-]/g, "-").replace(/\.{2,}/g, "-");
}

/**
 * Resolve the scratchpad directory for a session. Does not create it —
 * pair with {@link ensureScratchpadDir}. Resolution order: exact env
 * override → base-dir override → `os.tmpdir()` default.
 */
export function resolveScratchpadDir(cwd: string, sessionId: string): string {
  const exact = process.env[SCRATCHPAD_ENV_VAR];
  if (exact !== undefined && exact.length > 0) return exact;

  const layout = [slugify(cwd), safeSegment(sessionId), "scratchpad"] as const;
  const base = process.env[SCRATCHPAD_BASE_ENV_VAR];
  if (base !== undefined && base.length > 0) return path.join(base, ...layout);

  const uid =
    typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return path.join(os.tmpdir(), `openswarm-${uid}`, ...layout);
}

/**
 * Resolve the scratchpad directory for a spawned worker. When the
 * orchestrator's session root was inherited via `OPENSWARM_SCRATCHPAD_DIR`,
 * the worker gets a per-agent subdirectory under it (avoids write collisions
 * between workers while staying inside the root the bash-validation
 * exemption prefix-covers). Standalone workers allocate a fresh session dir
 * keyed by their agent id.
 */
export function resolveWorkerScratchpadDir(
  cwd: string,
  agentId: string,
): string {
  const inheritedRoot = process.env[SCRATCHPAD_ENV_VAR];
  if (inheritedRoot !== undefined && inheritedRoot.length > 0) {
    return path.join(inheritedRoot, "agents", safeSegment(agentId));
  }
  return resolveScratchpadDir(cwd, agentId);
}

/** Create the directory (recursive, 0700 like Claude Code's). Returns it. */
export function ensureScratchpadDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Render the scratchpad section for the system prompt (buildSystemPrompt
 * `extensions`). Wording tracks Claude Code's scratchpad section.
 */
export function formatScratchpadForSystemPrompt(dir: string): string {
  return (
    `## Scratchpad directory\n\n` +
    `Always use this scratchpad directory for temporary files instead of ` +
    `/tmp or other system temp directories:\n\`${dir}\`\n\n` +
    `Use it for ALL temporary file needs: intermediate results during ` +
    `multi-step tasks, scratch scripts, and outputs that don't belong in ` +
    `the user's project. It is session-specific, isolated from the user's ` +
    `project, and exempt from outside-workspace permission warnings. Only ` +
    `use /tmp if the user explicitly requests it.`
  );
}
