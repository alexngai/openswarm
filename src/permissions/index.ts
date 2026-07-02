/**
 * PermissionEngine — mode-only gating for M0.
 *
 * Evaluates whether a tool call is allowed under the active PermissionMode.
 * M0 does not implement claw's full rule grammar (tool(subject:*) patterns);
 * that lands in M2 alongside hooks. For M0 we gate purely by the tool's
 * declared requiredPermission level.
 *
 * Mapping:
 *   read-only          → allow RequiredPermission in {"none", "read"}
 *   workspace-write    → allow in {"none", "read", "write"}
 *   danger-full-access → allow all
 *
 * "exec" and "network" require danger-full-access. "write" requires at
 * minimum workspace-write. This matches the plan's §Phase 3 matrix.
 */

import type { PermissionMode, RequiredPermission, ToolSpec } from "../core/types.js";
import type { PermissionDecision } from "../engine/index.js";

export class PermissionEngine {
  constructor(private readonly mode: PermissionMode) {}

  /**
   * Check whether `tool` may run. `mode` defaults to the engine's construction
   * mode; callers that track a live, mutable mode (the CLI's `/permissions` and
   * `request_permissions` elevation — the gate reads `getCurrentMode()`) pass it
   * explicitly so a mid-session elevation actually takes effect instead of
   * checking against a frozen snapshot.
   *
   * `input` is accepted so future rule grammars can inspect tool arguments
   * (e.g., path patterns); M0 ignores it.
   */
  check(tool: ToolSpec, _input?: unknown, mode?: PermissionMode): PermissionDecision {
    const effectiveMode = mode ?? this.mode;
    const required = tool.requiredPermission;
    if (this.isAllowed(required, effectiveMode)) {
      return { allow: true };
    }
    return {
      allow: false,
      reason:
        `permission denied: tool "${tool.name}" requires "${required}" ` +
        `but mode is "${effectiveMode}"`,
    };
  }

  private isAllowed(required: RequiredPermission, mode: PermissionMode): boolean {
    switch (mode) {
      case "danger-full-access":
        return true;
      case "workspace-write":
        return required === "none" || required === "read" || required === "write";
      case "read-only":
        return required === "none" || required === "read";
    }
  }
}
