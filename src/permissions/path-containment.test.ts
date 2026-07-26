/**
 * Tests for central path containment.
 *
 * The case that matters most here is the symlinked *parent*. Every per-tool
 * check resolves a symlink only when the leaf is one, so a file reached through
 * a symlinked directory passes all thirteen of them. Central containment
 * resolves the ancestor chain, so it does not.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { makePathContainment } from "./path-containment.js";
import { ToolAccesses } from "../tools/access.js";
import type { ToolImpl, ToolExecutionContext } from "../tools/types.js";
import type { ToolSpec } from "../core/types.js";

let workspace: string;
let outside: string;

beforeEach(() => {
  const root = fs.realpathSync(os.tmpdir());
  workspace = fs.mkdtempSync(path.join(root, "contain-ws-"));
  outside = fs.mkdtempSync(path.join(root, "contain-out-"));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const spec: ToolSpec = {
  name: "probe",
  description: "test",
  inputSchema: { type: "object", properties: {} } as ToolSpec["inputSchema"],
  requiredPermission: "write",
  tier: 0,
};

/** A tool that declares whatever access the test needs. */
function toolDeclaring(
  declare: (input: unknown, ctx: ToolExecutionContext) => ReturnType<typeof ToolAccesses.all>,
): ToolImpl {
  return {
    spec,
    execute: async () => ({ status: "ok", output: "" }),
    accesses: declare,
  };
}

function writeTo(p: string): ToolImpl {
  return toolDeclaring(() => ToolAccesses.writeFile(p));
}

function readFrom(p: string): ToolImpl {
  return toolDeclaring(() => ToolAccesses.readFile(p));
}

describe("paths inside the workspace pass", () => {
  it("allows a plain file in the workspace", async () => {
    const check = makePathContainment(workspace);
    const result = await check(writeTo(path.join(workspace, "a.txt")), {});
    expect(result).toBeNull();
  });

  it("allows a file that does not exist yet", async () => {
    const check = makePathContainment(workspace);
    const target = path.join(workspace, "nested", "deep", "new.txt");
    expect(await check(writeTo(target), {})).toBeNull();
  });

  it("allows the workspace root itself", async () => {
    const check = makePathContainment(workspace);
    expect(await check(readFrom(workspace), {})).toBeNull();
  });
});

describe("paths outside the workspace are denied", () => {
  it("denies an absolute path elsewhere on disk", async () => {
    const check = makePathContainment(workspace);
    const result = await check(writeTo(path.join(outside, "victim.txt")), {});
    expect(result?.allow).toBe(false);
    expect(result?.allow === false && result.reason).toContain("outside the workspace");
  });

  it("denies a traversal out of the workspace", async () => {
    const check = makePathContainment(workspace);
    const result = await check(writeTo(path.join(workspace, "..", "escape.txt")), {});
    expect(result?.allow).toBe(false);
  });

  it("denies a symlinked leaf pointing out of the workspace", async () => {
    const target = path.join(outside, "victim.txt");
    fs.writeFileSync(target, "secret");
    const link = path.join(workspace, "link.txt");
    fs.symlinkSync(target, link);

    const check = makePathContainment(workspace);
    const result = await check(writeTo(link), {});
    expect(result?.allow).toBe(false);
  });

  it("denies a file reached through a symlinked PARENT directory", async () => {
    // The gap in every per-tool check: the leaf is an ordinary file, so a
    // leaf-only lstat sees nothing suspicious.
    const target = path.join(outside, "victim.txt");
    fs.writeFileSync(target, "secret");
    fs.symlinkSync(outside, path.join(workspace, "gateway"));

    const viaParent = path.join(workspace, "gateway", "victim.txt");
    expect(fs.lstatSync(viaParent).isSymbolicLink()).toBe(false);

    const check = makePathContainment(workspace);
    const result = await check(writeTo(viaParent), {});
    expect(result?.allow).toBe(false);
    expect(result?.allow === false && result.reason).toContain("outside the workspace");
  });

  it("denies a not-yet-existing file under a symlinked parent", async () => {
    fs.symlinkSync(outside, path.join(workspace, "gateway"));
    const check = makePathContainment(workspace);
    const result = await check(writeTo(path.join(workspace, "gateway", "new.txt")), {});
    expect(result?.allow).toBe(false);
  });

  it("names the offending operation in the denial", async () => {
    const check = makePathContainment(workspace);
    const result = await check(readFrom(path.join(outside, "secret.txt")), {});
    expect(result?.allow === false && result.reason).toContain("probe would read");
  });

  it("denies when any one of several declared paths escapes", async () => {
    const inside = path.join(workspace, "ok.txt");
    const escaping = path.join(outside, "bad.txt");
    const tool = toolDeclaring(() => [
      ...ToolAccesses.readFile(inside),
      ...ToolAccesses.writeFile(escaping),
    ]);

    const check = makePathContainment(workspace);
    const result = await check(tool, {});
    expect(result?.allow).toBe(false);
    expect(result?.allow === false && result.reason).toContain("bad.txt");
  });
});

describe("calls this cannot judge fall through", () => {
  it("has no opinion on a tool that declares all()", async () => {
    const check = makePathContainment(workspace);
    expect(await check(toolDeclaring(() => ToolAccesses.all()), {})).toBeNull();
  });

  it("has no opinion on a tool with no accesses callback", async () => {
    const check = makePathContainment(workspace);
    const bare: ToolImpl = { spec, execute: async () => ({ status: "ok", output: "" }) };
    expect(await check(bare, {})).toBeNull();
  });

  it("has no opinion on a tool that declares none()", async () => {
    const check = makePathContainment(workspace);
    expect(await check(toolDeclaring(() => ToolAccesses.none()), {})).toBeNull();
  });

  it("has no opinion when the declaration throws", async () => {
    const check = makePathContainment(workspace);
    const broken = toolDeclaring(() => {
      throw new Error("bad declaration");
    });
    expect(await check(broken, {})).toBeNull();
  });
});

describe("workspace root resolution", () => {
  it("resolves a symlinked workspace root before comparing", async () => {
    // A workspace reached through a symlink must still contain its own files.
    const alias = path.join(fs.realpathSync(os.tmpdir()), `contain-alias-${process.pid}`);
    fs.symlinkSync(workspace, alias);
    try {
      const check = makePathContainment(alias);
      expect(await check(writeTo(path.join(alias, "a.txt")), {})).toBeNull();
    } finally {
      fs.rmSync(alias, { force: true });
    }
  });

  it("initializes once across many calls", async () => {
    const check = makePathContainment(workspace);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        check(writeTo(path.join(workspace, `f${i}.txt`)), {}),
      ),
    );
    expect(results.every((r) => r === null)).toBe(true);
  });
});
