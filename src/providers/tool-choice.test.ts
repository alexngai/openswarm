import { describe, it, expect } from "vitest";
import { toolChoiceOption, toVercelToolChoice } from "./tool-choice.js";
import type { ToolSpec } from "../core/types.js";

function spec(name: string): ToolSpec {
  return {
    name,
    description: "",
    inputSchema: { type: "object" },
    requiredPermission: "none",
    tier: 0,
  };
}

const TOOLS = [spec("bash"), spec("read_file")];

describe("toVercelToolChoice", () => {
  it("returns undefined when unset, leaving the SDK default", () => {
    expect(toVercelToolChoice({ tools: TOOLS })).toBeUndefined();
  });

  it("passes the modes through", () => {
    expect(toVercelToolChoice({ toolChoice: "auto", tools: TOOLS })).toBe("auto");
    expect(toVercelToolChoice({ toolChoice: "none", tools: TOOLS })).toBe("none");
    expect(toVercelToolChoice({ toolChoice: "required", tools: TOOLS })).toBe(
      "required",
    );
  });

  it("maps a named tool to the SDK shape", () => {
    expect(toVercelToolChoice({ toolChoice: { name: "bash" }, tools: TOOLS })).toEqual({
      type: "tool",
      toolName: "bash",
    });
  });

  it("drops a named tool that is not advertised", () => {
    expect(
      toVercelToolChoice({ toolChoice: { name: "nope" }, tools: TOOLS }),
    ).toBeUndefined();
  });

  it("drops any choice when the request advertises no tools", () => {
    // `required` against an empty tool set is a provider-side error.
    expect(toVercelToolChoice({ toolChoice: "required", tools: [] })).toBeUndefined();
    expect(toVercelToolChoice({ toolChoice: "required" })).toBeUndefined();
  });
});

describe("toolChoiceOption", () => {
  it("returns an empty object when there is nothing to set", () => {
    expect(toolChoiceOption({ tools: TOOLS })).toEqual({});
  });

  it("returns a spreadable option when set", () => {
    expect(toolChoiceOption({ toolChoice: "required", tools: TOOLS })).toEqual({
      toolChoice: "required",
    });
  });
});
