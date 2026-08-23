import type { SlashCommand } from "../index.js";

export const exitCommand: SlashCommand = {
  name: "exit",
  description: "Exit the REPL",
  execute() {
    return { kind: "reducer-event", event: { type: "shutdown" } };
  },
};
