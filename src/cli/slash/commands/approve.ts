import type { SlashCommand } from "../index.js";

export const approveCommand: SlashCommand = {
  name: "approve",
  description: "Approve a pending permission request",
  allowedInStates: ["awaiting-permission", "streaming"],
  execute(ctx) {
    if (ctx.state.pendingPermission === undefined) {
      return { kind: "error", message: "no pending permission request" };
    }
    return {
      kind: "reducer-event",
      event: { type: "permission-response", decision: "approve" },
    };
  },
};
