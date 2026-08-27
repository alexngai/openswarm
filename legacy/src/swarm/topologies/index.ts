/**
 * Barrel export for the topologies registry — all six shapes:
 *   - `FanoutTopology` — N parallel members, independent tasks
 *   - `PipelineTopology` — sequential; each member's output feeds the next
 *   - `PeerTeamTopology` — N parallel members with live peer messaging
 *     via `send_message` / `check_inbox`
 *   - `CoordinatorTopology` — cc-swarm style; one long-lived root spawns
 *     peers dynamically via `agent({team: "self", ...})`
 *   - `CommitteeTopology` — parallel drafts, then a judge selects/merges
 *   - `CriticLoopTopology` — author/critic revision loop
 *   - `CascadeTopology` — ordered cheap→expensive tiers, escalate below gate τ
 */

export { FanoutTopology } from "./fanout.js";
export { PipelineTopology } from "./pipeline.js";
export { PeerTeamTopology } from "./peer-team.js";
export { CoordinatorTopology } from "./coordinator.js";
export { CommitteeTopology } from "./committee.js";
export { CriticLoopTopology } from "./critic-loop.js";
export { CascadeTopology } from "./cascade.js";
