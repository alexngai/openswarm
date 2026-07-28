import { describe, it, expect } from "vitest";
import {
  exportSamplingEnv,
  parseToolChoice,
  resolveSamplingConfig,
  TEMPERATURE_ENV,
  TOOL_CHOICE_ENV,
  TOP_K_ENV,
  TOP_P_ENV,
} from "./sampling.js";

describe("parseToolChoice", () => {
  it("recognises the modes case-insensitively", () => {
    expect(parseToolChoice("auto")).toBe("auto");
    expect(parseToolChoice("REQUIRED")).toBe("required");
    expect(parseToolChoice(" none ")).toBe("none");
  });

  it("treats anything else as a pinned tool name", () => {
    expect(parseToolChoice("bash")).toEqual({ name: "bash" });
  });

  it("returns undefined for unset or empty values", () => {
    expect(parseToolChoice(undefined)).toBeUndefined();
    expect(parseToolChoice("   ")).toBeUndefined();
  });
});

describe("resolveSamplingConfig", () => {
  it("is empty when nothing is set, so provider defaults survive", () => {
    expect(resolveSamplingConfig({}, {})).toEqual({});
  });

  it("reads the environment", () => {
    expect(
      resolveSamplingConfig({
        [TEMPERATURE_ENV]: "0.2",
        [TOP_P_ENV]: "0.95",
        [TOP_K_ENV]: "40",
        [TOOL_CHOICE_ENV]: "required",
      }),
    ).toEqual({ temperature: 0.2, topP: 0.95, topK: 40, toolChoice: "required" });
  });

  it("lets explicit overrides win over the environment", () => {
    expect(
      resolveSamplingConfig({ [TEMPERATURE_ENV]: "0.9" }, { temperature: 0.1 }),
    ).toEqual({ temperature: 0.1 });
  });

  it("accepts temperature 0 rather than treating it as unset", () => {
    expect(resolveSamplingConfig({ [TEMPERATURE_ENV]: "0" })).toEqual({
      temperature: 0,
    });
  });

  it("ignores malformed values", () => {
    expect(
      resolveSamplingConfig({ [TEMPERATURE_ENV]: "hot", [TOP_K_ENV]: "0" }),
    ).toEqual({});
  });

  it("omits absent keys entirely (spreadable into RunConfig)", () => {
    const out = resolveSamplingConfig({ [TOP_P_ENV]: "0.5" });
    expect(Object.keys(out)).toEqual(["topP"]);
  });
});

describe("exportSamplingEnv", () => {
  it("publishes resolved values for spawned workers", () => {
    const env: NodeJS.ProcessEnv = {};
    exportSamplingEnv(
      { temperature: 0.2, topP: 0.9, topK: 40, toolChoice: "required" },
      env,
    );
    expect(env[TEMPERATURE_ENV]).toBe("0.2");
    expect(env[TOP_P_ENV]).toBe("0.9");
    expect(env[TOP_K_ENV]).toBe("40");
    expect(env[TOOL_CHOICE_ENV]).toBe("required");
  });

  it("serialises a pinned tool name", () => {
    const env: NodeJS.ProcessEnv = {};
    exportSamplingEnv({ toolChoice: { name: "bash" } }, env);
    expect(env[TOOL_CHOICE_ENV]).toBe("bash");
  });

  it("does not clobber an already-set variable", () => {
    const env: NodeJS.ProcessEnv = { [TEMPERATURE_ENV]: "0.7" };
    exportSamplingEnv({ temperature: 0.1 }, env);
    expect(env[TEMPERATURE_ENV]).toBe("0.7");
  });

  it("writes nothing for an empty config", () => {
    const env: NodeJS.ProcessEnv = {};
    exportSamplingEnv({}, env);
    expect(Object.keys(env)).toEqual([]);
  });
});
