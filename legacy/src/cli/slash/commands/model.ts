import type { SlashCommand } from "../index.js";

const MODEL_ALIASES = new Set(["sonnet", "opus", "haiku"]);

export const modelCommand: SlashCommand = {
  name: "model",
  description: "Show or change the active model (sonnet | opus | haiku)",
  execute(ctx) {
    if (ctx.args.length === 0) {
      return { kind: "message", text: `current model: ${ctx.getModel()}` };
    }
    if (ctx.args.length > 1) {
      return {
        kind: "error",
        message: "usage: /model [sonnet | opus | haiku]",
      };
    }
    const next = ctx.args[0]!.toLowerCase();
    if (!MODEL_ALIASES.has(next)) {
      return {
        kind: "error",
        message: `unknown model alias: ${next} (expected sonnet | opus | haiku)`,
      };
    }
    ctx.setModel(next);
    return { kind: "message", text: `model set to ${next}` };
  },
};
