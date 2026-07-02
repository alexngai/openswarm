import type { PermissionMode } from "../core/types.js";

/**
 * Numeric order for PermissionMode values.
 * Higher number = broader access.
 */
const PERMISSION_ORDER: Record<PermissionMode, number> = {
  "read-only": 0,
  "workspace-write": 1,
  "danger-full-access": 2,
};

/**
 * Clamp a child's requested permission mode so it cannot exceed the parent's.
 * If the child requests broader access than the parent allows, the parent's
 * mode is returned instead.
 */
export function clampPermissionMode(
  childRequested: PermissionMode,
  parentActive: PermissionMode,
): PermissionMode {
  return PERMISSION_ORDER[childRequested] > PERMISSION_ORDER[parentActive]
    ? parentActive
    : childRequested;
}

/** Numeric rank of a permission mode (higher = broader access). */
export function permissionRank(mode: PermissionMode): number {
  return PERMISSION_ORDER[mode];
}
