/**
 * Translates a `PermissionMode` into the policy engine's standing rules.
 *
 * The two models answer different questions. `PermissionMode` grades a *tool*
 * by its declared `requiredPermission`, so every write-capable tool is treated
 * alike regardless of what it writes. `PolicyRules` grades an *operation* by
 * class, which is what makes a grant bindable to one resource.
 *
 * The translation is exact for the classes currently derived, so switching a
 * file operation from one to the other changes no answer:
 *
 *   read-only          reads allowed, writes prompt   → READ_ONLY_RULES
 *   workspace-write    reads and writes allowed       → WORKSPACE_WRITE_RULES
 *   danger-full-access everything allowed             → all four allow
 *
 * What it adds is memory. A prompted write under read-only is currently
 * re-prompted every call; as a policy decision it can be approved once and
 * bound to that path.
 */

import type { PermissionMode } from "../core/types.js";
import type { PolicyRules } from "../kernel/policy-engine.js";
import { READ_ONLY_RULES, WORKSPACE_WRITE_RULES } from "../kernel/policy-engine.js";

const FULL_ACCESS_RULES: PolicyRules = {
  "file.read": "allow",
  "file.write": "allow",
  "process.exec": "allow",
  "network.request": "allow",
};

export function rulesForMode(mode: PermissionMode): PolicyRules {
  switch (mode) {
    case "read-only":
      return READ_ONLY_RULES;
    case "workspace-write":
      return WORKSPACE_WRITE_RULES;
    case "danger-full-access":
      return FULL_ACCESS_RULES;
  }
}
