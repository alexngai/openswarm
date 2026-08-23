/**
 * /tasks — list the current swarm task registry.
 *
 * Delegates to the injected `SwarmHost.task` API when a host is present.
 * With no host, reports inability to inspect. Phase 6+ may teach the REPL
 * to spin up a standalone host by default.
 */

import type { SlashCommand } from "../index.js";

export const tasksCommand: SlashCommand = {
  name: "tasks",
  description: "List tasks from the current swarm host",
  async execute(ctx) {
    if (ctx.host === undefined) {
      return {
        kind: "message",
        text: "task inspection not yet wired (no host in this REPL)",
      };
    }
    try {
      const records = await ctx.host.task.list();
      if (records.length === 0) {
        return { kind: "message", text: "no tasks" };
      }
      // Prompt can be long — show the first line as the subject.
      const lines = records.map((r) => {
        const subject = r.prompt.split(/\r?\n/)[0] ?? "";
        const trimmed = subject.length > 60 ? subject.slice(0, 57) + "..." : subject;
        return `  ${r.id}  [${r.status}]  ${trimmed}`;
      });
      return {
        kind: "message",
        text: `tasks (${records.length}):\n${lines.join("\n")}`,
      };
    } catch (err) {
      return {
        kind: "error",
        message: `failed to list tasks: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  },
};
