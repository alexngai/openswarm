import type { SlashCommand } from "../index.js";

export const statusCommand: SlashCommand = {
  name: "status",
  description: "Show current state, permission mode, session id, model, tokens",
  execute(ctx) {
    const u = ctx.getUsage();
    const totalTokens =
      u.inputTokens +
      u.outputTokens +
      (u.cacheReadInputTokens ?? 0) +
      (u.cacheWriteInputTokens ?? 0);
    const session = ctx.state.sessionId ?? "—";
    return {
      kind: "message",
      text:
        `state: ${ctx.state.name}\n` +
        `permission: ${ctx.getPermissionMode()}\n` +
        `session: ${session}\n` +
        `model: ${ctx.getModel()}\n` +
        `tokens: ${totalTokens}`,
    };
  },
};
