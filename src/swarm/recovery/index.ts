/**
 * recovery/ — pluggable ConflictRecoveryStrategy seam (docs/44 P0).
 *
 * P0 exports the types + registry. Built-in strategies and dispatch wiring
 * land in P1.
 */

export * from "./types.js";
export { RecoveryRegistry, DEFAULT_RECOVERY_STRATEGY } from "./registry.js";
