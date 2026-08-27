import type { SlashCommand } from "../index.js";

export const statusCommand: SlashCommand = {
  name: "status",
  description: "Show current state, permission mode, session id, model, tokens",
  execute(ctx) {
    const u = ctx.getUsage();
    const cacheRead = u.cacheReadInputTokens ?? 0;
    const cacheWrite = u.cacheWriteInputTokens ?? 0;
    const totalTokens = u.inputTokens + u.outputTokens + cacheRead + cacheWrite;
    const session = ctx.state.sessionId ?? "—";
    // Cache share of the input side + context-per-turn (docs/55 TE-19). Both
    // lines appear only once usage has flowed; turns come from the store's
    // usage-update counter (one per message_stop).
    const cacheLine =
      cacheRead + u.inputTokens > 0
        ? `\ncache: ${Math.round((cacheRead / (cacheRead + u.inputTokens)) * 100)}% of input read from cache`
        : "";
    const turns = ctx.state.usageStats?.turns ?? 0;
    const ctxPerTurnLine =
      turns > 0
        ? `\nctx/turn: ${Math.round((u.inputTokens + cacheRead + cacheWrite) / turns)} tokens (${turns} turns)`
        : "";
    return {
      kind: "message",
      text:
        `state: ${ctx.state.name}\n` +
        `permission: ${ctx.getPermissionMode()}\n` +
        `session: ${session}\n` +
        `model: ${ctx.getModel()}\n` +
        `tokens: ${totalTokens}` +
        cacheLine +
        ctxPerTurnLine +
        `\ntoken preflight: local-estimate`,
    };
  },
};
