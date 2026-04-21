/**
 * /compact — hint the engine to compact the conversation.
 *
 * Round-trip flow (Phase 5):
 *   1. User types `/compact` → this command returns `{ kind: "engine-hint", prompt: HINT }`.
 *   2. `applySlashResult` in app.tsx dispatches `{ type: "submit" }` and calls
 *      `onSubmit(HINT)`, injecting the hint as the next user turn.
 *   3. The engine receives the hint prompt and the SDK internally triggers compaction.
 *   4. The SDK emits an `SDKCompactBoundaryMessage` (type "system", subtype
 *      "compact_boundary") with `compact_metadata.trigger === "manual"`.
 *   5. `translateSdkMessage` in event-translator.ts maps this to two `compaction`
 *      NormalizedEvents: `{ phase: "begin" }` then `{ phase: "end" }`.
 *   6. `translateEngineEvent` in app.tsx maps begin → `compact-begin` reducer event
 *      (+ system transcript entry) and end → `compact-end` reducer event.
 *   7. The REPL reducer drives: streaming → compact (on begin) → streaming (on end).
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
