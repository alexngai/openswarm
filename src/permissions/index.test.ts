import { describe, it, expect } from "vitest";
import { PermissionEngine } from "./index.js";
import type { ToolSpec } from "../core/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTool(
  name: string,
  requiredPermission: ToolSpec["requiredPermission"],
): ToolSpec {
  return {
    name,
    description: `tool ${name}`,
    inputSchema: { type: "object" },
    requiredPermission,
    tier: 0,
  };
}

const toolNone    = makeTool("read-config",    "none");
const toolRead    = makeTool("read-file",      "read");
const toolWrite   = makeTool("write-file",     "write");
const toolExec    = makeTool("run-command",    "exec");
const toolNetwork = makeTool("http-request",   "network");

// ---------------------------------------------------------------------------
// read-only mode (allows: none, read)
// ---------------------------------------------------------------------------

describe('PermissionEngine — read-only mode', () => {
  const engine = new PermissionEngine("read-only");

  it('allows none', () => {
    expect(engine.check(toolNone)).toEqual({ allow: true });
  });

  it('allows read', () => {
    expect(engine.check(toolRead)).toEqual({ allow: true });
  });

  it('denies write', () => {
    const result = engine.check(toolWrite);
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toContain(toolWrite.name);
      expect(result.reason).toContain("write");
      expect(result.reason).toContain("read-only");
    }
  });

  it('denies exec', () => {
    const result = engine.check(toolExec);
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toContain(toolExec.name);
      expect(result.reason).toContain("exec");
      expect(result.reason).toContain("read-only");
    }
  });

  it('denies network', () => {
    const result = engine.check(toolNetwork);
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toContain(toolNetwork.name);
      expect(result.reason).toContain("network");
      expect(result.reason).toContain("read-only");
    }
  });
});

// ---------------------------------------------------------------------------
// workspace-write mode (allows: none, read, write)
// ---------------------------------------------------------------------------

describe('PermissionEngine — workspace-write mode', () => {
  const engine = new PermissionEngine("workspace-write");

  it('allows none', () => {
    expect(engine.check(toolNone)).toEqual({ allow: true });
  });

  it('allows read', () => {
    expect(engine.check(toolRead)).toEqual({ allow: true });
  });

  it('allows write', () => {
    expect(engine.check(toolWrite)).toEqual({ allow: true });
  });

  it('denies exec', () => {
    const result = engine.check(toolExec);
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toContain(toolExec.name);
      expect(result.reason).toContain("exec");
      expect(result.reason).toContain("workspace-write");
    }
  });

  it('denies network', () => {
    const result = engine.check(toolNetwork);
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toContain(toolNetwork.name);
      expect(result.reason).toContain("network");
      expect(result.reason).toContain("workspace-write");
    }
  });
});

// ---------------------------------------------------------------------------
// danger-full-access mode (allows all)
// ---------------------------------------------------------------------------

describe('PermissionEngine — danger-full-access mode', () => {
  const engine = new PermissionEngine("danger-full-access");

  it('allows none', () => {
    expect(engine.check(toolNone)).toEqual({ allow: true });
  });

  it('allows read', () => {
    expect(engine.check(toolRead)).toEqual({ allow: true });
  });

  it('allows write', () => {
    expect(engine.check(toolWrite)).toEqual({ allow: true });
  });

  it('allows exec', () => {
    expect(engine.check(toolExec)).toEqual({ allow: true });
  });

  it('allows network', () => {
    expect(engine.check(toolNetwork)).toEqual({ allow: true });
  });
});

// ---------------------------------------------------------------------------
// Denial message content
// ---------------------------------------------------------------------------

describe('PermissionEngine — denial message format', () => {
  it('includes tool name, required permission, and active mode', () => {
    const engine = new PermissionEngine("read-only");
    const result = engine.check(toolExec);
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toContain(`"${toolExec.name}"`);
      expect(result.reason).toContain(`"exec"`);
      expect(result.reason).toContain(`"read-only"`);
    }
  });
});

// ---------------------------------------------------------------------------
// Consistency — multiple tools under same mode
// ---------------------------------------------------------------------------

describe('PermissionEngine — consistent decisions across multiple tools', () => {
  it('read-only denies all elevated tools consistently', () => {
    const engine = new PermissionEngine("read-only");
    const elevated = [toolWrite, toolExec, toolNetwork];
    for (const tool of elevated) {
      expect(engine.check(tool).allow).toBe(false);
    }
  });

  it('danger-full-access allows all tools consistently', () => {
    const engine = new PermissionEngine("danger-full-access");
    const all = [toolNone, toolRead, toolWrite, toolExec, toolNetwork];
    for (const tool of all) {
      expect(engine.check(tool)).toEqual({ allow: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Purity — no I/O, no state
// ---------------------------------------------------------------------------

describe('PermissionEngine — pure decisions', () => {
  it('same call returns same result every time', () => {
    const engine = new PermissionEngine("workspace-write");
    const first  = engine.check(toolExec);
    const second = engine.check(toolExec);
    expect(first).toEqual(second);
  });

  it('independent engines with same mode produce identical decisions', () => {
    const a = new PermissionEngine("read-only");
    const b = new PermissionEngine("read-only");
    expect(a.check(toolRead)).toEqual(b.check(toolRead));
    expect(a.check(toolWrite)).toEqual(b.check(toolWrite));
  });
});

// ---------------------------------------------------------------------------
// M0 ignores input argument
// ---------------------------------------------------------------------------

describe('PermissionEngine — input argument ignored (M0)', () => {
  it('decision is identical with and without input', () => {
    const engine = new PermissionEngine("read-only");
    expect(engine.check(toolRead)).toEqual(engine.check(toolRead, { path: "/etc/passwd" }));
    expect(engine.check(toolWrite)).toEqual(engine.check(toolWrite, { path: "/tmp/out" }));
  });

  it('passing various input types does not change allow decision', () => {
    const engine = new PermissionEngine("workspace-write");
    const inputs = [undefined, null, {}, [], "string", 42, true];
    for (const inp of inputs) {
      expect(engine.check(toolWrite, inp)).toEqual({ allow: true });
      expect(engine.check(toolExec, inp).allow).toBe(false);
    }
  });
});
