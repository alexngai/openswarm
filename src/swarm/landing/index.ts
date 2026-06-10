/**
 * landing/ — pluggable LandingStrategy seam (docs/44 P0).
 *
 * Public surface: the types, the registry, the built-in `merge-to-parent`
 * strategy, and helpers to construct a registry pre-loaded with built-ins.
 */

import { LandingRegistry } from "./registry.js";
import { MergeToParentStrategy } from "./merge-to-parent.js";

export * from "./types.js";
export { LandingRegistry } from "./registry.js";
export { MergeToParentStrategy } from "./merge-to-parent.js";

/** Strategy name used when a role/spec doesn't select one explicitly. */
export const DEFAULT_LANDING_STRATEGY = "merge-to-parent";

/**
 * Register the built-in landing strategies on a registry. Today only
 * `merge-to-parent`; `queue-to-branch` / `direct-push` land in docs/44 P4.
 */
export function registerBuiltinLandingStrategies(registry: LandingRegistry): void {
  registry.register(new MergeToParentStrategy());
}

/** Construct a registry pre-loaded with the built-in strategies. */
export function createDefaultLandingRegistry(): LandingRegistry {
  const registry = new LandingRegistry();
  registerBuiltinLandingStrategies(registry);
  return registry;
}
