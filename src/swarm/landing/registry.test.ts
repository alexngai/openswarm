import { describe, it, expect } from "vitest";
import { LandingRegistry } from "./registry.js";
import {
  createDefaultLandingRegistry,
  registerBuiltinLandingStrategies,
  DEFAULT_LANDING_STRATEGY,
} from "./index.js";
import type { LandingStrategy } from "./types.js";

const fakeStrategy = (name: string): LandingStrategy => ({
  name,
  async land() {
    return null;
  },
});

describe("LandingRegistry", () => {
  it("registers and retrieves by name", () => {
    const r = new LandingRegistry();
    const s = fakeStrategy("custom");
    r.register(s);
    expect(r.get("custom")).toBe(s);
    expect(r.has("custom")).toBe(true);
    expect(r.get("missing")).toBeUndefined();
    expect(r.has("missing")).toBe(false);
  });

  it("lists registered names", () => {
    const r = new LandingRegistry();
    r.register(fakeStrategy("a"));
    r.register(fakeStrategy("b"));
    expect([...r.list()].sort()).toEqual(["a", "b"]);
  });

  it("last registration wins for a duplicate name", () => {
    const r = new LandingRegistry();
    const first = fakeStrategy("dup");
    const second = fakeStrategy("dup");
    r.register(first);
    r.register(second);
    expect(r.get("dup")).toBe(second);
  });
});

describe("built-in landing strategies", () => {
  it("registerBuiltinLandingStrategies adds merge-to-parent", () => {
    const r = new LandingRegistry();
    registerBuiltinLandingStrategies(r);
    expect(r.has(DEFAULT_LANDING_STRATEGY)).toBe(true);
    expect(r.get(DEFAULT_LANDING_STRATEGY)?.name).toBe("merge-to-parent");
  });

  it("createDefaultLandingRegistry is pre-loaded with the default", () => {
    const r = createDefaultLandingRegistry();
    expect(r.get(DEFAULT_LANDING_STRATEGY)).toBeDefined();
  });
});
