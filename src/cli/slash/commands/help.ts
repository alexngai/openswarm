import type { SlashCommand } from "../index.js";

export const helpCommand: SlashCommand = {
  name: "help",
  description: "List all available slash commands",
  execute(ctx) {
    const lines = ctx.registry
      .list()
      .map((c) => `  /${c.name} — ${c.description}`);
    return {
      kind: "message",
      text: `available slash commands:\n${lines.join("\n")}`,
    };
  },
};
