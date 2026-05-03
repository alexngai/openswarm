/**
 * Barrel export for the topologies registry.
 *
 * Stage 4C ships only `FanoutTopology`. Stage 4E will add pipeline,
 * coordinator, peer-team, committee, and critic-loop.
 */

export { FanoutTopology } from "./fanout.js";
