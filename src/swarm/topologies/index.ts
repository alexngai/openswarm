/**
 * Barrel export for the topologies registry.
 *
 * Stage 4C shipped `FanoutTopology`. Stage 4E.2 adds `PipelineTopology`
 * (sequential — each member's output becomes context for the next).
 * Stage 4E.3 adds `PeerTeamTopology` (N parallel members with live peer
 * messaging via `send_message` / `check_inbox`). The remaining shapes
 * (coordinator, committee, critic-loop) land in 4E.4.
 */

export { FanoutTopology } from "./fanout.js";
export { PipelineTopology } from "./pipeline.js";
export { PeerTeamTopology } from "./peer-team.js";
