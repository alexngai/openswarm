/**
 * ACP `initialize` response — capability + version negotiation.
 *
 * swarm-harness owns zero auth code (env/keychain auth is validated in
 * buildAgentRuntime), so no auth methods are advertised. `loadSession` and
 * `promptCapabilities` are intentionally conservative for Stage A Steps 1–2;
 * they expand as the corresponding handlers land (docs/30 A.4/A.6).
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

  return {
    protocolVersion,
    agentInfo: { name: "swarm-harness", version: VERSION },
    agentCapabilities: {
      // Single-agent: session/load replays transcript text and resumes context.
      // Team mode advertises false until team transcript replay lands (B1).
      loadSession: opts.loadSession ?? true,
    },
    authMethods: [],
  };
}
