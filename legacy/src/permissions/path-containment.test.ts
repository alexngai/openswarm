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
import { makePathContainment, makeResourceDeriver } from "./path-containment.js";
import { resourceOf } from "../kernel/policy-engine.js";
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
    // `ToolImpl.accesses` is required, so this shape can only arrive from
    // outside the type system — a tool registered from plain JS. Containment
    // still declines rather than denying; the pessimism for that case lives in
    // the scheduler, which treats an absent declaration as `all()`.
    const check = makePathContainment(workspace);
    const bare = {
      spec,
      execute: async () => ({ status: "ok", output: "" }),
    } as unknown as ToolImpl;
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

describe("network accesses become authorizable requests", () => {
  it("derives a network.request carrying method and url", async () => {
    const derive = makeResourceDeriver(workspace);
    const derived = await derive(
      toolDeclaring(() => ToolAccesses.network("https://example.com/a", "POST")),
      {},
    );

    expect(derived.kind).toBe("requests");
    if (derived.kind !== "requests") return;
    expect(derived.requests).toHaveLength(1);
    const req = derived.requests[0]!;
    expect(req.kind).toBe("network.request");
    if (req.kind !== "network.request") return;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://example.com/a");
  });

  it("binds every path on one host to a single grant identity", () => {
    // Two fetches, one approval. `resourceOf` is what collapses them, so the
    // grant cache sees one key rather than one per URL.
    const a = resourceOf({
      kind: "network.request",
      operationId: "1",
      idempotency: "unknown",
      toolName: "web_fetch",
      method: "GET",
      url: "https://example.com/a",
    });
    const b = resourceOf({
      kind: "network.request",
      operationId: "2",
      idempotency: "unknown",
      toolName: "web_fetch",
      method: "GET",
      url: "https://example.com/b?q=1",
    });
    expect(a).toBe(b);
    expect(a).toBe("example.com");
  });

  it("gives an MCP server a grant identity of its own", async () => {
    const derive = makeResourceDeriver(workspace);
    const derived = await derive(toolDeclaring(() => ToolAccesses.mcpServer("my server")), {});

    if (derived.kind !== "requests") throw new Error("expected requests");
    // The name is escaped into the URL, so a server name with a space or a
    // slash cannot be confused for a different one.
    expect(resourceOf(derived.requests[0]!)).toBe("my%20server");
  });

  it("keeps two plugins from sharing one approval", async () => {
    const derive = makeResourceDeriver(workspace);
    const one = await derive(toolDeclaring(() => ToolAccesses.plugin("alpha")), {});
    const two = await derive(toolDeclaring(() => ToolAccesses.plugin("beta")), {});

    if (one.kind !== "requests" || two.kind !== "requests") throw new Error("expected requests");
    expect(resourceOf(one.requests[0]!)).not.toBe(resourceOf(two.requests[0]!));
  });

  it("still denies a path escape when the tool also reaches the network", async () => {
    const derive = makeResourceDeriver(workspace);
    const derived = await derive(
      toolDeclaring(() => [
        ...ToolAccesses.network("https://example.com"),
        ...ToolAccesses.writeFile("/etc/passwd"),
      ]),
      {},
    );
    expect(derived.kind).toBe("denied");
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
