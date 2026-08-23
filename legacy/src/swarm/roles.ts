/**
 * Team roles (M3a Phase 6).
 *
 * A `Role` bundles three things: a unique name, a system prompt suffix that
 * is appended to the base prompt on role-typed workers, and an allowlist of
 * tool names that the worker is permitted to invoke. Together these
 * implement the "role overlay" — the orchestrator ties a role name to a
 * task, and the worker entry wires the suffix + allowlist into RunConfig
 * before starting its turn loop.
 *
 * Role filtering at tool-dispatcher registration is orthogonal to
 * `canUseTool` (per-call permission) and `clampPermissionMode` (permission
 * ceiling). A role trims the visible tool surface; permission mode clamps
 * side-effects on whatever remains.
 *
 * Three built-ins ship here:
 *   - `architect` — read-only + planning (no code writes)
 *   - `executor` — full Tier 0 + Tier 1, no recursive spawn (`agent`)
 *   - `reviewer` — read-only + structured_output (no writes, no spawn)
 *
 * Custom roles are loaded from `<cwd>/.openswarm/roles.json` at
 * orchestrator startup. Invalid entries are skipped with a stderr warning;
 * a missing or unreadable file yields `[]` so operators can ship without
 * customisation.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Role
// ---------------------------------------------------------------------------

export interface Role {
  readonly name: string;
  readonly systemPromptSuffix: string;
  readonly allowedTools: readonly string[];
}

const RoleSchema = z.object({
  name: z.string().min(1),
  systemPromptSuffix: z.string(),
  allowedTools: z.array(z.string()).readonly(),
});

const RolesFileSchema = z.object({
  roles: z.array(z.unknown()),
});

// ---------------------------------------------------------------------------
// RoleRegistry
// ---------------------------------------------------------------------------

export class RoleRegistry {
  private readonly roles = new Map<string, Role>();

  /** Register a role. Overwrites any prior role with the same name. */
  register(role: Role): void {
    this.roles.set(role.name, role);
  }

  /** Look up a role by name. Returns undefined if unknown. */
  get(name: string): Role | undefined {
    return this.roles.get(name);
  }

  /** Snapshot of all registered roles. */
  list(): readonly Role[] {
    return [...this.roles.values()];
  }
}

// ---------------------------------------------------------------------------
// Built-in roles
// ---------------------------------------------------------------------------

const ARCHITECT: Role = {
  name: "architect",
  systemPromptSuffix:
    "You are the architect. Propose designs, write specs, leave implementation to the executor. Do not write code files.",
  allowedTools: [
    "read_file",
    "glob",
    "grep",
    "todo_write",
    "web_fetch",
    "web_search",
    "structured_output",
    "skill",
    "agent",
    "task_create",
    "task_update",
    "task_get",
    "task_list",
    "send_message",
    "check_inbox",
    "task_stop",
    "task_output",
  ],
};

const EXECUTOR: Role = {
  name: "executor",
  systemPromptSuffix:
    "You are the executor. Implement the task. Make minimal, focused changes.",
  allowedTools: [
    "bash",
    "read_file",
    "write_file",
    "edit_file",
    "multi_edit",
    "glob",
    "grep",
    "todo_write",
    "web_fetch",
    "web_search",
    "structured_output",
    "skill",
    "task_get",
    "task_list",
    "task_output",
    "send_message",
    "check_inbox",
  ],
};

const REVIEWER: Role = {
  name: "reviewer",
  systemPromptSuffix:
    "You are the reviewer. Assess the change; point out risks and fixes. Do not modify files.",
  allowedTools: [
    "read_file",
    "glob",
    "grep",
    "todo_write",
    "web_fetch",
    "structured_output",
    "skill",
    "task_get",
    "task_list",
    "task_output",
    "send_message",
    "check_inbox",
  ],
};

const RESOLVER: Role = {
  name: "resolver",
  systemPromptSuffix:
    "You are the conflict resolver. A merge produced conflicts. Inspect the " +
    "conflicting files, resolve every conflict marker so the result is " +
    "correct — preserve the intent of BOTH sides; never blindly discard one " +
    "side. Then commit your resolution with `commit_changes`, and finally call " +
    "`resolve_conflict` with the conflictId you were given. Do not start any " +
    "unrelated work.",
  allowedTools: [
    "bash",
    "read_file",
    "write_file",
    "edit_file",
    "multi_edit",
    "glob",
    "grep",
    "todo_write",
    "commit_changes",
    "resolve_conflict",
  ],
};

const INTEGRATOR: Role = {
  name: "integrator",
  systemPromptSuffix:
    "You are the integrator. You drain the team's merge queue, landing each " +
    "queued stream into the target branch in order and resolving any conflicts " +
    "before moving on. Keep the target branch healthy.",
  allowedTools: [
    "bash",
    "read_file",
    "glob",
    "grep",
    "todo_write",
    "commit_changes",
    "resolve_conflict",
    "send_message",
    "check_inbox",
    "task_get",
    "task_list",
  ],
};

export const BUILTIN_ROLES: readonly Role[] = [
  ARCHITECT,
  EXECUTOR,
  REVIEWER,
  RESOLVER,
  INTEGRATOR,
];

// ---------------------------------------------------------------------------
// Custom role loader
// ---------------------------------------------------------------------------

/**
 * Load custom roles from a JSON file.
 *
 * Shape: `{ "roles": Role[] }`. Each entry is Zod-validated against RoleSchema;
 * invalid entries are SKIPPED with a stderr warning rather than aborting the
 * whole load. A missing file yields `[]` silently. Unreadable or malformed
 * files yield `[]` with a stderr warning.
 *
 * The trust boundary is the same as M2 hooks: `.openswarm/roles.json` is
 * user-controlled. Signed role manifests are M5+.
 */
export async function loadCustomRoles(
  configPath: string,
): Promise<readonly Role[]> {
  // Missing file → []
  if (!fs.existsSync(configPath)) return [];

  let raw: string;
  try {
    raw = await fsp.readFile(configPath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[openswarm] roles: unreadable ${configPath}: ${msg}\n`,
    );
    return [];
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[openswarm] roles: malformed JSON in ${configPath}: ${msg}\n`,
    );
    return [];
  }

  const fileParsed = RolesFileSchema.safeParse(json);
  if (!fileParsed.success) {
    process.stderr.write(
      `[openswarm] roles: invalid shape in ${configPath} (expected { roles: Role[] }): ${fileParsed.error.message}\n`,
    );
    return [];
  }

  const out: Role[] = [];
  for (let i = 0; i < fileParsed.data.roles.length; i++) {
    const entry = fileParsed.data.roles[i];
    const parsed = RoleSchema.safeParse(entry);
    if (!parsed.success) {
      process.stderr.write(
        `[openswarm] roles: skipping invalid role at index ${i}: ${parsed.error.message}\n`,
      );
      continue;
    }
    out.push({
      name: parsed.data.name,
      systemPromptSuffix: parsed.data.systemPromptSuffix,
      allowedTools: [...parsed.data.allowedTools],
    });
  }
  return out;
}
