/**
 * ACP `initialize` response — capability + version negotiation.
 *
 * OpenSwarm owns zero auth code (env/keychain auth is validated in
 * buildAgentRuntime), so no auth methods are advertised. `loadSession` and
 * `promptCapabilities` are intentionally conservative for Stage A Steps 1–2;
 * they expand as the corresponding handlers land.
 */

import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type {
  InitializeRequest,
  InitializeResponse,
} from "@agentclientprotocol/sdk";
import { VERSION } from "../index.js";

export interface InitializeOptions {
  /** Whether to advertise session/load. Default true (single-agent). */
  readonly loadSession?: boolean;
  /**
   * When true (team mode), advertise `_meta.swarm` support so rich clients
   * can detect the enrichment and optionally request `memberText: "interleave"`
   * (B1.2). Baseline clients ignore the extra key.
   */
  readonly swarmMeta?: boolean;
}

/** The `_meta.swarm` client-capability shape we read at initialize (B1.2). */
export interface ClientSwarmCapability {
  /** `"interleave"` enables non-lead text streaming; default is `"collapse"`. */
  readonly memberText?: "collapse" | "interleave";
}

/**
 * Read the `_meta.swarm` marker from `clientCapabilities`, if any. Returns
 * undefined when the client sent no swarm capability (baseline behavior).
 */
export function readClientSwarmCapability(
  req: InitializeRequest,
): ClientSwarmCapability | undefined {
  const caps = req.clientCapabilities as
    | { _meta?: { swarm?: ClientSwarmCapability } }
    | undefined;
  return caps?._meta?.swarm;
}

export function initializeResponse(
  req: InitializeRequest,
  opts: InitializeOptions = {},
): InitializeResponse {
  // Echo the client's version when we support it, else the highest we support.
  const requested =
    typeof req.protocolVersion === "number"
      ? req.protocolVersion
      : PROTOCOL_VERSION;
  const protocolVersion = Math.min(
    requested,
    PROTOCOL_VERSION,
  ) as InitializeResponse["protocolVersion"];

  const agentCapabilities: InitializeResponse["agentCapabilities"] = {
    // Single-agent: session/load replays transcript text and resumes context.
    // Team mode advertises false until team transcript replay lands (B1).
    loadSession: opts.loadSession ?? true,
    // B1.2: advertise _meta.swarm support in team mode. Baseline clients
    // ignore this key; rich clients use it to decide to request interleave.
    ...(opts.swarmMeta && { _meta: { swarm: { v: 1 } } }),
  };

  return {
    protocolVersion,
    agentInfo: { name: "openswarm", version: VERSION },
    agentCapabilities,
    authMethods: [],
  };
}
