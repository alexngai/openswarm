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

import { randomUUID } from "node:crypto";
import { WorkspaceAuthority, PathEscapeError } from "../kernel/workspace-authority.js";
import type { OperationRequest } from "../kernel/contracts.js";
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

/**
 * What a tool call's declaration amounts to once its paths are canonicalized.
 *
 * `unknown` is deliberately distinct from an empty request list. A tool that
 * declares `none()` genuinely touches no files; a tool that declares `all()`
 * or nothing at all touches an unknowable set. Collapsing the two would let
 * the second be authorized as though it were the first.
 */
export type DerivedRequests =
  | { readonly kind: "denied"; readonly decision: PermissionDecision }
  | { readonly kind: "unknown" }
  | { readonly kind: "requests"; readonly requests: readonly OperationRequest[] };

/** Canonicalizes a tool call's declared resources into policy requests. */
export type ResourceDeriver = (
  toolImpl: ToolImpl,
  input: unknown,
) => Promise<DerivedRequests>;

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

/** A declared file operation that mutates, versus one that only observes. */
function isWrite(access: ToolFileAccess): boolean {
  return access.operation === "write" || access.operation === "readwrite";
}

export function makeResourceDeriver(cwd: string): ResourceDeriver {
  const authority = new WorkspaceAuthority(cwd);
  // The workspace root is realpath'd once. Containment is meaningless against
  // an unresolved root — on macOS /tmp is itself a symlink — so every call
  // waits on the same initialization.
  let ready: Promise<void> | undefined;
  const init = (): Promise<void> => (ready ??= authority.init());

  return async (toolImpl, input) => {
    if (toolImpl.accesses === undefined) return { kind: "unknown" };

    let declared;
    try {
      declared = toolImpl.accesses(input, { cwd });
    } catch {
      // A declaration that throws on its own input is a bug in the tool, not a
      // statement about paths. The dispatcher treats this as `all()`; matching
      // that keeps one interpretation of a broken declaration.
      return { kind: "unknown" };
    }

    if (declared.some((a) => a.kind === "all")) return { kind: "unknown" };

    const files = declared.filter((a): a is ToolFileAccess => a.kind === "file");
    if (files.length === 0) return { kind: "requests", requests: [] };

    await init();

    const requests: OperationRequest[] = [];
    for (const access of files) {
      let path;
      try {
        path = await authority.canonicalize(access.path);
      } catch (err) {
        if (err instanceof PathEscapeError) {
          return {
            kind: "denied",
            decision: {
              allow: false,
              reason:
                `${toolImpl.spec.name} would ${operationLabel(access)} ` +
                `${JSON.stringify(access.path)}, which resolves outside the workspace`,
            },
          };
        }
        throw err;
      }

      // operationId is assigned per authorization attempt rather than per
      // effect: nothing is executed here, so this identifies the decision.
      const operationId = randomUUID();
      requests.push(
        isWrite(access)
          ? {
              kind: "file.write",
              operationId,
              idempotency: "mutating",
              toolName: toolImpl.spec.name,
              path,
              expected: await authority.identify(path),
            }
          : {
              kind: "file.read",
              operationId,
              idempotency: "idempotent",
              toolName: toolImpl.spec.name,
              path,
            },
      );
    }

    return { kind: "requests", requests };
  };
}

/**
 * Containment-only view of the deriver, for callers that need the boundary
 * enforced but are not yet authorizing per resource.
 */
export function makePathContainment(cwd: string): PathContainmentCheck {
  const derive = makeResourceDeriver(cwd);
  return async (toolImpl, input) => {
    const derived = await derive(toolImpl, input);
    return derived.kind === "denied" ? derived.decision : null;
  };
}
