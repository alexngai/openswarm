import { describe, it, expect } from "vitest";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { initializeResponse } from "./capabilities.js";

describe("initializeResponse", () => {
  it("advertises agent info, empty auth methods, loadSession on", () => {
    const res = initializeResponse({ protocolVersion: PROTOCOL_VERSION });
    expect(res.agentInfo?.name).toBe("swarm-harness");
    expect(res.authMethods).toEqual([]);
    expect(res.agentCapabilities?.loadSession).toBe(true);
    expect(res.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it("clamps a higher requested protocol version down to our max", () => {
    const res = initializeResponse({
      protocolVersion: (PROTOCOL_VERSION + 5) as unknown as number,
    });
    expect(res.protocolVersion).toBe(PROTOCOL_VERSION);
  });
});
