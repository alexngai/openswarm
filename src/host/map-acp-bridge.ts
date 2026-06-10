/**
 * map-acp-bridge.ts — docs/44 Case 2. ACP-over-MAP: serve live ACP chat with the
 * swarm's coordinator over the OUTBOUND MAP connection (when the hub can't dial
 * our ACP-WS server directly).
 *
 * OpenHive opens an ACP session over MAP via the SDK's client-side
 * `ACPStreamConnection`; we serve it with the SDK's server-side
 * `ACPAgentAdapter`. The adapter manages the MAP transport + per-stream session
 * context; we implement its `ACPAgentHandler` by delegating to our existing
 * per-connection coordinator team (`createTeamConnection` / `AcpTeamAgent`,
 * docs/44 P6) — so ALL the team logic is reused. A per-stream forwarding shim
 * routes the team's `sessionUpdate` / `requestPermission` back through the
 * adapter (keyed by streamId).
 *
 * NOTE: the two ACP type systems (`@agentclientprotocol/sdk` used by our team
 * agent vs the MAP SDK's `ACP*` types) are structurally the ACP spec; the casts
 * here bridge the nominal gap. End-to-end protocol-version negotiation is
 * validated against a live OpenHive / `ACPStreamConnection`.
 */

import { ACPAgentAdapter, type AgentConnection } from "@multi-agent-protocol/sdk";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { createTeamConnection, type TeamConnection } from "../acp/team-connection.js";
import type { CommonOpts } from "../cli/argv.js";

export interface AcpOverMapOptions {
  /** The outbound MAP AgentConnection (from the sidecar). */
  readonly connection: AgentConnection;
  /** Hosted ACP coordinator-team options (model/permission/etc.). */
  readonly acpOpts: CommonOpts;
  readonly log?: (msg: string) => void;
}

export interface AcpOverMap {
  /** Active ACP-over-MAP stream count. */
  streamCount(): number;
  close(): Promise<void>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export function wireAcpOverMap(opts: AcpOverMapOptions): AcpOverMap {
  const log = opts.log ?? (() => {});
  const streams = new Map<string, TeamConnection>();
  // Late-bound: the handler needs the adapter to send updates, but the adapter
  // is constructed FROM the handler — resolve the cycle with a ref.
  const adapterRef: { current: ACPAgentAdapter | undefined } = { current: undefined };

  /**
   * Per-stream shim standing in for the ACP `AgentSideConnection` our team agent
   * writes to: forward its two outbound calls to the MAP adapter, keyed by the
   * stream this team serves.
   */
  function shimConn(streamId: string): AgentSideConnection {
    return {
      sessionUpdate: async (n: unknown) => {
        await adapterRef.current?.sendSessionUpdate(streamId, n as any);
      },
      requestPermission: async (r: unknown) =>
        (await adapterRef.current?.requestPermission(streamId, r as any)) as any,
    } as unknown as AgentSideConnection;
  }

  function teamFor(streamId: string): TeamConnection {
    let tc = streams.get(streamId);
    if (tc === undefined) {
      tc = createTeamConnection(shimConn(streamId), opts.acpOpts);
      streams.set(streamId, tc);
      log(`[acp-map] new ACP stream ${streamId} (${streams.size} active)`);
    }
    return tc;
  }

  const handler = {
    initialize: async (params: any, ctx: { streamId: string }) =>
      (await teamFor(ctx.streamId).agent.initialize(params)) as any,
    authenticate: async (params: any, ctx: { streamId: string }) =>
      (await teamFor(ctx.streamId).agent.authenticate?.(params)) as any,
    newSession: async (params: any, ctx: { streamId: string }) =>
      (await teamFor(ctx.streamId).agent.newSession(params)) as any,
    loadSession: async (params: any, ctx: { streamId: string }) =>
      (await teamFor(ctx.streamId).agent.loadSession?.(params)) as any,
    setSessionMode: async (params: any, ctx: { streamId: string }) =>
      (await teamFor(ctx.streamId).agent.setSessionMode?.(params)) as any,
    prompt: async (params: any, ctx: { streamId: string }) =>
      (await teamFor(ctx.streamId).agent.prompt(params)) as any,
    cancel: async (params: any, ctx: { streamId: string }) => {
      await teamFor(ctx.streamId).agent.cancel?.(params);
    },
  };

  const adapter = new ACPAgentAdapter(opts.connection, handler as any);
  adapterRef.current = adapter;
  log("[acp-map] ACP-over-MAP adapter wired");

  return {
    streamCount: () => streams.size,
    async close(): Promise<void> {
      for (const tc of streams.values()) {
        try {
          await tc.close();
        } catch {
          // best effort
        }
      }
      streams.clear();
    },
  };
}
