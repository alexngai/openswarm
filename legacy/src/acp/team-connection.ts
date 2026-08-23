/**
 * team-connection.ts — per-connection coordinator-team wiring for ACP.
 *
 * Extracted from `runAcpTeam` (stdio) so the same setup is shared by the host's
 * ACP-over-WebSocket path (docs/44 P6), where each WebSocket gets its own
 * connection. Builds the permission router + orchestrator runner + spine
 * recorder for one ACP connection and returns the `AcpTeamAgent` plus a
 * `close()` that flushes the spine and disposes the team.
 */

import type { AgentSideConnection, Agent } from "@agentclientprotocol/sdk";
import type { CommonOpts } from "../cli/argv.js";
import { AcpTeamAgent } from "./team-agent.js";
import { createOrchestratorRunner } from "./team-runner.js";
import { AcpPermissionRouter } from "./team-permission.js";
import { startSpineRecorder } from "./spine.js";

export interface TeamConnection {
  readonly agent: Agent;
  /** Flush the spine + dispose the persistent team. Best-effort. */
  close(): Promise<void>;
}

export function createTeamConnection(
  conn: AgentSideConnection,
  opts: CommonOpts,
): TeamConnection {
  const router = new AcpPermissionRouter();
  const runner = createOrchestratorRunner({
    permissionMode: opts.permissionMode,
    interactionHandler: router,
  });
  router.setRoster(() => runner.getActiveTeam()?.members);
  // The conn exists now (we're inside the AgentSideConnection factory), so bind
  // it immediately — permission escalations route to this client.
  router.setConn(conn);
  const spine = startSpineRecorder(runner);
  const agent = new AcpTeamAgent(conn, runner, opts, router, (sessionId) =>
    spine.start(sessionId),
  );

  return {
    agent,
    async close(): Promise<void> {
      try {
        await spine.stop();
      } catch {
        // best effort
      }
      try {
        await runner.getActiveTeam()?.dispose();
      } catch {
        // best effort
      }
    },
  };
}
