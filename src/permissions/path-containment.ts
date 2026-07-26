/**
 * Central path containment for the permission gate (docs/63 §A4, WP-03).
 *
 * Every file-bearing tool has, until now, answered "is this path allowed?" for
 * itself: resolve against cwd, prefix-compare with `isUnderCwd`, then realpath
 * only when the leaf itself is a symlink. Thirteen call sites, five of them
 * duplicating the same three steps, and all of them sharing one gap — nothing
 * resolves the *ancestor* chain, so a path whose parent directory is a symlink
 * out of the workspace passes.
 *
 * This moves the question to the one place every engine already goes through.
 * The Claude SDK, Codex, native, and hardened-native paths all call
 * `canUseTool` before executing anything, so a check here covers all four
 * without touching an engine. `WorkspaceAuthority.canonicalize` walks to the
 * deepest existing ancestor and resolves *that*, which is what closes the
 * parent-symlink gap and also gives a trustworthy answer for a file that does
 * not exist yet — the case a create has to get right.
 *
 * Resources come from the tool's `accesses` declaration rather than from
 * re-parsing tool input here, so this stays correct as tools change shape.
 *
 * Two cases yield no opinion, and both fall through to the checks that already
 * exist rather than denying:
 *
 *   - A tool that declares `all()` names no path to canonicalize. `bash` is the
 *     example, and it has its own validation gate.
 *   - A tool with no `accesses` callback. Plugin and MCP tools cannot predict
 *     their paths, and denying them here would break every one of them.
 *
 * Neither case is a hole this module opens; both are the status quo it leaves
 * in place. Closing them is the job of the discriminated policy engine, which
 * can express "unknown resource" as something other than silence.
 */

import { WorkspaceAuthority, PathEscapeError } from "../kernel/workspace-authority.js";
import type { ToolImpl } from "../tools/types.js";
import type { ToolFileAccess } from "../tools/access.js";
import type { PermissionDecision } from "../engine/index.js";

/**
 * Decides containment for one tool call. Resolves to `null` when the call
 * declares no path this can judge.
 */
export type PathContainmentCheck = (
  toolImpl: ToolImpl,
  input: unknown,
) => Promise<PermissionDecision | null>;

/** Human-readable operation label for a denial message. */
function operationLabel(access: ToolFileAccess): string {
  switch (access.operation) {
    case "read":
      return "read";
    case "search":
      return "search";
    case "write":
      return "write to";
    case "readwrite":
      return "modify";
  }
}

export function makePathContainment(cwd: string): PathContainmentCheck {
  const authority = new WorkspaceAuthority(cwd);
  // The workspace root is realpath'd once. Containment is meaningless against
  // an unresolved root — on macOS /tmp is itself a symlink — so every check
  // waits on the same initialization.
  let ready: Promise<void> | undefined;
  const init = (): Promise<void> => (ready ??= authority.init());

  return async (toolImpl, input) => {
    if (toolImpl.accesses === undefined) return null;

    let declared;
    try {
      declared = toolImpl.accesses(input, { cwd });
    } catch {
      // A declaration that throws on its own input is a bug in the tool, not a
      // statement about paths. The dispatcher treats this as `all()`; matching
      // that keeps one interpretation of a broken declaration.
      return null;
    }

    const files = declared.filter((a): a is ToolFileAccess => a.kind === "file");
    if (files.length === 0) return null;

    await init();

    for (const access of files) {
      try {
        await authority.canonicalize(access.path);
      } catch (err) {
        if (err instanceof PathEscapeError) {
          return {
            allow: false,
            reason:
              `${toolImpl.spec.name} would ${operationLabel(access)} ` +
              `${JSON.stringify(access.path)}, which resolves outside the workspace`,
          };
        }
        throw err;
      }
    }

    return null;
  };
}
