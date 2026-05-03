/**
 * Barrel export for the topologies registry.
 *
 * Stage 4C shipped `FanoutTopology`. Stage 4E.2 adds `PipelineTopology`
 * (sequential — each member's output becomes context for the next).
 * Stage 4E.3 adds `PeerTeamTopology` (N parallel members with live peer
 * messaging via `send_message` / `check_inbox`). Stage 4E.4 adds
 * `CoordinatorTopology` (cc-swarm style — one long-lived root spawns
 * peers dynamically via `agent({team: "self", ...})`). The remaining
 * shapes (committee, critic-loop) land later in 4E.
 */

export { FanoutTopology } from "./fanout.js";
export { PipelineTopology } from "./pipeline.js";
export { PeerTeamTopology } from "./peer-team.js";
export { CoordinatorTopology } from "./coordinator.js";
