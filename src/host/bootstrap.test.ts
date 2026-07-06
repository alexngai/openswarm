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

  it("reads the OpenSwarm bootstrap env vars", () => {
    const cfg = readBootstrapConfig({
      OPENSWARM_BOOTSTRAP_COORDINATOR: "true",
      OPENSWARM_BOOTSTRAP_CWD: "/work/repo",
      OPENSWARM_BOOTSTRAP_REHYDRATE: "all",
      OPENSWARM_DATA_DIR: "/data/swarm-1",
    });
    expect(cfg.coordinator).toBe(true);
    expect(cfg.coordinatorCwd).toBe("/work/repo");
    expect(cfg.rehydrate).toBe("all");
    expect(cfg.dataDir).toBe("/data/swarm-1");
  });

  it("decodes a base64 JSON bootstrap token", () => {
    const token = { openteams: { team_bundle_id: "tb_1" }, foo: 42 };
    const raw = Buffer.from(JSON.stringify(token), "utf-8").toString("base64");
    const cfg = readBootstrapConfig({ OPENSWARM_BOOTSTRAP_TOKEN: raw });
    expect(cfg.token).toEqual(token);
  });

  it("tolerates a malformed token (non-fatal, token undefined)", () => {
    const cfg = readBootstrapConfig({
      OPENSWARM_BOOTSTRAP_TOKEN: "@@not-base64-json@@",
      OPENSWARM_BOOTSTRAP_COORDINATOR: "true",
    });
    expect(cfg.token).toBeUndefined();
    expect(cfg.coordinator).toBe(true); // rest still parses
  });

  it("falls back to rehydrate=coordinators on an unknown policy value", () => {
    const cfg = readBootstrapConfig({ OPENSWARM_BOOTSTRAP_REHYDRATE: "bogus" });
    expect(cfg.rehydrate).toBe("coordinators");
  });

  it("treats coordinator values other than 'true' as false", () => {
    expect(readBootstrapConfig({ OPENSWARM_BOOTSTRAP_COORDINATOR: "1" }).coordinator).toBe(false);
    expect(readBootstrapConfig({ OPENSWARM_BOOTSTRAP_COORDINATOR: "" }).coordinator).toBe(false);
  });

  it("accepts OpenHive's MACRO_BOOTSTRAP_* coordinator aliases", () => {
    const cfg = readBootstrapConfig({
      MACRO_BOOTSTRAP_COORDINATOR: "true",
      MACRO_BOOTSTRAP_CWD: "/work/repo",
      MACRO_BOOTSTRAP_REHYDRATE: "all",
      SWARM_RUNNER_DATA_DIR: "/data/swarm-2",
    });
    expect(cfg.coordinator).toBe(true);
    expect(cfg.coordinatorCwd).toBe("/work/repo");
    expect(cfg.rehydrate).toBe("all");
    expect(cfg.dataDir).toBe("/data/swarm-2");
  });

  it("prefers the OPENSWARM_* names over the MACRO_* aliases when both are set", () => {
    const cfg = readBootstrapConfig({
      OPENSWARM_BOOTSTRAP_CWD: "/openswarm/cwd",
      MACRO_BOOTSTRAP_CWD: "/macro/cwd",
    });
    expect(cfg.coordinatorCwd).toBe("/openswarm/cwd");
  });

  it("surfaces hub dial-back fields from the token", () => {
    const raw = Buffer.from(
      JSON.stringify({
        openhive_url: "http://127.0.0.1:7836",
        onboard_token: "ohk_delegated_abc",
        swarm_id: "swarm_ABC123",
        swarm_name: "my-swarm",
      }),
      "utf-8",
    ).toString("base64");
    const cfg = readBootstrapConfig({ OPENSWARM_BOOTSTRAP_TOKEN: raw });
    expect(cfg.hubUrl).toBe("http://127.0.0.1:7836");
    expect(cfg.onboardToken).toBe("ohk_delegated_abc");
    expect(cfg.swarmId).toBe("swarm_ABC123");
    expect(cfg.swarmName).toBe("my-swarm");
  });

  it("leaves hub fields undefined when the token omits them", () => {
    const raw = Buffer.from(JSON.stringify({ foo: 1 }), "utf-8").toString("base64");
    const cfg = readBootstrapConfig({ OPENSWARM_BOOTSTRAP_TOKEN: raw });
    expect(cfg.hubUrl).toBeUndefined();
    expect(cfg.swarmId).toBeUndefined();
  });

  it("reads the token from the SWARM_RUNNER_ alias too", () => {
    const raw = Buffer.from(
      JSON.stringify({ openhive_url: "http://hub:9000" }),
      "utf-8",
    ).toString("base64");
    const cfg = readBootstrapConfig({ SWARM_RUNNER_BOOTSTRAP_TOKEN: raw });
    expect(cfg.hubUrl).toBe("http://hub:9000");
  });

});
