import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeCanUseTool } from "./gate.js";
import { PermissionEngine } from "./index.js";
import { ToolAccesses } from "../tools/access.js";
import type { PermissionMode } from "../core/types.js";
import type { ToolImpl } from "../tools/types.js";
import type { ToolDispatcher } from "../tools/dispatcher.js";
import type { PermissionBridge } from "./bridge.js";
import type { BridgeDecision } from "./bridge.js";

function writeTool(): ToolImpl {
  return {
    spec: {
      name: "write_file",
      description: "writes a file",
      inputSchema: { type: "object" },
      requiredPermission: "write",
      tier: 0,
    },
    execute: async () => ({ status: "ok", output: "" }),
  } as unknown as ToolImpl;
}

function makeDeps(
  getCurrentMode: () => PermissionMode,
  bridgeDecision: BridgeDecision = { allow: false, reason: "denied by test bridge" },
): Parameters<typeof makeCanUseTool>[0] {
  const tool = writeTool();
  const dispatcher = {
    get: (n: string) => (n === tool.spec.name ? tool : undefined),
  } as unknown as ToolDispatcher;
  const bridge = {
    request: async () => bridgeDecision,
  } as unknown as PermissionBridge;
  return {
    dispatcher,
    // permEngine is deliberately built read-only; the gate must honor the
    // LIVE getCurrentMode() instead (Phase 4.1e).
    permEngine: new PermissionEngine("read-only"),
    bridge,
    useHeadless: false,
    getCurrentMode,
    cwd: process.cwd(),
  };
}

describe("makeCanUseTool — honors live mode over the frozen permEngine (Phase 4.1e)", () => {
  it("allows a write tool when the live mode is workspace-write (post-elevation)", async () => {
    const gate = makeCanUseTool(makeDeps(() => "workspace-write"));
    expect(await gate("write_file", {})).toEqual({ allow: true });
  });

  it("prompts (bridge) and denies when the live mode is still read-only", async () => {
    const gate = makeCanUseTool(makeDeps(() => "read-only"));
    const decision = await gate("write_file", {});
    expect(decision.allow).toBe(false);
  });

  it("reflects an elevation that happens between calls", async () => {
    let mode: PermissionMode = "read-only";
    const gate = makeCanUseTool(makeDeps(() => mode));
    expect((await gate("write_file", {})).allow).toBe(false);
    mode = "workspace-write"; // simulate request_permissions / /permissions
    expect(await gate("write_file", {})).toEqual({ allow: true });
  });
});

// ---------------------------------------------------------------------------
// Per-resource authorization
// ---------------------------------------------------------------------------

/**
 * A tool that names the file it touches, which is what moves a call off the
 * tool-level mode check and onto the policy engine.
 */
function declaringTool(name: string, operation: "read" | "write"): ToolImpl {
  return {
    spec: {
      name,
      description: "declares its path",
      inputSchema: { type: "object" },
      requiredPermission: operation === "write" ? "write" : "read",
      tier: 0,
    },
    execute: async () => ({ status: "ok", output: "" }),
    accesses: (input: unknown, ctx: { cwd: string }) => {
      const p = (input as { path?: string }).path;
      if (p === undefined) return ToolAccesses.all();
      return ToolAccesses.file(operation, path.resolve(ctx.cwd, p));
    },
  } as unknown as ToolImpl;
}

interface Harness {
  readonly gate: ReturnType<typeof makeCanUseTool>;
  /** How many times a prompt reached the bridge. */
  prompts(): number;
}

function harness(
  mode: () => PermissionMode,
  respond: () => BridgeDecision,
  workspace: string,
): Harness {
  const tools = [declaringTool("declared_write", "write"), declaringTool("declared_read", "read")];
  const dispatcher = {
    get: (n: string) => tools.find((t) => t.spec.name === n),
  } as unknown as ToolDispatcher;

  let count = 0;
  const bridge = {
    request: async () => {
      count += 1;
      return respond();
    },
  } as unknown as PermissionBridge;

  return {
    gate: makeCanUseTool({
      dispatcher,
      permEngine: new PermissionEngine("read-only"),
      bridge,
      useHeadless: false,
      getCurrentMode: mode,
      cwd: workspace,
    }),
    prompts: () => count,
  };
}

describe("makeCanUseTool — authorizes declared resources per path", () => {
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    const root = fs.realpathSync(os.tmpdir());
    workspace = fs.mkdtempSync(path.join(root, "gate-ws-"));
    outside = fs.mkdtempSync(path.join(root, "gate-out-"));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("allows a declared read under read-only without prompting", async () => {
    const h = harness(() => "read-only", () => ({ allow: false }), workspace);
    expect(await h.gate("declared_read", { path: "a.txt" })).toEqual({ allow: true });
    expect(h.prompts()).toBe(0);
  });

  it("allows a declared write under workspace-write without prompting", async () => {
    const h = harness(() => "workspace-write", () => ({ allow: false }), workspace);
    expect(await h.gate("declared_write", { path: "a.txt" })).toEqual({ allow: true });
    expect(h.prompts()).toBe(0);
  });

  it("prompts for a declared write under read-only, and denies on refusal", async () => {
    const h = harness(() => "read-only", () => ({ allow: false, reason: "no" }), workspace);
    const decision = await h.gate("declared_write", { path: "a.txt" });
    expect(decision.allow).toBe(false);
    expect(h.prompts()).toBe(1);
  });

  it("remembers a session approval for that exact path", async () => {
    const h = harness(
      () => "read-only",
      () => ({ allow: true, alwaysAllow: true }),
      workspace,
    );
    expect((await h.gate("declared_write", { path: "a.txt" })).allow).toBe(true);
    expect((await h.gate("declared_write", { path: "a.txt" })).allow).toBe(true);
    // The second call is covered by the grant from the first.
    expect(h.prompts()).toBe(1);
  });

  it("does not let a grant widen to a different path", async () => {
    const h = harness(
      () => "read-only",
      () => ({ allow: true, alwaysAllow: true }),
      workspace,
    );
    await h.gate("declared_write", { path: "a.txt" });
    await h.gate("declared_write", { path: "b.txt" });
    expect(h.prompts()).toBe(2);
  });

  it("treats a plain approval as one-shot", async () => {
    // "y" has always meant just this once; only "always" creates a grant.
    const h = harness(() => "read-only", () => ({ allow: true }), workspace);
    await h.gate("declared_write", { path: "a.txt" });
    await h.gate("declared_write", { path: "a.txt" });
    expect(h.prompts()).toBe(2);
  });

  it("refuses an out-of-workspace path without prompting", async () => {
    const h = harness(
      () => "danger-full-access",
      () => ({ allow: true, alwaysAllow: true }),
      workspace,
    );
    const decision = await h.gate("declared_write", {
      path: path.join(outside, "victim.txt"),
    });
    expect(decision.allow).toBe(false);
    expect(decision.allow === false && decision.reason).toContain("outside the workspace");
    expect(h.prompts()).toBe(0);
  });

  it("falls back to the mode check when the tool cannot name its paths", async () => {
    // No `path` in the input, so the declaration degrades to all().
    const h = harness(() => "workspace-write", () => ({ allow: false }), workspace);
    expect(await h.gate("declared_write", {})).toEqual({ allow: true });
  });
});
