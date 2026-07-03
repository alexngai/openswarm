/**
 * /compact [instructions] — compact the conversation.
 *
 * Native/hardened engines (docs/48-compaction-design.md §"/compact rework"):
 * a real compaction control request via `ctx.requestCompaction`. The engine
 * queues it and runs the full in-session compaction (trigger "manual" — no
 * resume-instruction sentence in the continuation message, matching Claude
 * Code) at the next turn boundary. Optional trailing text is forwarded as
 * Claude Code "Additional Instructions" for the summarizer.
 *
 * SDK engine (no `requestCompaction` wired): falls back to the engine-hint
 * prompt — the SDK triggers its own compaction internally and emits an
 * SDKCompactBoundaryMessage that the event translator maps to `compaction`
 * events.
 */

import type { SlashCommand } from "../index.js";

const HINT =
  "Please compact the conversation history now — summarize prior turns to conserve context.";

export const compactCommand: SlashCommand = {
  name: "compact",
  description: "Compact the conversation (optional: /compact <instructions>)",
  execute(ctx) {
    const instructions = ctx.args.join(" ").trim();
    if (ctx.requestCompaction !== undefined) {
      const accepted = ctx.requestCompaction(
        instructions === "" ? undefined : instructions,
      );
      if (accepted) {
        return {
          kind: "message",
          text:
            instructions === ""
              ? "Compaction queued — runs at the start of the next turn."
              : `Compaction queued with instructions: ${instructions}`,
        };
      }
    }
    return { kind: "engine-hint", prompt: HINT };
  },
};
