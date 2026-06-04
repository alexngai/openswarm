import { describe, it, expect } from "vitest";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import {
  initializeResponse,
  readClientSwarmCapability,
} from "./capabilities.js";

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

  it("advertises _meta.swarm only when swarmMeta is set (B1.2)", () => {
    const off = initializeResponse({ protocolVersion: PROTOCOL_VERSION });
    expect(
      (off.agentCapabilities as { _meta?: unknown })._meta,
    ).toBeUndefined();
    const on = initializeResponse(
      { protocolVersion: PROTOCOL_VERSION },
      { loadSession: false, swarmMeta: true },
    );
    expect(
      (on.agentCapabilities as { _meta?: { swarm?: { v?: number } } })._meta?.swarm
        ?.v,
    ).toBe(1);
    expect(on.agentCapabilities?.loadSession).toBe(false);
  });
});

describe("readClientSwarmCapability", () => {
  it("returns undefined when the client sent no swarm capability (baseline)", () => {
    expect(readClientSwarmCapability({ protocolVersion: PROTOCOL_VERSION })).toBeUndefined();
    expect(
      readClientSwarmCapability({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      }),
    ).toBeUndefined();
  });

  it("reads memberText from clientCapabilities._meta.swarm", () => {
    const cap = readClientSwarmCapability({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        _meta: { swarm: { memberText: "interleave" } },
      },
    } as unknown as Parameters<typeof readClientSwarmCapability>[0]);
    expect(cap?.memberText).toBe("interleave");
  });
});
