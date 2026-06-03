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

export function initializeResponse(req: InitializeRequest): InitializeResponse {
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
      // session/load lands in a later Stage A step; advertise honestly.
      loadSession: false,
    },
    authMethods: [],
  };
}
