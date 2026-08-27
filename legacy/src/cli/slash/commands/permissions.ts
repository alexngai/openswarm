import type { PermissionMode } from "../../../core/types.js";
import type { SlashCommand } from "../index.js";

const PERMISSION_MODES = new Set<PermissionMode>([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

function isPermissionMode(s: string): s is PermissionMode {
  return PERMISSION_MODES.has(s as PermissionMode);
}

export const permissionsCommand: SlashCommand = {
  name: "permissions",
  description:
    "Show or change permission mode (read-only | workspace-write | danger-full-access)",
  execute(ctx) {
    if (ctx.args.length === 0) {
      return {
        kind: "message",
        text: `current permission mode: ${ctx.getPermissionMode()}`,
      };
    }
    if (ctx.args.length > 1) {
      return {
        kind: "error",
        message:
          "usage: /permissions [read-only | workspace-write | danger-full-access]",
      };
    }
    const raw = ctx.args[0]!.toLowerCase();
    if (!isPermissionMode(raw)) {
      return {
        kind: "error",
        message: `unknown permission mode: ${raw}`,
      };
    }
    // setPermissionMode may clamp silently; we re-read to report the
    // effective post-clamp value.
    ctx.setPermissionMode(raw);
    const after = ctx.getPermissionMode();
    if (after !== raw) {
      return {
        kind: "error",
        message: `permission mode clamped by parent context; requested ${raw}, effective ${after}`,
      };
    }
    return { kind: "message", text: `permission mode set to ${after}` };
  },
};
