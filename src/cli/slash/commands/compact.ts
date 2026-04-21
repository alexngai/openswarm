/**
 * /compact — hint the engine to compact the conversation.
 *
 * Phase 3 only surfaces the engine-hint prompt; Phase 5 wires the
 * Compactor observer. The REPL will inject this prompt as the next
 * user turn, nudging the model to summarize.
 */

import type { SlashCommand } from "../index.js";

const HINT =
  "Please compact the conversation history now — summarize prior turns to conserve context.";

export const compactCommand: SlashCommand = {
  name: "compact",
  description: "Ask the engine to compact the conversation",
  execute() {
    return { kind: "engine-hint", prompt: HINT };
  },
};
