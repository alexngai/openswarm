/**
 * /resume — restart a prior session.
 *
 * Only valid in `idle` state. With no args, lists the last 10 session ids
 * from the per-worktree session log (`.swarm-coder/sessions.log` unless
 * overridden via `SlashCommandContext.sessionLogPath`). With one arg,
 * emits a message signalling the REPL to wire `RunConfig.resumeFrom` for
 * the next turn. Phase 5 threads the actual `resumeFrom` through.
 */

import * as fs from "node:fs";
import type { SlashCommand } from "../index.js";

function readLastSessionIds(logPath: string, max: number): readonly string[] {
  try {
    const raw = fs.readFileSync(logPath, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
    // Each line may be plain id or JSON `{ "sessionId": "..." }`. Handle both.
    const ids: string[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "sessionId" in parsed &&
          typeof (parsed as { sessionId: unknown }).sessionId === "string"
        ) {
          ids.push((parsed as { sessionId: string }).sessionId);
          continue;
        }
      } catch {
        // fall through
      }
      ids.push(line);
    }
    return ids.slice(-max).reverse();
  } catch {
    return [];
  }
}

export const resumeCommand: SlashCommand = {
  name: "resume",
  description: "Resume a prior session (usage: /resume [<sessionId>])",
  allowedInStates: ["idle"],
  execute(ctx) {
    if (ctx.args.length === 0) {
      const ids = readLastSessionIds(
        ctx.sessionLogPath ?? ".swarm-coder/sessions.log",
        10,
      );
      if (ids.length === 0) {
        return { kind: "message", text: "no prior sessions found" };
      }
      return {
        kind: "message",
        text: `recent sessions:\n${ids.map((id) => `  ${id}`).join("\n")}`,
      };
    }
    if (ctx.args.length > 1) {
      return { kind: "error", message: "usage: /resume [<sessionId>]" };
    }
    const sessionId = ctx.args[0]!;
    // Surface the session id to the REPL via a session-id reducer event.
    // Phase 5 adds a side-channel that lets runRepl pull this into
    // `RunConfig.resumeFrom` on the next turn.
    return {
      kind: "reducer-event",
      event: { type: "session-id", sessionId },
    };
  },
};
