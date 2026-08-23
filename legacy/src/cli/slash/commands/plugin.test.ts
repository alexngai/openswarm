import { describe, it, expect } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pluginCommand } from "./plugin.js";
import { buildDefaultRegistry, buildSlashContext } from "../index.js";
import { createInitialState } from "../../../ui/repl/state.js";
import { PluginStateStore } from "../../../plugins/state.js";
import type { PluginInstallSource } from "../../../plugins/index.js";

const SOURCE: PluginInstallSource = { kind: "LocalPath", path: "/tmp/x" };

async function makeCtxWithStore(
  args: readonly string[],
  store: PluginStateStore,
) {
  const registry = buildDefaultRegistry({ pluginStore: store });
  return buildSlashContext(registry, createInitialState(), args, {
    pluginStore: store,
  });
}

async function makeTmpStore(): Promise<PluginStateStore> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "swarm-slash-plugin-test-"));
  return new PluginStateStore(dir);
}

describe("/plugin", () => {
  it("errors on missing subcommand", async () => {
    const store = await makeTmpStore();
    const ctx = await makeCtxWithStore([], store);
    const res = await pluginCommand.execute(ctx);
    expect(res.kind).toBe("error");
  });

  it("list on empty store returns 'no plugins installed'", async () => {
    const store = await makeTmpStore();
    const ctx = await makeCtxWithStore(["list"], store);
    const res = await pluginCommand.execute(ctx);
    expect(res.kind).toBe("message");
    if (res.kind === "message") {
      expect(res.text).toContain("no plugins installed");
    }
  });

  it("list shows installed plugins with enable state", async () => {
    const store = await makeTmpStore();
    await store.record("alpha", "1.2.3", SOURCE);
    await store.record("beta", "0.1.0", SOURCE);
    await store.setEnabled("beta", false);

    const ctx = await makeCtxWithStore(["list"], store);
    const res = await pluginCommand.execute(ctx);
    expect(res.kind).toBe("message");
    if (res.kind === "message") {
      expect(res.text).toContain("alpha v1.2.3 (enabled)");
      expect(res.text).toContain("beta v0.1.0 (disabled)");
    }
  });

  it("enable flips the bit for an installed plugin", async () => {
    const store = await makeTmpStore();
    await store.record("alpha", "1.0.0", SOURCE);
    await store.setEnabled("alpha", false);

    const ctx = await makeCtxWithStore(["enable", "alpha"], store);
    const res = await pluginCommand.execute(ctx);
    expect(res.kind).toBe("message");
    expect(await store.isEnabled("alpha")).toBe(true);
  });

  it("disable flips the bit for an installed plugin", async () => {
    const store = await makeTmpStore();
    await store.record("alpha", "1.0.0", SOURCE);

    const ctx = await makeCtxWithStore(["disable", "alpha"], store);
    const res = await pluginCommand.execute(ctx);
    expect(res.kind).toBe("message");
    expect(await store.isEnabled("alpha")).toBe(false);
  });

  it("enable on a plugin that is not installed returns an error", async () => {
    const store = await makeTmpStore();
    const ctx = await makeCtxWithStore(["enable", "ghost"], store);
    const res = await pluginCommand.execute(ctx);
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.message).toMatch(/not installed/);
    }
  });

  it("enable without an id returns usage error", async () => {
    const store = await makeTmpStore();
    const ctx = await makeCtxWithStore(["enable"], store);
    const res = await pluginCommand.execute(ctx);
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.message).toMatch(/usage/);
    }
  });

  it("install/update/uninstall surface CLI-only message (doc 17 Q2 deferral)", async () => {
    const store = await makeTmpStore();
    for (const sub of ["install", "update", "uninstall"] as const) {
      const ctx = await makeCtxWithStore([sub, "x"], store);
      const res = await pluginCommand.execute(ctx);
      expect(res.kind).toBe("error");
      if (res.kind === "error") {
        expect(res.message).toMatch(/CLI-only/);
      }
    }
  });

  it("unknown subcommand returns a usage error", async () => {
    const store = await makeTmpStore();
    const ctx = await makeCtxWithStore(["bogus"], store);
    const res = await pluginCommand.execute(ctx);
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.message).toMatch(/unknown \/plugin subcommand/);
    }
  });
});
