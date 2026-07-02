/**
 * Single-agent translator: NormalizedEvent stream -> ACP session/update.
 * Thin wrapper over the shared emitter (normalized-translate.ts), which is also
 * used by the team lane translator. See docs/archive/32 §9.
 */

import type {
  AgentSideConnection,
  SessionUpdate,
  StopReason,
} from "@agentclientprotocol/sdk";
import type { NormalizedEvent } from "../core/types.js";
import { emitNormalizedEvent } from "./normalized-translate.js";
import { ToolInputAccumulator } from "../core/tool-input.js";

export interface AcpTranslator {
  emit(ev: NormalizedEvent): Promise<void>;
  /** Resolved ACP stop reason after the stream ends (default end_turn). */
  stopReason(): StopReason;
}

export function makeAcpTranslator(
  conn: Pick<AgentSideConnection, "sessionUpdate">,
  sessionId: string,
): AcpTranslator {
  const open = new ToolInputAccumulator<string>();
  let stop: StopReason = "end_turn";
  const send = (update: SessionUpdate): Promise<void> =>
    conn.sessionUpdate({ sessionId, update });

  return {
    async emit(ev: NormalizedEvent): Promise<void> {
      await emitNormalizedEvent(ev, {
        send,
        open,
        setStop: (r) => {
          stop = r;
        },
        planFromTodos: true,
      });
    },
    stopReason: () => stop,
  };
}
