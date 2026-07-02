import type { SlashCommand } from "../index.js";

/**
 * `/plan` — toggle read-only plan mode.
 *
 *   /plan        toggle plan mode on/off
 *   /plan on     enter plan mode  (forces read-only + plan persona)
 *   /plan off    leave plan mode  (restores the permission ceiling)
 *
 * The actual permission-mode change is owned by the host's `setPlanMode`
 * wiring (main.ts): turning plan on narrows the effective mode to read-only;
 * turning it off restores the parent ceiling. This command just reports state.
 */
export const planCommand: SlashCommand = {
  name: "plan",
  description: "Toggle read-only plan mode (investigate + design, no edits)",
  execute(ctx) {
    const current = ctx.getPlanMode();

    let next: boolean;
    if (ctx.args.length === 0) {
      next = !current;
    } else {
      const arg = ctx.args[0]!.toLowerCase();
      if (arg === "on" || arg === "true") {
        next = true;
      } else if (arg === "off" || arg === "false") {
        next = false;
      } else if (arg === "status") {
        return {
          kind: "message",
          text: `plan mode is ${current ? "on" : "off"} (permission mode: ${ctx.getPermissionMode()})`,
        };
      } else {
        return { kind: "error", message: "usage: /plan [on | off | status]" };
      }
    }

    if (next === current) {
      return { kind: "message", text: `plan mode already ${current ? "on" : "off"}` };
    }

    ctx.setPlanMode(next);
    const mode = ctx.getPermissionMode();
    return {
      kind: "message",
      text: next
        ? `plan mode ON — read-only investigation + design (permission mode: ${mode}). Use /plan off to implement.`
        : `plan mode OFF — permission mode: ${mode}.`,
    };
  },
};
