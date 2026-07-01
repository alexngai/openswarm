import { describe, it, expect } from "vitest";
import { readBootstrapConfig } from "./bootstrap.js";

/** docs/44 P5 — bootstrap-contract env parsing. */
describe("readBootstrapConfig", () => {
  it("defaults to no coordinator + rehydrate=coordinators on an empty env", () => {
    const cfg = readBootstrapConfig({});
    expect(cfg.coordinator).toBe(false);
    expect(cfg.rehydrate).toBe("coordinators");
    expect(cfg.token).toBeUndefined();
    expect(cfg.dataDir).toBeUndefined();
  });

  it("reads the Swarm Runner bootstrap env vars", () => {
    const cfg = readBootstrapConfig({
      MACRO_BOOTSTRAP_COORDINATOR: "true",
      MACRO_BOOTSTRAP_CWD: "/work/repo",
      MACRO_BOOTSTRAP_REHYDRATE: "all",
      SWARM_RUNNER_DATA_DIR: "/data/swarm-1",
    });
    expect(cfg.coordinator).toBe(true);
    expect(cfg.coordinatorCwd).toBe("/work/repo");
    expect(cfg.rehydrate).toBe("all");
    expect(cfg.dataDir).toBe("/data/swarm-1");
  });

  it("accepts the swarm-harness-prefixed aliases", () => {
    const cfg = readBootstrapConfig({
      SWARM_HARNESS_BOOTSTRAP_COORDINATOR: "true",
      SWARM_HARNESS_DATA_DIR: "/data/sh",
      SWARM_HARNESS_BOOTSTRAP_REHYDRATE: "none",
    });
    expect(cfg.coordinator).toBe(true);
    expect(cfg.dataDir).toBe("/data/sh");
    expect(cfg.rehydrate).toBe("none");
  });

  it("decodes a base64 JSON bootstrap token", () => {
    const token = { openteams: { team_bundle_id: "tb_1" }, foo: 42 };
    const raw = Buffer.from(JSON.stringify(token), "utf-8").toString("base64");
    const cfg = readBootstrapConfig({ SWARM_RUNNER_BOOTSTRAP_TOKEN: raw });
    expect(cfg.token).toEqual(token);
  });

  it("accepts legacy OPENSWARM bootstrap env vars", () => {
    const token = { openteams: { team_bundle_id: "legacy" } };
    const raw = Buffer.from(JSON.stringify(token), "utf-8").toString("base64");
    const cfg = readBootstrapConfig({
      OPENSWARM_BOOTSTRAP_TOKEN: raw,
      OPENSWARM_DATA_DIR: "/data/legacy",
    });
    expect(cfg.token).toEqual(token);
    expect(cfg.dataDir).toBe("/data/legacy");
  });

  it("tolerates a malformed token (non-fatal, token undefined)", () => {
    const cfg = readBootstrapConfig({
      SWARM_RUNNER_BOOTSTRAP_TOKEN: "@@not-base64-json@@",
      MACRO_BOOTSTRAP_COORDINATOR: "true",
    });
    expect(cfg.token).toBeUndefined();
    expect(cfg.coordinator).toBe(true); // rest still parses
  });

  it("falls back to rehydrate=coordinators on an unknown policy value", () => {
    const cfg = readBootstrapConfig({ MACRO_BOOTSTRAP_REHYDRATE: "bogus" });
    expect(cfg.rehydrate).toBe("coordinators");
  });

  it("treats coordinator values other than 'true' as false", () => {
    expect(readBootstrapConfig({ MACRO_BOOTSTRAP_COORDINATOR: "1" }).coordinator).toBe(false);
    expect(readBootstrapConfig({ MACRO_BOOTSTRAP_COORDINATOR: "" }).coordinator).toBe(false);
  });
});
