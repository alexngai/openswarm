/**
 * message-queue.tsx — Renders queued messages above the input during streaming.
 *
 * Phase 3: when the user types and presses Enter while the model is streaming,
 * the message is queued for auto-submission after the turn ends. This component
 * shows the pending queue with a `❯` prefix and an edit hint.
 */

import { createMemo } from "solid-js";
import { theme } from "./theme.js";

export interface MessageQueueProps {
  readonly messages: readonly string[];
}

export function MessageQueue(props: MessageQueueProps) {
  const combined = createMemo(() => {
    const header = `queued (${props.messages.length}):`;
    const items = props.messages.map((msg) => `  ❯ ${msg}`);
    return [header, ...items].join("\n");
  });

  return <text fg={theme.accent}>{combined()}</text>;
}
