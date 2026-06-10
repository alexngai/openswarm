import { describe, it, expect, vi } from "vitest";
import { wireAcpOverMap } from "./map-acp-bridge.js";
import type { AgentConnection } from "@multi-agent-protocol/sdk";
import type { CommonOpts } from "../cli/argv.js";

/**
 * docs/44 Case 2 — ACP-over-MAP structural wiring. The full ACP chat round-trip
 * is driven by a real OpenHive `ACPStreamConnection` client (per-stream sessions
 * arrive as ACP envelopes); here we verify the adapter wires onto the connection
 * and tears down cleanly. The team-session logic itself is covered by the P6
 * ACP suite (`createTeamConnection` / `AcpTeamAgent`).
 */

const acpOpts: CommonOpts = {
  permissionMode: "workspace-write",
  outputFormat: "json",
  headless: true,
  plugins: true,
  skills: true,
  mcp: true,
  hooks: true,
  dumpTools: false,
  enableWebSearch: false,
  framework: "auto",
};

function fakeConn(): { conn: AgentConnection; onMessage: ReturnType<typeof vi.fn> } {
  const onMessage = vi.fn();
  const conn = { onMessage } as unknown as AgentConnection;
  return { conn, onMessage };
}

describe("wireAcpOverMap", () => {
  it("constructs the ACP-over-MAP adapter on the connection", () => {
    const { conn, onMessage } = fakeConn();
    const acp = wireAcpOverMap({ connection: conn, acpOpts, log: () => {} });
    // The SDK adapter subscribes to inbound MAP messages (ACP envelopes).
    expect(onMessage).toHaveBeenCalled();
    expect(acp.streamCount()).toBe(0);
  });

  it("closes cleanly with no active streams", async () => {
    const { conn } = fakeConn();
    const acp = wireAcpOverMap({ connection: conn, acpOpts, log: () => {} });
    await expect(acp.close()).resolves.toBeUndefined();
    expect(acp.streamCount()).toBe(0);
  });
});
