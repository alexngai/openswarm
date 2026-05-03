/**
 * Barrel export for the topologies registry.
 *
 * Stage 4C shipped `FanoutTopology`. Stage 4E.2 adds `PipelineTopology`
 * (sequential — each member's output becomes context for the next). The
 * remaining shapes (coordinator, peer-team, committee, critic-loop) land
 * in 4E.3 and 4E.4.
 */

export { FanoutTopology } from "./fanout.js";
export { PipelineTopology } from "./pipeline.js";
