import { describe, it, expect, afterEach } from "vitest";
import {
  ContextBuilder,
  getContextBuilder,
  setContextBuilder,
  resetContextBuilder,
  environmentFragment,
  permissionsFragment,
  approvedCommandsFragment,
  userInstructionsFragment,
  modelContextFragment,
  toolInventoryFragment,
  agentRoleFragment,
  type ContextFragment,
  type ContextState,
} from "./index.js";

afterEach(() => {
  resetContextBuilder();
});

function baseState(overrides?: Partial<ContextState>): ContextState {
  return {
    cwd: "/home/user/project",
    permissionMode: "workspace-write",
    model: "claude-sonnet-4-6",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Individual fragments
// ---------------------------------------------------------------------------

describe("environmentFragment", () => {
  it("generates environment info", () => {
    const result = environmentFragment.generate(baseState());
    expect(result).toContain("/home/user/project");
    expect(result).toContain(process.platform);
    expect(result).toContain(process.version);
  });

  it("includes session id when present", () => {
    const result = environmentFragment.generate(
      baseState({ sessionId: "abc-123" }),
    );
    expect(result).toContain("abc-123");
  });

  it("includes turn count when present", () => {
    const result = environmentFragment.generate(
      baseState({ turnCount: 5 }),
    );
    expect(result).toContain("Turn: 5");
  });
});

describe("permissionsFragment", () => {
  it("describes read-only mode", () => {
    const result = permissionsFragment.generate(
      baseState({ permissionMode: "read-only" }),
    );
    expect(result).toContain("read-only");
    expect(result).toContain("MUST NOT write");
  });

  it("describes workspace-write mode", () => {
    const result = permissionsFragment.generate(baseState());
    expect(result).toContain("workspace-write");
  });

  it("describes full-access mode", () => {
    const result = permissionsFragment.generate(
      baseState({ permissionMode: "danger-full-access" }),
    );
    expect(result).toContain("full-access");
    expect(result).toContain("caution");
  });
});

describe("approvedCommandsFragment", () => {
  it("returns null when no commands", () => {
    expect(approvedCommandsFragment.generate(baseState())).toBeNull();
    expect(
      approvedCommandsFragment.generate(
        baseState({ approvedCommands: [] }),
      ),
    ).toBeNull();
  });

  it("lists approved commands", () => {
    const result = approvedCommandsFragment.generate(
      baseState({
        approvedCommands: ["git push", "npm test"],
      }),
    );
    expect(result).toContain("`git push`");
    expect(result).toContain("`npm test`");
  });
});

describe("userInstructionsFragment", () => {
  it("returns null when no instructions", () => {
    expect(userInstructionsFragment.generate(baseState())).toBeNull();
  });

  it("includes custom instructions", () => {
    const result = userInstructionsFragment.generate(
      baseState({ customInstructions: "Always use TypeScript" }),
    );
    expect(result).toContain("Always use TypeScript");
  });
});

describe("modelContextFragment", () => {
  it("includes model name", () => {
    const result = modelContextFragment.generate(baseState());
    expect(result).toContain("claude-sonnet-4-6");
  });
});

describe("toolInventoryFragment", () => {
  it("returns null when no tools", () => {
    expect(toolInventoryFragment.generate(baseState())).toBeNull();
  });

  it("lists enabled tools", () => {
    const result = toolInventoryFragment.generate(
      baseState({ enabledTools: ["bash", "read_file", "grep"] }),
    );
    expect(result).toContain("3 tools");
    expect(result).toContain("bash, read_file, grep");
  });
});

describe("agentRoleFragment", () => {
  it("returns null when no role", () => {
    expect(agentRoleFragment.generate(baseState())).toBeNull();
  });

  it("includes agent role", () => {
    const result = agentRoleFragment.generate(
      baseState({ agentRole: "researcher" }),
    );
    expect(result).toContain("researcher");
  });
});

// ---------------------------------------------------------------------------
// ContextBuilder
// ---------------------------------------------------------------------------

describe("ContextBuilder", () => {
  it("builds context with default fragments", () => {
    const builder = ContextBuilder.withDefaults();
    const result = builder.build(baseState());
    expect(result).toContain("Environment");
    expect(result).toContain("Permissions");
    expect(result).toContain("Model");
  });

  it("builds empty context", () => {
    const builder = ContextBuilder.empty();
    const result = builder.build(baseState());
    expect(result).toBe("");
  });

  it("registers custom fragments", () => {
    const custom: ContextFragment = {
      id: "custom",
      priority: 5,
      generate: () => "## Custom\nHello",
    };
    const builder = ContextBuilder.empty().register(custom);
    const result = builder.build(baseState());
    expect(result).toContain("Custom");
    expect(result).toContain("Hello");
  });

  it("replaces existing fragments by id", () => {
    const replacement: ContextFragment = {
      id: "environment",
      priority: 10,
      generate: () => "## Custom Environment",
    };
    const builder = ContextBuilder.withDefaults().register(replacement);
    const result = builder.build(baseState());
    expect(result).toContain("Custom Environment");
    expect(result).not.toContain(process.platform);
  });

  it("unregisters fragments", () => {
    const builder = ContextBuilder.withDefaults()
      .unregister("environment")
      .unregister("model-context");
    const result = builder.build(baseState());
    expect(result).not.toContain("Environment");
    expect(result).not.toContain("Model");
    expect(result).toContain("Permissions");
  });

  it("has() checks fragment presence", () => {
    const builder = ContextBuilder.withDefaults();
    expect(builder.has("environment")).toBe(true);
    expect(builder.has("nonexistent")).toBe(false);
  });

  it("fragmentCount returns count", () => {
    expect(ContextBuilder.withDefaults().fragmentCount).toBe(10);
    expect(ContextBuilder.empty().fragmentCount).toBe(0);
  });

  it("sorts fragments by priority", () => {
    const low: ContextFragment = {
      id: "low",
      priority: 100,
      generate: () => "LOW",
    };
    const high: ContextFragment = {
      id: "high",
      priority: 1,
      generate: () => "HIGH",
    };
    const builder = ContextBuilder.empty().register(low).register(high);
    const result = builder.build(baseState());
    expect(result.indexOf("HIGH")).toBeLessThan(result.indexOf("LOW"));
  });

  it("skips fragments that return null", () => {
    const nullable: ContextFragment = {
      id: "nullable",
      priority: 1,
      generate: () => null,
    };
    const present: ContextFragment = {
      id: "present",
      priority: 2,
      generate: () => "PRESENT",
    };
    const builder = ContextBuilder.empty()
      .register(nullable)
      .register(present);
    const result = builder.build(baseState());
    expect(result).toBe("PRESENT");
  });

  it("skips fragments that return empty string", () => {
    const empty: ContextFragment = {
      id: "empty",
      priority: 1,
      generate: () => "",
    };
    const builder = ContextBuilder.empty().register(empty);
    const result = builder.build(baseState());
    expect(result).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

describe("singleton management", () => {
  it("getContextBuilder returns consistent instance", () => {
    const b1 = getContextBuilder();
    const b2 = getContextBuilder();
    expect(b1).toBe(b2);
  });

  it("setContextBuilder overrides singleton", () => {
    const custom = ContextBuilder.empty();
    setContextBuilder(custom);
    expect(getContextBuilder()).toBe(custom);
  });

  it("resetContextBuilder clears singleton", () => {
    const b1 = getContextBuilder();
    resetContextBuilder();
    const b2 = getContextBuilder();
    expect(b1).not.toBe(b2);
  });
});
