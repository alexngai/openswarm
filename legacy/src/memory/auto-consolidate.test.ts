import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  evaluateConsolidationCadence,
  resolveCadenceOptions,
  resolveCommand,
  resolveSharedBankArg,
  resolveOnPath,
  stateFilePath,
  readState,
  writeState,
  maybeAutoConsolidate,
  resetSpawnClock,
  type ConsolidateState,
  type CadenceOptions,
} from "./auto-consolidate.js";

const HOUR = 60 * 60 * 1000;
const baseOpts: CadenceOptions = { enabled: true, intervalMs: 24 * HOUR, spawnGapMs: 10_000 };

describe("evaluateConsolidationCadence", () => {
  it("runs when never run before", () => {
    const d = evaluateConsolidationCadence({ lastRunMs: null }, baseOpts, 1_000_000, 0);
    expect(d.shouldRun).toBe(true);
    expect(d.reason).toBe("never run");
  });

  it("does not run when disabled", () => {
    const d = evaluateConsolidationCadence({ lastRunMs: null }, { ...baseOpts, enabled: false }, 1_000_000, 0);
    expect(d.shouldRun).toBe(false);
    expect(d.reason).toBe("disabled");
  });

  it("debounces within the spawn gap", () => {
    const now = 1_000_000;
    const d = evaluateConsolidationCadence({ lastRunMs: null }, baseOpts, now, now - 5_000);
    expect(d.shouldRun).toBe(false);
    expect(d.reason).toBe("spawn-gap debounce");
  });

  it("skips when the last run is within the interval", () => {
    const now = 100 * HOUR;
    const state: ConsolidateState = { lastRunMs: now - 2 * HOUR };
    const d = evaluateConsolidationCadence(state, baseOpts, now, 0);
    expect(d.shouldRun).toBe(false);
    expect(d.reason).toContain("too recent");
  });

  it("runs when the interval has elapsed", () => {
    const now = 100 * HOUR;
    const state: ConsolidateState = { lastRunMs: now - 25 * HOUR };
    const d = evaluateConsolidationCadence(state, baseOpts, now, 0);
    expect(d.shouldRun).toBe(true);
    expect(d.reason).toBe("interval elapsed");
  });
});

describe("resolveCadenceOptions", () => {
  it("defaults to enabled with a 24h interval", () => {
    const o = resolveCadenceOptions({});
    expect(o.enabled).toBe(true);
    expect(o.intervalMs).toBe(24 * HOUR);
  });

  it("honors disable values and custom interval", () => {
    expect(resolveCadenceOptions({ OPENSWARM_AUTO_CONSOLIDATE: "off" }).enabled).toBe(false);
    expect(resolveCadenceOptions({ OPENSWARM_AUTO_CONSOLIDATE: "0" }).enabled).toBe(false);
    expect(resolveCadenceOptions({ OPENSWARM_AUTO_CONSOLIDATE_INTERVAL_HOURS: "6" }).intervalMs).toBe(6 * HOUR);
  });

  it("ignores invalid interval and falls back to default", () => {
    expect(resolveCadenceOptions({ OPENSWARM_AUTO_CONSOLIDATE_INTERVAL_HOURS: "nope" }).intervalMs).toBe(24 * HOUR);
    expect(resolveCadenceOptions({ OPENSWARM_AUTO_CONSOLIDATE_INTERVAL_HOURS: "-3" }).intervalMs).toBe(24 * HOUR);
  });
});

describe("resolveCommand", () => {
  it("uses a shell override verbatim", () => {
    const cmd = resolveCommand("/repo", { OPENSWARM_AUTO_CONSOLIDATE_CMD: "cogcore run && cogcore dream" });
    expect(cmd).toEqual({ file: "cogcore run && cogcore dream", args: [], shell: true });
  });

  it("returns null when cogcore is absent and no override is set", () => {
    expect(resolveCommand("/repo", { PATH: "/nonexistent-xyz" })).toBeNull();
  });

  it("builds the default cogcore command when resolvable on PATH", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acbin-"));
    const bin = path.join(dir, "cogcore");
    fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
    try {
      const cmd = resolveCommand("/repo", { PATH: dir, OPENSWARM_SHARED_SKILL_BANK: "0" });
      expect(cmd).toEqual({ file: bin, args: ["run", "--once", "--repo", "/repo"], shell: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends --shared-bank when the shared skill bank resolves", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acbin-"));
    const bin = path.join(dir, "cogcore");
    fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
    try {
      const cmd = resolveCommand("/repo", {
        PATH: dir,
        OPENSWARM_SHARED_SKILL_BANK: "/srv/bank",
      });
      expect(cmd).toEqual({
        file: bin,
        args: ["run", "--once", "--repo", "/repo", "--shared-bank", "/srv/bank"],
        shell: false,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveSharedBankArg", () => {
  it("is disabled by explicit falsy values", () => {
    for (const v of ["0", "off", "false", "no"]) {
      expect(resolveSharedBankArg({ OPENSWARM_SHARED_SKILL_BANK: v })).toBeNull();
    }
  });

  it("uses an explicit path even when the directory does not exist yet", () => {
    expect(resolveSharedBankArg({ OPENSWARM_SHARED_SKILL_BANK: "/srv/bank" })).toBe("/srv/bank");
  });

  it("defaults to the SkillProvider bank only when it exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acbank-"));
    try {
      expect(resolveSharedBankArg({ OPENSWARM_SKILLS_DIR: dir })).toBe(dir);
      expect(
        resolveSharedBankArg({ OPENSWARM_SKILLS_DIR: path.join(dir, "missing") }),
      ).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveOnPath", () => {
  it("finds an executable and returns null for missing ones", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpath-"));
    const bin = path.join(dir, "mytool");
    fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
    try {
      expect(resolveOnPath("mytool", { PATH: dir })).toBe(bin);
      expect(resolveOnPath("nope-xyz", { PATH: dir })).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("state persistence", () => {
  it("round-trips and tolerates a missing/corrupt file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acstate-"));
    const file = path.join(dir, "nested", "marker.json");
    try {
      expect(readState(file)).toEqual({ lastRunMs: null });
      writeState(file, { lastRunMs: 12345 });
      expect(readState(file)).toEqual({ lastRunMs: 12345 });
      fs.writeFileSync(file, "not json", "utf8");
      expect(readState(file)).toEqual({ lastRunMs: null });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves a project-local default path and honors an override", () => {
    expect(stateFilePath("/repo", {})).toBe(
      path.join("/repo", ".openswarm", "cognitive-core", "last-consolidate.json"),
    );
    expect(stateFilePath("/repo", { OPENSWARM_AUTO_CONSOLIDATE_STATE: "/tmp/x.json" })).toBe("/tmp/x.json");
  });
});

describe("maybeAutoConsolidate", () => {
  let dir: string;
  const stateFile = () => path.join(dir, "marker.json");

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "acrun-"));
    resetSpawnClock();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function fakeSpawn() {
    const calls: Array<{ file: string; args?: readonly string[] }> = [];
    const spawnFn = ((file: string, argsOrOpts?: unknown) => {
      calls.push({ file, args: Array.isArray(argsOrOpts) ? (argsOrOpts as string[]) : undefined });
      return {
        pid: 4242,
        unref() {},
        on() {},
      } as unknown as ReturnType<typeof import("node:child_process").spawn>;
    }) as unknown as typeof import("node:child_process").spawn;
    return { calls, spawnFn };
  }

  it("triggers a spawn when due and records the timestamp", async () => {
    const { calls, spawnFn } = fakeSpawn();
    const env = { OPENSWARM_AUTO_CONSOLIDATE_STATE: stateFile(), PATH: "/anything", OPENSWARM_AUTO_CONSOLIDATE_CMD: "cogcore run --once" };
    const res = await maybeAutoConsolidate({ cwd: "/repo", now: 1_000_000, env, spawnFn });
    expect(res.triggered).toBe(true);
    expect(res.pid).toBe(4242);
    expect(calls).toHaveLength(1);
    expect(readState(stateFile()).lastRunMs).toBe(1_000_000);
  });

  it("does not spawn again within the interval", async () => {
    const { calls, spawnFn } = fakeSpawn();
    const env = { OPENSWARM_AUTO_CONSOLIDATE_STATE: stateFile(), OPENSWARM_AUTO_CONSOLIDATE_CMD: "cogcore run" };
    const first = await maybeAutoConsolidate({ cwd: "/repo", now: 1_000_000, env, spawnFn });
    expect(first.triggered).toBe(true);
    // Advance beyond the spawn-gap but within the 24h interval.
    const second = await maybeAutoConsolidate({ cwd: "/repo", now: 1_000_000 + 60_000, env, spawnFn });
    expect(second.triggered).toBe(false);
    expect(second.reason).toContain("too recent");
    expect(calls).toHaveLength(1);
  });

  it("no-ops when disabled", async () => {
    const { calls, spawnFn } = fakeSpawn();
    const env = { OPENSWARM_AUTO_CONSOLIDATE: "0", OPENSWARM_AUTO_CONSOLIDATE_STATE: stateFile() };
    const res = await maybeAutoConsolidate({ cwd: "/repo", now: 1_000_000, env, spawnFn });
    expect(res.triggered).toBe(false);
    expect(res.reason).toBe("disabled");
    expect(calls).toHaveLength(0);
  });

  it("no-ops when cogcore is not installed and no override is set", async () => {
    const { calls, spawnFn } = fakeSpawn();
    const env = { OPENSWARM_AUTO_CONSOLIDATE_STATE: stateFile(), PATH: "/nonexistent-xyz" };
    const res = await maybeAutoConsolidate({ cwd: "/repo", now: 1_000_000, env, spawnFn });
    expect(res.triggered).toBe(false);
    expect(res.reason).toBe("cogcore not found");
    expect(calls).toHaveLength(0);
  });
});
