/**
 * /stop — abort the current streaming turn.
 *
 * Fires the injected AbortController if present. Also emits a
 * `stream-end` reducer event so the REPL transitions back to idle
 * promptly even if the engine doesn't flush a `message_stop` in
 * response to the abort.
 */

import type { SlashCommand } from "../index.js";

export const stopCommand: SlashCommand = {
  name: "stop",
  description: "Abort the current streaming turn",
  allowedInStates: ["streaming", "awaiting-permission"],
  execute(ctx) {
    if (ctx.abort !== undefined) {
      try {
        ctx.abort.abort();
      } catch {
        // AbortController.abort never throws, but be defensive anyway.
      }
    }
    return {
      kind: "reducer-event",
      event: { type: "stream-end" },
    };
  },
};
