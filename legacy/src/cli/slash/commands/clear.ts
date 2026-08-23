import type { SlashCommand } from "../index.js";

export const clearCommand: SlashCommand = {
  name: "clear",
  description: "Purge the transcript",
  execute() {
    return { kind: "reducer-event", event: { type: "clear" } };
  },
};
