/**
 * landing/registry.ts — name-keyed registry of LandingStrategy instances.
 *
 * Mirrors macro-agent's `WorkspaceManager.registerLandingStrategy` surface
 * (docs/44 P0). Topologies look up a strategy by name and call `land()`.
 */

import type { LandingStrategy } from "./types.js";

export class LandingRegistry {
  private readonly strategies = new Map<string, LandingStrategy>();

  register(strategy: LandingStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  get(name: string): LandingStrategy | undefined {
    return this.strategies.get(name);
  }

  has(name: string): boolean {
    return this.strategies.has(name);
  }

  list(): readonly string[] {
    return [...this.strategies.keys()];
  }
}
